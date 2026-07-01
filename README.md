# Obsidian note+

A professional, privacy-focused AI assistant for your Obsidian vault. This plugin implements a high-performance Retrieval-Augmented Generation (RAG) pipeline to turn your notes into an interactive, searchable knowledge base.

---

## Overview

Obsidian note+ provides a sidebar chatbot that "reads" your vault to answer questions with precision. It combines semantic vector search with BM25 keyword search, optional query enhancement, and optional LLM reranking to ensure accurate retrieval even in large, complex vaults.

### Key Features

* **Semantic Chat**: Engage in natural language conversations with your notes using advanced embeddings.
* **Hybrid Retrieval**: Dense vector similarity fused with BM25 keyword scoring (via Reciprocal Rank Fusion or a tunable weighted sum), so exact terms and semantic meaning are both covered.
* **Structure-Aware Chunking**: Notes are split along their markdown heading hierarchy (not blind fixed-size blocks), and every chunk is tagged with its heading breadcrumb for better embeddings.
* **Query Enhancement**: Optional conversation-aware query rewriting (so "the other one" resolves correctly) and HyDE (Hypothetical Document Embeddings) for vague queries.
* **LLM Reranking**: Optional "retrieve wide, rerank narrow" pass where the model reorders candidates by true relevance before the final answer is generated.
* **Context Packing**: Neighbor-chunk expansion and a configurable token budget assemble the most complete, relevant context without blowing past your model's limits.
* **Privacy-First Redaction**: Automatic local PII protection; sensitive data like API keys, tokens, and emails are redacted *before* anything leaves your machine.
* **Context Scoping**: A context picker to narrow your search to specific tags, folders, or files.
* **Smart Citations**: AI responses include standard `[[WikiLinks]]` that are fully clickable and navigate directly to your source notes.
* **Incremental Indexing**: Only changed files are re-chunked and re-embedded, so startup and edits stay fast even in large vaults.

---

## RAG Architecture

Every question you ask goes through the following pipeline (see `src/chat/rag-engine.ts` for the orchestration):

```
Your Note                                Your Question
   │                                          │
   ▼                                          ▼
1. Privacy Scrubbing                  5. Query Rewriting (optional)
   (PrivacyManager redacts             Resolves follow-ups like "the
   secrets before anything             other one" into a standalone
   is chunked or embedded)             query using chat history
   │                                          │
   ▼                                          ▼
2. Structure-Aware Chunking           6. HyDE (optional)
   (MarkdownTextSplitter splits         Generates a short hypothetical
   by heading hierarchy, keeps          answer passage and embeds THAT
   code fences intact, tags each        instead of the raw question —
   chunk with a heading breadcrumb)     often matches real notes better
   │                                          │
   ▼                                          ▼
3. Embedding                          7. Hybrid Search
   (EmbeddingManager hashes             (EmbeddingManager queries the
   content to skip unchanged            VectorStore for dense/cosine
   chunks, batches calls to the         matches AND the LexicalIndex for
   OpenRouter embeddings API)           BM25 keyword matches, in parallel)
   │                                          │
   ▼                                          ▼
4. Vector Storage                     8. Fusion (RRF or Weighted)
   (VectorStore persists vectors        Reciprocal Rank Fusion (default)
   to a dedicated embeddings.json,      or a tunable weighted blend
   separate from plugin settings)       merges the two ranked lists
                                               │
                                               ▼
                                       9. Reranking (optional)
                                          A single LLM call reorders the
                                          fused candidates by true
                                          relevance ("retrieve wide,
                                          rerank narrow")
                                               │
                                               ▼
                                       10. Context Packing
                                           Survivors are expanded with
                                           neighboring chunks from the
                                           same note and packed into your
                                           configured token budget
                                               │
                                               ▼
                                       11. Answer Generation
                                           The packed context + numbered
                                           sources are sent to your chosen
                                           LLM, which cites [[WikiLinks]]
                                           back to your notes
```

### Component map

| Component | File | Responsibility |
| --- | --- | --- |
| `PrivacyManager` | `src/indexer/privacy-manager.ts` | Redacts API keys, tokens, emails, and private keys before content is chunked. |
| `ChunkManager` / `DocumentSplitter` | `src/indexer/chunk-manager.ts`, `src/indexer/text-splitter.ts` | Splits notes into heading-aware (or fixed-size) chunks with overlap. |
| `VectorStore` | `src/indexer/vector-store.ts` | Persists embeddings + metadata to `embeddings.json`; does cosine similarity search and filtering. |
| `LexicalIndex` | `src/indexer/lexical-index.ts` | In-memory BM25 keyword index, rebuilt lazily when the vector store changes. |
| `EmbeddingManager` | `src/indexer/embedding-manager.ts` | Coordinates embedding calls, hybrid search, and RRF/weighted fusion. |
| `query-transformer` | `src/chat/query-transformer.ts` | Conversation-aware query rewriting and HyDE document generation. |
| `reranker` | `src/chat/reranker.ts` | Optional LLM-based reranking of the fused candidate pool. |
| `RAGEngine` | `src/chat/rag-engine.ts` | Orchestrates the full pipeline end-to-end and builds the final prompt. |
| `openrouter` | `src/llm/openrouter.ts` | Talks to the OpenRouter API for both embeddings and chat completions. |

Because retrieval is hybrid, a query that only shares exact keywords with a note (e.g. a project codename) is just as retrievable as one that's only semantically similar — the two ranked lists are always fused together rather than one replacing the other.

---

## Getting Started

### Installation

You can install Obsidian note+ either by downloading a release or by building it from source.

#### Option A: Manual install from a release

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](../../releases).
2. In your vault, create the folder `<VaultFolder>/.obsidian/plugins/obsidian-note+/`.
3. Copy the three downloaded files into that folder.
4. Reload Obsidian (or use **Settings → Community plugins → Reload plugins**).
5. Go to **Settings → Community plugins**, find **Obsidian note+**, and toggle it on.

#### Option B: Build from source

1. **Clone or download** this repository into your vault's `.obsidian/plugins/` directory, in a folder named `obsidian-note+`:

```bash
cd <VaultFolder>/.obsidian/plugins
git clone <repo-url> obsidian-note+
cd obsidian-note+
```

2. **Install dependencies**:

```bash
npm install
```

3. **Build the plugin**:

```bash
npm run build
```

This runs a type-check and produces `main.js` at the plugin root using esbuild. For active development, use `npm run dev` instead to watch and rebuild on file changes.

4. **Enable the plugin**: Go to **Settings → Community plugins**, disable **Restricted mode** if needed, then toggle on **Obsidian note+**.

> **Requirements**: Node.js 18+ and npm. See `AGENTS.md` for the full development environment reference.

### First-Launch Configuration

1. **Enable**: Go to **Settings → Community plugins** and toggle on **Obsidian note+**.
2. **API key**: Open the plugin settings and enter your **OpenRouter API key** under **General settings**. Get one at [openrouter.ai](https://openrouter.ai).
3. **Model selection**: Choose your preferred LLM under **OpenRouter chat model** (default is `google/gemini-2.5-flash`). Any OpenRouter-supported chat model ID works, e.g. `openai/gpt-4o`, `anthropic/claude-3.5-sonnet`.
4. **(Optional) tune retrieval**: Review the **Search & Retrieval** and **Query Enhancement** sections in settings — the defaults (hybrid RRF fusion, neighbor expansion, query rewriting) work well for most vaults, but larger vaults may benefit from a bigger retrieval pool or the LLM reranker.
5. **Initial indexing**: Open the Command Palette (`Ctrl/Cmd + P`) and run:

   `Obsidian note+: Rebuild Index`

   This performs the initial chunking, redaction, and embedding of your vault. Progress and results are shown via notices; large vaults may take a few minutes depending on your embedding API's rate limits.
6. **Open the chatbot**: Click the chat bubble icon in the left ribbon, or run the **Toggle Chatbot** ribbon action, to open the chat view in the right sidebar.

---

## Commands

All commands are available from the Command Palette (`Ctrl/Cmd + P`), prefixed with **Obsidian note+**.

| Command | Action |
| --- | --- |
| **Toggle Chatbot** *(ribbon icon)* | Opens or closes the interactive chat view in the right sidebar. |
| **Rebuild Index** | Scans for new/modified files and updates the chunk + vector cache incrementally. Use this after adding notes or changing indexing-related settings. |
| **Index Changed Files Now** | Same incremental scan as Rebuild Index, useful as an explicit "sync now" without waiting for auto-indexing. |
| **Force Rebuild Index (Clear Cache)** | Deletes the local `embeddings.json` and re-indexes the entire vault from scratch. Use this if retrieval accuracy drops, or after changing the chunking strategy, chunk size, or chunk overlap. |
| **Toggle Auto-Indexing (Pause/Resume)** | Pauses or resumes automatic re-indexing on file modify/delete/rename. Useful while bulk-editing notes you don't want re-embedded yet. |
| **Purge Excluded Folder Vectors** | Instantly removes vectors belonging to folders added to your **Excluded folders** setting, without a full rebuild. |
| **Test Search** | Debug tool: opens a prompt for a query and logs the raw hybrid search results (score, source, content preview) to the console. |
| **Debug: Inspect File Chunks** | Logs how the currently active note was split into chunks, including chunk IDs, headings, and content previews, to the console. |

### Settings tab actions

Beyond the Command Palette, the **Obsidian note+** settings tab (**Settings → Obsidian note+**) also exposes:

* **Re-index Vault** button — re-scans the vault's file list (used for the file browser/context picker), independent of chunking/embedding.
* **View Advanced** button — opens a searchable modal listing every indexed file with its size and extension.

---

## How It Works

The plugin follows a rigorous data pipeline to ensure both performance and privacy (see [RAG Architecture](#rag-architecture) above for the full diagram):

1. **Privacy Scrubbing**: The `PrivacyManager` runs regex patterns to replace sensitive strings with placeholders (e.g., `[REDACTED_API_KEY]`) before any chunking or embedding happens.
2. **Structure-Aware Chunking**: Notes are split along their markdown heading hierarchy into ~1000-character segments (configurable), preserving code fences and recording a heading breadcrumb per chunk. A fixed-size character strategy is available as an alternative.
3. **Vector Storage**: Embeddings are stored locally in a dedicated `embeddings.json` file (kept separate from plugin settings so it isn't rewritten on every settings change). Content is hashed so unchanged chunks are skipped on re-index ("smart embed").
4. **Hybrid Retrieval**: When you ask a question, the plugin retrieves a candidate pool from both dense vector search and BM25 keyword search, then fuses the two rankings (Reciprocal Rank Fusion by default).
5. **Query Enhancement** *(optional)*: Follow-up questions are rewritten into standalone queries using conversation history; HyDE can generate a hypothetical passage to embed instead of the literal question.
6. **Reranking** *(optional)*: A single LLM call reorders the fused candidate pool by true relevance before the final context is assembled.
7. **Context Packing**: Surviving chunks are expanded with their immediate neighbors from the same note and packed into a configurable token budget before being sent to the LLM with numbered source citations.

---

## Privacy Notice

This plugin is designed to keep your data as safe as possible.

* **Local Processing**: Chunking, redaction, lexical (BM25) search, fusion, and context packing all happen entirely on your device.
* **External Access**: Only redacted text chunks, your chat queries, and (if enabled) the intermediate query-rewriting/HyDE/reranking prompts are sent to OpenRouter.
* **No Analytics**: This plugin does not track your usage or collect telemetry.

---

## License

Distributed under the 0-BSD License. See `LICENSE` for more information.
