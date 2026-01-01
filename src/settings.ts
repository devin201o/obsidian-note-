import { App, Modal, PluginSettingTab, Setting } from "obsidian";
import MyPlugin from "./main";
import type { IndexedFile } from "./indexer";

export interface ChatMessage {
    content: string;
    sender: "user" | "bot";
    timestamp: string;
}

export interface MyPluginSettings {
    mySetting: string;
    chatHistory: ChatMessage[];
    openRouterApiKey: string;
    openRouterModel: string;
    indexMarkdownOnly: boolean;
    enableRedaction: boolean;
    customRedactionPatterns: string;
    retrievalPoolSize: number;
    maxContextChunks: number;
    excludedFolders: string[];
}

export const DEFAULT_SETTINGS: MyPluginSettings = {
    mySetting: 'default',
    chatHistory: [],
    openRouterApiKey: '',
    openRouterModel: 'google/gemini-2.5-flash',
    indexMarkdownOnly: true,
    enableRedaction: true,
    customRedactionPatterns: '',
    retrievalPoolSize: 50,
    maxContextChunks: 15,
    excludedFolders: []
}

/**
 * Modal to display the list of indexed files
 */
export class IndexedFilesModal extends Modal {
    private files: IndexedFile[];
    private searchQuery: string = "";

    constructor(app: App, files: IndexedFile[]) {
        super(app);
        this.files = files;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass("indexed-files-modal");

        // Header
        contentEl.createEl("h2", { text: "Indexed Files" });
        contentEl.createEl("p", { 
            text: `Total files: ${this.files.length}`,
            cls: "indexed-files-count"
        });

        // Search input
        const searchContainer = contentEl.createDiv({ cls: "indexed-files-search" });
        const searchInput = searchContainer.createEl("input", {
            type: "text",
            placeholder: "Search files...",
            cls: "indexed-files-search-input"
        });
        searchInput.addEventListener("input", (e) => {
            this.searchQuery = (e.target as HTMLInputElement).value;
            this.renderFileList(fileListEl);
        });

        // File list container
        const fileListEl = contentEl.createDiv({ cls: "indexed-files-list" });
        this.renderFileList(fileListEl);
    }

    private renderFileList(container: HTMLElement) {
        container.empty();

        const filteredFiles = this.searchQuery
            ? this.files.filter(f => 
                f.name.toLowerCase().includes(this.searchQuery.toLowerCase()) ||
                f.path.toLowerCase().includes(this.searchQuery.toLowerCase())
            )
            : this.files;

        if (filteredFiles.length === 0) {
            container.createEl("p", { 
                text: this.searchQuery ? "No files match your search." : "No files indexed yet.",
                cls: "indexed-files-empty"
            });
            return;
        }

        // Show filtered count if searching
        if (this.searchQuery) {
            container.createEl("p", {
                text: `Showing ${filteredFiles.length} of ${this.files.length} files`,
                cls: "indexed-files-filter-count"
            });
        }

        const listEl = container.createEl("ul", { cls: "indexed-files-ul" });
        
        for (const file of filteredFiles) {
            const listItem = listEl.createEl("li", { cls: "indexed-file-item" });
            
            const fileInfo = listItem.createDiv({ cls: "indexed-file-info" });
            fileInfo.createEl("span", { 
                text: file.name,
                cls: "indexed-file-name"
            });
            fileInfo.createEl("span", { 
                text: file.path,
                cls: "indexed-file-path"
            });

            const fileMeta = listItem.createDiv({ cls: "indexed-file-meta" });
            fileMeta.createEl("span", {
                text: `.${file.extension}`,
                cls: "indexed-file-ext"
            });
            fileMeta.createEl("span", {
                text: this.formatFileSize(file.size),
                cls: "indexed-file-size"
            });
        }
    }

    private formatFileSize(bytes: number): string {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

export class SampleSettingTab extends PluginSettingTab {
	plugin: MyPlugin;
	private fileCountEl: HTMLElement | null = null;
	private lastIndexedEl: HTMLElement | null = null;

	constructor(app: App, plugin: MyPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		// ===== Vault Indexer Section =====
		containerEl.createEl("h3", { text: "Vault Indexer" });

		// Index status display
		const indexStatusContainer = containerEl.createDiv({ cls: "index-status-container" });
		
		const statsRow = indexStatusContainer.createDiv({ cls: "index-stats-row" });
		
		const fileCountContainer = statsRow.createDiv({ cls: "index-stat" });
		fileCountContainer.createEl("span", { text: "Files indexed: " });
		this.fileCountEl = fileCountContainer.createEl("strong", { 
			text: String(this.plugin.indexer?.getFileCount() ?? 0)
		});

		const lastIndexedContainer = statsRow.createDiv({ cls: "index-stat" });
		lastIndexedContainer.createEl("span", { text: "Last indexed: " });
		const stats = this.plugin.indexer?.getStats();
		this.lastIndexedEl = lastIndexedContainer.createEl("strong", {
			text: stats?.lastIndexed 
				? new Date(stats.lastIndexed).toLocaleString() 
				: "Never"
		});

		// Buttons row
		const buttonsRow = indexStatusContainer.createDiv({ cls: "index-buttons-row" });
		
		const reindexButton = buttonsRow.createEl("button", {
			text: "Re-index Vault",
			cls: "mod-cta"
		});
		reindexButton.addEventListener("click", async () => {
			reindexButton.disabled = true;
			reindexButton.textContent = "Indexing...";
			
			await this.plugin.indexVault();
			
			reindexButton.disabled = false;
			reindexButton.textContent = "Re-index Vault";
			this.updateIndexStats();
		});

		const viewAdvancedButton = buttonsRow.createEl("button", {
			text: "View Advanced",
		});
		viewAdvancedButton.addEventListener("click", () => {
			const files = this.plugin.indexer?.getIndexedFiles() ?? [];
			new IndexedFilesModal(this.app, files).open();
		});

		// Indexer settings
		new Setting(containerEl)
			.setName('Index markdown files only')
			.setDesc('When enabled, only .md files will be indexed. Disable to index all files.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.indexMarkdownOnly)
				.onChange(async (value) => {
					this.plugin.settings.indexMarkdownOnly = value;
					await this.plugin.saveSettings();
				}));

		// ===== Folder Exclusion Section =====
		containerEl.createEl("h3", { text: "Folder Exclusion" });

		new Setting(containerEl)
			.setName('Excluded folders')
			.setDesc('Folders to exclude from indexing and search (one folder path per line). Example: Calendar, Archives/Old')
			.addTextArea(textArea => {
				textArea
					.setPlaceholder('Calendar\nArchives\nTemplates')
					.setValue(this.plugin.settings.excludedFolders.join('\n'))
					.onChange(async (value) => {
						this.plugin.settings.excludedFolders = value
							.split('\n')
							.map(f => f.trim())
							.filter(f => f.length > 0);
						await this.plugin.saveSettings();
					});
				textArea.inputEl.rows = 4;
				textArea.inputEl.cols = 40;
				return textArea;
			});

		// ===== Privacy & Redaction Section =====
		containerEl.createEl("h3", { text: "Privacy & Redaction" });

		new Setting(containerEl)
			.setName('Enable redaction')
			.setDesc('Automatically redact sensitive data (API keys, emails, private keys) before indexing. Files are still searchable, but secret values are replaced with placeholders.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableRedaction)
				.onChange(async (value) => {
					this.plugin.settings.enableRedaction = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Custom redaction patterns')
			.setDesc('Add custom regex patterns to redact (one per line). Example: sk-[a-zA-Z0-9]+')
			.addTextArea(textArea => {
				textArea
					.setPlaceholder('sk-[a-zA-Z0-9]+\nmy-secret-pattern')
					.setValue(this.plugin.settings.customRedactionPatterns)
					.onChange(async (value) => {
						this.plugin.settings.customRedactionPatterns = value;
						await this.plugin.saveSettings();
					});
				textArea.inputEl.rows = 4;
				textArea.inputEl.cols = 40;
				return textArea;
			});

		// ===== Search & Retrieval Section =====
		containerEl.createEl("h3", { text: "Search & Retrieval" });

		new Setting(containerEl)
			.setName('Retrieval pool size')
			.setDesc('Number of initial chunks to fetch for reranking. Higher values may improve accuracy but increase processing time.')
			.addSlider(slider => slider
				.setLimits(10, 100, 5)
				.setValue(this.plugin.settings.retrievalPoolSize)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.retrievalPoolSize = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Max context chunks')
			.setDesc('Maximum number of chunks sent to the LLM. Higher values provide more context but use more tokens.')
			.addSlider(slider => slider
				.setLimits(1, 30, 1)
				.setValue(this.plugin.settings.maxContextChunks)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.maxContextChunks = value;
					await this.plugin.saveSettings();
				}));

		// ===== General Settings Section =====
		containerEl.createEl("h3", { text: "General Settings" });

		new Setting(containerEl)
			.setName('Settings #1')
			.setDesc('It\'s a secret')
			.addText(text => text
				.setPlaceholder('Enter your secret')
				.setValue(this.plugin.settings.mySetting)
				.onChange(async (value) => {
					this.plugin.settings.mySetting = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('OpenRouter API Key')
			.setDesc('Enter your OpenRouter API key. Get one at openrouter.ai')
			.addText(text => {
				text.setPlaceholder('sk-or-...')
					.setValue(this.plugin.settings.openRouterApiKey)
					.onChange(async (value) => {
						this.plugin.settings.openRouterApiKey = value;
						await this.plugin.saveSettings();
					});
				text.inputEl.type = 'password';
				return text;
			});

		new Setting(containerEl)
			.setName('OpenRouter Chat Model')
			.setDesc('The model ID to use for chat (e.g., google/gemini-2.5-flash, openai/gpt-4o, anthropic/claude-3.5-sonnet)')
			.addText(text => text
				.setPlaceholder('google/gemini-2.5-flash')
				.setValue(this.plugin.settings.openRouterModel)
				.onChange(async (value) => {
					this.plugin.settings.openRouterModel = value;
					await this.plugin.saveSettings();
				}));
	}

	private updateIndexStats(): void {
		if (this.fileCountEl) {
			this.fileCountEl.textContent = String(this.plugin.indexer?.getFileCount() ?? 0);
		}
		if (this.lastIndexedEl) {
			const stats = this.plugin.indexer?.getStats();
			this.lastIndexedEl.textContent = stats?.lastIndexed 
				? new Date(stats.lastIndexed).toLocaleString() 
				: "Never";
		}
	}
}
