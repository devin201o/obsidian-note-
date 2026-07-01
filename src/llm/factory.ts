import type { MyPluginSettings } from "../settings";
import { ChatProvider, ChatProviderId, EmbeddingProvider, EmbeddingProviderId } from "./types";
import { createOpenRouterProvider } from "./providers/openrouter";
import { createOpenAIProvider } from "./providers/openai";
import { OllamaProvider } from "./providers/ollama";

/** Display labels for provider dropdowns in the settings UI. */
export const CHAT_PROVIDER_LABELS: Record<ChatProviderId, string> = {
    openrouter: "OpenRouter",
    openai: "OpenAI",
    ollama: "Ollama (local)",
};

export const EMBEDDING_PROVIDER_LABELS: Record<EmbeddingProviderId, string> = {
    openrouter: "OpenRouter",
    openai: "OpenAI",
    ollama: "Ollama (local)",
};

/**
 * Build the chat backend for the currently selected chat provider, using
 * that provider's own saved key/model from settings.
 */
export function createChatProvider(settings: MyPluginSettings): ChatProvider {
    switch (settings.chatProvider) {
        case "openai":
            return createOpenAIProvider({
                apiKey: settings.openAIApiKey,
                chatModel: settings.openAIModel,
                embeddingModel: settings.openAIEmbeddingModel,
            });
        case "ollama":
            return new OllamaProvider({
                baseUrl: settings.ollamaBaseUrl,
                chatModel: settings.ollamaModel,
                embeddingModel: settings.ollamaEmbeddingModel,
            });
        case "openrouter":
        default:
            return createOpenRouterProvider({
                apiKey: settings.openRouterApiKey,
                chatModel: settings.openRouterModel,
                embeddingModel: settings.openRouterEmbeddingModel,
            });
    }
}

/**
 * Build the embedding backend for the currently selected embedding provider,
 * independent of whichever provider is used for chat.
 */
export function createEmbeddingProvider(settings: MyPluginSettings): EmbeddingProvider {
    switch (settings.embeddingProvider) {
        case "openai":
            return createOpenAIProvider({
                apiKey: settings.openAIApiKey,
                chatModel: settings.openAIModel,
                embeddingModel: settings.openAIEmbeddingModel,
            });
        case "ollama":
            return new OllamaProvider({
                baseUrl: settings.ollamaBaseUrl,
                chatModel: settings.ollamaModel,
                embeddingModel: settings.ollamaEmbeddingModel,
            });
        case "openrouter":
        default:
            return createOpenRouterProvider({
                apiKey: settings.openRouterApiKey,
                chatModel: settings.openRouterModel,
                embeddingModel: settings.openRouterEmbeddingModel,
            });
    }
}

/**
 * Whether the selected chat provider has enough configuration to attempt a
 * request. OpenRouter/OpenAI need a non-empty API key; Ollama just needs a
 * base URL (it's a local server, not a hosted API).
 */
export function isChatProviderConfigured(settings: MyPluginSettings): boolean {
    switch (settings.chatProvider) {
        case "openai":
            return settings.openAIApiKey.trim().length > 0;
        case "ollama":
            return settings.ollamaBaseUrl.trim().length > 0;
        case "openrouter":
        default:
            return settings.openRouterApiKey.trim().length > 0;
    }
}

/** Same as {@link isChatProviderConfigured}, for the embedding provider. */
export function isEmbeddingProviderConfigured(settings: MyPluginSettings): boolean {
    switch (settings.embeddingProvider) {
        case "openai":
            return settings.openAIApiKey.trim().length > 0;
        case "ollama":
            return settings.ollamaBaseUrl.trim().length > 0;
        case "openrouter":
        default:
            return settings.openRouterApiKey.trim().length > 0;
    }
}
