import { ItemView, WorkspaceLeaf } from "obsidian";

export const VIEW_TYPE_CHATBOT = "chatbot-view";

export class ChatbotView extends ItemView {
    constructor(leaf: WorkspaceLeaf) {
        super(leaf);
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

        // Add container class for scoped styling
        container.addClass("chatbot-container");

        // Basic layout
        container.createEl("h4", { text: "Chatbot" });
        container.createDiv({ cls: "chat-log" });
        container.createEl("input", { 
            type: "text", 
            placeholder: "Type a message...",
            cls: "chat-input"
        });
    }
}