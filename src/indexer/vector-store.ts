import { App, normalizePath, Plugin } from "obsidian";

/**
 * Options for filtering search results
 */
export interface SearchOptions {
    /** Specific file paths to include */
    files?: string[];
    /** Folder path prefixes to include */
    folders?: string[];
    /** Tags to include (will check file metadata) */
    tags?: string[];
}

/**
 * Stored vector data for a chunk.
 * Intentionally minimal: the chunk's text content and derived fields (file path,
 * WikiLink) already live in memory in the ChunkManager and are cheap to
 * recompute, so we avoid persisting a second copy of the vault's text here.
 * Keeping this shape lean is what keeps the on-disk/in-memory footprint of the
 * embedding store proportional to "vector count * dimensions" instead of
 * "vector count * (dimensions + full chunk text)".
 */
export interface StoredVector {
    /** The embedding vector */
    vector: number[];
    /** Hash of the content to detect changes */
    contentHash: string;
}

/**
 * Search result from vector similarity search
 */
export interface SearchResult {
    /** The chunk ID */
    chunkId: string;
    /** The file path, derived from the chunk ID */
    filePath: string;
    /** Cosine similarity score (0-1) */
    score: number;
}

/**
 * Data structure for the vector store JSON file
 */
export interface VectorStoreData {
    version: number;
    vectors: Record<string, StoredVector>;
}

/** Bumped because the persisted shape and storage location both changed (see below). */
const VECTOR_STORE_VERSION = 2;
/** Dedicated file inside the plugin's own config directory, separate from data.json/settings. */
const VECTOR_STORE_FILE = "vector-store.json";
/** Number of decimal places kept for each embedding component; more than enough precision for cosine similarity. */
const VECTOR_PRECISION = 6;

/**
 * Chunk IDs are always formatted as "filePath::chunkIndex". Extract the file path portion.
 */
function getFilePathFromChunkId(chunkId: string): string {
    const separatorIndex = chunkId.lastIndexOf("::");
    return separatorIndex === -1 ? chunkId : chunkId.substring(0, separatorIndex);
}

/**
 * Round a vector's components to a fixed precision to shrink JSON size without
 * meaningfully affecting cosine-similarity accuracy.
 */
function roundVector(vector: number[]): number[] {
    const factor = 10 ** VECTOR_PRECISION;
    return vector.map(value => Math.round(value * factor) / factor);
}

/**
 * VectorStore manages persistent storage of embedding vectors.
 *
 * Embeddings are persisted to their own file (`vector-store.json`) inside the
 * plugin's config directory rather than being merged into Obsidian's
 * `data.json` (which also holds plugin settings). For a large vault this file
 * can grow to hold thousands of vectors; keeping it out of `data.json` means:
 *  - Loading/saving plugin settings never has to parse/serialize embeddings.
 *  - Saving embeddings after indexing a single file no longer requires
 *    re-reading and re-writing the *entire* settings blob.
 */
export class VectorStore {
    private plugin: Plugin;
    private app: App;
    private vectors: Map<string, StoredVector> = new Map();
    private isDirty: boolean = false;
    private storePath: string;
    /** True if legacy/incompatible data was found and discarded during load, requiring a re-embed. */
    private migratedFromLegacy: boolean = false;

    constructor(plugin: Plugin) {
        this.plugin = plugin;
        this.app = plugin.app;
        const pluginDir = plugin.manifest.dir ?? `.obsidian/plugins/${plugin.manifest.id}`;
        this.storePath = normalizePath(`${pluginDir}/${VECTOR_STORE_FILE}`);
    }

    /**
     * Load vector data from disk
     */
    async load(): Promise<void> {
        try {
            if (await this.app.vault.adapter.exists(this.storePath)) {
                const raw = await this.app.vault.adapter.read(this.storePath);
                const storeData = JSON.parse(raw) as VectorStoreData;

                if (storeData.version === VECTOR_STORE_VERSION && storeData.vectors) {
                    this.vectors = new Map(Object.entries(storeData.vectors));
                    console.log(`Loaded ${this.vectors.size} vectors from storage`);
                    return;
                }

                // Incompatible version on disk; discard and require a re-embed rather than
                // trying to load a shape we no longer understand.
                console.log("Vector store file has an incompatible version; it will be rebuilt.");
                this.migratedFromLegacy = true;
            } else {
                // Check for pre-migration data that used to live inside data.json.
                await this.migrateLegacyDataJsonStore();
            }
        } catch (error) {
            console.error("Failed to load vector store:", error);
            this.vectors = new Map();
        }
    }

    /**
     * One-time migration: older versions of this plugin stored embeddings (plus a
     * duplicate copy of every chunk's text) inside Obsidian's shared `data.json`
     * settings file. If that old key is found, drop it (so `data.json` shrinks
     * back down to just settings) and flag that embeddings need to be rebuilt in
     * the new dedicated store.
     */
    private async migrateLegacyDataJsonStore(): Promise<void> {
        const existingData = (await this.plugin.loadData()) as Record<string, unknown> | null;
        if (!existingData || !("vectorStore" in existingData)) {
            return;
        }

        console.log("Found legacy embeddings inside data.json; migrating to a dedicated store.");
        this.migratedFromLegacy = true;

        const { vectorStore: _legacyVectorStore, ...settingsOnly } = existingData;
        await this.plugin.saveData(settingsOnly);
    }

    /**
     * Save vector data to disk
     */
    async save(): Promise<void> {
        if (!this.isDirty) {
            return;
        }

        try {
            const storeData: VectorStoreData = {
                version: VECTOR_STORE_VERSION,
                vectors: Object.fromEntries(this.vectors)
            };

            await this.app.vault.adapter.write(this.storePath, JSON.stringify(storeData));

            this.isDirty = false;
            console.log(`Saved ${this.vectors.size} vectors to storage`);
        } catch (error) {
            console.error("Failed to save vector store:", error);
        }
    }

    /**
     * Get vector for a chunk ID
     */
    getVector(chunkId: string): StoredVector | undefined {
        return this.vectors.get(chunkId);
    }

    /**
     * Check if a vector exists and has matching content hash
     */
    hasValidVector(chunkId: string, contentHash: string): boolean {
        const stored = this.vectors.get(chunkId);
        return stored !== undefined && stored.contentHash === contentHash;
    }

    /**
     * Save a vector for a chunk
     */
    saveVector(chunkId: string, vector: number[], contentHash: string): void {
        this.vectors.set(chunkId, { vector: roundVector(vector), contentHash });
        this.isDirty = true;
    }

    /**
     * Calculate cosine similarity between two vectors
     */
    private cosineSimilarity(a: number[], b: number[]): number {
        if (a.length !== b.length || a.length === 0) {
            return 0;
        }

        let dotProduct = 0;
        let normA = 0;
        let normB = 0;

        for (let i = 0; i < a.length; i++) {
            const aVal = a[i] ?? 0;
            const bVal = b[i] ?? 0;
            dotProduct += aVal * bVal;
            normA += aVal * aVal;
            normB += bVal * bVal;
        }

        const denominator = Math.sqrt(normA) * Math.sqrt(normB);
        if (denominator === 0) {
            return 0;
        }

        return dotProduct / denominator;
    }

    /**
     * Check if a file matches the search options filter
     */
    private matchesFilter(filePath: string, options?: SearchOptions): boolean {
        if (!options) {
            return true; // No filter, include all
        }

        const hasFileFilter = options.files && options.files.length > 0;
        const hasFolderFilter = options.folders && options.folders.length > 0;
        const hasTagFilter = options.tags && options.tags.length > 0;

        // If no filters specified, include all
        if (!hasFileFilter && !hasFolderFilter && !hasTagFilter) {
            return true;
        }

        // Check file filter (exact match)
        if (hasFileFilter && options.files!.includes(filePath)) {
            return true;
        }

        // Check folder filter (recursive - includes all subfolders)
        if (hasFolderFilter) {
            for (const folder of options.folders!) {
                // Normalize folder path: ensure it ends with / for proper prefix matching
                const normalizedFolder = folder.endsWith("/") ? folder : folder + "/";
                // Check if file is directly in the folder or in any subfolder
                if (filePath.startsWith(normalizedFolder) || filePath === folder) {
                    return true;
                }
            }
        }

        // Check tag filter using MetadataCache (with hierarchy support)
        if (hasTagFilter) {
            const file = this.app.vault.getAbstractFileByPath(filePath);
            if (file) {
                const cache = this.app.metadataCache.getCache(filePath);
                const fileTags: string[] = [];
                
                // Collect inline tags
                if (cache?.tags) {
                    for (const t of cache.tags) {
                        fileTags.push(t.tag.toLowerCase());
                    }
                }
                
                // Collect frontmatter tags
                if (cache?.frontmatter?.tags) {
                    const fmTags: string[] = Array.isArray(cache.frontmatter.tags) 
                        ? cache.frontmatter.tags 
                        : [cache.frontmatter.tags];
                    for (const t of fmTags) {
                        if (typeof t === "string") {
                            const normalized = t.startsWith("#") ? t.toLowerCase() : `#${t.toLowerCase()}`;
                            fileTags.push(normalized);
                        }
                    }
                }
                
                // Also check singular 'tag' field
                if (cache?.frontmatter?.tag && typeof cache.frontmatter.tag === "string") {
                    const t = cache.frontmatter.tag;
                    const normalized = t.startsWith("#") ? t.toLowerCase() : `#${t.toLowerCase()}`;
                    fileTags.push(normalized);
                }
                
                // Check if any selected tag matches file tags (with hierarchy)
                for (const selectedTag of options.tags!) {
                    const normalizedSelected = selectedTag.startsWith("#") 
                        ? selectedTag.toLowerCase() 
                        : `#${selectedTag.toLowerCase()}`;
                    
                    for (const fileTag of fileTags) {
                        // Exact match
                        if (fileTag === normalizedSelected) {
                            return true;
                        }
                        // Hierarchy match: #project matches #project/subtask
                        // If selected is #project, it should match #project/anything
                        if (fileTag.startsWith(normalizedSelected + "/")) {
                            return true;
                        }
                    }
                }
            }
        }

        return false;
    }

    /**
     * Search for similar vectors using cosine similarity
     * @param queryVector The query embedding vector
     * @param limit Maximum number of results to return
     * @param options Optional filters for files, folders, or tags
     */
    search(queryVector: number[], limit: number = 5, options?: SearchOptions): SearchResult[] {
        const results: SearchResult[] = [];

        for (const [chunkId, stored] of this.vectors) {
            const filePath = getFilePathFromChunkId(chunkId);

            // Apply search filters
            if (!this.matchesFilter(filePath, options)) {
                continue;
            }
            
            const score = this.cosineSimilarity(queryVector, stored.vector);
            results.push({ chunkId, filePath, score });
        }

        // Sort by score descending and return top results
        results.sort((a, b) => b.score - a.score);
        return results.slice(0, limit);
    }

    /**
     * Whether the last `load()` discarded incompatible/legacy data, meaning
     * embeddings need to be regenerated via "Rebuild Index".
     */
    needsRebuildAfterMigration(): boolean {
        return this.migratedFromLegacy;
    }

    /**
     * Delete all vectors for a file path
     * Chunk IDs are formatted as "filepath::index"
     */
    deleteVectorsForFile(filePath: string): number {
        const prefix = `${filePath}::`;
        let deletedCount = 0;

        for (const chunkId of this.vectors.keys()) {
            if (chunkId.startsWith(prefix)) {
                this.vectors.delete(chunkId);
                deletedCount++;
            }
        }

        if (deletedCount > 0) {
            this.isDirty = true;
        }

        return deletedCount;
    }

    /**
     * Delete vectors by chunk IDs
     */
    deleteVectors(chunkIds: string[]): void {
        for (const id of chunkIds) {
            this.vectors.delete(id);
        }
        if (chunkIds.length > 0) {
            this.isDirty = true;
        }
    }

    /**
     * Get all stored chunk IDs for a file path
     */
    getChunkIdsForFile(filePath: string): string[] {
        const prefix = `${filePath}::`;
        const ids: string[] = [];

        for (const chunkId of this.vectors.keys()) {
            if (chunkId.startsWith(prefix)) {
                ids.push(chunkId);
            }
        }

        return ids;
    }

    /**
     * Get total count of stored vectors
     */
    getVectorCount(): number {
        return this.vectors.size;
    }

    /**
     * Clear all vectors and save immediately
     */
    async clearAll(): Promise<void> {
        this.vectors.clear();
        this.isDirty = true;
        await this.save();
        console.log("Vector store cleared and saved.");
    }

    /**
     * Get all vectors as an array (for similarity search)
     */
    getAllVectors(): Array<{ chunkId: string; vector: number[] }> {
        const result: Array<{ chunkId: string; vector: number[] }> = [];
        for (const [chunkId, stored] of this.vectors) {
            result.push({ chunkId, vector: stored.vector });
        }
        return result;
    }

    /**
     * Check if there are unsaved changes
     */
    hasUnsavedChanges(): boolean {
        return this.isDirty;
    }
}
