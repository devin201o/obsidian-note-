import { OpenAICompatibleProvider } from "./openai-compatible";

const OPENAI_BASE_URL = "https://api.openai.com/v1";

export interface OpenAIProviderConfig {
    apiKey: string;
    chatModel: string;
    embeddingModel: string;
}

export function createOpenAIProvider(config: OpenAIProviderConfig): OpenAICompatibleProvider {
    return new OpenAICompatibleProvider({
        baseUrl: OPENAI_BASE_URL,
        apiKey: config.apiKey,
        chatModel: config.chatModel,
        embeddingModel: config.embeddingModel,
    });
}
