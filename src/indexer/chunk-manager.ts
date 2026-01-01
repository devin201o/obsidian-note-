import { App, TFile } from "obsidian";
import { RecursiveCharacterTextSplitter, TextSplitterConfig } from "./text-splitter";
import { PrivacyManager } from "./privacy-manager";

/**
 * Represents a chunk of text from a file
 */
export interface Chunk {
    /** Unique identifier: filepath::index */
    id: string;
    /** The chunk text content */
    content: string;
    /** Path to the source file */
    filePath: string;
    /** WikiLink format for LLM reference, e.g., [[My Note]] */
    fileLink: string;
    /** Index of this chunk within the file */
    chunkIndex: number;
}

/**
 * ChunkManager handles the chunking of vault files and maintains a registry of all chunks.
 * It uses RecursiveCharacterTextSplitter for intelligent text splitting.
 */
export class ChunkManager {
    private app: App;
    private splitter: RecursiveCharacterTextSplitter;
    private privacyManager: PrivacyManager;
    /** Map of file path to array of chunks */
    private chunksByFile: Map<string, Chunk[]> = new Map();

    constructor(app: App, privacyManager: PrivacyManager, splitterConfig?: Partial<TextSplitterConfig>) {
        this.app = app;
        this.privacyManager = privacyManager;
        this.splitter = new RecursiveCharacterTextSplitter(splitterConfig);
    }

    /**
     * Process a file: read its content, redact sensitive data, split into chunks, and store them
     */
    async processFile(file: TFile): Promise<Chunk[]> {
        // Only process markdown files
        if (file.extension !== "md") {
            return [];
        }

        // Read content from disk
        let content = await this.app.vault.read(file);
        
        // CRITICAL: Redact sensitive data BEFORE any splitting or embedding
        content = this.privacyManager.redact(content);
        
        const chunks = this.createChunksFromContent(content, file);
        this.chunksByFile.set(file.path, chunks);
        
        return chunks;
    }

    /**
     * Update a file: clear existing chunks and re-process
     */
    async updateFile(file: TFile): Promise<Chunk[]> {
        this.deleteFile(file.path);
        return this.processFile(file);
    }

    /**
     * Delete all chunks associated with a file path
     */
    deleteFile(path: string): void {
        this.chunksByFile.delete(path);
    }

    /**
     * Rename file: update filePath and id for all chunks without re-reading content
     */
    renameFile(oldPath: string, newPath: string): void {
        const chunks = this.chunksByFile.get(oldPath);
        if (!chunks) {
            return;
        }

        // Calculate new file link from new path
        const newFileLink = this.createFileLink(newPath);

        // Update each chunk with new path and id
        const updatedChunks = chunks.map(chunk => ({
            ...chunk,
            id: `${newPath}::${chunk.chunkIndex}`,
            filePath: newPath,
            fileLink: newFileLink
        }));

        // Remove old entry and add new one
        this.chunksByFile.delete(oldPath);
        this.chunksByFile.set(newPath, updatedChunks);
    }

    /**
     * Get all chunks as a flat array
     */
    getAllChunks(): Chunk[] {
        const allChunks: Chunk[] = [];
        for (const chunks of this.chunksByFile.values()) {
            allChunks.push(...chunks);
        }
        return allChunks;
    }

    /**
     * Get chunks for a specific file
     */
    getChunksForFile(path: string): Chunk[] {
        return this.chunksByFile.get(path) ?? [];
    }

    /**
     * Get the total number of chunks
     */
    getTotalChunkCount(): number {
        let count = 0;
        for (const chunks of this.chunksByFile.values()) {
            count += chunks.length;
        }
        return count;
    }

    /**
     * Get the number of files that have been chunked
     */
    getFileCount(): number {
        return this.chunksByFile.size;
    }

    /**
     * Clear all chunks
     */
    clearAll(): void {
        this.chunksByFile.clear();
    }

    /**
     * Process all markdown files in the vault
     */
    async processAllFiles(): Promise<number> {
        this.clearAll();
        const files = this.app.vault.getMarkdownFiles();
        
        for (const file of files) {
            await this.processFile(file);
        }
        
        return this.getTotalChunkCount();
    }

    /**
     * Create chunks from text content
     */
    private createChunksFromContent(content: string, file: TFile): Chunk[] {
        const textChunks = this.splitter.splitText(content);
        const fileLink = this.createFileLink(file.path);
        
        return textChunks.map((text, index) => ({
            id: `${file.path}::${index}`,
            content: text,
            filePath: file.path,
            fileLink: fileLink,
            chunkIndex: index
        }));
    }

    /**
     * Create a WikiLink from a file path
     * e.g., "folder/My Note.md" -> "[[My Note]]"
     */
    private createFileLink(path: string): string {
        // Remove .md extension and get just the filename
        const fileName = path.replace(/\.md$/, "");
        // Extract just the note name (last part of path without extension)
        const noteName = fileName.split("/").pop() ?? fileName;
        return `[[${noteName}]]`;
    }

    /**
     * Search chunks by content
     */
    searchChunks(query: string): Chunk[] {
        const lowerQuery = query.toLowerCase();
        return this.getAllChunks().filter(chunk => 
            chunk.content.toLowerCase().includes(lowerQuery)
        );
    }

    /**
     * Get splitter configuration
     */
    getSplitterConfig(): TextSplitterConfig {
        return this.splitter.getConfig();
    }
}
