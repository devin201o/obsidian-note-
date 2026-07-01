/**
 * Chunking strategy identifier.
 * - "markdown": structure-aware splitting by heading hierarchy (recommended)
 * - "character": legacy fixed-size recursive character splitting
 */
export type ChunkingStrategy = "markdown" | "character";

/**
 * Configuration options for the text splitter
 */
export interface TextSplitterConfig {
    chunkSize: number;
    chunkOverlap: number;
    strategy: ChunkingStrategy;
}

/**
 * Default configuration for the text splitter
 */
export const DEFAULT_SPLITTER_CONFIG: TextSplitterConfig = {
    chunkSize: 1000,
    chunkOverlap: 200,
    strategy: "markdown"
};

/**
 * A single split produced by a splitter.
 * `content` is the human-readable chunk text (used for display and citation),
 * while `heading` is the breadcrumb of markdown headings the chunk lives under
 * (e.g. "Architecture > Retrieval"). Empty for content above the first heading
 * or when using the character strategy.
 */
export interface SplitChunk {
    content: string;
    heading: string;
}

/**
 * Build the text that is actually sent to the embedding model for a chunk.
 * Prepending the note title + heading breadcrumb anchors short sections in
 * their topic, which markedly improves retrieval for terse notes.
 */
export function buildEmbedText(noteName: string, heading: string, content: string): string {
    const crumb = [noteName, heading].filter(part => part && part.length > 0).join(" > ");
    return crumb.length > 0 ? `${crumb}\n\n${content}` : content;
}

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
    getConfig(): { chunkSize: number; chunkOverlap: number } {
        return {
            chunkSize: this.chunkSize,
            chunkOverlap: this.chunkOverlap
        };
    }
}

interface HeadingFrame {
    level: number;
    title: string;
}

/**
 * MarkdownTextSplitter splits markdown by its heading hierarchy first, then
 * size-limits each section. It keeps fenced code blocks intact and records the
 * heading breadcrumb for every chunk so callers can anchor embeddings in topic
 * context. This preserves far more semantic structure than blind character
 * splitting, which is the single biggest driver of retrieval quality.
 */
export class MarkdownTextSplitter {
    private readonly chunkSize: number;
    private readonly chunkOverlap: number;
    private readonly charSplitter: RecursiveCharacterTextSplitter;

    private static readonly HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
    private static readonly FENCE_RE = /^\s*(`{3,}|~{3,})/;

    constructor(config: Partial<TextSplitterConfig> = {}) {
        const merged = { ...DEFAULT_SPLITTER_CONFIG, ...config };
        this.chunkSize = merged.chunkSize;
        this.chunkOverlap = merged.chunkOverlap;

        if (this.chunkOverlap >= this.chunkSize) {
            throw new Error("chunkOverlap must be less than chunkSize");
        }

        this.charSplitter = new RecursiveCharacterTextSplitter(merged);
    }

    /**
     * Split markdown text into heading-aware chunks.
     */
    splitMarkdown(text: string): SplitChunk[] {
        const { frontmatter, body } = this.extractFrontmatter(text);
        const sections = this.splitIntoSections(body);

        // Fold frontmatter into the first section so tags/aliases stay searchable.
        if (frontmatter.length > 0) {
            const first = sections[0];
            if (first && first.heading === "") {
                first.content = `${frontmatter}\n\n${first.content}`.trim();
            } else {
                sections.unshift({ heading: "", content: frontmatter });
            }
        }

        const result: SplitChunk[] = [];
        for (const section of sections) {
            const pieces = this.splitSection(section.content);
            for (const piece of pieces) {
                const trimmed = piece.trim();
                if (trimmed.length > 0) {
                    result.push({ content: trimmed, heading: section.heading });
                }
            }
        }

        return result;
    }

    /**
     * Pull YAML frontmatter off the top of the document, if present.
     */
    private extractFrontmatter(text: string): { frontmatter: string; body: string } {
        if (!text.startsWith("---")) {
            return { frontmatter: "", body: text };
        }

        const lines = text.split("\n");
        if ((lines[0] ?? "").trim() !== "---") {
            return { frontmatter: "", body: text };
        }

        for (let i = 1; i < lines.length; i++) {
            if ((lines[i] ?? "").trim() === "---") {
                const frontmatter = lines.slice(1, i).join("\n").trim();
                const body = lines.slice(i + 1).join("\n");
                return { frontmatter, body };
            }
        }

        return { frontmatter: "", body: text };
    }

    /**
     * Split a document body into sections delimited by ATX headings, tracking
     * the heading stack so each section carries its full breadcrumb. Headings
     * inside fenced code blocks are ignored.
     */
    private splitIntoSections(body: string): Array<{ heading: string; content: string }> {
        const lines = body.split("\n");
        const sections: Array<{ heading: string; content: string }> = [];
        const stack: HeadingFrame[] = [];
        let current: string[] = [];
        let fence: string | null = null;

        const flush = (breadcrumb: string) => {
            const content = current.join("\n").trim();
            if (content.length > 0) {
                sections.push({ heading: breadcrumb, content });
            }
            current = [];
        };

        const breadcrumbOf = (frames: HeadingFrame[]): string =>
            frames.map(f => f.title).join(" > ");

        for (const line of lines) {
            const fenceMatch = MarkdownTextSplitter.FENCE_RE.exec(line);
            if (fenceMatch) {
                const marker = fenceMatch[1] ?? "";
                if (fence === null) {
                    fence = marker;
                } else if (marker[0] === fence[0] && marker.length >= fence.length) {
                    // Per CommonMark, a fence only closes on a marker of the same
                    // character that is at least as long as the opening one, so a
                    // shorter nested fence (e.g. ``` inside ````) doesn't close it.
                    fence = null;
                }
                current.push(line);
                continue;
            }

            const headingMatch = fence === null ? MarkdownTextSplitter.HEADING_RE.exec(line) : null;
            if (headingMatch) {
                // Close the section that belongs to the current (pre-update) stack.
                flush(breadcrumbOf(stack));

                const level = (headingMatch[1] ?? "").length;
                const title = (headingMatch[2] ?? "").trim();
                while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= level) {
                    stack.pop();
                }
                stack.push({ level, title });
                current.push(line);
            } else {
                current.push(line);
            }
        }

        flush(breadcrumbOf(stack));
        return sections;
    }

    /**
     * Split one section's content into size-bounded chunks, keeping fenced code
     * blocks whole and falling back to character splitting for oversized blocks.
     */
    private splitSection(content: string): string[] {
        if (content.length <= this.chunkSize) {
            return [content];
        }

        const blocks = this.splitIntoBlocks(content);
        const chunks: string[] = [];
        let current = "";

        for (const block of blocks) {
            const candidateLength = current.length === 0 ? block.length : current.length + 2 + block.length;

            if (candidateLength > this.chunkSize && current.length > 0) {
                chunks.push(current.trim());
                current = this.getOverlapText(current);
            }

            if (block.length > this.chunkSize) {
                if (current.trim().length > 0) {
                    chunks.push(current.trim());
                    current = "";
                }
                for (const sub of this.charSplitter.splitText(block)) {
                    chunks.push(sub.trim());
                }
                continue;
            }

            current = current.length === 0 ? block : `${current}\n\n${block}`;
        }

        if (current.trim().length > 0) {
            chunks.push(current.trim());
        }

        return chunks;
    }

    /**
     * Break a section into paragraph blocks, keeping fenced code blocks intact.
     */
    private splitIntoBlocks(content: string): string[] {
        const lines = content.split("\n");
        const blocks: string[] = [];
        let current: string[] = [];
        let fence: string | null = null;

        const flush = () => {
            const joined = current.join("\n").trim();
            if (joined.length > 0) {
                blocks.push(joined);
            }
            current = [];
        };

        for (const line of lines) {
            const fenceMatch = MarkdownTextSplitter.FENCE_RE.exec(line);
            if (fenceMatch) {
                const marker = fenceMatch[1] ?? "";
                if (fence === null) {
                    fence = marker;
                } else if (marker[0] === fence[0] && marker.length >= fence.length) {
                    fence = null;
                }
                current.push(line);
                continue;
            }

            if (fence === null && line.trim() === "") {
                flush();
            } else {
                current.push(line);
            }
        }

        flush();
        return blocks;
    }

    private getOverlapText(text: string): string {
        if (this.chunkOverlap <= 0) {
            return "";
        }
        if (text.length <= this.chunkOverlap) {
            return text;
        }
        return text.slice(-this.chunkOverlap);
    }
}

/**
 * Splitter facade used by ChunkManager. Selects the concrete splitter based on
 * the configured strategy and always returns SplitChunk[].
 */
export class DocumentSplitter {
    private readonly strategy: ChunkingStrategy;
    private readonly markdownSplitter: MarkdownTextSplitter;
    private readonly charSplitter: RecursiveCharacterTextSplitter;

    constructor(config: Partial<TextSplitterConfig> = {}) {
        const merged = { ...DEFAULT_SPLITTER_CONFIG, ...config };
        this.strategy = merged.strategy;
        this.markdownSplitter = new MarkdownTextSplitter(merged);
        this.charSplitter = new RecursiveCharacterTextSplitter(merged);
    }

    split(text: string): SplitChunk[] {
        if (this.strategy === "character") {
            return this.charSplitter.splitText(text).map(content => ({ content, heading: "" }));
        }
        return this.markdownSplitter.splitMarkdown(text);
    }
}
