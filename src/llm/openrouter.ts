import { requestUrl } from "obsidian";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_MODEL = "google/gemini-2.5-flash";
const EMBEDDING_MODEL = "openai/text-embedding-3-small";

export interface LLMResponse {
    content: string;
    error?: string;
}

export interface EmbeddingResponse {
    embeddings: number[][];
    error?: string;
}

/**
 * Extract a human-readable error message from an OpenRouter/OpenAI-style
 * error response body, falling back to the HTTP status text.
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

export async function sendChatMessage(
    apiKey: string,
    messages: { role: "user" | "assistant" | "system"; content: string }[],
    model?: string
): Promise<LLMResponse> {
    if (!apiKey) {
        return { content: "", error: "API key not set" };
    }

    const modelToUse = model?.trim() || DEFAULT_MODEL;

    try {
        const response = await requestUrl({
            url: `${OPENROUTER_BASE_URL}/chat/completions`,
            method: "POST",
            contentType: "application/json",
            headers: {
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model: modelToUse,
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

/**
 * Get embeddings for an array of texts using OpenRouter's embedding API
 */
export async function getEmbeddings(
    apiKey: string,
    texts: string[]
): Promise<EmbeddingResponse> {
    if (!apiKey) {
        return { embeddings: [], error: "API key not set" };
    }

    if (texts.length === 0) {
        return { embeddings: [] };
    }

    try {
        const response = await requestUrl({
            url: `${OPENROUTER_BASE_URL}/embeddings`,
            method: "POST",
            contentType: "application/json",
            headers: {
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model: EMBEDDING_MODEL,
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
