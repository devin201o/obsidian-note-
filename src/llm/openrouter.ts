import OpenAI from "openai";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const MODEL = "google/gemini-2.5-flash";
const EMBEDDING_MODEL = "openai/text-embedding-3-small";

export interface LLMResponse {
    content: string;
    error?: string;
}

export interface EmbeddingResponse {
    embeddings: number[][];
    error?: string;
}

export async function sendChatMessage(
    apiKey: string,
    messages: { role: "user" | "assistant" | "system"; content: string }[]
): Promise<LLMResponse> {
    if (!apiKey) {
        return { content: "", error: "API key not set" };
    }

    try {
        const client = new OpenAI({
            baseURL: OPENROUTER_BASE_URL,
            apiKey: apiKey,
            dangerouslyAllowBrowser: true, // Required for browser/Obsidian environment
        });

        const completion = await client.chat.completions.create({
            model: MODEL,
            messages: messages,
        });

        const responseContent = completion.choices[0]?.message?.content;
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
        const client = new OpenAI({
            baseURL: OPENROUTER_BASE_URL,
            apiKey: apiKey,
            dangerouslyAllowBrowser: true,
        });

        const response = await client.embeddings.create({
            model: EMBEDDING_MODEL,
            input: texts,
        });

        // Sort by index to ensure correct order
        const sortedData = response.data.sort((a, b) => a.index - b.index);
        const embeddings = sortedData.map(item => item.embedding);

        return { embeddings };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
        console.error("Embedding error:", errorMessage);
        return { embeddings: [], error: errorMessage };
    }
}

/**
 * Get embedding for a single text
 */
export async function getEmbedding(
    apiKey: string,
    text: string
): Promise<{ embedding: number[] | null; error?: string }> {
    const result = await getEmbeddings(apiKey, [text]);
    if (result.error) {
        return { embedding: null, error: result.error };
    }
    return { embedding: result.embeddings[0] ?? null };
}
