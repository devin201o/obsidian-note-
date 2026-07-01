import { OpenAICompatibleProvider } from "./openai-compatible";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export interface OpenRouterProviderConfig {
    apiKey: string;
    chatModel: string;
    embeddingModel: string;
}

export function createOpenRouterProvider(config: OpenRouterProviderConfig): OpenAICompatibleProvider {
    return new OpenAICompatibleProvider({
        baseUrl: OPENROUTER_BASE_URL,
        apiKey: config.apiKey,
        chatModel: config.chatModel,
        embeddingModel: config.embeddingModel,
    });
}
