/**
 * Shared contracts for LLM providers. Every provider (OpenRouter, OpenAI,
 * Ollama, ...) implements these interfaces so the rest of the plugin never
 * needs to know which API it's actually talking to.
 */

export interface ChatMessage {
    role: "user" | "assistant" | "system";
    content: string;
}

export interface LLMResponse {
    content: string;
    error?: string;
}

export interface EmbeddingResponse {
    embeddings: number[][];
    error?: string;
}

/**
 * A configured chat backend. The model, API key/base URL are bound in at
 * construction time, so callers only ever pass the conversation.
 */
export interface ChatProvider {
    sendChatMessage(messages: ChatMessage[]): Promise<LLMResponse>;
}

/**
 * A configured embedding backend.
 */
export interface EmbeddingProvider {
    getEmbeddings(texts: string[]): Promise<EmbeddingResponse>;
}

/** Identifiers for the chat backends the plugin supports. */
export type ChatProviderId = "openrouter" | "openai" | "ollama";

/** Identifiers for the embedding backends the plugin supports. */
export type EmbeddingProviderId = "openrouter" | "openai" | "ollama";
