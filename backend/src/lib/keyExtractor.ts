/**
 * Key Extraction Utility for Exact Lookup
 *
 * Extracts explicit keys and reference IDs from user queries for exact lookup
 * before semantic retrieval. Supports:
 * - Jira issue keys (PROJ-123)
 * - Document reference IDs (spms:guide-v2)
 * - Cattower/Checker URLs
 * - Jira browse URLs
 */

export interface ExtractedKey {
    type: 'jira_key' | 'doc_reference' | 'cattower_url' | 'jira_url' | 'error_code'
    value: string // normalized value for lookup
    original: string // original matched string
    confidence: number // 0-1, extraction confidence
}

const ERROR_CODE_QUERY_CUE_PATTERN = /(에러\s*코드|에러코드|오류\s*코드|오류코드|error\s*codes?)/iu
const PURE_NUMERIC_ERROR_CODE_PATTERN = /\b(\d{4,})\b/g

/**
 * Pattern 1: Jira Issue Key
 * Format: PROJ-123, BUG-456
 * Regex: ^[A-Z][A-Z0-9_]+-\d+$
 */
function extractJiraKeys(query: string): ExtractedKey[] {
    const pattern = /\b([A-Z][A-Z0-9_]+-\d+)\b/g
    const matches = Array.from(query.matchAll(pattern))

    return matches.map((match) => ({
        type: 'jira_key',
        value: match[1], // plain key for client_reference_id lookup
        original: match[1],
        confidence: 1.0, // exact pattern match
    }))
}

/**
 * Pattern 2: Document Reference ID
 * Format: spms:api-guide-v2, docs:deployment-guide
 * Regex: (spms|docs|cattower):[a-zA-Z0-9_-]+
 */
function extractDocReferences(query: string): ExtractedKey[] {
    const pattern = /\b((?:spms|docs|cattower):[a-zA-Z0-9_-]+(?::[a-zA-Z0-9_-]+)*)\b/g
    const matches = Array.from(query.matchAll(pattern))

    return matches.map((match) => {
        const fullRef = match[1]
        // Normalize: remove source prefix for lookup (stored as plain ID)
        const normalized = fullRef.split(':').slice(1).join(':')

        return {
            type: 'doc_reference',
            value: normalized || fullRef, // fallback to full if no colon
            original: fullRef,
            confidence: 0.95, // high confidence but may need normalization
        }
    })
}

/**
 * Pattern 4: Jira Browse URL
 * Format: https://jira.example.com/browse/PROJ-123
 * Extract issue key from URL
 */
function extractJiraUrls(query: string): ExtractedKey[] {
    const pattern = /https?:\/\/[a-zA-Z0-9.-]+\/browse\/([A-Z][A-Z0-9_]+-\d+)(?:[?#][^\s]*)?/g
    const matches = Array.from(query.matchAll(pattern))

    return matches.map((match) => ({
        type: 'jira_url',
        value: match[1], // extracted issue key
        original: match[0],
        confidence: 0.9, // URL may change, but key extraction is reliable
    }))
}

/**
 * Pattern 3: Cattower/Checker URL
 * Format: https://cattower.example.com/docs/api-guide-v2
 * Extract path components and convert to reference ID
 */
function extractCattowerUrls(query: string): ExtractedKey[] {
    const pattern = /https?:\/\/(cattower|checker|docs)\.[a-zA-Z0-9.-]+\/([a-zA-Z0-9_/-]+)(?:\?[^\s]*)?/g
    const matches = Array.from(query.matchAll(pattern))

    return matches.map((match) => {
        const domain = match[1]
        const path = match[2]

        // Extract last meaningful path component as ID
        const pathParts = path.split('/').filter((p) => p && p !== 'docs' && p !== 'guide')
        const extractedId = pathParts[pathParts.length - 1] || path

        return {
            type: 'cattower_url',
            value: extractedId, // simplified ID for lookup
            original: match[0],
            confidence: 0.7, // URL parsing is heuristic
        }
    })
}

function extractErrorCodes(query: string): ExtractedKey[] {
    if (!ERROR_CODE_QUERY_CUE_PATTERN.test(query)) {
        return []
    }

    const matches = Array.from(query.matchAll(PURE_NUMERIC_ERROR_CODE_PATTERN))

    return matches.map((match) => ({
        type: 'error_code',
        value: match[1],
        original: match[1],
        confidence: 0.92,
    }))
}

/**
 * Main extraction function
 * Returns all extracted keys sorted by confidence (highest first)
 */
export function extractExplicitKeys(query: string): ExtractedKey[] {
    const allKeys: ExtractedKey[] = [
        ...extractJiraKeys(query),
        ...extractJiraUrls(query),
        ...extractDocReferences(query),
        ...extractCattowerUrls(query),
        ...extractErrorCodes(query),
    ]

    // Sort by confidence (highest first), then by type priority
    const typePriority: Record<ExtractedKey['type'], number> = {
        jira_key: 1,
        jira_url: 2,
        doc_reference: 3,
        cattower_url: 4,
        error_code: 5,
    }

    return allKeys.sort((a, b) => {
        if (a.confidence !== b.confidence) {
            return b.confidence - a.confidence
        }
        return typePriority[a.type] - typePriority[b.type]
    })
}

/**
 * Get primary key for exact lookup
 * Returns the highest-confidence key, or null if none found
 */
export function getPrimaryKey(query: string): ExtractedKey | null {
    const keys = extractExplicitKeys(query)
    return keys.length > 0 ? keys[0] : null
}

/**
 * Check if query contains any explicit keys
 */
export function hasExplicitKeys(query: string): boolean {
    return extractExplicitKeys(query).length > 0
}
