import { App, Modal } from "obsidian";
import type { IndexedFile } from "../indexer";

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
