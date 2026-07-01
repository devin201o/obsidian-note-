import type { ChunkingStrategy } from "../indexer/text-splitter";
import type { HybridStrategy } from "../indexer/embedding-manager";
import type { ChatProviderId, EmbeddingProviderId } from "../llm/types";

export interface ChatMessage {
    content: string;
    sender: "user" | "bot";
    timestamp: string;
}

export interface MyPluginSettings {
    chatHistory: ChatMessage[];
    /** Which backend answers chat messages. */
    chatProvider: ChatProviderId;
    /** Which backend generates embeddings for search. Independent of chatProvider. */
    embeddingProvider: EmbeddingProviderId;
    openRouterApiKey: string;
    openRouterModel: string;
    openRouterEmbeddingModel: string;
    openAIApiKey: string;
    openAIModel: string;
    openAIEmbeddingModel: string;
    ollamaBaseUrl: string;
    ollamaModel: string;
    ollamaEmbeddingModel: string;
    indexMarkdownOnly: boolean;
    enableRedaction: boolean;
    customRedactionPatterns: string;
    retrievalPoolSize: number;
    maxContextChunks: number;
    excludedFolders: string[];
    autoIndexChanges: boolean;
    chunkingStrategy: ChunkingStrategy;
    chunkSize: number;
    chunkOverlap: number;
    hybridStrategy: HybridStrategy;
    vectorWeight: number;
    relevanceThreshold: number;
    contextTokenBudget: number;
    neighborExpansion: boolean;
    queryRewriting: boolean;
    useHyde: boolean;
    useReranker: boolean;
    rerankCandidates: number;
}

export const DEFAULT_SETTINGS: MyPluginSettings = {
    chatHistory: [],
    chatProvider: 'openrouter',
    embeddingProvider: 'openrouter',
    openRouterApiKey: '',
    openRouterModel: 'google/gemini-2.5-flash',
    openRouterEmbeddingModel: 'openai/text-embedding-3-small',
    openAIApiKey: '',
    openAIModel: 'gpt-4o-mini',
    openAIEmbeddingModel: 'text-embedding-3-small',
    ollamaBaseUrl: 'http://localhost:11434',
    ollamaModel: 'llama3.1',
    ollamaEmbeddingModel: 'nomic-embed-text',
    indexMarkdownOnly: true,
    enableRedaction: true,
    customRedactionPatterns: '',
    retrievalPoolSize: 50,
    maxContextChunks: 15,
    excludedFolders: [],
    autoIndexChanges: true,
    chunkingStrategy: 'markdown',
    chunkSize: 1000,
    chunkOverlap: 200,
    hybridStrategy: 'rrf',
    vectorWeight: 0.6,
    relevanceThreshold: 0.5,
    contextTokenBudget: 6000,
    neighborExpansion: true,
    queryRewriting: true,
    useHyde: false,
    useReranker: false,
    rerankCandidates: 20
}
