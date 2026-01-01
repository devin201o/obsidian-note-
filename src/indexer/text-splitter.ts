/**
 * Configuration options for the text splitter
 */
export interface TextSplitterConfig {
    chunkSize: number;
    chunkOverlap: number;
}

/**
 * Default configuration for the text splitter
 */
export const DEFAULT_SPLITTER_CONFIG: TextSplitterConfig = {
    chunkSize: 1000,
    chunkOverlap: 200
};

/**
 * RecursiveCharacterTextSplitter splits text recursively using a hierarchy of separators.
 * It preserves semantic structure (paragraphs, sentences) as much as possible.
 */
export class RecursiveCharacterTextSplitter {
    private readonly chunkSize: number;
    private readonly chunkOverlap: number;
    private readonly separators: string[] = ["\n\n", "\n", ". ", " ", ""];

    constructor(config: Partial<TextSplitterConfig> = {}) {
        const mergedConfig = { ...DEFAULT_SPLITTER_CONFIG, ...config };
        this.chunkSize = mergedConfig.chunkSize;
        this.chunkOverlap = mergedConfig.chunkOverlap;

        if (this.chunkOverlap >= this.chunkSize) {
            throw new Error("chunkOverlap must be less than chunkSize");
        }
    }

    /**
     * Split text into chunks
     */
    splitText(text: string): string[] {
        return this.splitTextRecursive(text, this.separators);
    }

    /**
     * Recursively split text using the separator hierarchy
     */
    private splitTextRecursive(text: string, separators: string[]): string[] {
        const chunks: string[] = [];

        // Base case: text is small enough
        if (text.length <= this.chunkSize) {
            if (text.trim().length > 0) {
                chunks.push(text);
            }
            return chunks;
        }

        // Find the best separator to use
        let separator: string = separators[separators.length - 1] ?? ""; // Default to last (empty string)
        let nextSeparators = separators;

        for (let i = 0; i < separators.length; i++) {
            const sep = separators[i];
            if (sep === undefined) continue;
            if (sep === "") {
                separator = sep;
                nextSeparators = separators.slice(i + 1);
                break;
            }
            if (text.includes(sep)) {
                separator = sep;
                nextSeparators = separators.slice(i + 1);
                break;
            }
        }

        // Split by the chosen separator
        const splits = this.splitBySeparator(text, separator);

        // Merge small splits and recursively split large ones
        let currentChunk = "";

        for (const split of splits) {
            const splitWithSep = separator !== "" ? split + separator : split;

            // If adding this split would exceed chunk size
            if (currentChunk.length + splitWithSep.length > this.chunkSize) {
                // Save current chunk if it has content
                if (currentChunk.trim().length > 0) {
                    chunks.push(currentChunk.trim());
                }

                // If the split itself is too large, recursively split it
                if (splitWithSep.length > this.chunkSize) {
                    const subChunks = this.splitTextRecursive(split, nextSeparators);
                    chunks.push(...subChunks);
                    currentChunk = "";
                } else {
                    // Start new chunk with overlap from previous
                    currentChunk = this.getOverlapText(currentChunk) + splitWithSep;
                }
            } else {
                currentChunk += splitWithSep;
            }
        }

        // Don't forget the last chunk
        if (currentChunk.trim().length > 0) {
            chunks.push(currentChunk.trim());
        }

        return chunks;
    }

    /**
     * Split text by a separator, keeping track of the parts
     */
    private splitBySeparator(text: string, separator: string): string[] {
        if (separator === "") {
            // Split by character, but group into reasonable sizes
            const result: string[] = [];
            for (let i = 0; i < text.length; i += this.chunkSize - this.chunkOverlap) {
                result.push(text.slice(i, i + this.chunkSize));
            }
            return result;
        }
        return text.split(separator).filter(s => s.length > 0);
    }

    /**
     * Get the overlap text from the end of a chunk
     */
    private getOverlapText(text: string): string {
        if (text.length <= this.chunkOverlap) {
            return text;
        }
        return text.slice(-this.chunkOverlap);
    }

    /**
     * Get the current configuration
     */
    getConfig(): TextSplitterConfig {
        return {
            chunkSize: this.chunkSize,
            chunkOverlap: this.chunkOverlap
        };
    }
}
