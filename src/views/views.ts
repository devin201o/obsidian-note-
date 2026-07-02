import { ItemView, WorkspaceLeaf, Notice, Modal, App, MarkdownRenderer, Component, TFile, setIcon, FuzzySuggestModal } from "obsidian";
import type { FuzzyMatch } from "obsidian";
import type MyPlugin from "../main";
import type { ChatMessage } from "../settings";
import type { RAGEngine, AttachedFile } from "../chat/rag-engine";
import { estimateTokens } from "../chat/rag-engine";
import { isChatProviderConfigured, isEmbeddingProviderConfigured } from "../llm/factory";

export const VIEW_TYPE_CHATBOT = "chatbot-view";

/**
 * Token count above which an attached file (or the running total) is
 * flagged as "large" in the UI. Not a hard limit, just a cost warning.
 */
const LARGE_ATTACHMENT_TOKEN_WARNING = 3000;

export class ChatbotView extends ItemView {
    private plugin: MyPlugin;
    private ragEngine: RAGEngine;
    private chatLogEl: HTMLElement | null = null;
    private inputEl: HTMLTextAreaElement | null = null;
    private sendButton: HTMLButtonElement | null = null;
    private renderComponent: Component;
    private attachmentPillsEl: HTMLElement | null = null;
    private attachedFiles: AttachedFile[] = [];
    private attachmentsExpanded: boolean = false;
    private readonly MAX_VISIBLE_PILLS = 3;

    constructor(leaf: WorkspaceLeaf, plugin: MyPlugin, ragEngine: RAGEngine) {
        super(leaf);
        this.plugin = plugin;
        this.ragEngine = ragEngine;
        this.renderComponent = new Component();
    }

    getViewType() {
        return VIEW_TYPE_CHATBOT;
    }

    getDisplayText() {
        return "Chat with Notes";
    }

    async onOpen() {
        this.renderComponent.load();

        const container = this.containerEl.children[1];
        if (!container) return;
        container.empty();

        container.addClass("chatbot-container");
        
        // Header with title and reset button
        const headerEl = container.createDiv({ cls: "chat-header" });
        headerEl.createEl("h4", { text: "Chat with Notes" });
        
        const resetButton = headerEl.createEl("button", {
            cls: "chat-reset-button",
            attr: { "aria-label": "Clear conversation" }
        });
        resetButton.innerHTML = "⟳";
        resetButton.addEventListener("click", () => this.resetConversation());
        
        this.chatLogEl = container.createDiv({ cls: "chat-log" });
        
        // Handle clicks on internal links (WikiLinks)
        this.chatLogEl.addEventListener("click", (ev: MouseEvent) => {
            const target = ev.target as HTMLElement;
            // Check if clicked element or its parent is an internal link
            const link = target.closest("a.internal-link") as HTMLElement | null;
            if (link) {
                ev.preventDefault();
                const href = link.getAttribute("data-href");
                if (href) {
                    // Check if Ctrl (Windows/Linux) or Meta/Cmd (Mac) is held for new tab
                    const newLeaf = ev.ctrlKey || ev.metaKey;
                    this.app.workspace.openLinkText(href, "", newLeaf);
                }
            }
        });
        
        // Render existing messages from storage
        for (const msg of this.plugin.settings.chatHistory) {
            await this.renderMessage(msg);
        }
        this.scrollToBottom();

        // Attachment pills container (above input)
        this.attachmentPillsEl = container.createDiv({ cls: "chat-attachment-pills" });

        const inputContainer = container.createDiv({ cls: "chat-input-container" });
        
        // Attach-file button
        const attachButton = inputContainer.createEl("button", {
            cls: "chat-attachment-button",
            attr: { "aria-label": "Attach file" }
        });
        setIcon(attachButton, "paperclip");
        attachButton.addEventListener("click", () => this.showFilePickerModal());
        
        // Use textarea for multi-line input
        this.inputEl = inputContainer.createEl("textarea", { 
            placeholder: "Ask about your notes...",
            cls: "chat-input"
        });
        this.inputEl.rows = 2;

        this.sendButton = inputContainer.createEl("button", {
            text: "Send",
            cls: "chat-send-button"
        });

        this.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                this.sendMessage();
            }
        });

        this.sendButton.addEventListener("click", () => {
            this.sendMessage();
        });
    }

    private async sendMessage() {
        if (!this.inputEl || !this.chatLogEl) return;
        
        const content = this.inputEl.value.trim();
        if (!content) return;

        // Check that a chat provider is configured
        if (!isChatProviderConfigured(this.plugin.settings)) {
            new Notice("Please configure an AI provider in Settings → obsidian note+");
            return;
        }

        // Check that an embedding provider is configured too. Without it, search
        // silently returns no context and the model answers from general
        // knowledge, which is easy to mistake for an answer based on your notes.
        if (!isEmbeddingProviderConfigured(this.plugin.settings)) {
            new Notice("Please configure an embedding provider in Settings → obsidian note+, then run 'Rebuild Index'.");
            return;
        }

        // Disable input during processing
        this.setInputEnabled(false);

        // Snapshot attachments for this request; one-shot, so they're only
        // cleared once we know the response succeeded.
        const attachedFilesForRequest = [...this.attachedFiles];

        const userMessage: ChatMessage = {
            content,
            sender: "user",
            timestamp: new Date().toISOString()
        };

        // Add user message to storage and render
        this.plugin.settings.chatHistory.push(userMessage);
        await this.plugin.saveSettings();
        await this.renderMessage(userMessage);
        
        this.inputEl.value = "";
        this.scrollToBottom();

        // Build conversation history for RAG (last 10 messages for context)
        const recentHistory = this.plugin.settings.chatHistory.slice(-11, -1); // Exclude current message
        const conversationHistory: Array<{ role: "user" | "assistant"; content: string }> = [];
        
        for (const msg of recentHistory) {
            conversationHistory.push({
                role: msg.sender === "user" ? "user" : "assistant",
                content: msg.content
            });
        }

        // Show typing indicator
        const typingIndicator = this.showTypingIndicator();

        try {
            // Send to RAG engine, with any attached files' full content
            const response = await this.ragEngine.ask(content, conversationHistory, attachedFilesForRequest);

            // Remove typing indicator
            typingIndicator.remove();

            // Create and save bot response
            const botMessage: ChatMessage = {
                content: response,
                sender: "bot",
                timestamp: new Date().toISOString()
            };

            this.plugin.settings.chatHistory.push(botMessage);
            await this.plugin.saveSettings();
            await this.renderMessage(botMessage);
            this.scrollToBottom();

            // One-shot: clear only the attachments actually sent with this
            // message (matched by path), not the whole list — the user may
            // have attached something new while this request was in flight.
            const usedPaths = new Set(attachedFilesForRequest.map(f => f.path));
            this.attachedFiles = this.attachedFiles.filter(f => !usedPaths.has(f.path));
            this.renderAttachmentPills();
        } catch (error) {
            typingIndicator.remove();
            const errorMsg = error instanceof Error ? error.message : "Unknown error";
            new Notice(`Error: ${errorMsg}`);
        } finally {
            this.setInputEnabled(true);
            this.inputEl?.focus();
        }
    }

    private setInputEnabled(enabled: boolean) {
        if (this.inputEl) {
            this.inputEl.disabled = !enabled;
        }
        if (this.sendButton) {
            this.sendButton.disabled = !enabled;
        }
    }

    private showTypingIndicator(): HTMLElement {
        if (!this.chatLogEl) {
            return document.createElement("div");
        }
        const indicator = this.chatLogEl.createDiv({ cls: "chat-message chat-message-bot chat-typing" });
        indicator.createDiv({ cls: "chat-message-content", text: "Thinking..." });
        this.scrollToBottom();
        return indicator;
    }

    private async renderMessage(message: ChatMessage) {
        if (!this.chatLogEl) return;

        const messageEl = this.chatLogEl.createDiv({ 
            cls: `chat-message chat-message-${message.sender}` 
        });

        const copyButton = messageEl.createEl("button", {
            cls: "chat-message-copy-button",
            attr: { "aria-label": "Copy message" }
        });
        setIcon(copyButton, "copy");

        copyButton.addEventListener("click", () => {
            navigator.clipboard.writeText(message.content).then(() => {
                new Notice("Copied to clipboard");
                setIcon(copyButton, "check");
                setTimeout(() => {
                    setIcon(copyButton, "copy");
                }, 2000);
            }).catch(() => {
                new Notice("Failed to copy to clipboard");
            });
        });

        const messageBubble = messageEl.createDiv({ cls: "chat-message-bubble" });

        const contentEl = messageBubble.createDiv({ cls: "chat-message-content" });

        // Use MarkdownRenderer for bot messages to make [[WikiLinks]] clickable
        if (message.sender === "bot") {
            await MarkdownRenderer.render(
                this.app,
                message.content,
                contentEl,
                "",
                this.renderComponent
            );
        } else {
            // Plain text for user messages
            contentEl.setText(message.content);
        }

        const date = new Date(message.timestamp);
        const timeStr = date.toLocaleTimeString([], { 
            hour: "2-digit", 
            minute: "2-digit" 
        });
        messageBubble.createDiv({
            cls: "chat-message-time",
            text: timeStr 
        });
    }

    private scrollToBottom() {
        if (!this.chatLogEl) return;
        // Use requestAnimationFrame to ensure DOM has updated
        requestAnimationFrame(() => {
            if (this.chatLogEl) {
                this.chatLogEl.scrollTop = this.chatLogEl.scrollHeight;
            }
        });
    }

    // ===== File Attachment Methods =====

    /**
     * Open the file picker, excluding files that are already attached.
     */
    private showFilePickerModal() {
        const alreadyAttached = new Set(this.attachedFiles.map(f => f.path));
        const files = this.app.vault.getMarkdownFiles().filter(f => !alreadyAttached.has(f.path));
        const modal = new FilePickerModal(this.app, files, (file) => this.addAttachment(file));
        modal.open();
    }

    /**
     * Read a file's full content and attach it. The content is snapshotted
     * at attach-time, so later edits to the file won't retroactively change
     * what gets sent.
     */
    private async addAttachment(file: TFile) {
        try {
            const content = await this.app.vault.cachedRead(file);
            this.attachedFiles.push({
                path: file.path,
                displayName: file.basename,
                content,
                tokenCount: estimateTokens(content)
            });
            this.renderAttachmentPills();
        } catch (error) {
            new Notice(`Failed to read "${file.basename}" for attaching`);
        }
    }

    private removeAttachment(index: number) {
        this.attachedFiles.splice(index, 1);
        this.renderAttachmentPills();
    }

    private renderAttachmentPills() {
        if (!this.attachmentPillsEl) return;
        this.attachmentPillsEl.empty();

        if (this.attachedFiles.length === 0) {
            this.attachmentPillsEl.removeClass("expanded");
            return;
        }

        // Toggle expanded class
        if (this.attachmentsExpanded) {
            this.attachmentPillsEl.addClass("expanded");
        } else {
            this.attachmentPillsEl.removeClass("expanded");
        }

        const pillsRow = this.attachmentPillsEl.createDiv({ cls: "chat-attachment-pills-row" });

        const totalCount = this.attachedFiles.length;
        const showAll = this.attachmentsExpanded || totalCount <= this.MAX_VISIBLE_PILLS;
        const visibleFiles = showAll ? this.attachedFiles : this.attachedFiles.slice(0, this.MAX_VISIBLE_PILLS);

        for (const file of visibleFiles) {
            const pill = pillsRow.createDiv({ cls: "chat-attachment-pill" });
            const isLarge = file.tokenCount > LARGE_ATTACHMENT_TOKEN_WARNING;
            if (isLarge) {
                pill.addClass("chat-attachment-pill-warning");
            }
            // Use both title (visual hover tooltip) and aria-label (screen readers).
            const tooltip = isLarge
                ? `~${file.tokenCount.toLocaleString()} tokens — large attachment, this will use more of your model's context and may cost more per message.`
                : `~${file.tokenCount.toLocaleString()} tokens`;
            pill.setAttribute("title", tooltip);
            pill.setAttribute("aria-label", tooltip);

            const iconEl = pill.createSpan({ cls: "chat-attachment-pill-icon" });
            setIcon(iconEl, "file-text");
            pill.createSpan({ cls: "chat-attachment-pill-text", text: file.displayName });

            const index = this.attachedFiles.indexOf(file);
            const removeBtn = pill.createEl("button", {
                cls: "chat-attachment-pill-remove",
                text: "×",
                attr: { type: "button", "aria-label": `Remove ${file.displayName}` }
            });
            removeBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                this.removeAttachment(index);
            });
        }

        // Show expand/collapse button if there are hidden pills
        if (totalCount > this.MAX_VISIBLE_PILLS) {
            const expandBtn = pillsRow.createEl("button", {
                cls: "chat-attachment-expand",
                attr: { type: "button" }
            });
            if (this.attachmentsExpanded) {
                expandBtn.textContent = "▲ Less";
                expandBtn.setAttribute("aria-label", "Show fewer attachments");
            } else {
                const hiddenCount = totalCount - this.MAX_VISIBLE_PILLS;
                expandBtn.textContent = `+${hiddenCount} more...`;
                expandBtn.setAttribute("aria-label", `Show ${hiddenCount} more attachments`);
            }
            expandBtn.addEventListener("click", () => {
                this.attachmentsExpanded = !this.attachmentsExpanded;
                this.renderAttachmentPills();
            });
        }

        // Running token total, so the cost is visible before sending.
        const totalTokens = this.attachedFiles.reduce((sum, f) => sum + f.tokenCount, 0);
        const totalEl = this.attachmentPillsEl.createDiv({ cls: "chat-attachment-total" });
        if (totalTokens > LARGE_ATTACHMENT_TOKEN_WARNING) {
            totalEl.addClass("chat-attachment-total-warning");
            totalEl.setText(`~${totalTokens.toLocaleString()} tokens attached — this will use more of your model's context and may cost more per message.`);
        } else {
            totalEl.setText(`~${totalTokens.toLocaleString()} tokens attached`);
        }
    }

    // ===== End File Attachment Methods =====

    private async resetConversation() {
        // Show confirmation dialog
        const confirmed = await this.showConfirmDialog(
            "Clear conversation",
            "Are you sure you want to clear all messages? This cannot be undone."
        );
        
        if (!confirmed) return;
        
        // Clear chat history
        this.plugin.settings.chatHistory = [];
        await this.plugin.saveSettings();
        
        // Clear the chat log UI
        if (this.chatLogEl) {
            this.chatLogEl.empty();
        }
        
        new Notice("Conversation cleared");
    }

    private showConfirmDialog(title: string, message: string): Promise<boolean> {
        return new Promise((resolve) => {
            const modal = new ConfirmModal(this.app, title, message, resolve);
            modal.open();
        });
    }

    async onClose() {
        // Unload the render component to clean up any registered resources
        this.renderComponent.unload();
    }
}

class ConfirmModal extends Modal {
    private title: string;
    private message: string;
    private resolve: (value: boolean) => void;

    constructor(app: App, title: string, message: string, resolve: (value: boolean) => void) {
        super(app);
        this.title = title;
        this.message = message;
        this.resolve = resolve;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass("confirm-modal");

        contentEl.createEl("h3", { text: this.title });
        contentEl.createEl("p", { text: this.message });

        const buttonContainer = contentEl.createDiv({ cls: "confirm-modal-buttons" });
        
        const cancelButton = buttonContainer.createEl("button", { text: "Cancel" });
        cancelButton.addEventListener("click", () => {
            this.resolve(false);
            this.close();
        });

        const confirmButton = buttonContainer.createEl("button", { 
            text: "Clear",
            cls: "mod-warning"
        });
        confirmButton.addEventListener("click", () => {
            this.resolve(true);
            this.close();
        });
    }

    onClose() {
        this.contentEl.empty();
    }
}

/**
 * Fuzzy suggester for picking a file from the vault
 */
class FilePickerModal extends FuzzySuggestModal<TFile> {
    private files: TFile[];
    private onSelectCallback: (file: TFile) => void;

    constructor(app: App, files: TFile[], onSelect: (file: TFile) => void) {
        super(app);
        this.files = files;
        this.onSelectCallback = onSelect;
        this.setPlaceholder("Search files...");
    }

    getItems(): TFile[] {
        return this.files;
    }

    getItemText(file: TFile): string {
        return file.path;
    }

    onChooseItem(file: TFile, evt: MouseEvent | KeyboardEvent): void {
        this.onSelectCallback(file);
    }

    renderSuggestion(match: FuzzyMatch<TFile>, el: HTMLElement): void {
        const file = match.item;
        el.addClass("file-picker-item");

        const iconEl = el.createSpan({ cls: "file-picker-item-icon" });
        setIcon(iconEl, "file-text");

        const nameEl = el.createSpan({ cls: "file-picker-item-text" });
        nameEl.setText(file.basename);
        
        if (file.parent && file.parent.path !== "/") {
            const pathEl = el.createSpan({ cls: "file-picker-item-path" });
            pathEl.setText(file.parent.path);
        }
    }
}