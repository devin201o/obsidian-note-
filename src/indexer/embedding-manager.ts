import { Notice } from "obsidian";
import { Chunk, ChunkManager } from "./chunk-manager";
import { VectorStore, SearchOptions } from "./vector-store";
import { LexicalIndex } from "./lexical-index";
import { getEmbeddings } from "../llm/openrouter";

/**
 * How vector and lexical (BM25) rankings are combined.
 * - "rrf": Reciprocal Rank Fusion (robust, scale-free; default)
 * - "weighted": normalized weighted sum controlled by vectorWeight
 */
export type HybridStrategy = "rrf" | "weighted";

/** A fused search result returned to callers. */
export interface HybridSearchResult {
    chunkId: string;
    content: string;
    filePath: string;
    fileLink: string;
    score: number;
}

/** Constant used by Reciprocal Rank Fusion; larger = flatter rank weighting. */
const RRF_K = 60;

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
    private lexicalIndex: LexicalIndex = new LexicalIndex();
    private hybridStrategy: HybridStrategy = "rrf";
    /** Weight of the vector component in "weighted" mode (0..1). */
    private vectorWeight: number = 0.6;

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
     * Configure how vector and lexical rankings are fused.
     */
    setHybridConfig(strategy: HybridStrategy, vectorWeight: number): void {
        this.hybridStrategy = strategy;
        this.vectorWeight = Math.max(0, Math.min(1, vectorWeight));
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
        let i = 0;

        for (const chunk of chunks) {
            // Yield every 500 chunks to prevent UI freezing
            if (i++ % 500 === 0) {
                await this.delay(5);
            }

            // Hash the embedded text (title + breadcrumb + content) so that a
            // change to the heading context also triggers a re-embed.
            const hash = this.hashContent(chunk.embedText);
            
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
            // Yield to the main thread to keep UI responsive
            await this.delay(10);
            
            const batch = chunksToEmbed.slice(i, i + this.config.batchSize);
            const texts = batch.map(item => item.chunk.embedText);

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
                            item.chunk.fileLink,
                            item.chunk.heading
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
        this.vectorStore.deleteStoredMtime(filePath);
        if (deletedCount > 0) {
            await this.vectorStore.save();
            console.log(`Deleted ${deletedCount} vectors for ${filePath}`);
        }
    }

    /**
     * Rename vectors when a file is renamed
     */
    async renameFileVectors(oldPath: string, newPath: string): Promise<void> {
        // Carry over the stored mtime so the renamed file isn't treated as "changed"
        const storedMtime = this.vectorStore.getStoredMtime(oldPath);
        if (storedMtime !== undefined) {
            this.vectorStore.deleteStoredMtime(oldPath);
            this.vectorStore.setStoredMtime(newPath, storedMtime);
        }

        const oldIds = this.vectorStore.getChunkIdsForFile(oldPath);
        
        if (oldIds.length === 0) {
            if (storedMtime !== undefined) {
                await this.vectorStore.save();
            }
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
                    newFileLink,
                    stored.heading ?? ""
                );
            }
        }

        // Delete old entries
        this.vectorStore.deleteVectors(oldIds);
        await this.vectorStore.save();
        
        console.log(`Renamed ${oldIds.length} vectors from ${oldPath} to ${newPath}`);
    }

    /**
     * Simple delay helper
     */
    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Rebuild the BM25 lexical index if the vector store changed since it was
     * last built. The index is a derived, in-memory structure.
     */
    private ensureLexicalIndex(): void {
        const version = this.vectorStore.getMutationVersion();
        if (this.lexicalIndex.getBuiltVersion() !== version) {
            this.lexicalIndex.build(this.vectorStore.getLexicalDocuments(), version);
        }
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
     * Search for similar chunks using hybrid search: dense vector similarity
     * fused with BM25 lexical ranking. Lexical retrieval can surface exact-term
     * matches (names, IDs, jargon) that pure embeddings miss, and vice versa.
     *
     * @param queryText The text to search for
     * @param limit Maximum number of results to return after fusion
     * @param poolSize Number of candidates to fetch from each retriever before fusing
     * @param options Optional filters for files, folders, or tags
     */
    async search(
        queryText: string,
        limit: number = 15,
        poolSize: number = 50,
        options?: SearchOptions
    ): Promise<HybridSearchResult[]> {
        const queryVector = await this.getQueryEmbedding(queryText);
        if (!queryVector) {
            return [];
        }

        // Dense retrieval: already filtered for excluded folders + search options.
        const vectorCandidates = this.vectorStore.search(queryVector, poolSize, options);

        // Sparse retrieval: BM25 over the same filtered document set.
        this.ensureLexicalIndex();
        const allow = (filePath: string) => this.vectorStore.passesFilter(filePath, options);
        const lexicalHits = this.lexicalIndex.search(queryText, poolSize, allow);

        if (vectorCandidates.length === 0 && lexicalHits.length === 0) {
            return [];
        }

        // Build a lookup so we can resolve content/links for lexical-only hits.
        const meta = new Map<string, { content: string; filePath: string; fileLink: string }>();
        for (const c of vectorCandidates) {
            meta.set(c.chunkId, { content: c.content, filePath: c.filePath, fileLink: c.fileLink });
        }
        const resolveMeta = (id: string) => {
            const existing = meta.get(id);
            if (existing) return existing;
            const stored = this.vectorStore.getVector(id);
            if (!stored || !stored.content) return null;
            const resolved = { content: stored.content, filePath: stored.filePath, fileLink: stored.fileLink ?? "" };
            meta.set(id, resolved);
            return resolved;
        };

        const fusedScores = this.hybridStrategy === "weighted"
            ? this.fuseWeighted(vectorCandidates, lexicalHits)
            : this.fuseRRF(vectorCandidates, lexicalHits);

        const results: HybridSearchResult[] = [];
        for (const [id, score] of fusedScores) {
            const m = resolveMeta(id);
            if (!m) continue;
            results.push({ chunkId: id, content: m.content, filePath: m.filePath, fileLink: m.fileLink, score });
        }

        results.sort((a, b) => b.score - a.score);
        return results.slice(0, limit);
    }

    /**
     * Reciprocal Rank Fusion: combine rankings by summing 1/(k + rank). This is
     * scale-free, so it sidesteps the problem of mixing bounded cosine scores
     * with unbounded BM25 scores.
     */
    private fuseRRF(
        vectorCandidates: Array<{ chunkId: string }>,
        lexicalHits: Array<{ id: string }>
    ): Map<string, number> {
        const scores = new Map<string, number>();
        const add = (id: string, rank: number) => {
            scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + rank + 1));
        };
        vectorCandidates.forEach((c, rank) => add(c.chunkId, rank));
        lexicalHits.forEach((h, rank) => add(h.id, rank));
        return scores;
    }

    /**
     * Weighted-sum fusion. Cosine scores are already ~0..1; BM25 scores are
     * min-max normalized over the candidate set before combining.
     */
    private fuseWeighted(
        vectorCandidates: Array<{ chunkId: string; score: number }>,
        lexicalHits: Array<{ id: string; score: number }>
    ): Map<string, number> {
        const scores = new Map<string, number>();

        let maxLex = 0;
        for (const h of lexicalHits) {
            if (h.score > maxLex) maxLex = h.score;
        }

        const wVec = this.vectorWeight;
        const wLex = 1 - this.vectorWeight;

        for (const c of vectorCandidates) {
            const vecNorm = Math.max(0, Math.min(1, c.score));
            scores.set(c.chunkId, (scores.get(c.chunkId) ?? 0) + wVec * vecNorm);
        }
        for (const h of lexicalHits) {
            const lexNorm = maxLex > 0 ? h.score / maxLex : 0;
            scores.set(h.id, (scores.get(h.id) ?? 0) + wLex * lexNorm);
        }

        return scores;
    }
}
