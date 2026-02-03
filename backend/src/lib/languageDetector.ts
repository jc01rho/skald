export enum Language {
    KOREAN = 'korean',
    ENGLISH = 'english',
    JAPANESE = 'japanese',
    CHINESE = 'chinese',
    UNKNOWN = 'unknown',
}

const LANGUAGE_PATTERNS = {
    [Language.KOREAN]: /[\uAC00-\uD7AF]/,
    [Language.JAPANESE]: /[\u3040-\u309F\u30A0-\u30FF]/,
    [Language.CHINESE]: /[\u4E00-\u9FFF]/,
    [Language.ENGLISH]: /^[\x00-\x7F]+$/, // ASCII only
}

/**
 * Detect the primary language of a text string
 * Priority: Korean > Japanese > Chinese > English
 * Mixed text prefers CJK languages over English
 */
export function detectLanguage(text: string): Language {
    if (!text || text.trim().length === 0) {
        return Language.UNKNOWN
    }

    // Check for Korean (highest priority for this project)
    if (LANGUAGE_PATTERNS[Language.KOREAN].test(text)) {
        return Language.KOREAN
    }

    // Check for Japanese
    if (LANGUAGE_PATTERNS[Language.JAPANESE].test(text)) {
        return Language.JAPANESE
    }

    // Check for Chinese
    if (LANGUAGE_PATTERNS[Language.CHINESE].test(text)) {
        return Language.CHINESE
    }

    // Check for English (ASCII only)
    if (LANGUAGE_PATTERNS[Language.ENGLISH].test(text)) {
        return Language.ENGLISH
    }

    return Language.UNKNOWN
}

/**
 * Check if text contains any CJK (Chinese, Japanese, Korean) characters
 */
export function containsCJK(text: string): boolean {
    return (
        LANGUAGE_PATTERNS[Language.KOREAN].test(text) ||
        LANGUAGE_PATTERNS[Language.JAPANESE].test(text) ||
        LANGUAGE_PATTERNS[Language.CHINESE].test(text)
    )
}

/**
 * Get search strategy based on detected language
 */
export function getSearchStrategyForLanguage(language: Language): {
    useTrgm: boolean
    useFullText: boolean
} {
    switch (language) {
        case Language.KOREAN:
        case Language.JAPANESE:
        case Language.CHINESE:
            return { useTrgm: true, useFullText: false }
        case Language.ENGLISH:
            return { useTrgm: false, useFullText: true }
        default:
            return { useTrgm: true, useFullText: true }
    }
}
