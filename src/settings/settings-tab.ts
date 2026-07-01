import { App, PluginSettingTab, Setting } from "obsidian";
import MyPlugin from "../main";
import { IndexedFilesModal } from "./indexed-files-modal";
import { CHAT_PROVIDER_LABELS, EMBEDDING_PROVIDER_LABELS } from "../llm/factory";
import type { ChatProviderId, EmbeddingProviderId } from "../llm/types";

/**
 * Render a section heading with a one-line, plain-language description
 * underneath it, so people who aren't familiar with RAG/embeddings jargon
 * still know what a section is for at a glance.
 */
function addSectionHeading(containerEl: HTMLElement, title: string, description: string): void {
	containerEl.createEl("h3", { text: title });
	containerEl.createEl("p", { text: description, cls: "settings-section-desc" });
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

		// ===== AI Provider Section =====
		addSectionHeading(
			containerEl,
			"AI provider",
			"Choose which AI service powers chat and note search, and enter its credentials. Chat and search can use different providers."
		);

		containerEl.createEl("h4", { text: "Chat" });
		new Setting(containerEl)
			.setName('Chat provider')
			.setDesc('Which AI service answers your questions in the chat view.')
			.addDropdown(dropdown => {
				for (const id of Object.keys(CHAT_PROVIDER_LABELS) as ChatProviderId[]) {
					dropdown.addOption(id, CHAT_PROVIDER_LABELS[id]);
				}
				dropdown
					.setValue(this.plugin.settings.chatProvider)
					.onChange(async (value) => {
						this.plugin.settings.chatProvider = value as ChatProviderId;
						await this.plugin.saveSettings();
						this.display();
					});
			});
		this.renderChatProviderFields(containerEl);

		containerEl.createEl("h4", { text: "Embeddings" });
		new Setting(containerEl)
			.setName('Embedding provider')
			.setDesc('Which AI service turns your notes into searchable vectors during indexing. Can be a different service than chat (for example, a local Ollama model here with a hosted chat model above).')
			.addDropdown(dropdown => {
				for (const id of Object.keys(EMBEDDING_PROVIDER_LABELS) as EmbeddingProviderId[]) {
					dropdown.addOption(id, EMBEDDING_PROVIDER_LABELS[id]);
				}
				dropdown
					.setValue(this.plugin.settings.embeddingProvider)
					.onChange(async (value) => {
						this.plugin.settings.embeddingProvider = value as EmbeddingProviderId;
						await this.plugin.saveSettings();
						this.display();
					});
			});
		this.renderEmbeddingProviderFields(containerEl);

		// ===== Vault Indexer Section =====
		addSectionHeading(
			containerEl,
			"Vault indexer",
			"Controls which files get scanned and how the plugin reacts as you edit your vault."
		);

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
			.setName('Auto-detect changes')
			.setDesc('If enabled, the plugin will automatically re-index files while you edit. Disable to pause indexing.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoIndexChanges)
				.onChange(async (value) => {
					this.plugin.settings.autoIndexChanges = value;
					await this.plugin.saveSettings();
				}));

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
		addSectionHeading(
			containerEl,
			"Folder exclusion",
			"Keep specific folders out of search and indexing entirely."
		);

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
		addSectionHeading(
			containerEl,
			"Privacy & redaction",
			"Automatically strip sensitive data like API keys and emails before anything is indexed."
		);

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

		// ===== Chunking Section =====
		addSectionHeading(
			containerEl,
			"Chunking",
			"Controls how notes are split into pieces before being turned into embeddings. Most people can leave these at the defaults."
		);

		new Setting(containerEl)
			.setName('Chunking strategy')
			.setDesc('Markdown splits notes by heading structure (recommended). Character uses fixed-size blocks. Changing this requires a Force Rebuild Index.')
			.addDropdown(dropdown => dropdown
				.addOption('markdown', 'Markdown (structure-aware)')
				.addOption('character', 'Character (fixed-size)')
				.setValue(this.plugin.settings.chunkingStrategy)
				.onChange(async (value) => {
					this.plugin.settings.chunkingStrategy = value === 'character' ? 'character' : 'markdown';
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Chunk size')
			.setDesc('Target maximum characters per chunk. Larger chunks add context but reduce precision. Changing this requires a Force Rebuild Index.')
			.addSlider(slider => slider
				.setLimits(400, 3000, 100)
				.setValue(this.plugin.settings.chunkSize)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.chunkSize = value;
					// Keep overlap strictly below chunk size.
					if (this.plugin.settings.chunkOverlap >= value) {
						this.plugin.settings.chunkOverlap = Math.floor(value / 5);
					}
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Chunk overlap')
			.setDesc('Characters shared between adjacent chunks to preserve context across boundaries. Must be less than chunk size. Changing this requires a Force Rebuild Index.')
			.addSlider(slider => slider
				.setLimits(0, 600, 50)
				.setValue(this.plugin.settings.chunkOverlap)
				.setDynamicTooltip()
				.onChange(async (value) => {
					// Clamp overlap below chunk size to satisfy the splitter invariant.
					this.plugin.settings.chunkOverlap = Math.min(value, this.plugin.settings.chunkSize - 100);
					await this.plugin.saveSettings();
				}));

		// ===== Search & Retrieval Section =====
		addSectionHeading(
			containerEl,
			"Search & retrieval",
			"Fine-tunes how the plugin finds and ranks the most relevant notes for your question."
		);

		new Setting(containerEl)
			.setName('Hybrid fusion method')
			.setDesc('How dense (vector) and keyword (BM25) results are combined. Reciprocal Rank Fusion is robust and recommended; weighted lets you bias toward vector or keyword matches.')
			.addDropdown(dropdown => dropdown
				.addOption('rrf', 'Reciprocal Rank Fusion (recommended)')
				.addOption('weighted', 'Weighted sum')
				.setValue(this.plugin.settings.hybridStrategy)
				.onChange(async (value) => {
					this.plugin.settings.hybridStrategy = value === 'weighted' ? 'weighted' : 'rrf';
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Vector weight (weighted mode)')
			.setDesc('Only used with weighted fusion. 1.0 = pure vector similarity, 0.0 = pure keyword (BM25). The remainder is given to keyword matching.')
			.addSlider(slider => slider
				.setLimits(0, 100, 5)
				.setValue(Math.round(this.plugin.settings.vectorWeight * 100))
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.vectorWeight = value / 100;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Retrieval pool size')
			.setDesc('Number of initial chunks to fetch from each retriever before fusion. Higher values may improve accuracy but increase processing time.')
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
			.setDesc('Maximum number of top matches considered before relevance filtering and packing. Higher values improve recall but consider more candidates.')
			.addSlider(slider => slider
				.setLimits(1, 30, 1)
				.setValue(this.plugin.settings.maxContextChunks)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.maxContextChunks = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Relevance threshold')
			.setDesc('Drop matches scoring below this fraction of the top match. Higher values send fewer, more relevant chunks (better for vague queries); 0 disables filtering.')
			.addSlider(slider => slider
				.setLimits(0, 100, 5)
				.setValue(Math.round(this.plugin.settings.relevanceThreshold * 100))
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.relevanceThreshold = value / 100;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Context token budget')
			.setDesc('Approximate maximum tokens of note context sent to the LLM. Chunks are packed until this budget is reached.')
			.addSlider(slider => slider
				.setLimits(1000, 16000, 500)
				.setValue(this.plugin.settings.contextTokenBudget)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.contextTokenBudget = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Neighbor expansion')
			.setDesc('Include the chunks immediately before and after each match from the same note, giving the model fuller surrounding context.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.neighborExpansion)
				.onChange(async (value) => {
					this.plugin.settings.neighborExpansion = value;
					await this.plugin.saveSettings();
				}));

		// ===== Query Enhancement Section =====
		addSectionHeading(
			containerEl,
			"Query enhancement",
			"Optional extra AI steps that can improve answer quality at the cost of a bit more time and tokens per message."
		);

		new Setting(containerEl)
			.setName('Conversation-aware query rewriting')
			.setDesc('Before searching, rewrite follow-up questions into a standalone query using the conversation, so references like "the other one" resolve correctly. Adds one small LLM call per follow-up message.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.queryRewriting)
				.onChange(async (value) => {
					this.plugin.settings.queryRewriting = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('HyDE (hypothetical document embeddings)')
			.setDesc('Generate a short hypothetical answer and embed that for vector search, which often matches notes better than embedding the raw question. Improves vague queries at the cost of one extra LLM call per message. Off by default.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.useHyde)
				.onChange(async (value) => {
					this.plugin.settings.useHyde = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('LLM reranker')
			.setDesc('Retrieve a wider candidate pool and have the model reorder it by relevance before answering. Highest precision, but adds a larger LLM call per message. Off by default.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.useReranker)
				.onChange(async (value) => {
					this.plugin.settings.useReranker = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Reranker candidate pool')
			.setDesc('How many candidates to send to the reranker when it is enabled. Larger pools improve recall but cost more tokens.')
			.addSlider(slider => slider
				.setLimits(5, 50, 5)
				.setValue(this.plugin.settings.rerankCandidates)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.rerankCandidates = value;
					await this.plugin.saveSettings();
				}));

	}

	/** Render the API key/base URL + model fields for the selected chat provider. */
	private renderChatProviderFields(containerEl: HTMLElement): void {
		switch (this.plugin.settings.chatProvider) {
			case 'openai':
				this.addApiKeySetting(
					containerEl,
					'OpenAI API key',
					'Get one at platform.openai.com.',
					'sk-...',
					() => this.plugin.settings.openAIApiKey,
					(value) => { this.plugin.settings.openAIApiKey = value; }
				);
				this.addModelSetting(
					containerEl,
					'Chat model',
					'The model ID to use for chat (e.g., gpt-4o-mini, gpt-4o).',
					'gpt-4o-mini',
					() => this.plugin.settings.openAIModel,
					(value) => { this.plugin.settings.openAIModel = value; }
				);
				break;
			case 'ollama':
				this.addOllamaBaseUrlSetting(containerEl);
				this.addModelSetting(
					containerEl,
					'Chat model',
					'The name of a model you have pulled locally (e.g., llama3.1, mistral, qwen2.5).',
					'llama3.1',
					() => this.plugin.settings.ollamaModel,
					(value) => { this.plugin.settings.ollamaModel = value; }
				);
				break;
			case 'openrouter':
			default:
				this.addApiKeySetting(
					containerEl,
					'OpenRouter API key',
					'Get one at openrouter.ai.',
					'sk-or-...',
					() => this.plugin.settings.openRouterApiKey,
					(value) => { this.plugin.settings.openRouterApiKey = value; }
				);
				this.addModelSetting(
					containerEl,
					'Chat model',
					'The model ID to use for chat (e.g., google/gemini-2.5-flash, openai/gpt-4o, anthropic/claude-3.5-sonnet).',
					'google/gemini-2.5-flash',
					() => this.plugin.settings.openRouterModel,
					(value) => { this.plugin.settings.openRouterModel = value; }
				);
				break;
		}
	}

	/** Render the API key/base URL + model fields for the selected embedding provider. */
	private renderEmbeddingProviderFields(containerEl: HTMLElement): void {
		switch (this.plugin.settings.embeddingProvider) {
			case 'openai':
				this.addApiKeySetting(
					containerEl,
					'OpenAI API key',
					'Get one at platform.openai.com.',
					'sk-...',
					() => this.plugin.settings.openAIApiKey,
					(value) => { this.plugin.settings.openAIApiKey = value; }
				);
				this.addModelSetting(
					containerEl,
					'Embedding model',
					'The model ID to use for embeddings (e.g., text-embedding-3-small).',
					'text-embedding-3-small',
					() => this.plugin.settings.openAIEmbeddingModel,
					(value) => { this.plugin.settings.openAIEmbeddingModel = value; }
				);
				break;
			case 'ollama':
				this.addOllamaBaseUrlSetting(containerEl);
				this.addModelSetting(
					containerEl,
					'Embedding model',
					'The name of a local embedding model you have pulled (e.g., nomic-embed-text).',
					'nomic-embed-text',
					() => this.plugin.settings.ollamaEmbeddingModel,
					(value) => { this.plugin.settings.ollamaEmbeddingModel = value; }
				);
				break;
			case 'openrouter':
			default:
				this.addApiKeySetting(
					containerEl,
					'OpenRouter API key',
					'Get one at openrouter.ai.',
					'sk-or-...',
					() => this.plugin.settings.openRouterApiKey,
					(value) => { this.plugin.settings.openRouterApiKey = value; }
				);
				this.addModelSetting(
					containerEl,
					'Embedding model',
					'The model ID to use for embeddings (e.g., openai/text-embedding-3-small).',
					'openai/text-embedding-3-small',
					() => this.plugin.settings.openRouterEmbeddingModel,
					(value) => { this.plugin.settings.openRouterEmbeddingModel = value; }
				);
				break;
		}
	}

	private addApiKeySetting(
		containerEl: HTMLElement,
		name: string,
		desc: string,
		placeholder: string,
		getValue: () => string,
		setValue: (value: string) => void
	): void {
		new Setting(containerEl)
			.setName(name)
			.setDesc(desc)
			.addText(text => {
				text.setPlaceholder(placeholder)
					.setValue(getValue())
					.onChange(async (value) => {
						setValue(value);
						await this.plugin.saveSettings();
					});
				text.inputEl.type = 'password';
				return text;
			});
	}

	private addModelSetting(
		containerEl: HTMLElement,
		name: string,
		desc: string,
		placeholder: string,
		getValue: () => string,
		setValue: (value: string) => void
	): void {
		new Setting(containerEl)
			.setName(name)
			.setDesc(desc)
			.addText(text => text
				.setPlaceholder(placeholder)
				.setValue(getValue())
				.onChange(async (value) => {
					setValue(value);
					await this.plugin.saveSettings();
				}));
	}

	private addOllamaBaseUrlSetting(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName('Ollama base URL')
			.setDesc('Where your local Ollama server is running. No API key is needed, but Ollama must be running and reachable at this address.')
			.addText(text => text
				.setPlaceholder('http://localhost:11434')
				.setValue(this.plugin.settings.ollamaBaseUrl)
				.onChange(async (value) => {
					this.plugin.settings.ollamaBaseUrl = value;
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
