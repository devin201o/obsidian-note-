import type { ChatProvider } from "../llm/types";
import type { HybridSearchResult } from "../indexer/embedding-manager";

/** Max characters of each passage shown to the reranker, to bound token cost. */
const SNIPPET_CHARS = 600;

const RERANK_SYSTEM_PROMPT =
    "You are a search-result reranker. Given a query and a numbered list of " +
    "passages, decide which passages are most relevant to answering the query. " +
    "Respond with ONLY a JSON array of passage numbers ordered from most to least " +
    "relevant, e.g. [3,0,5]. Omit passages that are not relevant. Do not include " +
    "any text outside the array.";

/**
 * Parse a JSON-ish array of indices from the model's reply, tolerating stray
 * text around it.
 */
function parseIndexArray(text: string, count: number): number[] {
    const match = text.match(/\[[^\]]*\]/);
    if (!match) {
        return [];
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(match[0]);
    } catch {
        return [];
    }

    if (!Array.isArray(parsed)) {
        return [];
    }

    const seen = new Set<number>();
    const indices: number[] = [];
    for (const value of parsed) {
        const index = typeof value === "number" ? value : Number(value);
        if (Number.isInteger(index) && index >= 0 && index < count && !seen.has(index)) {
            seen.add(index);
            indices.push(index);
        }
    }
    return indices;
}

/**
 * Rerank fused search results with a single LLM relevance pass and return the
 * top N in the model's order. This is the "retrieve wide, rerank narrow"
 * pattern; it adds one LLM call, so it is opt-in. Falls back to the original
 * ranking (truncated to topN) on any error or unparseable response.
 */
export async function rerankResults(
    provider: ChatProvider,
    query: string,
    candidates: HybridSearchResult[],
    topN: number
): Promise<HybridSearchResult[]> {
    if (candidates.length <= 1) {
        return candidates.slice(0, topN);
    }

    const list = candidates
        .map((c, i) => `[${i}] ${c.content.slice(0, SNIPPET_CHARS).replace(/\s+/g, " ").trim()}`)
        .join("\n\n");

    const userPrompt = `Query: ${query}\n\nPassages:\n${list}`;

    try {
        const response = await provider.sendChatMessage([
            { role: "system", content: RERANK_SYSTEM_PROMPT },
            { role: "user", content: userPrompt }
        ]);

        if (response.error || !response.content) {
            return candidates.slice(0, topN);
        }

        const order = parseIndexArray(response.content, candidates.length);
        if (order.length === 0) {
            return candidates.slice(0, topN);
        }

        const reranked: HybridSearchResult[] = [];
        for (const index of order) {
            const candidate = candidates[index];
            if (candidate) {
                reranked.push(candidate);
            }
        }
        return reranked.slice(0, topN);
    } catch {
        return candidates.slice(0, topN);
    }
}
