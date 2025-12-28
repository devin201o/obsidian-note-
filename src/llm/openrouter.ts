import OpenAI from "openai";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const MODEL = "google/gemini-2.5-flash";

export interface LLMResponse {
    content: string;
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
