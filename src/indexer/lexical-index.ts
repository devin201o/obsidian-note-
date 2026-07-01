/**
 * A document to be indexed for lexical (keyword) search.
 */
export interface LexicalDocument {
    id: string;
    filePath: string;
    content: string;
}

/**
 * A lexical search hit.
 */
export interface LexicalHit {
    id: string;
    score: number;
}

/**
 * Common English stop words dropped during tokenization so BM25 term weighting
 * isn't dominated by high-frequency, low-information words.
 */
const STOP_WORDS = new Set([
    "the", "and", "for", "are", "but", "not", "you", "your", "was", "were",
    "has", "have", "had", "with", "this", "that", "these", "those", "from",
    "they", "them", "their", "what", "which", "who", "whom", "will", "would",
    "can", "could", "should", "into", "than", "then", "there", "here", "when",
    "where", "how", "why", "all", "any", "some", "such", "only", "own", "same",
    "its", "our", "out", "about", "over", "also", "more", "most", "other"
]);

/**
 * Tokenize text into lowercase alphanumeric terms, dropping very short tokens
 * and stop words.
 */
export function tokenize(text: string): string[] {
    const raw = text.toLowerCase().split(/[^a-z0-9]+/);
    const tokens: string[] = [];
    for (const token of raw) {
        if (token.length >= 2 && !STOP_WORDS.has(token)) {
            tokens.push(token);
        }
    }
    return tokens;
}

const BM25_K1 = 1.5;
const BM25_B = 0.75;

/**
 * LexicalIndex provides BM25-ranked keyword search over chunk contents. It is
 * built lazily from the vector store and rebuilt when the store's contents
 * change, so it stays a pure in-memory derived structure (nothing persisted).
 */
export class LexicalIndex {
    private docIds: string[] = [];
    private filePaths: string[] = [];
    private docLengths: number[] = [];
    /** term -> list of [docIndex, termFrequency] */
    private postings: Map<string, Array<[number, number]>> = new Map();
    /** term -> document frequency */
    private df: Map<string, number> = new Map();
    private avgDocLength = 0;
    private docCount = 0;
    private builtVersion = -1;

    /**
     * The store version this index was last built from (-1 if never built).
     */
    getBuiltVersion(): number {
        return this.builtVersion;
    }

    /**
     * Rebuild the index from the given documents.
     */
    build(documents: LexicalDocument[], version: number): void {
        this.docIds = [];
        this.filePaths = [];
        this.docLengths = [];
        this.postings = new Map();
        this.df = new Map();

        let totalLength = 0;

        for (const doc of documents) {
            const tokens = tokenize(doc.content);
            const docIndex = this.docIds.length;

            this.docIds.push(doc.id);
            this.filePaths.push(doc.filePath);
            this.docLengths.push(tokens.length);
            totalLength += tokens.length;

            const termFreq = new Map<string, number>();
            for (const token of tokens) {
                termFreq.set(token, (termFreq.get(token) ?? 0) + 1);
            }

            for (const [term, freq] of termFreq) {
                let postingList = this.postings.get(term);
                if (!postingList) {
                    postingList = [];
                    this.postings.set(term, postingList);
                }
                postingList.push([docIndex, freq]);
                this.df.set(term, (this.df.get(term) ?? 0) + 1);
            }
        }

        this.docCount = this.docIds.length;
        this.avgDocLength = this.docCount > 0 ? totalLength / this.docCount : 0;
        this.builtVersion = version;
    }

    /**
     * Run a BM25 search.
     * @param query The raw query text
     * @param limit Maximum number of hits to return
     * @param allow Optional predicate to include only documents whose file path passes
     */
    search(query: string, limit: number, allow?: (filePath: string) => boolean): LexicalHit[] {
        if (this.docCount === 0 || this.avgDocLength === 0) {
            return [];
        }

        const queryTerms = Array.from(new Set(tokenize(query)));
        if (queryTerms.length === 0) {
            return [];
        }

        const scores = new Map<number, number>();

        for (const term of queryTerms) {
            const postingList = this.postings.get(term);
            if (!postingList) continue;

            const df = this.df.get(term) ?? 0;
            if (df === 0) continue;

            // BM25 idf with the +1 smoothing variant to keep it non-negative.
            const idf = Math.log(1 + (this.docCount - df + 0.5) / (df + 0.5));

            for (const [docIndex, tf] of postingList) {
                const filePath = this.filePaths[docIndex];
                if (allow && filePath !== undefined && !allow(filePath)) {
                    continue;
                }

                const docLength = this.docLengths[docIndex] ?? 0;
                const denom = tf + BM25_K1 * (1 - BM25_B + (BM25_B * docLength) / this.avgDocLength);
                const termScore = idf * ((tf * (BM25_K1 + 1)) / denom);
                scores.set(docIndex, (scores.get(docIndex) ?? 0) + termScore);
            }
        }

        const hits: LexicalHit[] = [];
        for (const [docIndex, score] of scores) {
            const id = this.docIds[docIndex];
            if (id !== undefined && score > 0) {
                hits.push({ id, score });
            }
        }

        hits.sort((a, b) => b.score - a.score);
        return hits.slice(0, limit);
    }
}
