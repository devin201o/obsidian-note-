import { EmbeddingManager } from "../indexer/embedding-manager";
import { sendChatMessage } from "../llm/openrouter";

/**
 * RAGEngine connects the embedding search with the LLM to provide
 * context-aware answers based on the user's vault content.
 */
export class RAGEngine {
    private embeddingManager: EmbeddingManager;
    private apiKey: string = "";
    private model: string = "google/gemini-2.5-flash";

    constructor(embeddingManager: EmbeddingManager) {
        this.embeddingManager = embeddingManager;
    }

    /**
     * Set the API key for LLM requests
     */
    setApiKey(apiKey: string): void {
        this.apiKey = apiKey;
    }

    /**
     * Set the model to use for chat
     */
    setModel(model: string): void {
        this.model = model;
    }

    /**
     * Ask a question and get a RAG-augmented response
     * @param userQuery The user's question
     * @param conversationHistory Previous messages for context
     * @returns The LLM's response
     */
    async ask(
        userQuery: string,
        conversationHistory: Array<{ role: "user" | "assistant"; content: string }> = []
    ): Promise<string> {
        if (!this.apiKey) {
            return "Error: API key not set. Please configure it in Settings → obsidian note+.";
        }

        // Step 1: Retrieve relevant chunks
        const searchResults = await this.embeddingManager.search(userQuery, 5);

        // Step 2: Build the system prompt with context
        const systemPrompt = this.buildSystemPrompt(searchResults);

        // Step 3: Build messages array
        const messages: Array<{ role: "user" | "assistant" | "system"; content: string }> = [
            { role: "system", content: systemPrompt }
        ];

        // Include conversation history for context continuity
        for (const msg of conversationHistory) {
            messages.push(msg);
        }

        // Add the current query
        messages.push({ role: "user", content: userQuery });

        // Step 4: Send to LLM with configured model
        const response = await sendChatMessage(this.apiKey, messages, this.model);

        if (response.error) {
            return `Error: ${response.error}`;
        }

        return response.content;
    }

    /**
     * Build the system prompt with retrieved context
     */
    private buildSystemPrompt(
        searchResults: Array<{ chunkId: string; content: string; filePath: string; fileLink: string; score: number }>
    ): string {
        const basePrompt = `You are an Obsidian assistant. Answer the user's question based on the context provided from their notes.

CRITICAL INSTRUCTIONS:
1. You MUST cite your sources using the exact WikiLink format provided (e.g., [[Note Name]]).
2. Do NOT use Markdown links like [Title](path).
3. When referencing information, always mention where it came from using the WikiLink.
4. If the context doesn't contain relevant information, say so honestly.
5. Be concise but thorough in your answers.`;

        if (searchResults.length === 0) {
            return `${basePrompt}

Note: No relevant context was found in the vault for this query. Answer based on your general knowledge, but inform the user that no specific notes were found.`;
        }

        // Build context section with sources
        let contextSection = "\n\n--- CONTEXT FROM YOUR NOTES ---\n";
        
        for (const result of searchResults) {
            contextSection += `\nSource: ${result.fileLink} (relevance: ${(result.score * 100).toFixed(1)}%)\n`;
            contextSection += `${result.content}\n`;
            contextSection += "---\n";
        }

        return basePrompt + contextSection;
    }

    /**
     * Search for relevant context without generating a response
     * Useful for debugging or showing sources separately
     */
    async getContext(
        query: string,
        limit: number = 5
    ): Promise<Array<{ content: string; fileLink: string; score: number }>> {
        const results = await this.embeddingManager.search(query, limit);
        return results.map(r => ({
            content: r.content,
            fileLink: r.fileLink,
            score: r.score
        }));
    }
}
