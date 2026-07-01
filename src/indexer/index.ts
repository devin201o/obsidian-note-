export { VaultIndexer } from "./vault-indexer";
export type { IndexedFile, IndexStats } from "./vault-indexer";

export { RecursiveCharacterTextSplitter, MarkdownTextSplitter, DocumentSplitter, buildEmbedText } from "./text-splitter";
export type { TextSplitterConfig, ChunkingStrategy, SplitChunk } from "./text-splitter";

export { ChunkManager } from "./chunk-manager";
export type { Chunk } from "./chunk-manager";

export { VectorStore } from "./vector-store";
export type { StoredVector, VectorStoreData, SearchResult, CachedChunk } from "./vector-store";

export { EmbeddingManager } from "./embedding-manager";
export type { EmbeddingManagerConfig, EmbeddingResult, HybridStrategy, HybridSearchResult } from "./embedding-manager";

export { LexicalIndex, tokenize } from "./lexical-index";
export type { LexicalDocument, LexicalHit } from "./lexical-index";
