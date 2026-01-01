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
    // OpenAI API keys (sk-...) and GitHub Personal Access Tokens (ghp_...)
    {
        pattern: /(sk-[a-zA-Z0-9]{32,})|(ghp_[a-zA-Z0-9]{30,})/g,
        replacement: "[REDACTED_API_KEY]",
        description: "OpenAI/GitHub API keys"
    },
    // OpenRouter API keys (sk-or-...)
    {
        pattern: /sk-or-[a-zA-Z0-9-]{30,}/g,
        replacement: "[REDACTED_API_KEY]",
        description: "OpenRouter API keys"
    },
    // AWS Access Keys
    {
        pattern: /AKIA[0-9A-Z]{16}/g,
        replacement: "[REDACTED_AWS_KEY]",
        description: "AWS Access Keys"
    },
    // AWS Secret Keys (40 char base64-like strings after aws_secret or similar context)
    {
        pattern: /(?:aws_secret_access_key|secret_key)["'\s:=]+([A-Za-z0-9+/]{40})/gi,
        replacement: "$1[REDACTED_AWS_SECRET]",
        description: "AWS Secret Keys"
    },
    // Email addresses
    {
        pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
        replacement: "[REDACTED_EMAIL]",
        description: "Email addresses"
    },
    // RSA/OpenSSH Private Keys
    {
        pattern: /-{5}BEGIN\s+(RSA|OPENSSH|DSA|EC|PGP)\s+PRIVATE\s+KEY-{5}[\s\S]*?-{5}END\s+\1\s+PRIVATE\s+KEY-{5}/g,
        replacement: "[REDACTED_PRIVATE_KEY]",
        description: "Private keys (RSA, OpenSSH, DSA, EC, PGP)"
    },
    // Bearer tokens in headers
    {
        pattern: /Bearer\s+[a-zA-Z0-9_-]{20,}/gi,
        replacement: "Bearer [REDACTED_TOKEN]",
        description: "Bearer tokens"
    },
    // Generic API keys in common formats (api_key=..., apiKey: "...", etc.)
    {
        pattern: /(?:api[_-]?key|apikey|api[_-]?secret|api[_-]?token)["'\s:=]+["']?([a-zA-Z0-9_-]{20,})["']?/gi,
        replacement: "$1[REDACTED_API_KEY]",
        description: "Generic API keys"
    },
    // Password fields
    {
        pattern: /(?:password|passwd|pwd)["'\s:=]+["']?([^\s"']{8,})["']?/gi,
        replacement: "$1[REDACTED_PASSWORD]",
        description: "Passwords"
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
}
