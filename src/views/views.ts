import { ItemView, WorkspaceLeaf, Notice } from "obsidian";
import type MyPlugin from "../main";
import type { ChatMessage } from "../settings";
import { sendChatMessage } from "../llm/openrouter";

export const VIEW_TYPE_CHATBOT = "chatbot-view";

export class ChatbotView extends ItemView {
    private plugin: MyPlugin;
    private chatLogEl: HTMLElement | null = null;
    private inputEl: HTMLInputElement | null = null;

    constructor(leaf: WorkspaceLeaf, plugin: MyPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType() {
        return VIEW_TYPE_CHATBOT;
    }

    getDisplayText() {
        return "Chatbot view";
    }

    async onOpen() {
        const container = this.containerEl.children[1];
        if (!container) return;
        container.empty();

        container.addClass("chatbot-container");
        container.createEl("h4", { text: "Chatbot" });
        
        this.chatLogEl = container.createDiv({ cls: "chat-log" });
        
        // Render existing messages from storage
        this.plugin.settings.chatHistory.forEach(msg => {
            this.renderMessage(msg);
        });
        this.scrollToBottom();

        const inputContainer = container.createDiv({ cls: "chat-input-container" });
        
        this.inputEl = inputContainer.createEl("input", { 
            type: "text", 
            placeholder: "Type a message...",
            cls: "chat-input"
        });

        const sendButton = inputContainer.createEl("button", {
            text: "Send",
            cls: "chat-send-button"
        });

        this.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                this.sendMessage();
            }
        });

        sendButton.addEventListener("click", () => {
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

        const userMessage: ChatMessage = {
            content,
            sender: "user",
            timestamp: new Date().toISOString()
        };

        // Add user message to storage and render
        this.plugin.settings.chatHistory.push(userMessage);
        await this.plugin.saveSettings();
        this.renderMessage(userMessage);
        
        this.inputEl.value = "";
        this.inputEl.focus();
        this.scrollToBottom();

        // Build conversation history for LLM
        const llmMessages: { role: "user" | "assistant" | "system"; content: string }[] = [
            { role: "system", content: "You are a helpful assistant." }
        ];
        
        // Include recent conversation history (last 10 messages for context)
        const recentHistory = this.plugin.settings.chatHistory.slice(-10);
        for (const msg of recentHistory) {
            llmMessages.push({
                role: msg.sender === "user" ? "user" : "assistant",
                content: msg.content
            });
        }

        // Send to LLM
        const response = await sendChatMessage(
            this.plugin.settings.openRouterApiKey,
            llmMessages
        );

        if (response.error) {
            new Notice(`Error: ${response.error}`);
            return;
        }

        // Create and save bot response
        const botMessage: ChatMessage = {
            content: response.content,
            sender: "bot",
            timestamp: new Date().toISOString()
        };

        this.plugin.settings.chatHistory.push(botMessage);
        await this.plugin.saveSettings();
        this.renderMessage(botMessage);
        this.scrollToBottom();
    }

    private renderMessage(message: ChatMessage) {
        if (!this.chatLogEl) return;

        const messageEl = this.chatLogEl.createDiv({ 
            cls: `chat-message chat-message-${message.sender}` 
        });

        messageEl.createDiv({ 
            cls: "chat-message-content",
            text: message.content 
        });

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
        this.chatLogEl.scrollTop = this.chatLogEl.scrollHeight;
    }

    async onClose() {
        // Nothing to clean up - messages are in plugin.settings
    }
}