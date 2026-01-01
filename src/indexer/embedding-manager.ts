import { Notice } from "obsidian";
import { Chunk, ChunkManager } from "./chunk-manager";
import { VectorStore, SearchOptions } from "./vector-store";
import { getEmbeddings } from "../llm/openrouter";

/**
 * Configuration for the embedding manager
 */
export interface EmbeddingManagerConfig {
    /** Batch size for embedding API calls */
    batchSize: number;
    /** Delay between batches in ms to avoid rate limiting */
    batchDelayMs: number;
}

const DEFAULT_CONFIG: EmbeddingManagerConfig = {
    batchSize: 20,
    batchDelayMs: 100
};

/**
 * Result of an embedding operation
 */
export interface EmbeddingResult {
    processed: number;
    skipped: number;
    failed: number;
    error?: string;
}

/**
 * EmbeddingManager coordinates the ChunkManager, VectorStore, and embedding API.
 * It efficiently manages embeddings by hashing content and reusing existing vectors.
 */
export class EmbeddingManager {
    private chunkManager: ChunkManager;
    private vectorStore: VectorStore;
    private config: EmbeddingManagerConfig;
    private apiKey: string = "";

    constructor(
        chunkManager: ChunkManager,
        vectorStore: VectorStore,
        config?: Partial<EmbeddingManagerConfig>
    ) {
        this.chunkManager = chunkManager;
        this.vectorStore = vectorStore;
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    /**
     * Set the API key for embedding requests
     */
    setApiKey(apiKey: string): void {
        this.apiKey = apiKey;
    }

    /**
     * Generate a simple hash of content for change detection
     * Uses a fast djb2 hash algorithm
     */
    private hashContent(content: string): string {
        let hash = 5381;
        for (let i = 0; i < content.length; i++) {
            hash = ((hash << 5) + hash) + content.charCodeAt(i);
            hash = hash & hash; // Convert to 32-bit integer
        }
        // Convert to hex string and ensure positive number
        return (hash >>> 0).toString(16);
    }

    /**
     * Process chunks and generate embeddings for those that need it
     */
    async embedChunks(chunks: Chunk[]): Promise<EmbeddingResult> {
        const result: EmbeddingResult = {
            processed: 0,
            skipped: 0,
            failed: 0
        };

        if (!this.apiKey) {
            return { ...result, error: "API key not set" };
        }

        if (chunks.length === 0) {
            return result;
        }

        // Separate chunks that need embedding from those that can be skipped
        const chunksToEmbed: Array<{ chunk: Chunk; hash: string }> = [];

        for (const chunk of chunks) {
            const hash = this.hashContent(chunk.content);
            
            if (this.vectorStore.hasValidVector(chunk.id, hash)) {
                result.skipped++;
            } else {
                chunksToEmbed.push({ chunk, hash });
            }
        }

        if (chunksToEmbed.length === 0) {
            return result;
        }

        // Process in batches
        for (let i = 0; i < chunksToEmbed.length; i += this.config.batchSize) {
            const batch = chunksToEmbed.slice(i, i + this.config.batchSize);
            const texts = batch.map(item => item.chunk.content);

            try {
                const response = await getEmbeddings(this.apiKey, texts);

                if (response.error) {
                    console.error(`Embedding batch error: ${response.error}`);
                    result.failed += batch.length;
                    continue;
                }

                // Save each embedding
                for (let j = 0; j < batch.length; j++) {
                    const embedding = response.embeddings[j];
                    const item = batch[j];
                    if (embedding && item) {
                        this.vectorStore.saveVector(
                            item.chunk.id, 
                            embedding, 
                            item.hash,
                            item.chunk.content,
                            item.chunk.filePath,
                            item.chunk.fileLink
                        );
                        result.processed++;
                    } else {
                        result.failed++;
                    }
                }
            } catch (error) {
                console.error("Embedding batch failed:", error);
                result.failed += batch.length;
            }

            // Delay between batches to avoid rate limiting
            if (i + this.config.batchSize < chunksToEmbed.length) {
                await this.delay(this.config.batchDelayMs);
            }
        }

        // Save after processing
        await this.vectorStore.save();

        return result;
    }

    /**
     * Process a single file: embed its chunks and clean up stale vectors
     */
    async embedFile(filePath: string): Promise<EmbeddingResult> {
        const chunks = this.chunkManager.getChunksForFile(filePath);
        
        // Get current chunk IDs
        const currentChunkIds = new Set(chunks.map(c => c.id));
        
        // Find and remove stale vectors (chunks that no longer exist)
        const storedIds = this.vectorStore.getChunkIdsForFile(filePath);
        const staleIds = storedIds.filter(id => !currentChunkIds.has(id));
        
        if (staleIds.length > 0) {
            this.vectorStore.deleteVectors(staleIds);
            console.log(`Removed ${staleIds.length} stale vectors for ${filePath}`);
        }

        // Embed the current chunks
        return this.embedChunks(chunks);
    }

    /**
     * Process all files in the vault
     */
    async embedAllFiles(): Promise<EmbeddingResult> {
        const allChunks = this.chunkManager.getAllChunks();
        
        // Get all current chunk IDs
        const currentChunkIds = new Set(allChunks.map(c => c.id));
        
        // Clean up vectors for chunks that no longer exist
        const allStoredVectors = this.vectorStore.getAllVectors();
        const staleIds = allStoredVectors
            .filter(v => !currentChunkIds.has(v.chunkId))
            .map(v => v.chunkId);
        
        if (staleIds.length > 0) {
            this.vectorStore.deleteVectors(staleIds);
            console.log(`Removed ${staleIds.length} stale vectors`);
        }

        // Embed all chunks
        const result = await this.embedChunks(allChunks);

        return result;
    }

    /**
     * Delete all vectors for a file
     */
    async deleteFileVectors(filePath: string): Promise<void> {
        const deletedCount = this.vectorStore.deleteVectorsForFile(filePath);
        if (deletedCount > 0) {
            await this.vectorStore.save();
            console.log(`Deleted ${deletedCount} vectors for ${filePath}`);
        }
    }

    /**
     * Rename vectors when a file is renamed
     */
    async renameFileVectors(oldPath: string, newPath: string): Promise<void> {
        const oldIds = this.vectorStore.getChunkIdsForFile(oldPath);
        
        if (oldIds.length === 0) {
            return;
        }

        // Calculate new file link from new path
        const newFileName = newPath.replace(/\.md$/, "").split("/").pop() ?? newPath;
        const newFileLink = `[[${newFileName}]]`;

        // For each old ID, create a new entry with the updated path
        for (const oldId of oldIds) {
            const stored = this.vectorStore.getVector(oldId);
            if (stored) {
                // Extract the chunk index from the old ID
                const index = oldId.substring(oldPath.length + 2); // +2 for "::"
                const newId = `${newPath}::${index}`;
                
                this.vectorStore.saveVector(
                    newId, 
                    stored.vector, 
                    stored.contentHash,
                    stored.content,
                    newPath,
                    newFileLink
                );
            }
        }

        // Delete old entries
        this.vectorStore.deleteVectors(oldIds);
        await this.vectorStore.save();
        
        console.log(`Renamed ${oldIds.length} vectors from ${oldPath} to ${newPath}`);
    }

    /**
     * Get embedding statistics
     */
    getStats(): { vectorCount: number; chunkCount: number } {
        return {
            vectorCount: this.vectorStore.getVectorCount(),
            chunkCount: this.chunkManager.getTotalChunkCount()
        };
    }

    /**
     * Simple delay helper
     */
    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Get embedding vector for a query text
     */
    async getQueryEmbedding(queryText: string): Promise<number[] | null> {
        if (!this.apiKey) {
            console.error("API key not set");
            return null;
        }

        const response = await getEmbeddings(this.apiKey, [queryText]);
        if (response.error || response.embeddings.length === 0) {
            console.error("Failed to get query embedding:", response.error);
            return null;
        }

        return response.embeddings[0] ?? null;
    }

    /**
     * Search for similar chunks using the VectorStore search
     * @param queryText The text to search for
     * @param limit Maximum number of results
     * @param options Optional filters for files, folders, or tags
     */
    async search(
        queryText: string,
        limit: number = 5,
        options?: SearchOptions
    ): Promise<Array<{ chunkId: string; content: string; filePath: string; fileLink: string; score: number }>> {
        const queryVector = await this.getQueryEmbedding(queryText);
        if (!queryVector) {
            return [];
        }

        return this.vectorStore.search(queryVector, limit, options);
    }

    /**
     * Find similar chunks using cosine similarity (returns full Chunk objects)
     */
    async findSimilar(
        queryText: string,
        topK: number = 5
    ): Promise<Array<{ chunk: Chunk; score: number }>> {
        const searchResults = await this.search(queryText, topK);
        
        // Map search results back to Chunk objects
        const results: Array<{ chunk: Chunk; score: number }> = [];
        for (const result of searchResults) {
            const chunks = this.chunkManager.getChunksForFile(result.filePath);
            const chunk = chunks.find(c => c.id === result.chunkId);
            if (chunk) {
                results.push({ chunk, score: result.score });
            }
        }

        return results;
    }
}
