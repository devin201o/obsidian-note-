/**
 * PrivacyManager handles redaction of sensitive information before indexing.
 * Uses a "Redact-then-Index" approach to protect secrets while still allowing search.
 */

/**
 * Redaction pattern with its replacement placeholder
 */
interface RedactionPattern {
    pattern: RegExp;
    replacement: string;
    description: string;
}

/**
 * Default patterns for common sensitive data
 */
const DEFAULT_PATTERNS: RedactionPattern[] = [
    // OpenAI API keys (Handle both legacy sk- and new sk-proj- formats)
    {
        // Matches sk- followed by 20+ chars (alphanumeric, underscores, hyphens)
        pattern: /sk-[a-zA-Z0-9\-_]{20,}/g, 
        replacement: "[REDACTED_API_KEY]",
        description: "OpenAI API keys (Standard & Project)"
    },
    // GitHub Personal Access Tokens (ghp_, gho_, etc)
    {
        pattern: /(ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9]{20,}/g,
        replacement: "[REDACTED_GITHUB_TOKEN]",
        description: "GitHub Tokens"
    },
    // OpenRouter API keys
    {
        pattern: /sk-or-[a-zA-Z0-9\-_]{30,}/g,
        replacement: "[REDACTED_API_KEY]",
        description: "OpenRouter API keys"
    },
    // AWS Access Keys (Standard AKIA...)
    {
        pattern: /(?<![A-Z0-9])AKIA[0-9A-Z]{16}(?![A-Z0-9])/g,
        replacement: "[REDACTED_AWS_KEY]",
        description: "AWS Access Keys"
    },
    // Email addresses
    {
        pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
        replacement: "[REDACTED_EMAIL]",
        description: "Email addresses"
    },
    // Private Keys
    {
        pattern: /-{5}BEGIN\s+(RSA|OPENSSH|DSA|EC|PGP)\s+PRIVATE\s+KEY-{5}[\s\S]*?-{5}END\s+\1\s+PRIVATE\s+KEY-{5}/g,
        replacement: "[REDACTED_PRIVATE_KEY]",
        description: "Private keys"
    },
    // Generic "api_key = xyz" patterns
    {
        pattern: /(?:api[_-]?key|apikey|secret)["'\s:=]+["']?([a-zA-Z0-9\-_]{20,})["']?/gi,
        replacement: "[REDACTED_GENERIC_SECRET]",
        description: "Generic API Key assignments"
    }
];

export class PrivacyManager {
    private enabled: boolean = true;
    private customPatterns: RedactionPattern[] = [];

    constructor() {
        this.enabled = true;
        this.customPatterns = [];
    }

    /**
     * Enable or disable redaction
     */
    setEnabled(enabled: boolean): void {
        this.enabled = enabled;
    }

    /**
     * Check if redaction is enabled
     */
    isEnabled(): boolean {
        return this.enabled;
    }

    /**
     * Set custom redaction patterns from user settings
     * @param patternsText One regex pattern per line
     */
    setCustomPatterns(patternsText: string): void {
        this.customPatterns = [];
        
        if (!patternsText.trim()) {
            return;
        }

        const lines = patternsText.split("\n").filter(line => line.trim());
        
        for (const line of lines) {
            try {
                // Create a global regex from the pattern
                const pattern = new RegExp(line.trim(), "g");
                this.customPatterns.push({
                    pattern,
                    replacement: "[REDACTED_CUSTOM]",
                    description: `Custom pattern: ${line.trim()}`
                });
            } catch (error) {
                // Skip invalid regex patterns
                console.warn(`PrivacyManager: Invalid regex pattern "${line}":`, error);
            }
        }

        console.log(`PrivacyManager: Loaded ${this.customPatterns.length} custom patterns`);
    }

    /**
     * Redact sensitive information from text
     * @param text The original text content
     * @returns Text with sensitive data replaced by placeholders
     */
    redact(text: string): string {
        if (!this.enabled) {
            return text;
        }

        let redactedText = text;
        let totalRedactions = 0;

        // Apply default patterns
        for (const { pattern, replacement } of DEFAULT_PATTERNS) {
            // Reset regex lastIndex for global patterns
            pattern.lastIndex = 0;
            const matches = redactedText.match(pattern);
            if (matches) {
                totalRedactions += matches.length;
            }
            redactedText = redactedText.replace(pattern, replacement);
        }

        // Apply custom patterns
        for (const { pattern, replacement } of this.customPatterns) {
            // Reset regex lastIndex for global patterns
            pattern.lastIndex = 0;
            const matches = redactedText.match(pattern);
            if (matches) {
                totalRedactions += matches.length;
            }
            redactedText = redactedText.replace(pattern, replacement);
        }

        if (totalRedactions > 0) {
            console.log(`PrivacyManager: Redacted ${totalRedactions} sensitive item(s)`);
        }

        return redactedText;
    }

    /**
     * Get the list of default pattern descriptions
     */
    getDefaultPatternDescriptions(): string[] {
        return DEFAULT_PATTERNS.map(p => p.description);
    }

    /**
     * Get the count of custom patterns currently loaded
     */
    getCustomPatternCount(): number {
        return this.customPatterns.length;
    }

    /**
     * Check if a file path is within an excluded folder
     * @param filePath The file path to check
     * @param excludedFolders Array of folder paths to exclude
     * @returns true if the file is in an excluded folder
     */
    static isFolderExcluded(filePath: string, excludedFolders: string[]): boolean {
        if (!excludedFolders || excludedFolders.length === 0) {
            return false;
        }

        for (const folder of excludedFolders) {
            if (!folder) continue;
            
            // Normalize folder path: ensure it ends with / for proper prefix matching
            const normalizedFolder = folder.endsWith("/") ? folder : folder + "/";
            
            // Check if file path starts with the excluded folder
            if (filePath.startsWith(normalizedFolder) || filePath.startsWith(folder + "/")) {
                return true;
            }
            
            // Also check if the file is directly at the folder path (edge case)
            if (filePath === folder) {
                return true;
            }
        }

        return false;
    }
}
