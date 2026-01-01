import { App, TFile, TFolder, Vault } from "obsidian";

export interface IndexedFile {
    path: string;
    name: string;
    extension: string;
    size: number;
    created: number;
    modified: number;
}

export interface IndexStats {
    totalFiles: number;
    lastIndexed: string | null;
}

export class VaultIndexer {
    private app: App;
    private indexedFiles: IndexedFile[] = [];
    private lastIndexed: Date | null = null;

    constructor(app: App) {
        this.app = app;
    }

    /**
     * Index all markdown files in the vault
     */
    async indexVault(): Promise<IndexedFile[]> {
        this.indexedFiles = [];
        const files = this.app.vault.getMarkdownFiles();

        for (const file of files) {
            const indexedFile = await this.indexFile(file);
            this.indexedFiles.push(indexedFile);
        }

        this.lastIndexed = new Date();
        return this.indexedFiles;
    }

    /**
     * Index all files (not just markdown) in the vault
     */
    async indexAllFiles(): Promise<IndexedFile[]> {
        this.indexedFiles = [];
        const files = this.app.vault.getFiles();

        for (const file of files) {
            const indexedFile = await this.indexFile(file);
            this.indexedFiles.push(indexedFile);
        }

        this.lastIndexed = new Date();
        return this.indexedFiles;
    }

    /**
     * Index a single file
     */
    private async indexFile(file: TFile): Promise<IndexedFile> {
        return {
            path: file.path,
            name: file.basename,
            extension: file.extension,
            size: file.stat.size,
            created: file.stat.ctime,
            modified: file.stat.mtime
        };
    }

    /**
     * Get all indexed files
     */
    getIndexedFiles(): IndexedFile[] {
        return this.indexedFiles;
    }

    /**
     * Get index statistics
     */
    getStats(): IndexStats {
        return {
            totalFiles: this.indexedFiles.length,
            lastIndexed: this.lastIndexed ? this.lastIndexed.toISOString() : null
        };
    }

    /**
     * Get file count
     */
    getFileCount(): number {
        return this.indexedFiles.length;
    }

    /**
     * Search indexed files by name
     */
    searchByName(query: string): IndexedFile[] {
        const lowerQuery = query.toLowerCase();
        return this.indexedFiles.filter(file => 
            file.name.toLowerCase().includes(lowerQuery) ||
            file.path.toLowerCase().includes(lowerQuery)
        );
    }

    /**
     * Get files by extension
     */
    getFilesByExtension(extension: string): IndexedFile[] {
        return this.indexedFiles.filter(file => file.extension === extension);
    }

    /**
     * Clear the index
     */
    clearIndex(): void {
        this.indexedFiles = [];
        this.lastIndexed = null;
    }
}
