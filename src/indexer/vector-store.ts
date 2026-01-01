import { Plugin } from "obsidian";

/**
 * Stored vector data for a chunk
 */
export interface StoredVector {
    /** The embedding vector */
    vector: number[];
    /** Hash of the content to detect changes */
    contentHash: string;
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
     * Save a vector for a chunk
     */
    saveVector(chunkId: string, vector: number[], contentHash: string): void {
        this.vectors.set(chunkId, { vector, contentHash });
        this.isDirty = true;
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
     * Clear all vectors
     */
    clearAll(): void {
        this.vectors.clear();
        this.isDirty = true;
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
