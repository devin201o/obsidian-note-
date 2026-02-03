import { ItemView, WorkspaceLeaf, Notice, Modal, App, MarkdownRenderer, Component, Menu, TFile, TFolder, setIcon, FuzzySuggestModal } from "obsidian";
import type { FuzzyMatch } from "obsidian";
import type MyPlugin from "../main";
import type { ChatMessage } from "../settings";
import type { RAGEngine } from "../chat/rag-engine";
import type { SearchOptions } from "../indexer/vector-store";

export const VIEW_TYPE_CHATBOT = "chatbot-view";

// Cache for folders and tags to avoid rescanning vault on every menu open
let cachedFolders: string[] | null = null;
let cachedTags: string[] | null = null;
let cacheTimestamp: number = 0;
const CACHE_TTL_MS = 30000; // 30 seconds cache TTL

/**
 * Context item for scoping RAG search
 */
interface ContextItem {
    type: "file" | "folder" | "tag";
    value: string;
    displayName: string;
}

export class ChatbotView extends ItemView {
    private plugin: MyPlugin;
    private ragEngine: RAGEngine;
    private chatLogEl: HTMLElement | null = null;
    private inputEl: HTMLTextAreaElement | null = null;
    private sendButton: HTMLButtonElement | null = null;
    private renderComponent: Component;
    private contextPillsEl: HTMLElement | null = null;
    private selectedContexts: ContextItem[] = [];
    private contextExpanded: boolean = false;
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
        
        // Invalidate cache when metadata changes
        this.registerEvent(
            this.app.metadataCache.on("changed", () => {
                cachedTags = null;
            })
        );
        this.registerEvent(
            this.app.vault.on("create", () => {
                cachedFolders = null;
                cachedTags = null;
            })
        );
        this.registerEvent(
            this.app.vault.on("delete", () => {
                cachedFolders = null;
                cachedTags = null;
            })
        );
        this.registerEvent(
            this.app.vault.on("rename", () => {
                cachedFolders = null;
                cachedTags = null;
            })
        );
        
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

        // Context pills container (above input)
        this.contextPillsEl = container.createDiv({ cls: "chat-context-pills" });

        const inputContainer = container.createDiv({ cls: "chat-input-container" });
        
        // Context picker button
        const contextButton = inputContainer.createEl("button", {
            cls: "chat-context-button",
            attr: { "aria-label": "Add context" }
        });
        setIcon(contextButton, "paperclip");
        contextButton.addEventListener("click", (e) => this.showContextMenu(e));
        
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

        // Check if API key is set
        if (!this.plugin.settings.openRouterApiKey) {
            new Notice("Please set your OpenRouter API key in **Settings → obsidian note+**");
            return;
        }

        // Disable input during processing
        this.setInputEnabled(false);

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
            // Build search options from selected contexts
            const searchOptions = this.buildSearchOptions();
            
            // Send to RAG engine with context filters
            const response = await this.ragEngine.ask(content, conversationHistory, searchOptions);

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

    // ===== Context Picker Methods =====

    private showContextMenu(e: MouseEvent) {
        const menu = new Menu();

        menu.addItem((item) => {
            item.setTitle("📄 Add File...")
                .onClick(() => this.showFilePickerModal());
        });

        menu.addItem((item) => {
            item.setTitle("📁 Add Folder...")
                .onClick(() => this.showFolderPickerModal());
        });

        menu.addItem((item) => {
            item.setTitle("🏷️ Add Tag...")
                .onClick(() => this.showTagPickerModal());
        });

        if (this.selectedContexts.length > 0) {
            menu.addSeparator();
            menu.addItem((item) => {
                item.setTitle("Clear all context")
                    .onClick(() => {
                        this.selectedContexts = [];
                        this.renderContextPills();
                    });
            });
        }

        menu.showAtMouseEvent(e);
    }

    private showFilePickerModal() {
        const files = this.app.vault.getMarkdownFiles();
        const modal = new FilePickerModal(this.app, files, (file) => {
            this.addContext({
                type: "file",
                value: file.path,
                displayName: file.basename
            });
        });
        modal.open();
    }

    private showFolderPickerModal() {
        const folders = this.getAllFolders();
        const modal = new FolderSuggester(this.app, folders, (folder) => {
            this.addContext({
                type: "folder",
                value: folder,
                displayName: folder
            });
        });
        modal.open();
    }

    private showTagPickerModal() {
        const tags = this.getAllTags();
        const modal = new TagSuggester(this.app, tags, (tag) => {
            this.addContext({
                type: "tag",
                value: tag,
                displayName: tag
            });
        });
        modal.open();
    }

    private getAllFolders(): string[] {
        const now = Date.now();
        // Return cached if valid
        if (cachedFolders && (now - cacheTimestamp) < CACHE_TTL_MS) {
            return cachedFolders;
        }

        const folders: string[] = [];
        const rootFolder = this.app.vault.getRoot();
        
        const traverse = (folder: TFolder) => {
            for (const child of folder.children) {
                if (child instanceof TFolder) {
                    folders.push(child.path);
                    traverse(child);
                }
            }
        };
        
        traverse(rootFolder);
        cachedFolders = folders.sort();
        cacheTimestamp = now;
        return cachedFolders;
    }

    private getAllTags(): string[] {
        const now = Date.now();
        // Return cached if valid
        if (cachedTags && (now - cacheTimestamp) < CACHE_TTL_MS) {
            return cachedTags;
        }

        const tagSet = new Set<string>();
        const files = this.app.vault.getMarkdownFiles();
        
        for (const file of files) {
            const cache = this.app.metadataCache.getFileCache(file);
            
            // Get inline tags from body
            if (cache?.tags) {
                for (const tagCache of cache.tags) {
                    const tag = tagCache.tag;
                    tagSet.add(tag);
                    // Also add parent tags for hierarchy (e.g., #project/subtask adds #project)
                    this.addParentTags(tag, tagSet);
                }
            }
            
            // Get frontmatter tags
            if (cache?.frontmatter?.tags) {
                const fmTags = Array.isArray(cache.frontmatter.tags) 
                    ? cache.frontmatter.tags 
                    : [cache.frontmatter.tags];
                for (const rawTag of fmTags) {
                    if (typeof rawTag === "string") {
                        const tag = rawTag.startsWith("#") ? rawTag : `#${rawTag}`;
                        tagSet.add(tag);
                        this.addParentTags(tag, tagSet);
                    }
                }
            }
            
            // Also check frontmatter 'tag' (singular) field
            if (cache?.frontmatter?.tag) {
                const rawTag = cache.frontmatter.tag;
                if (typeof rawTag === "string") {
                    const tag = rawTag.startsWith("#") ? rawTag : `#${rawTag}`;
                    tagSet.add(tag);
                    this.addParentTags(tag, tagSet);
                }
            }
        }
        
        cachedTags = Array.from(tagSet).sort();
        return cachedTags;
    }

    /**
     * Add parent tags for nested tag hierarchy
     * e.g., #project/frontend/react adds #project/frontend and #project
     */
    private addParentTags(tag: string, tagSet: Set<string>) {
        const parts = tag.split("/");
        for (let i = 1; i < parts.length; i++) {
            const parentTag = parts.slice(0, i).join("/");
            tagSet.add(parentTag);
        }
    }

    private addContext(item: ContextItem) {
        // Don't add duplicates
        const exists = this.selectedContexts.some(
            c => c.type === item.type && c.value === item.value
        );
        if (!exists) {
            this.selectedContexts.push(item);
            this.renderContextPills();
        }
    }

    private removeContext(index: number) {
        this.selectedContexts.splice(index, 1);
        this.renderContextPills();
    }

    private renderContextPills() {
        if (!this.contextPillsEl) return;
        this.contextPillsEl.empty();

        if (this.selectedContexts.length === 0) {
            this.contextPillsEl.removeClass("expanded");
            return;
        }

        // Toggle expanded class
        if (this.contextExpanded) {
            this.contextPillsEl.addClass("expanded");
        } else {
            this.contextPillsEl.removeClass("expanded");
        }

        const totalCount = this.selectedContexts.length;
        const showAll = this.contextExpanded || totalCount <= this.MAX_VISIBLE_PILLS;
        const visibleContexts = showAll ? this.selectedContexts : this.selectedContexts.slice(0, this.MAX_VISIBLE_PILLS);

        for (const ctx of visibleContexts) {
            const pill = this.contextPillsEl.createDiv({ cls: "chat-context-pill" });
            pill.setAttribute("data-type", ctx.type);
            
            const icon = ctx.type === "file" ? "📄" : ctx.type === "folder" ? "📁" : "🏷️";
            pill.createSpan({ cls: "chat-context-pill-text", text: `${icon} ${ctx.displayName}` });
            
            const removeBtn = pill.createSpan({ cls: "chat-context-pill-remove", text: "×" });
            const index = this.selectedContexts.indexOf(ctx);
            removeBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                this.removeContext(index);
            });
        }

        // Show expand/collapse button if there are hidden pills
        if (totalCount > this.MAX_VISIBLE_PILLS) {
            const expandBtn = this.contextPillsEl.createSpan({ cls: "chat-context-expand" });
            if (this.contextExpanded) {
                expandBtn.textContent = "▲ Less";
            } else {
                const hiddenCount = totalCount - this.MAX_VISIBLE_PILLS;
                expandBtn.textContent = `+${hiddenCount} more...`;
            }
            expandBtn.addEventListener("click", () => {
                this.contextExpanded = !this.contextExpanded;
                this.renderContextPills();
            });
        }
    }

    private buildSearchOptions(): SearchOptions | undefined {
        if (this.selectedContexts.length === 0) {
            return undefined;
        }

        const options: SearchOptions = {};
        
        const files = this.selectedContexts.filter(c => c.type === "file").map(c => c.value);
        const folders = this.selectedContexts.filter(c => c.type === "folder").map(c => c.value);
        const tags = this.selectedContexts.filter(c => c.type === "tag").map(c => c.value);

        if (files.length > 0) options.files = files;
        if (folders.length > 0) options.folders = folders;
        if (tags.length > 0) options.tags = tags;

        return options;
    }

    // ===== End Context Picker Methods =====

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
        
        const nameEl = el.createSpan({ cls: "file-picker-name" });
        nameEl.setText(file.basename);
        
        if (file.parent && file.parent.path !== "/") {
            const pathEl = el.createSpan({ cls: "file-picker-path" });
            pathEl.setText(file.parent.path);
        }
    }
}

/**
 * Fuzzy suggester for picking a folder from the vault
 */
class FolderSuggester extends FuzzySuggestModal<string> {
    private folders: string[];
    private onSelectCallback: (folder: string) => void;

    constructor(app: App, folders: string[], onSelect: (folder: string) => void) {
        super(app);
        this.folders = folders;
        this.onSelectCallback = onSelect;
        this.setPlaceholder("Search folders...");
    }

    getItems(): string[] {
        return this.folders;
    }

    getItemText(folder: string): string {
        return folder;
    }

    onChooseItem(folder: string, evt: MouseEvent | KeyboardEvent): void {
        this.onSelectCallback(folder);
    }

    renderSuggestion(match: FuzzyMatch<string>, el: HTMLElement): void {
        el.addClass("folder-picker-item");
        el.createSpan({ text: "📁 ", cls: "folder-picker-icon" });
        el.createSpan({ text: match.item, cls: "folder-picker-name" });
    }
}

/**
 * Fuzzy suggester for picking a tag from the vault
 */
class TagSuggester extends FuzzySuggestModal<string> {
    private tags: string[];
    private onSelectCallback: (tag: string) => void;

    constructor(app: App, tags: string[], onSelect: (tag: string) => void) {
        super(app);
        this.tags = tags;
        this.onSelectCallback = onSelect;
        this.setPlaceholder("Search tags...");
    }

    getItems(): string[] {
        return this.tags;
    }

    getItemText(tag: string): string {
        return tag;
    }

    onChooseItem(tag: string, evt: MouseEvent | KeyboardEvent): void {
        this.onSelectCallback(tag);
    }

    renderSuggestion(match: FuzzyMatch<string>, el: HTMLElement): void {
        el.addClass("tag-picker-item");
        el.createSpan({ text: match.item, cls: "tag-picker-name" });
    }
}