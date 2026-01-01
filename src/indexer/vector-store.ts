import { App, Plugin } from "obsidian";

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
 * Stored vector data for a chunk
 */
export interface StoredVector {
    /** The embedding vector */
    vector: number[];
    /** Hash of the content to detect changes */
    contentHash: string;
    /** The actual text content of the chunk */
    content: string;
    /** The file path this chunk belongs to */
    filePath: string;
    /** WikiLink format for LLM reference */
    fileLink: string;
}

/**
 * Search result from vector similarity search
 */
export interface SearchResult {
    /** The chunk ID */
    chunkId: string;
    /** The text content of the chunk */
    content: string;
    /** The file path */
    filePath: string;
    /** WikiLink format */
    fileLink: string;
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

const VECTOR_STORE_VERSION = 1;
const VECTOR_STORE_FILE = "embeddings.json";

/**
 * VectorStore manages persistent storage of embedding vectors.
 * Uses Obsidian's plugin data API for persistence.
 */
export class VectorStore {
    private plugin: Plugin;
    private app: App;
    private vectors: Map<string, StoredVector> = new Map();
    private isDirty: boolean = false;
    /** Folders to exclude from search results */
    private excludedFolders: string[] = [];

    constructor(plugin: Plugin) {
        this.plugin = plugin;
        this.app = plugin.app;
    }

    /**
     * Set the list of excluded folders
     */
    setExcludedFolders(folders: string[]): void {
        this.excludedFolders = folders;
    }

    /**
     * Check if a file path is in an excluded folder
     */
    private isExcluded(filePath: string): boolean {
        if (!this.excludedFolders || this.excludedFolders.length === 0) {
            return false;
        }

        for (const folder of this.excludedFolders) {
            if (!folder) continue;
            const normalizedFolder = folder.endsWith("/") ? folder : folder + "/";
            if (filePath.startsWith(normalizedFolder) || filePath.startsWith(folder + "/")) {
                return true;
            }
        }
        return false;
    }

    /**
     * Load vector data from disk
     */
    async load(): Promise<void> {
        try {
            const data = await this.plugin.loadData();
            if (data?.vectorStore) {
                const storeData = data.vectorStore as VectorStoreData;
                if (storeData.version === VECTOR_STORE_VERSION && storeData.vectors) {
                    this.vectors = new Map(Object.entries(storeData.vectors));
                    console.log(`Loaded ${this.vectors.size} vectors from storage`);
                }
            }
        } catch (error) {
            console.error("Failed to load vector store:", error);
            this.vectors = new Map();
        }
    }

    /**
     * Save vector data to disk
     */
    async save(): Promise<void> {
        if (!this.isDirty) {
            return;
        }

        try {
            // Load existing plugin data to preserve other settings
            const existingData = await this.plugin.loadData() ?? {};
            
            const storeData: VectorStoreData = {
                version: VECTOR_STORE_VERSION,
                vectors: Object.fromEntries(this.vectors)
            };

            await this.plugin.saveData({
                ...existingData,
                vectorStore: storeData
            });

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
     * Save a vector for a chunk with its content
     */
    saveVector(
        chunkId: string, 
        vector: number[], 
        contentHash: string,
        content: string,
        filePath: string,
        fileLink: string
    ): void {
        this.vectors.set(chunkId, { vector, contentHash, content, filePath, fileLink });
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
            // Skip legacy vectors that don't have content metadata
            if (!stored.content || !stored.filePath) {
                continue;
            }

            // Skip vectors from excluded folders
            if (this.isExcluded(stored.filePath)) {
                continue;
            }

            // Apply search filters
            if (!this.matchesFilter(stored.filePath, options)) {
                continue;
            }
            
            const score = this.cosineSimilarity(queryVector, stored.vector);
            results.push({
                chunkId,
                content: stored.content,
                filePath: stored.filePath,
                fileLink: stored.fileLink ?? "",
                score
            });
        }

        // Sort by score descending and return top results
        results.sort((a, b) => b.score - a.score);
        return results.slice(0, limit);
    }

    /**
     * Check if vectors need migration (legacy format without content)
     */
    hasLegacyVectors(): boolean {
        for (const stored of this.vectors.values()) {
            if (!stored.content || !stored.filePath) {
                return true;
            }
        }
        return false;
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

    /**
     * Purge all vectors for files in excluded folders
     * @returns The number of vectors deleted
     */
    purgeExcludedVectors(): number {
        if (!this.excludedFolders || this.excludedFolders.length === 0) {
            return 0;
        }

        let deletedCount = 0;
        const toDelete: string[] = [];

        for (const [chunkId, stored] of this.vectors) {
            if (stored.filePath && this.isExcluded(stored.filePath)) {
                toDelete.push(chunkId);
            }
        }

        for (const chunkId of toDelete) {
            this.vectors.delete(chunkId);
            deletedCount++;
        }

        if (deletedCount > 0) {
            this.isDirty = true;
        }

        return deletedCount;
    }
}
