# Obsidian note+

A professional, privacy-focused AI assistant for your Obsidian vault. This plugin implements a high-performance Retrieval-Augmented Generation (RAG) pipeline to turn your notes into an interactive, searchable knowledge base.

---

## Overview

Obsidian note+ provides a sidebar chatbot that "reads" your vault to answer questions with precision. It combines semantic vector search with keyword-based reranking to ensure accurate retrieval even in large, complex vaults.

### Key Features

* **Semantic Chat**: Engage in natural language conversations with your notes using advanced embeddings.
* **Privacy-First Redaction**: Automatic local PII protection; sensitive data like API keys and emails are redacted *before* leaving your machine.
* **Hybrid Search**: Optimized retrieval pool logic that combines vector similarity with keyword boosting for pinpoint accuracy.
* **Context Scoping**: A GitHub Copilot-inspired context picker to narrow your search to specific tags, folders, or files.
* **Smart Citations**: AI responses include standard `[[WikiLinks]]` that are fully clickable and navigate directly to your source notes.

---

## Getting Started

### Installation

1. **Clone or Download**: Place the plugin folder in your vault's `.obsidian/plugins/` directory.
2. **Install Dependencies**: Open a terminal in the plugin folder and run:
```bash
npm install

```


3. **Build**: Compile the TypeScript source into the executable plugin:
```bash
npm run build

```



### First-Launch Configuration

1. **Enable**: Go to **Settings > Community Plugins** and toggle on **Obsidian note+**.
2. **API Key**: Enter your **OpenRouter API Key** in the plugin settings.
3. **Model Selection**: Choose your preferred LLM (default is `google/gemini-2.5-flash`).
4. **Initial Indexing**: Open the Command Palette (`Ctrl/Cmd + P`) and run:
`Obsidian Note+: Rebuild Index`
This will perform the initial chunking and embedding of your vault.

---

## Commands

| Command | Action |
| --- | --- |
| **Open Chatbot** | Opens the interactive chat view in the right sidebar. |
| **Rebuild Index** | Scans for new/modified files and updates the vector cache incrementally. |
| **Force Rebuild Index** | Deletes the local `embeddings.json` and re-indexes the entire vault (use this if accuracy drops or logic changes). |
| **Purge Excluded Chunks** | Instantly removes vectors belonging to folders added to your "Excluded Folders" list. |
| **Test Search** | Debug tool to see raw similarity scores and retrieved chunks for a specific query. |
| **Debug: Inspect File Chunks** | Visualizes how the active note is being "seen" and split by the AI. |

---

## How It Works

The plugin follows a rigorous data pipeline to ensure both performance and privacy:

1. **Privacy Scrubbing**: The `PrivacyManager` runs regex patterns to replace sensitive strings with placeholders (e.g., `[REDACTED_API_KEY]`).
2. **Recursive Chunking**: Notes are split into ~1000 character segments, respecting headers and paragraphs to maintain semantic context.
3. **Vector Storage**: Embeddings are stored locally in `embeddings.json`. The plugin uses a "Smart Embed" logic to skip files that haven't been modified.
4. **Hybrid Retrieval**: When you ask a question, the plugin fetches a large pool of results (default 50) and reranks them locally based on keyword matches before sending the best 15 to the AI.

---

## Privacy Notice

This plugin is designed to keep your data as safe as possible.

* **Local Processing**: Chunking, redaction, and reranking happen entirely on your device.
* **External Access**: Only redacted text chunks and your specific chat queries are sent to OpenRouter.
* **No Analytics**: This plugin does not track your usage or collect telemetry.

---

## License

Distributed under the MIT License. See `LICENSE` for more information.
