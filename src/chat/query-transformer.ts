import { sendChatMessage } from "../llm/openrouter";

/**
 * A conversation turn used as context for query transformation.
 */
export interface ConversationTurn {
    role: "user" | "assistant";
    content: string;
}

/** How many recent turns to feed the rewriter. */
const MAX_HISTORY_TURNS = 6;

const REWRITE_SYSTEM_PROMPT =
    "You rewrite a user's latest message into a single, standalone search query " +
    "for retrieving notes from their personal knowledge base. Resolve pronouns and " +
    "vague references (e.g. \"it\", \"that one\", \"the other\") using the conversation. " +
    "Preserve the user's key terms. Output ONLY the rewritten query on a single line, " +
    "with no quotes, labels, or explanation.";

/**
 * Strip quotes/labels the model may add and collapse to a single line.
 */
function sanitizeQuery(text: string): string {
    let line = text.trim().split("\n").map(l => l.trim()).find(l => l.length > 0) ?? "";
    // Remove a leading label like "Query:" if the model added one.
    line = line.replace(/^(query|search query|rewritten query)\s*[:\-]\s*/i, "");
    // Strip surrounding quotes.
    line = line.replace(/^["'`]+/, "").replace(/["'`]+$/, "");
    return line.trim();
}

/**
 * Rewrite the latest user message into a standalone retrieval query using the
 * conversation history. Falls back to the original query on any error or when
 * there is no history to resolve against.
 */
export async function rewriteQuery(
    apiKey: string,
    model: string,
    history: ConversationTurn[],
    query: string
): Promise<string> {
    if (!apiKey) {
        return query;
    }

    const recent = history.slice(-MAX_HISTORY_TURNS);
    if (recent.length === 0) {
        // Nothing to disambiguate against; skip the extra call.
        return query;
    }

    const transcript = recent
        .map(turn => `${turn.role === "user" ? "User" : "Assistant"}: ${turn.content}`)
        .join("\n");

    const userPrompt =
        `Conversation so far:\n${transcript}\n\n` +
        `Latest user message: ${query}\n\n` +
        `Standalone search query:`;

    try {
        const response = await sendChatMessage(
            apiKey,
            [
                { role: "system", content: REWRITE_SYSTEM_PROMPT },
                { role: "user", content: userPrompt }
            ],
            model
        );

        if (response.error || !response.content) {
            return query;
        }

        const rewritten = sanitizeQuery(response.content);
        return rewritten.length > 0 ? rewritten : query;
    } catch {
        return query;
    }
}

const HYDE_SYSTEM_PROMPT =
    "You generate a short, hypothetical passage that could plausibly answer the " +
    "user's question, written in the declarative style of a personal note. This " +
    "passage is used only to improve semantic search; it does not need to be true. " +
    "Write 2-4 factual-sounding sentences. Do not hedge, ask questions, or add " +
    "preamble\u2014output only the passage.";

/**
 * Generate a Hypothetical Document (HyDE) for a query. Embedding a note-like
 * passage tends to match real notes far better than embedding a question does.
 * Returns an empty string on failure so callers can fall back to the raw query.
 */
export async function generateHydeDocument(
    apiKey: string,
    model: string,
    query: string
): Promise<string> {
    if (!apiKey) {
        return "";
    }

    try {
        const response = await sendChatMessage(
            apiKey,
            [
                { role: "system", content: HYDE_SYSTEM_PROMPT },
                { role: "user", content: query }
            ],
            model
        );

        if (response.error || !response.content) {
            return "";
        }

        return response.content.trim();
    } catch {
        return "";
    }
}
