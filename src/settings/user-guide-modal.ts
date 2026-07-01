import { App, Modal } from "obsidian";

interface GlossaryEntry {
    term: string;
    definition: string;
}

const GLOSSARY: GlossaryEntry[] = [
    {
        term: "Embedding",
        definition: "A numeric fingerprint of a piece of text that captures its meaning, so the plugin can find notes that are conceptually similar to your question, not just ones that share the same words."
    },
    {
        term: "Chunk",
        definition: "A note is too long to search as one block, so it's split into smaller pieces called chunks (usually a section or a few paragraphs) before being turned into embeddings."
    },
    {
        term: "Hybrid search",
        definition: "The plugin combines two ways of finding notes: matching by meaning (embeddings) and matching by exact keywords (like a classic search). Combining both catches more of what you're looking for."
    },
    {
        term: "Reranking",
        definition: "An optional extra step where the AI double-checks a wider set of candidate notes and reorders them by true relevance before answering. More accurate, but a bit slower."
    },
    {
        term: "HyDE (hypothetical document embeddings)",
        definition: "An optional trick where the AI first writes a short made-up answer to your question, then searches using that instead of your literal question. This often finds better matches for vague questions."
    },
    {
        term: "Query rewriting",
        definition: "An optional step that rewrites follow-up questions (like \"what about the other one?\") into a standalone question using your chat history, so search still works correctly."
    },
    {
        term: "Redaction",
        definition: "Before anything is indexed, the plugin automatically blanks out things that look like secrets (API keys, private keys, emails) so they're never sent to an AI provider."
    }
];

/**
 * A plain-language walkthrough of what the plugin does and how to set it up,
 * for people who don't need (or want) to understand the RAG jargon used
 * elsewhere in the settings tab.
 */
export class UserGuideModal extends Modal {
    constructor(app: App) {
        super(app);
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass("user-guide-modal");

        contentEl.createEl("h2", { text: "Obsidian note+ user guide" });

        contentEl.createEl("h3", { text: "What this plugin does" });
        contentEl.createEl("p", {
            text: "Obsidian note+ lets you chat with your own notes. Ask a question in the chat panel, " +
                "and the plugin searches your vault for the most relevant notes, then asks an AI to answer " +
                "using what it found \u2014 with clickable links back to the source notes."
        });

        contentEl.createEl("h3", { text: "Quick start" });
        const steps = contentEl.createEl("ol", { cls: "user-guide-steps" });
        steps.createEl("li", {
            text: "Pick an AI provider. In Settings \u2192 AI provider, choose a service for Chat and for " +
                "Embeddings (they can be the same or different), and enter an API key. Ollama needs no key " +
                "but must be running on your computer."
        });
        steps.createEl("li", {
            text: "Build your index. Open the Command Palette (Ctrl/Cmd + P) and run \"Rebuild Index\". " +
                "This reads your notes, splits them up, and turns them into embeddings so they're searchable. " +
                "It only needs to fully re-run when you change providers or chunking settings \u2014 normal edits " +
                "are picked up automatically."
        });
        steps.createEl("li", {
            text: "Start chatting. Click the chat bubble icon in the left sidebar and ask a question about " +
                "your notes."
        });

        contentEl.createEl("h3", { text: "Tips" });
        const tips = contentEl.createEl("ul", { cls: "user-guide-tips" });
        tips.createEl("li", { text: "If answers seem to miss obvious notes, try increasing \"Max context chunks\" or \"Retrieval pool size\" under Search & retrieval." });
        tips.createEl("li", { text: "If you keep sensitive folders in your vault (e.g. journals), add them under Folder exclusion so they're never indexed." });
        tips.createEl("li", { text: "The extra toggles under Query enhancement (rewriting, HyDE, reranking) can improve answer quality, at the cost of a bit more time per message. They're safe to leave off while you're getting started." });

        contentEl.createEl("h3", { text: "Glossary" });
        contentEl.createEl("p", {
            text: "The settings tab uses a few technical terms so you have full control over how retrieval works. Here's what they mean:",
            cls: "user-guide-glossary-intro"
        });
        const glossaryList = contentEl.createEl("dl", { cls: "user-guide-glossary" });
        for (const entry of GLOSSARY) {
            glossaryList.createEl("dt", { text: entry.term });
            glossaryList.createEl("dd", { text: entry.definition });
        }
    }

    onClose(): void {
        const { contentEl } = this;
        contentEl.empty();
    }
}
