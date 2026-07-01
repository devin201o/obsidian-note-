import { requestUrl } from "obsidian";
import { ChatMessage, ChatProvider, EmbeddingProvider, EmbeddingResponse, LLMResponse } from "../types";

export interface OpenAICompatibleConfig {
    /** e.g. "https://openrouter.ai/api/v1" or "https://api.openai.com/v1" */
    baseUrl: string;
    apiKey: string;
    chatModel: string;
    embeddingModel: string;
}

/**
 * Extract a human-readable error message from an OpenAI-style error response
 * body, falling back to the HTTP status text.
 */
function extractErrorMessage(status: number, json: unknown): string {
    if (json && typeof json === "object" && "error" in json) {
        const err = (json as { error?: { message?: string } | string }).error;
        if (typeof err === "string") return err;
        if (err && typeof err === "object" && typeof err.message === "string") {
            return err.message;
        }
    }
    return `Request failed with status ${status}`;
}

/**
 * Chat + embedding provider for any API that mirrors OpenAI's request/response
 * shape (`/chat/completions`, `/embeddings`, Bearer auth). OpenRouter and
 * OpenAI itself both implement this shape, so they share this one class and
 * differ only by base URL.
 */
export class OpenAICompatibleProvider implements ChatProvider, EmbeddingProvider {
    constructor(private config: OpenAICompatibleConfig) {}

    async sendChatMessage(messages: ChatMessage[]): Promise<LLMResponse> {
        const { apiKey, baseUrl, chatModel } = this.config;
        if (!apiKey) {
            return { content: "", error: "API key not set" };
        }

        try {
            const response = await requestUrl({
                url: `${baseUrl}/chat/completions`,
                method: "POST",
                contentType: "application/json",
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                    model: chatModel,
                    messages,
                }),
                throw: false,
            });

            if (response.status >= 400) {
                return { content: "", error: extractErrorMessage(response.status, response.json) };
            }

            const responseContent = response.json?.choices?.[0]?.message?.content;
            if (!responseContent) {
                return { content: "", error: "No response from model" };
            }

            return { content: responseContent };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
            return { content: "", error: errorMessage };
        }
    }

    async getEmbeddings(texts: string[]): Promise<EmbeddingResponse> {
        const { apiKey, baseUrl, embeddingModel } = this.config;
        if (!apiKey) {
            return { embeddings: [], error: "API key not set" };
        }

        if (texts.length === 0) {
            return { embeddings: [] };
        }

        try {
            const response = await requestUrl({
                url: `${baseUrl}/embeddings`,
                method: "POST",
                contentType: "application/json",
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                    model: embeddingModel,
                    input: texts,
                }),
                throw: false,
            });

            if (response.status >= 400) {
                const errorMessage = extractErrorMessage(response.status, response.json);
                console.error("Embedding error:", errorMessage);
                return { embeddings: [], error: errorMessage };
            }

            const data: Array<{ index: number; embedding: number[] }> = response.json?.data ?? [];

            // Sort by index to ensure correct order
            const sortedData = [...data].sort((a, b) => a.index - b.index);
            const embeddings = sortedData.map(item => item.embedding);

            return { embeddings };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
            console.error("Embedding error:", errorMessage);
            return { embeddings: [], error: errorMessage };
        }
    }
}
