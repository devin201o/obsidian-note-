import { requestUrl } from "obsidian";
import { ChatMessage, ChatProvider, EmbeddingProvider, EmbeddingResponse, LLMResponse } from "../types";

export interface OllamaProviderConfig {
    /** e.g. "http://localhost:11434" */
    baseUrl: string;
    chatModel: string;
    embeddingModel: string;
}

function normalizeBaseUrl(baseUrl: string): string {
    return baseUrl.trim().replace(/\/+$/, "");
}

/** Friendlier message for the common "Ollama isn't running" case. */
function describeConnectionError(baseUrl: string, error: unknown): string {
    const message = error instanceof Error ? error.message : "Unknown error occurred";
    if (/ECONNREFUSED|Failed to fetch|NetworkError/i.test(message)) {
        return `Could not reach Ollama at ${baseUrl}. Make sure Ollama is running locally.`;
    }
    return message;
}

/**
 * Chat + embedding provider for a local Ollama server. No API key is
 * required; only a reachable base URL. See https://docs.ollama.com/api.
 */
export class OllamaProvider implements ChatProvider, EmbeddingProvider {
    private baseUrl: string;

    constructor(private config: OllamaProviderConfig) {
        this.baseUrl = normalizeBaseUrl(config.baseUrl);
    }

    async sendChatMessage(messages: ChatMessage[]): Promise<LLMResponse> {
        try {
            const response = await requestUrl({
                url: `${this.baseUrl}/api/chat`,
                method: "POST",
                contentType: "application/json",
                body: JSON.stringify({
                    model: this.config.chatModel,
                    messages,
                    stream: false,
                }),
                throw: false,
            });

            if (response.status >= 400) {
                return { content: "", error: response.json?.error ?? `Request failed with status ${response.status}` };
            }

            const content = response.json?.message?.content;
            if (!content) {
                return { content: "", error: "No response from model" };
            }

            return { content };
        } catch (error) {
            return { content: "", error: describeConnectionError(this.baseUrl, error) };
        }
    }

    async getEmbeddings(texts: string[]): Promise<EmbeddingResponse> {
        if (texts.length === 0) {
            return { embeddings: [] };
        }

        try {
            const response = await requestUrl({
                url: `${this.baseUrl}/api/embed`,
                method: "POST",
                contentType: "application/json",
                body: JSON.stringify({
                    model: this.config.embeddingModel,
                    input: texts,
                }),
                throw: false,
            });

            if (response.status >= 400) {
                const errorMessage = response.json?.error ?? `Request failed with status ${response.status}`;
                console.error("Embedding error:", errorMessage);
                return { embeddings: [], error: errorMessage };
            }

            const embeddings: number[][] = response.json?.embeddings ?? [];
            return { embeddings };
        } catch (error) {
            const errorMessage = describeConnectionError(this.baseUrl, error);
            console.error("Embedding error:", errorMessage);
            return { embeddings: [], error: errorMessage };
        }
    }
}
