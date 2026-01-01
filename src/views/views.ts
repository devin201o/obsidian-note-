import { ItemView, WorkspaceLeaf, Notice, Modal, App, MarkdownRenderer, Component } from "obsidian";
import type MyPlugin from "../main";
import type { ChatMessage } from "../settings";
import type { RAGEngine } from "../chat/rag-engine";

export const VIEW_TYPE_CHATBOT = "chatbot-view";

export class ChatbotView extends ItemView {
    private plugin: MyPlugin;
    private ragEngine: RAGEngine;
    private chatLogEl: HTMLElement | null = null;
    private inputEl: HTMLTextAreaElement | null = null;
    private sendButton: HTMLButtonElement | null = null;
    private renderComponent: Component;

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
        
        // Render existing messages from storage
        for (const msg of this.plugin.settings.chatHistory) {
            await this.renderMessage(msg);
        }
        this.scrollToBottom();

        const inputContainer = container.createDiv({ cls: "chat-input-container" });
        
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
            // Send to RAG engine
            const response = await this.ragEngine.ask(content, conversationHistory);

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

        const contentEl = messageEl.createDiv({ cls: "chat-message-content" });

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
        messageEl.createDiv({ 
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