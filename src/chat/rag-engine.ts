import { EmbeddingManager, HybridSearchResult } from "../indexer/embedding-manager";
import { SearchOptions } from "../indexer/vector-store";
import type { ChatProvider } from "../llm/types";
import { rewriteQuery, generateHydeDocument } from "./query-transformer";
import { rerankResults } from "./reranker";
import type { MyPluginSettings } from "../settings";

/**
 * Settings getter function type
 */
type SettingsGetter = () => MyPluginSettings;

/**
 * A block of context assembled for the prompt: one primary chunk plus any
 * neighbor chunks merged into a single passage.
 */
interface ContextItem {
    fileLink: string;
    content: string;
}

/**
 * A file the user has explicitly attached. Unlike retrieved context, its
 * full content is guaranteed to reach the model.
 */
export interface AttachedFile {
    /** Vault path, used to exclude this file from retrieval so it isn't duplicated. */
    path: string;
    /** Display name shown in the UI and cited to the model. */
    displayName: string;
    /** Full file content at the time it was attached. */
    content: string;
    /** Rough token estimate, used by the UI to warn about large attachments. */
    tokenCount: number;
}

/** Rough token estimate (~4 chars/token) used for context budgeting. */
export function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

/**
 * RAGEngine connects the embedding search with the LLM to provide
 * context-aware answers based on the user's vault content.
 */
export class RAGEngine {
    private embeddingManager: EmbeddingManager;
    private chatProvider: ChatProvider | null = null;
    private getSettings: SettingsGetter | null = null;

    constructor(embeddingManager: EmbeddingManager) {
        this.embeddingManager = embeddingManager;
    }

    /**
     * Set the backend used to answer chat messages. Swapped out whenever the
     * user changes the chat provider in settings.
     */
    setChatProvider(provider: ChatProvider): void {
        this.chatProvider = provider;
    }

    /**
     * Set settings getter for dynamic access to plugin settings
     */
    setSettingsGetter(getter: SettingsGetter): void {
        this.getSettings = getter;
    }

    /**
     * Ask a question and get a RAG-augmented response
     * @param userQuery The user's question
     * @param conversationHistory Previous messages for context
     * @param attachedFiles Files the user explicitly attached; their full content is
     *   injected into the prompt and they are excluded from vault-wide retrieval
     * @returns The LLM's response
     */
    async ask(
        userQuery: string,
        conversationHistory: Array<{ role: "user" | "assistant"; content: string }> = [],
        attachedFiles: AttachedFile[] = []
    ): Promise<string> {
        if (!this.chatProvider) {
            return "Error: AI provider not configured. Please configure it in Settings → obsidian note+.";
        }

        // Get retrieval settings (use defaults if getter not set)
        const settings = this.getSettings?.();
        const poolSize = settings?.retrievalPoolSize ?? 50;
        const maxChunks = settings?.maxContextChunks ?? 15;
        const relevanceThreshold = settings?.relevanceThreshold ?? 0.5;
        const tokenBudget = settings?.contextTokenBudget ?? 6000;
        const neighborRadius = settings?.neighborExpansion === false ? 0 : 1;
        const queryRewriting = settings?.queryRewriting !== false;
        const useHyde = settings?.useHyde === true;
        const useReranker = settings?.useReranker === true;
        const rerankCandidates = settings?.rerankCandidates ?? 20;

        // Step 0: Rewrite follow-up questions into a standalone retrieval query
        // using the conversation, so references like "the other one" resolve.
        let retrievalQuery = userQuery;
        if (queryRewriting && conversationHistory.length > 0) {
            retrievalQuery = await rewriteQuery(this.chatProvider, conversationHistory, userQuery);
        }

        // Optional HyDE: embed a hypothetical answer passage for dense retrieval
        // while keeping the literal keywords for BM25.
        let vectorQuery = retrievalQuery;
        if (useHyde) {
            const hyde = await generateHydeDocument(this.chatProvider, retrievalQuery);
            if (hyde.length > 0) {
                vectorQuery = hyde;
            }
        }

        // Step 1: Retrieve relevant chunks with hybrid search (vector + BM25 fusion).
        // When reranking, retrieve a wider candidate pool to rerank down from.
        // Attached files are excluded here since their full content is already
        // guaranteed to be in the prompt; retrieving them again would waste the
        // context budget on duplicate content.
        const searchLimit = useReranker ? Math.max(maxChunks, rerankCandidates) : maxChunks;
        const searchOptions: SearchOptions | undefined = attachedFiles.length > 0
            ? { excludeFiles: attachedFiles.map(f => f.path) }
            : undefined;
        const searchResults = await this.embeddingManager.search(
            vectorQuery, 
            searchLimit, 
            poolSize, 
            searchOptions,
            retrievalQuery
        );

        // Step 2: Narrow the candidates. Either an LLM reranker (retrieve wide,
        // rerank narrow) or a relevance floor relative to the top match.
        let narrowed: HybridSearchResult[];
        if (useReranker) {
            narrowed = await rerankResults(this.chatProvider, retrievalQuery, searchResults, maxChunks);
        } else {
            narrowed = this.applyRelevanceFloor(searchResults, relevanceThreshold);
        }

        // Step 3: Pack the survivors into a token budget, expanding each with its
        // neighbors for fuller context.
        const contextItems = this.packContext(narrowed, tokenBudget, neighborRadius);

        // Step 4: Build the system prompt with context
        const systemPrompt = this.buildSystemPrompt(contextItems, attachedFiles);

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

        // Step 4: Send to the configured chat provider
        const response = await this.chatProvider.sendChatMessage(messages);

        if (response.error) {
            return `Error: ${response.error}`;
        }

        return response.content;
    }

    /**
     * Keep only results whose score is within `threshold` of the top result's
     * score (relative floor), so vague queries don't pad the context with weak
     * matches. The single best result is always kept.
     */
    private applyRelevanceFloor(results: HybridSearchResult[], threshold: number): HybridSearchResult[] {
        if (results.length === 0) {
            return results;
        }
        const top = results[0];
        if (!top || top.score <= 0 || threshold <= 0) {
            return results;
        }
        const cutoff = top.score * threshold;
        const kept = results.filter(r => r.score >= cutoff);
        return kept.length > 0 ? kept : [top];
    }

    /**
     * Assemble context blocks up to a token budget. Each primary result is
     * expanded with adjacent chunks from the same file (neighbor expansion),
     * deduplicating chunks already included by an earlier block.
     */
    private packContext(
        results: HybridSearchResult[],
        tokenBudget: number,
        neighborRadius: number
    ): ContextItem[] {
        const includedIds = new Set<string>();
        const items: ContextItem[] = [];
        let usedTokens = 0;

        for (const result of results) {
            if (includedIds.has(result.chunkId)) {
                continue;
            }

            const group = this.expandNeighbors(result.chunkId, neighborRadius, includedIds);
            if (group.length === 0) {
                continue;
            }

            let content = group.map(g => g.content).join("\n\n");
            let itemTokens = estimateTokens(content);

            // Truncate any single passage that alone exceeds the budget, so one
            // oversized group (e.g. a large chunk plus neighbors) can't silently
            // blow past the configured limit while still guaranteeing at least
            // one non-empty result gets through.
            if (tokenBudget > 0 && itemTokens > tokenBudget) {
                const maxChars = tokenBudget * 4;
                content = content.slice(0, maxChars).trimEnd();
                itemTokens = estimateTokens(content);
            }

            if (tokenBudget > 0 && usedTokens + itemTokens > tokenBudget) {
                break;
            }

            for (const g of group) {
                includedIds.add(g.chunkId);
            }
            items.push({ fileLink: result.fileLink, content });
            usedTokens += itemTokens;
        }

        return items;
    }

    /**
     * Gather a chunk together with its neighbors (chunkIndex +/- radius) from the
     * same file, ordered by position, skipping chunks already included.
     */
    private expandNeighbors(
        centerId: string,
        radius: number,
        includedIds: Set<string>
    ): HybridSearchResult[] {
        const sep = centerId.lastIndexOf("::");
        if (sep === -1) {
            const center = this.embeddingManager.getChunk(centerId);
            return center ? [center] : [];
        }

        const filePath = centerId.slice(0, sep);
        const centerIndex = Number(centerId.slice(sep + 2));
        if (Number.isNaN(centerIndex)) {
            const center = this.embeddingManager.getChunk(centerId);
            return center ? [center] : [];
        }

        const group: HybridSearchResult[] = [];
        for (let index = centerIndex - radius; index <= centerIndex + radius; index++) {
            if (index < 0) continue;
            const id = `${filePath}::${index}`;
            if (includedIds.has(id)) continue;
            const chunk = this.embeddingManager.getChunk(id);
            if (chunk) {
                group.push(chunk);
            }
        }
        return group;
    }

    /**
     * Build the system prompt with attached files and retrieved context
     */
    private buildSystemPrompt(
        contextItems: ContextItem[],
        attachedFiles: AttachedFile[]
    ): string {
        let basePrompt = `You are an Obsidian assistant. Answer the user's question using the context provided from their notes, which is given as a numbered list of sources.

CRITICAL INSTRUCTIONS:
1. Base your answer on the provided context. Do NOT fabricate facts, quotes, or sources.
2. Cite the sources you use inline with the exact WikiLink format shown (e.g., [[Note Name]]). Do NOT use Markdown links like [Title](path).
3. If the context does not contain enough information to answer, say so clearly. Only add general knowledge if it is genuinely helpful, and make explicit that it does not come from their notes.
4. Prefer information from higher-listed sources when sources conflict, but use your judgment.
5. Be concise but thorough.`;

        // Attached files: full content, guaranteed to be included (unlike
        // retrieved context, which is filtered/thresholded).
        let attachedSection = "";
        if (attachedFiles.length > 0) {
            basePrompt += `\n\nIMPORTANT: The user has attached ${attachedFiles.length} file(s) in full below. Treat their content as authoritative and prioritize it when it's relevant to the question.`;

            attachedSection = "\n\n--- ATTACHED FILES (full content, provided by the user) ---\n";
            attachedFiles.forEach((file, index) => {
                attachedSection += `\n[Attached ${index + 1}] ${file.displayName}\n${file.content}\n---\n`;
            });
        }

        if (contextItems.length === 0) {
            const note = attachedFiles.length > 0
                ? "Note: No additional related context was found elsewhere in the vault. Answer using the attached file(s) above."
                : "Note: No relevant context was found in the vault for this query. Answer based on your general knowledge, but inform the user that no specific notes were found.";
            return `${basePrompt}${attachedSection}\n\n${note}`;
        }

        // Build context section with numbered sources for easier inline citation.
        let contextSection = "\n\n--- CONTEXT FROM YOUR NOTES ---\n";
        
        contextItems.forEach((item, index) => {
            contextSection += `\n[${index + 1}] Source: ${item.fileLink}\n`;
            contextSection += `${item.content}\n`;
            contextSection += "---\n";
        });

        return basePrompt + attachedSection + contextSection;
    }
}
