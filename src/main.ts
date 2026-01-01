import {App, debounce, Editor, MarkdownView, Modal, Notice, Plugin, TAbstractFile, TFile} from 'obsidian';
import {DEFAULT_SETTINGS, MyPluginSettings, SampleSettingTab} from "./settings";
import { ChatbotView, VIEW_TYPE_CHATBOT } from "./views/views";
import { VaultIndexer } from "./indexer";
import { ChunkManager } from "./indexer/chunk-manager";
import { VectorStore } from "./indexer/vector-store";
import { EmbeddingManager } from "./indexer/embedding-manager";
import { RAGEngine } from "./chat/rag-engine";
import { PrivacyManager } from "./indexer/privacy-manager";

export default class HelloWorldPlugin extends Plugin {
	settings: MyPluginSettings;
	indexer: VaultIndexer;
	chunkManager: ChunkManager;
	vectorStore: VectorStore;
	embeddingManager: EmbeddingManager;
	ragEngine: RAGEngine;
	privacyManager: PrivacyManager;
	
	// Debounced update function for file modifications
	private debouncedUpdateFile = debounce(
		async (file: TFile) => {
			await this.chunkManager.updateFile(file);
			console.log(`Rechunked file: ${file.path}`);
			// Update embeddings for the modified file
			if (this.settings.openRouterApiKey) {
				await this.embeddingManager.embedFile(file.path);
			}
		},
		2000,
		true
	);

	async onload() {
		await this.loadSettings();
		
		// Initialize the vault indexer
		this.indexer = new VaultIndexer(this.app);
		
		// Initialize the privacy manager
		this.privacyManager = new PrivacyManager();
		this.privacyManager.setEnabled(this.settings.enableRedaction);
		this.privacyManager.setCustomPatterns(this.settings.customRedactionPatterns);
		
		// Initialize the chunk manager with privacy manager
		this.chunkManager = new ChunkManager(this.app, this.privacyManager, {
			chunkSize: 1000,
			chunkOverlap: 200
		});
		
		// Initialize the vector store
		this.vectorStore = new VectorStore(this);
		await this.vectorStore.load();
		
		// Check for legacy vectors that need migration
		if (this.vectorStore.hasLegacyVectors()) {
			console.log("Legacy vectors detected. They will be re-embedded with content metadata.");
			new Notice("Vector store needs update. Please run 'Rebuild Index' to update embeddings.");
		}
		
		// Initialize the embedding manager
		this.embeddingManager = new EmbeddingManager(
			this.chunkManager,
			this.vectorStore,
			{ batchSize: 20, batchDelayMs: 100 }
		);
		this.embeddingManager.setApiKey(this.settings.openRouterApiKey);
		
		// Initialize the RAG engine
		this.ragEngine = new RAGEngine(this.embeddingManager);
		this.ragEngine.setApiKey(this.settings.openRouterApiKey);
		this.ragEngine.setModel(this.settings.openRouterModel);
		
		// Index the vault on startup
		await this.indexVault();
		
		// Process all files for chunking on startup
		await this.rebuildChunkIndex();

		// Register vault event listeners for real-time chunk updates
		this.registerEvent(
			this.app.vault.on("modify", (file: TAbstractFile) => {
				if (file instanceof TFile && file.extension === "md") {
					this.debouncedUpdateFile(file);
				}
			})
		);

		this.registerEvent(
			this.app.vault.on("delete", (file: TAbstractFile) => {
				if (file instanceof TFile) {
					this.chunkManager.deleteFile(file.path);
					this.embeddingManager.deleteFileVectors(file.path);
					console.log(`Deleted chunks and vectors for: ${file.path}`);
				}
			})
		);

		this.registerEvent(
			this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
				if (file instanceof TFile) {
					this.chunkManager.renameFile(oldPath, file.path);
					this.embeddingManager.renameFileVectors(oldPath, file.path);
					console.log(`Renamed chunks and vectors: ${oldPath} -> ${file.path}`);
				}
			})
		);

		// Register the chatbot view type
		this.registerView(
			VIEW_TYPE_CHATBOT,
			(leaf) => new ChatbotView(leaf, this, this.ragEngine)
		);

		// Add ribbon icon to toggle chatbot
		this.addRibbonIcon('message-square', 'Toggle Chatbot', () => {
			this.toggleView();
		});

		// This adds a status bar item to the bottom of the app. Does not work on mobile apps.
		const statusBarItemEl = this.addStatusBarItem();
		statusBarItemEl.setText('Status bar text');

		// This adds a simple command that can be triggered anywhere
		this.addCommand({
			id: 'open-modal-simple',
			name: 'Open modal (simple)',
			callback: () => {
				new SampleModal(this.app).open();
			}
		});
		
		// Add command to rebuild the chunk index and embeddings
		this.addCommand({
			id: 'rebuild-index',
			name: 'Rebuild Index',
			callback: async () => {
				await this.rebuildChunkIndex();
				await this.rebuildEmbeddings();
			}
		});

		// Add command to force rebuild (clears cache first)
		this.addCommand({
			id: 'force-rebuild-index',
			name: 'Force Rebuild Index (Clear Cache)',
			callback: async () => {
				await this.forceRebuildIndex();
			}
		});

		// Add debug command to inspect chunks for current file
		this.addCommand({
			id: 'debug-inspect-chunks',
			name: 'Debug: Inspect File Chunks',
			callback: async () => {
				await this.debugInspectChunks();
			}
		});

		// Add command to test search functionality
		this.addCommand({
			id: 'test-search',
			name: 'Test Search',
			callback: async () => {
				await this.testSearch();
			}
		});
		
		// This adds an editor command that can perform some operation on the current editor instance
		this.addCommand({
			id: 'replace-selected',
			name: 'Replace selected content',
			editorCallback: (editor: Editor, view: MarkdownView) => {
				editor.replaceSelection('Sample editor command');
			}
		});
		// This adds a complex command that can check whether the current state of the app allows execution of the command
		this.addCommand({
			id: 'open-modal-complex',
			name: 'Open modal (complex)',
			checkCallback: (checking: boolean) => {
				// Conditions to check
				const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (markdownView) {
					// If checking is true, we're simply "checking" if the command can be run.
					// If checking is false, then we want to actually perform the operation.
					if (!checking) {
						new SampleModal(this.app).open();
					}

					// This command will only show up in Command Palette when the check function returns true
					return true;
				}
				return false;
			}
		});

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new SampleSettingTab(this.app, this));

		// If the plugin hooks up any global DOM events (on parts of the app that doesn't belong to this plugin)
		// Using this function will automatically remove the event listener when this plugin is disabled.
		this.registerDomEvent(document, 'click', (evt: MouseEvent) => {
			// new Notice("Click");
		});

		// When registering intervals, this function will automatically clear the interval when the plugin is disabled.
		this.registerInterval(window.setInterval(() => console.log('setInterval'), 5 * 60 * 1000));

	}

	async toggleView() {
		const { workspace } = this.app;

		const existingLeaves = workspace.getLeavesOfType(VIEW_TYPE_CHATBOT);

		if (existingLeaves.length > 0) {
			// Close all existing chatbot views
			existingLeaves.forEach(leaf => leaf.detach());
		} else {
			// Open chatbot in the right sidebar
			const rightLeaf = workspace.getRightLeaf(false);
			if (rightLeaf) {
				await rightLeaf.setViewState({
					type: VIEW_TYPE_CHATBOT,
					active: true,
				});
				workspace.revealLeaf(rightLeaf);
			}
		}
	}

	async onunload() {
		// Save any pending vector changes
		if (this.vectorStore?.hasUnsavedChanges()) {
			await this.vectorStore.save();
		}
	}

	async indexVault() {
		const notice = new Notice("Indexing vault...", 0);
		try {
			if (this.settings.indexMarkdownOnly) {
				await this.indexer.indexVault();
			} else {
				await this.indexer.indexAllFiles();
			}
			notice.hide();
			new Notice(`Indexed ${this.indexer.getFileCount()} files`);
		} catch (error) {
			notice.hide();
			new Notice("Error indexing vault");
			console.error("Vault indexing error:", error);
		}
	}

	async rebuildChunkIndex() {
		const notice = new Notice("Rebuilding chunk index...", 0);
		try {
			const chunkCount = await this.chunkManager.processAllFiles();
			notice.hide();
			new Notice(`Created ${chunkCount} chunks from ${this.chunkManager.getFileCount()} files`);
		} catch (error) {
			notice.hide();
			new Notice("Error rebuilding chunk index");
			console.error("Chunk index rebuild error:", error);
		}
	}

	async rebuildEmbeddings() {
		if (!this.settings.openRouterApiKey) {
			new Notice("API key not set. Skipping embeddings.");
			return;
		}

		const notice = new Notice("Generating embeddings...", 0);
		try {
			this.embeddingManager.setApiKey(this.settings.openRouterApiKey);
			const result = await this.embeddingManager.embedAllFiles();
			notice.hide();
			
			if (result.error) {
				new Notice(`Embedding error: ${result.error}`);
			} else {
				new Notice(`Embeddings: ${result.processed} new, ${result.skipped} cached, ${result.failed} failed`);
			}
		} catch (error) {
			notice.hide();
			new Notice("Error generating embeddings");
			console.error("Embedding error:", error);
		}
	}

	async forceRebuildIndex() {
		try {
			// Step 1: Clear vector cache
			new Notice("Clearing vector cache...");
			await this.vectorStore.clearAll();
			console.log("Vector cache cleared.");

			// Step 2: Rebuild chunks
			await this.rebuildChunkIndex();

			// Step 3: Rebuild embeddings (will fetch all since cache is empty)
			await this.rebuildEmbeddings();

			new Notice("Force rebuild complete!");
		} catch (error) {
			new Notice("Force rebuild failed. Check console for details.");
			console.error("Force rebuild error:", error);
		}
	}

	async debugInspectChunks() {
		// Get the currently active file
		const activeFile = this.app.workspace.getActiveFile();
		
		if (!activeFile) {
			new Notice("No active file. Please open a markdown file.");
			return;
		}

		if (activeFile.extension !== "md") {
			new Notice("Active file is not a markdown file.");
			return;
		}

		// Get chunks for this file
		const chunks = this.chunkManager.getChunksForFile(activeFile.path);

		if (chunks.length === 0) {
			new Notice(`No chunks found for ${activeFile.name}. Try running 'Rebuild Index' first.`);
			console.log(`No chunks found for: ${activeFile.path}`);
			return;
		}

		new Notice(`Found ${chunks.length} chunks. Check console for details.`);

		console.log("=".repeat(60));
		console.log(`DEBUG: Chunks for file: ${activeFile.path}`);
		console.log(`Total chunks: ${chunks.length}`);
		console.log("=".repeat(60));

		chunks.forEach((chunk, index) => {
			console.log(`\n--- Chunk [${index}] ---`);
			console.log(`ID: ${chunk.id}`);
			console.log(`FileLink: ${chunk.fileLink}`);
			console.log(`Length: ${chunk.content.length} characters`);
			console.log(`Content Preview (first 300 chars):`);
			console.log(chunk.content.substring(0, 300));
			if (chunk.content.length > 300) {
				console.log("...[truncated]");
			}
		});

		console.log("\n" + "=".repeat(60));
		console.log("END DEBUG OUTPUT");
		console.log("=".repeat(60));
	}

	async testSearch() {
		if (!this.settings.openRouterApiKey) {
			new Notice("API key not set. Please configure it in settings.");
			return;
		}

		// Open modal to get search query
		new SearchInputModal(this.app, async (query) => {
			if (!query || query.trim() === "") {
				new Notice("Empty query.");
				return;
			}

			const notice = new Notice("Searching...", 0);
			try {
				const results = await this.embeddingManager.search(query.trim(), 3);
				notice.hide();

				if (results.length === 0) {
					new Notice("No results found.");
					console.log("Search returned no results for:", query);
					return;
				}

				new Notice(`Found ${results.length} results. Check console for details.`);
				
				console.log("=== Search Results ===");
				console.log(`Query: "${query}"`);
				console.log("---");
				
				results.forEach((result, index) => {
					console.log(`\n[${index + 1}] Score: ${result.score.toFixed(4)}`);
					console.log(`    Source: ${result.fileLink} (${result.filePath})`);
					console.log(`    Content: ${result.content.substring(0, 200)}...`);
				});
				
				console.log("\n=== End Results ===");
			} catch (error) {
				notice.hide();
				new Notice("Search failed. Check console for details.");
				console.error("Search error:", error);
			}
		}).open();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<MyPluginSettings>);
	}

	async saveSettings() {
		await this.saveData(this.settings);
		// Update embedding manager and RAG engine with new API key if it changes
		if (this.embeddingManager) {
			this.embeddingManager.setApiKey(this.settings.openRouterApiKey);
		}
		if (this.ragEngine) {
			this.ragEngine.setApiKey(this.settings.openRouterApiKey);
			this.ragEngine.setModel(this.settings.openRouterModel);
		}
		// Update privacy manager settings
		if (this.privacyManager) {
			this.privacyManager.setEnabled(this.settings.enableRedaction);
			this.privacyManager.setCustomPatterns(this.settings.customRedactionPatterns);
		}
	}
}

class SampleModal extends Modal {
	constructor(app: App) {
		super(app);
	}

	onOpen() {
		let {contentEl} = this;
		contentEl.setText('Woah!');
	}

	onClose() {
		const {contentEl} = this;
		contentEl.empty();
	}
}

class SearchInputModal extends Modal {
	private onSubmit: (query: string) => void;
	private inputEl: HTMLInputElement | null = null;

	constructor(app: App, onSubmit: (query: string) => void) {
		super(app);
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("search-input-modal");

		contentEl.createEl("h3", { text: "Search Notes" });

		this.inputEl = contentEl.createEl("input", {
			type: "text",
			placeholder: "Enter search query...",
			cls: "search-input"
		});
		this.inputEl.style.width = "100%";
		this.inputEl.style.padding = "8px";
		this.inputEl.style.marginBottom = "12px";

		this.inputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				this.submit();
			}
		});

		const buttonContainer = contentEl.createDiv({ cls: "search-button-container" });
		buttonContainer.style.display = "flex";
		buttonContainer.style.justifyContent = "flex-end";
		buttonContainer.style.gap = "8px";

		const cancelBtn = buttonContainer.createEl("button", { text: "Cancel" });
		cancelBtn.addEventListener("click", () => this.close());

		const searchBtn = buttonContainer.createEl("button", { text: "Search", cls: "mod-cta" });
		searchBtn.addEventListener("click", () => this.submit());

		// Focus input after modal opens
		setTimeout(() => this.inputEl?.focus(), 10);
	}

	private submit() {
		const query = this.inputEl?.value ?? "";
		this.close();
		this.onSubmit(query);
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
