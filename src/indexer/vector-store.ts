import { Plugin } from "obsidian";

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
    private vectors: Map<string, StoredVector> = new Map();
    private isDirty: boolean = false;

    constructor(plugin: Plugin) {
        this.plugin = plugin;
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
     * Search for similar vectors using cosine similarity
     */
    search(queryVector: number[], limit: number = 5): SearchResult[] {
        const results: SearchResult[] = [];

        for (const [chunkId, stored] of this.vectors) {
            // Skip legacy vectors that don't have content metadata
            if (!stored.content || !stored.filePath) {
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
}
