import {App, debounce, Editor, MarkdownView, Modal, Notice, Plugin, TAbstractFile, TFile} from 'obsidian';
import {DEFAULT_SETTINGS, MyPluginSettings, SampleSettingTab} from "./settings";
import { ChatbotView, VIEW_TYPE_CHATBOT } from "./views/views";
import { VaultIndexer } from "./indexer";
import { ChunkManager } from "./indexer/chunk-manager";
import { VectorStore } from "./indexer/vector-store";
import { EmbeddingManager } from "./indexer/embedding-manager";

export default class HelloWorldPlugin extends Plugin {
	settings: MyPluginSettings;
	indexer: VaultIndexer;
	chunkManager: ChunkManager;
	vectorStore: VectorStore;
	embeddingManager: EmbeddingManager;
	
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
		
		// Initialize the chunk manager
		this.chunkManager = new ChunkManager(this.app, {
			chunkSize: 1000,
			chunkOverlap: 200
		});
		
		// Initialize the vector store
		this.vectorStore = new VectorStore(this);
		await this.vectorStore.load();
		
		// Initialize the embedding manager
		this.embeddingManager = new EmbeddingManager(
			this.chunkManager,
			this.vectorStore,
			{ batchSize: 20, batchDelayMs: 100 }
		);
		this.embeddingManager.setApiKey(this.settings.openRouterApiKey);
		
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
			(leaf) => new ChatbotView(leaf, this) // Pass plugin instance
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

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<MyPluginSettings>);
	}

	async saveSettings() {
		await this.saveData(this.settings);
		// Update embedding manager with new API key if it changes
		if (this.embeddingManager) {
			this.embeddingManager.setApiKey(this.settings.openRouterApiKey);
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
