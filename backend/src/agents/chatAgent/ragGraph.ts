import { Project } from '@/entities/Project'
import { getOptimizedChatHistory } from '@/lib/chatUtils'
import { StateGraph, END } from '@langchain/langgraph'
import { Annotation } from '@langchain/langgraph'
import { decomposeQuery, rewrite, rewriteMultiQuery, generateHyDE, generateJiraHyDE } from './queryRewrite'
import { MemoFilter } from '@/lib/filterUtils'
import { EmbeddingService } from '@/services/embeddingService'
import { memoChunkVectorSearch, MemoChunkWithDistance } from '@/embeddings/vectorSearch'
import { HybridSearchService, HybridSearchResult } from '@/embeddings/hybridSearch'
import { QueryUnderstandingAgent, SearchStrategy } from '../queryUnderstandingAgent'
import { getTitleAndSummaryAndContentForMemoList } from '@/queries/memo'
import { RerankService } from '@/services/rerankService'
import { CHAT_AGENT_INSTRUCTIONS, CHAT_AGENT_INSTRUCTIONS_WITH_SOURCES } from './prompts'
import { ChatPromptTemplate } from '@langchain/core/prompts'
import { logger } from '@/lib/logger'
import { DI } from '@/di'
import { MemoParentChunk } from '@/entities/MemoParentChunk'
import { reorderForLongContext, selectOptimalStrategy, ReorderStrategy } from '@/lib/contextReorder'
import { validateRetrieval, getRetryStrategy, RetrievalValidation } from '@/lib/retrievalValidator'
import { mapWithConcurrency } from '@/lib/asyncUtils'
import { HNSWOptimizationService } from '@/lib/hnswOptimization'
import { extractExplicitKeys, ExtractedKey } from '@/lib/keyExtractor'
import { expandTechnicalQueryVariants } from '@/lib/queryNormalization'
import { buildMemoSourceUrl } from '@/lib/memoSourceUrl'
import { RawSourceDocument } from '@/entities/RawSourceDocument'
import { WikiPage } from '@/entities/WikiPage'
import { WikiPageSourceLink } from '@/entities/WikiPageSourceLink'
import { WikiNode } from '@/entities/WikiNode'
import { WikiEdge } from '@/entities/WikiEdge'

interface RerankResult {
    index: number
    document: string
    relevance_score: number
    memo_uuid?: string
    memo_title?: string
    source_url?: string
    embedding?: number[] // Optional embedding for MMR diversity calculation
}

export type LowConfidenceGuidanceMode =
    | 'none'
    | 'user_context_only_partial'
    | 'retrieval_only_partial'
    | 'both_weak_limitations'
    | 'key_miss_with_alternatives'
    | 'insufficient_evidence'

const ENTERPRISE_IDENTIFIER_PATTERN = /(엔터프라이즈|enterprise|sparrow)/iu
const ERROR_CODE_IDENTIFIER_PATTERN = /(에러\s*코드|에러코드|오류\s*코드|오류코드|error\s*codes?)/iu
const GENERIC_ANCHOR_CUE_PATTERN =
    /(코드|번호|아이디|\bid\b|issue|ticket|reference|참조|키|version|버전|error|errors|exception|path|경로|file|파일|class|함수|method|api|endpoint)/iu
const PURE_NUMERIC_ANCHOR_PATTERN = /\b\d{4,}\b/g
const STRUCTURED_ANCHOR_PATTERN = /\b[a-zA-Z0-9]+(?:[._:/-][a-zA-Z0-9]+)+\b/g
const MIXED_ALPHANUMERIC_ANCHOR_PATTERN = /\b(?=[A-Za-z0-9_-]{4,}\b)(?=\w*[A-Za-z])(?=\w*\d)[A-Za-z0-9_-]+\b/g
const CAMEL_CASE_ANCHOR_PATTERN = /\b[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]+)+\b/g

function normalizeInlineWhitespace(value: string): string {
    return value.replace(/\s+/g, ' ').trim()
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function collectUniqueAnchors(target: Map<string, string>, values: string[]) {
    for (const value of values) {
        const normalized = normalizeInlineWhitespace(value)
        if (!normalized) continue
        const key = normalized.toLowerCase()
        if (!target.has(key)) {
            target.set(key, normalized)
        }
    }
}

function extractQueryAnchors(query: string): string[] {
    const normalizedQuery = normalizeInlineWhitespace(query)
    const anchors = new Map<string, string>()
    const explicitKeys = extractExplicitKeys(query)
    const hasGenericAnchorCue = GENERIC_ANCHOR_CUE_PATTERN.test(normalizedQuery)

    collectUniqueAnchors(
        anchors,
        explicitKeys.flatMap((key) => [key.original, key.value])
    )
    collectUniqueAnchors(
        anchors,
        Array.from(normalizedQuery.matchAll(STRUCTURED_ANCHOR_PATTERN), (match) => match[0])
    )
    collectUniqueAnchors(
        anchors,
        Array.from(normalizedQuery.matchAll(MIXED_ALPHANUMERIC_ANCHOR_PATTERN), (match) => match[0])
    )
    collectUniqueAnchors(
        anchors,
        Array.from(normalizedQuery.matchAll(CAMEL_CASE_ANCHOR_PATTERN), (match) => match[0])
    )

    if (hasGenericAnchorCue) {
        collectUniqueAnchors(
            anchors,
            Array.from(normalizedQuery.matchAll(PURE_NUMERIC_ANCHOR_PATTERN), (match) => match[0])
        )
    }

    return Array.from(anchors.values()).sort((left, right) => right.length - left.length)
}

function anchorMatchesText(anchor: string, text: string): boolean {
    if (!anchor || !text) {
        return false
    }

    if (/^[\p{L}\p{N}]+$/u.test(anchor)) {
        const boundaryPattern = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(anchor)}([^\\p{L}\\p{N}]|$)`, 'iu')
        return boundaryPattern.test(text)
    }

    return text.toLowerCase().includes(anchor.toLowerCase())
}

function buildLiteralQueryAnchorBlock(query: string): string {
    const queryAnchors = extractQueryAnchors(query)
    if (queryAnchors.length === 0) {
        return ''
    }

    return (
        '[Literal Query Anchors — prioritize evidence containing these exact strings]\n' +
        `${queryAnchors.join(', ')}\n` +
        '[End of Literal Query Anchors]\n\n'
    )
}

export function buildUserContextEvidenceBlock(userContext: string | null | undefined): string {
    const normalized = userContext?.trim()
    if (!normalized) {
        return ''
    }

    const escaped = normalized.replace(/```/g, '\\\`\\\`\\\`').replace(/\[/g, '［').replace(/\]/g, '］')

    return ['[User-Provided Context]', '```text', escaped, '```', '[End of User-Provided Context]', '', ''].join('\n')
}

function preserveAnchorMatches({
    query,
    rerankedResults,
    chunkResults,
    memoPropertiesMap,
    topK,
}: {
    query: string
    rerankedResults: RerankResult[]
    chunkResults: MemoChunkWithDistance[]
    memoPropertiesMap: Map<string, { title: string; summary: string; content: string; source_url: string }> | null
    topK: number
}): RerankResult[] {
    const anchors = extractQueryAnchors(query)
    if (anchors.length === 0 || chunkResults.length === 0) {
        return rerankedResults
    }

    const existingByIndex = new Map(rerankedResults.map((result) => [result.index, result]))
    const anchorCandidates = chunkResults
        .map((chunkResult, index) => {
            const memo = memoPropertiesMap?.get(chunkResult.chunk.memo_uuid)
            const searchableText = [memo?.title, memo?.summary, chunkResult.chunk.chunk_content]
                .filter(Boolean)
                .join('\n')
            const matchedAnchors = anchors.filter((anchor) => anchorMatchesText(anchor, searchableText))
            if (matchedAnchors.length === 0) {
                return null
            }

            const result = existingByIndex.get(index) || {
                index,
                document: chunkResult.chunk.chunk_content,
                relevance_score: Math.max(0, Math.min(1, 1 - chunkResult.distance / 2)),
                memo_uuid: chunkResult.chunk.memo_uuid,
                memo_title: memo?.title || '',
                source_url: memo?.source_url || '',
                embedding: chunkResult.chunk.embedding as number[],
            }

            return {
                result,
                matchedAnchors,
                anchorScore: matchedAnchors.reduce((sum, anchor) => sum + anchor.length, 0),
                distance: chunkResult.distance,
            }
        })
        .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
        .sort((left, right) => {
            if (right.matchedAnchors.length !== left.matchedAnchors.length) {
                return right.matchedAnchors.length - left.matchedAnchors.length
            }
            if (right.anchorScore !== left.anchorScore) {
                return right.anchorScore - left.anchorScore
            }
            return left.distance - right.distance
        })
        .slice(0, Math.min(3, topK))

    if (anchorCandidates.length === 0) {
        return rerankedResults
    }

    const pinnedIndices = new Set(anchorCandidates.map((candidate) => candidate.result.index))
    const pinnedResults = anchorCandidates.map((candidate) => candidate.result)
    const remainingResults = rerankedResults.filter((result) => !pinnedIndices.has(result.index))
    return [...pinnedResults, ...remainingResults].slice(0, Math.max(topK, pinnedResults.length))
}

function uniqueQueries(values: string[]): string[] {
    return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)))
}

export function buildIdentifierFallbackQueries(query: string): string[] {
    const anchors = extractQueryAnchors(query)
    if (anchors.length === 0) {
        return []
    }

    return uniqueQueries(
        anchors.slice(0, 3).flatMap((anchor) => {
            if (anchor.includes(' ')) {
                return [anchor, `"${anchor}"`]
            }

            return [anchor, `"${anchor}"`]
        })
    )
}

export interface RAGConfig {
    llmProvider: 'cli-proxy-api'
    references: {
        enabled: boolean
    }
    queryRewrite: {
        enabled: boolean
        multiQuery?: boolean
        hydeEnabled?: boolean
    }
    vectorSearch: {
        topK: number
        similarityThreshold: number
    }
    reranking: {
        enabled: boolean
        topK: number
        mmrEnabled?: boolean
        mmrLambda?: number
    }
    queryUnderstanding?: {
        enabled: boolean
    }
    hybridSearch?: {
        enabled: boolean
        vectorWeight?: number
        bm25Weight?: number
    }
    contextReorder?: {
        enabled: boolean
        strategy?: ReorderStrategy
        autoSelect?: boolean
    }
    crag?: {
        enabled: boolean
        scoreThreshold?: number
        filterLowRelevance?: boolean
    }
    selfRag?: {
        enabled: boolean
        qualityThreshold?: number
        rollbackThreshold?: number
    }
    fallbackSearch?: {
        enabled: boolean
        triggerThreshold?: number
        expandedTopK?: number
        loweredThreshold?: number
        enableMultiQuery?: boolean
    }
    confidence?: {
        threshold?: number
    }
}

interface WikiTraversalContext {
    pages: Array<{
        slug: string
        title: string
        summary: string | null
        canonical: string | null
        confidence: number
        freshness: number
    }>
    nodes: Array<{
        canonicalName: string
        displayName: string
        description: string | null
        nodeType: string
        confidence: number
        freshness: number
    }>
    edges: Array<{
        fromCanonicalName: string
        toCanonicalName: string
        edgeType: string
        weight: number
    }>
}

// Define your state schema
const RAGState = Annotation.Root({
    project: Annotation<Project>,
    query: Annotation<string>,
    filters: Annotation<MemoFilter[]>,
    clientSystemPrompt: Annotation<string | null>,
    userContext: Annotation<string | null>,
    ragConfig: Annotation<RAGConfig>,
    chatId: Annotation<string | null>,
    conversationHistory: Annotation<Array<['human' | 'ai' | 'system', string]> | null>,
    queryUnderstanding: Annotation<SearchStrategy | null>,
    rewrittenQuery: Annotation<string | null>,
    subQuestions: Annotation<string[] | null>,
    chunkResults: Annotation<MemoChunkWithDistance[] | null>,
    rerankedResults: Annotation<RerankResult[]>,
    memoPropertiesMap: Annotation<Map<
        string,
        { title: string; summary: string; content: string; source_url: string }
    > | null>,
    parentChunkMap: Annotation<Map<string, string> | null>,
    precomputedQueryEmbedding: Annotation<number[] | null>,
    cragValidation: Annotation<RetrievalValidation | null>,
    prompt: Annotation<ChatPromptTemplate>,
    contextStr: Annotation<string | null>,
    exactLookupKeys: Annotation<ExtractedKey[] | null>,
    exactLookupResults: Annotation<Array<{
        memo_uuid?: string
        key: string
        title: string
        content: string
        source_url: string
        found: boolean
        status?: 'hit' | 'archived_only' | 'miss'
        archivedContent?: string
        contradiction?: { urlKey: string; inlineKey: string }
    }> | null>,
    lookupHit: Annotation<boolean | null>,
    wikiTraversal: Annotation<WikiTraversalContext | null>,
})

async function getChatHistoryNode(state: typeof RAGState.State) {
    const { chatId, project } = state
    if (!chatId) {
        return { conversationHistory: null }
    }
    const conversationHistory = await getOptimizedChatHistory(chatId, project)
    return { conversationHistory }
}

/**
 * Exact key lookup node — runs before vector search.
 * Extracts explicit Jira keys/document references from the query and performs
 * a direct DB lookup on client_reference_id. If hit, sets lookupHit=true and
 * exactLookupResults with the full content. If miss, marks found=false so that
 * buildLLMInputs can surface a key-not-found message instead of a generic abstain.
 */
async function exactLookupNode(state: typeof RAGState.State) {
    const { query, project } = state

    const extractedKeys = extractExplicitKeys(query)
    if (extractedKeys.length === 0) {
        return { exactLookupKeys: null, exactLookupResults: null, lookupHit: null }
    }

    logger.info(
        { extractedKeys: extractedKeys.map((k) => ({ type: k.type, value: k.value, confidence: k.confidence })) },
        'exactLookup: extracted keys from query'
    )

    // Task 12: Extended type to support archived_only and contradiction states
    const results: Array<{
        memo_uuid?: string
        key: string
        title: string
        content: string
        source_url: string
        found: boolean
        status?: 'hit' | 'archived_only' | 'miss'
        archivedContent?: string
        contradiction?: { urlKey: string; inlineKey: string }
    }> = []
    let anyHit = false

    type ErrorCodeLookupRow = {
        uuid: string
        title: string
        content: string | null
        chunk_content: string | null
        source_url: string | null
        source: string | null
        submission_id: string | null
        archived: boolean
    }

    const extractErrorCodeSnippet = (text: string, code: string): string => {
        const idx = text.indexOf(code)
        if (idx === -1) {
            return text.slice(0, 500).trim()
        }

        const start = Math.max(0, idx - 240)
        const end = Math.min(text.length, idx + code.length + 240)
        return text.slice(start, end).trim()
    }

    const scoreErrorCodeLookupRow = (row: ErrorCodeLookupRow, code: string): number => {
        const title = row.title || ''
        const chunkContent = row.chunk_content || ''
        const content = row.content || ''
        const combined = `${title}\n${chunkContent}\n${content}`
        const lowerTitle = title.toLowerCase()
        const lowerCombined = combined.toLowerCase()

        let score = 0

        if (/(error codes?|오류\s*코드|에러\s*코드|레거시 오류 코드)/iu.test(title)) {
            score += 50
        }
        if (lowerTitle.includes('backend')) {
            score += 10
        }
        if (lowerTitle.includes('legacy') || title.includes('레거시')) {
            score += 10
        }
        if ((row.chunk_content || '').includes(code)) {
            score += 25
        }
        if (content.includes(code)) {
            score += 10
        }

        const codeIdx = lowerCombined.indexOf(code.toLowerCase())
        if (codeIdx >= 0) {
            const surrounding = lowerCombined.slice(Math.max(0, codeIdx - 80), codeIdx + code.length + 80)
            if (/(error|오류|에러|message|원인|명칭|작업)/iu.test(surrounding)) {
                score += 20
            }
            if (/(미존재|존재하지|분석중|분석 중)/iu.test(surrounding)) {
                score += 20
            }
        }

        return score
    }

    const findErrorCodeLookupRow = async (code: string): Promise<ErrorCodeLookupRow | null> => {
        const rows = await DI.em.getConnection().execute<ErrorCodeLookupRow[]>(
            `SELECT skald_memo.uuid,
                    skald_memo.title,
                    skald_memocontent.content,
                    skald_memochunk.chunk_content,
                    skald_memo.metadata->>'source_url' AS source_url,
                    skald_memo.source,
                    skald_memo.metadata->>'submission_id' AS submission_id,
                    COALESCE(skald_memo.archived, false) AS archived
             FROM skald_memochunk
             JOIN skald_memo ON skald_memo.uuid = skald_memochunk.memo_uuid
             LEFT JOIN skald_memocontent ON skald_memo.uuid = skald_memocontent.memo_id
             WHERE skald_memo.project_id = ?
               AND skald_memochunk.chunk_content ILIKE ?
             ORDER BY skald_memochunk.chunk_index ASC
             LIMIT 50`,
            [project.uuid, `%${code}%`]
        )

        if (rows.length === 0) {
            return null
        }

        return (
            rows.map((row) => ({ row, score: scoreErrorCodeLookupRow(row, code) })).sort((a, b) => b.score - a.score)[0]
                ?.row ?? null
        )
    }

    for (const extractedKey of extractedKeys) {
        try {
            if (extractedKey.type === 'error_code') {
                const row = await findErrorCodeLookupRow(extractedKey.value)

                if (row) {
                    const sourceText = row.chunk_content || row.content || row.title
                    results.push({
                        memo_uuid: row.uuid,
                        key: extractedKey.value,
                        title: row.title,
                        content: extractErrorCodeSnippet(sourceText, extractedKey.value),
                        source_url: buildMemoSourceUrl({
                            projectUuid: project.uuid,
                            memoUuid: row.uuid,
                            sourceUrl: row.source_url,
                            source: row.source,
                            submissionId: row.submission_id,
                        }),
                        found: !row.archived,
                        status: row.archived ? 'archived_only' : 'hit',
                        archivedContent: row.archived
                            ? extractErrorCodeSnippet(sourceText, extractedKey.value)
                            : undefined,
                    })
                    if (!row.archived) {
                        anyHit = true
                    }
                    logger.info(
                        { key: extractedKey.value, type: extractedKey.type, memoUuid: row.uuid },
                        'exactLookup: HIT on error code content search'
                    )
                    continue
                }

                results.push({
                    key: extractedKey.value,
                    title: '',
                    content: '',
                    source_url: '',
                    found: false,
                    status: 'miss',
                })
                logger.info(
                    { key: extractedKey.value, type: extractedKey.type },
                    'exactLookup: MISS — error code not found in KB content'
                )
                continue
            }

            // Task 12: Two-stage lookup — first try active (archived=false), then archived
            const rows = await DI.em.getConnection().execute<
                Array<{
                    uuid: string
                    title: string
                    content: string | null
                    source_url: string | null
                    source: string | null
                    submission_id: string | null
                    archived: boolean
                }>
            >(
                `SELECT skald_memo.uuid, skald_memo.title,
                        skald_memocontent.content,
                        skald_memo.metadata->>'source_url' AS source_url,
                        skald_memo.source,
                        skald_memo.metadata->>'submission_id' AS submission_id,
                        COALESCE(skald_memo.archived, false) AS archived
                 FROM skald_memo
                 LEFT JOIN skald_memocontent ON skald_memo.uuid = skald_memocontent.memo_id
                 WHERE skald_memo.project_id = ?
                   AND skald_memo.client_reference_id = ?
                 LIMIT 1`,
                [project.uuid, extractedKey.value]
            )

            if (rows.length > 0) {
                const row = rows[0]
                if (!row.archived) {
                    // Normal hit
                    results.push({
                        memo_uuid: row.uuid,
                        key: extractedKey.value,
                        title: row.title,
                        content: row.content || row.title,
                        source_url: buildMemoSourceUrl({
                            projectUuid: project.uuid,
                            memoUuid: row.uuid,
                            sourceUrl: row.source_url,
                            source: row.source,
                            submissionId: row.submission_id,
                        }),
                        found: true,
                        status: 'hit',
                    })
                    anyHit = true
                    logger.info(
                        { key: extractedKey.value, type: extractedKey.type, memoUuid: row.uuid },
                        'exactLookup: HIT on client_reference_id (active)'
                    )
                } else {
                    // Task 12: Archived-only hit — surface as distinct state
                    results.push({
                        memo_uuid: row.uuid,
                        key: extractedKey.value,
                        title: row.title,
                        content: '',
                        source_url: buildMemoSourceUrl({
                            projectUuid: project.uuid,
                            memoUuid: row.uuid,
                            sourceUrl: row.source_url,
                            source: row.source,
                            submissionId: row.submission_id,
                        }),
                        found: false,
                        status: 'archived_only',
                        archivedContent: row.content || row.title,
                    })
                    logger.info(
                        { key: extractedKey.value, type: extractedKey.type, memoUuid: row.uuid },
                        'exactLookup: ARCHIVED-ONLY hit on client_reference_id'
                    )
                }
            } else {
                // Try metadata.issueKey fallback for Jira keys
                const metaRows = await DI.em.getConnection().execute<
                    Array<{
                        uuid: string
                        title: string
                        content: string | null
                        source_url: string | null
                        source: string | null
                        submission_id: string | null
                        archived: boolean
                    }>
                >(
                    `SELECT skald_memo.uuid, skald_memo.title,
                            skald_memocontent.content,
                            skald_memo.metadata->>'source_url' AS source_url,
                            skald_memo.source,
                            skald_memo.metadata->>'submission_id' AS submission_id,
                            COALESCE(skald_memo.archived, false) AS archived
                     FROM skald_memo
                     LEFT JOIN skald_memocontent ON skald_memo.uuid = skald_memocontent.memo_id
                     WHERE skald_memo.project_id = ?
                       AND skald_memo.metadata->>'issueKey' = ?
                     LIMIT 1`,
                    [project.uuid, extractedKey.value]
                )

                if (metaRows.length > 0) {
                    const row = metaRows[0]
                    if (!row.archived) {
                        // Normal hit
                        results.push({
                            memo_uuid: row.uuid,
                            key: extractedKey.value,
                            title: row.title,
                            content: row.content || row.title,
                            source_url: buildMemoSourceUrl({
                                projectUuid: project.uuid,
                                memoUuid: row.uuid,
                                sourceUrl: row.source_url,
                                source: row.source,
                                submissionId: row.submission_id,
                            }),
                            found: true,
                            status: 'hit',
                        })
                        anyHit = true
                        logger.info(
                            { key: extractedKey.value, type: extractedKey.type, memoUuid: row.uuid },
                            'exactLookup: HIT on metadata.issueKey (active)'
                        )
                    } else {
                        // Task 12: Archived-only hit
                        results.push({
                            memo_uuid: row.uuid,
                            key: extractedKey.value,
                            title: row.title,
                            content: '',
                            source_url: buildMemoSourceUrl({
                                projectUuid: project.uuid,
                                memoUuid: row.uuid,
                                sourceUrl: row.source_url,
                                source: row.source,
                                submissionId: row.submission_id,
                            }),
                            found: false,
                            status: 'archived_only',
                            archivedContent: row.content || row.title,
                        })
                        logger.info(
                            { key: extractedKey.value, type: extractedKey.type, memoUuid: row.uuid },
                            'exactLookup: ARCHIVED-ONLY hit on metadata.issueKey'
                        )
                    }
                } else {
                    // True miss
                    results.push({
                        key: extractedKey.value,
                        title: '',
                        content: '',
                        source_url: '',
                        found: false,
                        status: 'miss',
                    })
                    logger.info(
                        { key: extractedKey.value, type: extractedKey.type },
                        'exactLookup: MISS — key not found in KB'
                    )
                }
            }
        } catch (err) {
            logger.warn({ key: extractedKey.value, err }, 'exactLookup: error during lookup, skipping key')
            results.push({
                key: extractedKey.value,
                title: '',
                content: '',
                source_url: '',
                found: false,
                status: 'miss',
            })
        }
    }

    return {
        exactLookupKeys: extractedKeys,
        exactLookupResults: results,
        lookupHit: anyHit,
    }
}

/**
 * Merged node: analyzeQuery + queryRewrite run in parallel via Promise.all.
 * Both are LLM calls and are independent of each other (both use only query + history),
 * so running them concurrently saves one serial LLM round-trip.
 */
async function analyzeAndRewriteNode(state: typeof RAGState.State) {
    const { query, conversationHistory, ragConfig } = state
    const context = (conversationHistory || []).map(([role, content]) => `${role}: ${content}`).join('\n')
    const conversationMessages = (conversationHistory || [])
        .map(([userMsg, assistantMsg]) => [
            { role: 'user' as const, content: userMsg },
            { role: 'assistant' as const, content: assistantMsg },
        ])
        .flat()

    // P1-6: Speculative search — pre-compute original query embedding in parallel with LLM calls
    // This embedding will be reused in vectorSearchNode, saving one round-trip
    const [queryUnderstanding, rewrittenQueryRaw, precomputedQueryEmbedding] = await Promise.all([
        ragConfig.queryUnderstanding?.enabled
            ? QueryUnderstandingAgent.understandQuery(query, context)
            : Promise.resolve(null),
        ragConfig.queryRewrite.enabled ? rewrite(query, conversationMessages) : Promise.resolve(null),
        EmbeddingService.generateEmbedding(query, 'search'),
    ])

    const shouldDecompose =
        !!queryUnderstanding &&
        (queryUnderstanding.intent === 'comparison' ||
            queryUnderstanding.intent === 'troubleshooting' ||
            queryUnderstanding.query_type === 'broad')

    const subQuestions = shouldDecompose ? await decomposeQuery(query) : null

    logger.info(
        {
            originalQuery: query,
            rewrittenQuery: rewrittenQueryRaw,
            queryChanged: rewrittenQueryRaw && rewrittenQueryRaw !== query,
            queryUnderstandingEnabled: ragConfig.queryUnderstanding?.enabled,
            queryRewriteEnabled: ragConfig.queryRewrite.enabled,
            precomputedEmbedding: !!precomputedQueryEmbedding,
            decompositionEnabled: shouldDecompose,
            subQuestionCount: subQuestions?.length ?? 0,
        },
        'RAG analyzeAndRewrite completed (with speculative embedding)'
    )

    return {
        queryUnderstanding,
        rewrittenQuery: rewrittenQueryRaw && rewrittenQueryRaw !== query ? rewrittenQueryRaw : null,
        subQuestions,
        precomputedQueryEmbedding,
    }
}

function hybridResultToMemoChunk(result: HybridSearchResult): MemoChunkWithDistance {
    return {
        chunk: {
            uuid: result.uuid,
            chunk_content: result.chunk_content,
            chunk_index: 0,
            embedding: [],
            memo_uuid: result.memo_uuid,
            project_uuid: '',
        },
        distance: 2 * (1 - result.hybrid_score),
    }
}

function deduplicateByBestScore(allResults: MemoChunkWithDistance[][]): MemoChunkWithDistance[] {
    const memoScoreMap = new Map<string, MemoChunkWithDistance>()

    for (const results of allResults) {
        for (const result of results) {
            const memoUuid = result.chunk.memo_uuid
            const existing = memoScoreMap.get(memoUuid)

            if (!existing || result.distance < existing.distance) {
                memoScoreMap.set(memoUuid, result)
            }
        }
    }

    return Array.from(memoScoreMap.values()).sort((a, b) => a.distance - b.distance)
}

function calculateAverageScore(results: MemoChunkWithDistance[]): number {
    if (results.length === 0) return 0
    const avgDistance = results.reduce((sum, r) => sum + r.distance, 0) / results.length
    return Math.max(0, Math.min(1, 1 - avgDistance / 2))
}

function calculateDynamicConfidenceThreshold(results: RerankResult[], baseThreshold: number): number {
    if (results.length === 0) {
        return baseThreshold
    }

    const scores = results.map((result) => result.relevance_score)
    const averageScore = scores.reduce((sum, score) => sum + score, 0) / scores.length
    const maxScore = Math.max(...scores)

    if (maxScore >= baseThreshold) {
        return baseThreshold
    }

    return Math.max(0.18, Math.min(baseThreshold, averageScore * 0.9))
}

function buildLowConfidenceGuidance({
    mode,
    avgRelevanceScore,
}: {
    mode: Exclude<LowConfidenceGuidanceMode, 'none'>
    avgRelevanceScore: number
}): string {
    const avgScoreText = avgRelevanceScore.toFixed(2)

    const guidanceTable: Record<Exclude<LowConfidenceGuidanceMode, 'none'>, string> = {
        user_context_only_partial:
            '\n\n[응답 제한 모드: 사용자 제공 컨텍스트 우선]\n' +
            `- 검색된 문서 근거는 약하거나 없습니다 (평균 관련성: ${avgScoreText}).\n` +
            '- [User-Provided Context]에 직접 포함된 사실만 제한적으로 답변하십시오.\n' +
            '- 검색된 문서로 확인되지 않은 일반화, 확장 추론, 추가 사실 보완은 하지 마십시오.\n' +
            '- 답변에서 확인된 부분과 아직 확인되지 않은 부분을 분리해 명시하십시오.\n',
        retrieval_only_partial:
            '\n\n[응답 제한 모드: 약한 검색 근거]\n' +
            `- 검색된 문서의 관련성이 낮습니다 (평균 관련성: ${avgScoreText}).\n` +
            '- 검색된 문서에서 직접 확인되는 최소 사실만 부분적으로 답변하십시오.\n' +
            '- 문서에서 직접 확인되지 않는 세부사항은 추측하지 말고, 제공된 문맥에서 확인되지 않는다고 명시하십시오.\n' +
            '- blanket refusal 대신 제한된 범위의 grounded answer를 우선하십시오.\n',
        both_weak_limitations:
            '\n\n[응답 제한 모드: 근거 제한 및 상충 가능성]\n' +
            `- 검색 근거가 약하고(평균 관련성: ${avgScoreText}), 사용자 제공 컨텍스트만으로도 전체 질문을 확정하기 어렵습니다.\n` +
            '- 두 출처에서 직접 확인되는 최소 사실만 답변하고, 불확실하거나 누락된 부분은 명시적으로 구분하십시오.\n' +
            '- 검색 결과와 사용자 제공 컨텍스트가 상충하거나 범위가 다르면 그 차이를 숨기지 말고 드러내십시오.\n' +
            '- 근거가 없는 일반 상식 보완이나 확장 추론은 금지됩니다.\n',
        key_miss_with_alternatives:
            '\n\n[응답 제한 모드: 요청 문서 없음 + 대체 근거]\n' +
            '- 사용자가 요청한 특정 문서는 지식베이스에서 확인되지 않습니다.\n' +
            '- 다만 검색 결과 또는 사용자 제공 컨텍스트에 부분적으로 관련된 대체 근거가 있을 수 있습니다.\n' +
            '- 요청 문서 자체를 찾은 것처럼 말하지 말고, 대체 근거임을 명확히 밝힌 뒤 제한적으로 답변하십시오.\n' +
            '- 요청 문서 부재와 대체 근거 기반 답변을 반드시 분리해 설명하십시오.\n',
        insufficient_evidence:
            '\n\n[응답 제한 모드: 근거 부족]\n' +
            `- 검색 결과와 사용자 제공 컨텍스트 모두 질문에 답하기에 충분하지 않습니다 (평균 관련성: ${avgScoreText}).\n` +
            '- 제공된 문맥에서 직접 확인되는 사실이 없다면, 충분한 근거를 찾지 못했다고 분명히 말하십시오.\n' +
            '- 확인 가능한 최소 사실만 답변하고, 나머지는 제공된 문맥에서 확인되지 않는다고 설명하십시오.\n' +
            '- 절대로 내용을 만들어내지 마십시오.\n',
    }

    return guidanceTable[mode]
}

export function getLowConfidenceGuidanceMode({
    lookupHit,
    rerankedResults,
    confidenceThreshold,
    hasStrongLiteralAnchorEvidence = false,
    hasUserContext = false,
    hasKeyMisses = false,
}: {
    lookupHit: boolean | null
    rerankedResults: RerankResult[]
    confidenceThreshold: number
    hasStrongLiteralAnchorEvidence?: boolean
    hasUserContext?: boolean
    hasKeyMisses?: boolean
}): LowConfidenceGuidanceMode {
    const hasAlternativeEvidence = lookupHit || hasUserContext || rerankedResults.length > 0

    if (hasKeyMisses && hasAlternativeEvidence) {
        return 'key_miss_with_alternatives'
    }

    if (hasStrongLiteralAnchorEvidence) {
        return 'none'
    }

    const avgRelevanceScore =
        rerankedResults.length > 0
            ? rerankedResults.reduce((sum, r) => sum + r.relevance_score, 0) / rerankedResults.length
            : 0
    const retrievalWeak = rerankedResults.length === 0 || avgRelevanceScore < confidenceThreshold

    if (lookupHit || !retrievalWeak) {
        return 'none'
    }

    if (hasUserContext && rerankedResults.length === 0) {
        return 'user_context_only_partial'
    }

    if (hasUserContext && rerankedResults.length > 0) {
        return 'both_weak_limitations'
    }

    if (rerankedResults.length > 0) {
        return 'retrieval_only_partial'
    }

    return 'insufficient_evidence'
}

export function shouldInjectLowConfidenceGuidance({
    lookupHit,
    rerankedResults,
    confidenceThreshold,
    hasStrongLiteralAnchorEvidence = false,
    hasUserContext = false,
    hasKeyMisses = false,
}: {
    lookupHit: boolean | null
    rerankedResults: RerankResult[]
    confidenceThreshold: number
    hasStrongLiteralAnchorEvidence?: boolean
    hasUserContext?: boolean
    hasKeyMisses?: boolean
}): boolean {
    return (
        getLowConfidenceGuidanceMode({
            lookupHit,
            rerankedResults,
            confidenceThreshold,
            hasStrongLiteralAnchorEvidence,
            hasUserContext,
            hasKeyMisses,
        }) !== 'none'
    )
}

function hasStrongLiteralAnchorEvidence({
    query,
    rerankedResults,
    chunkResults,
    memoPropertiesMap,
}: {
    query: string
    rerankedResults: RerankResult[]
    chunkResults: MemoChunkWithDistance[] | null
    memoPropertiesMap: Map<string, { title: string; summary: string; content: string; source_url: string }> | null
}): boolean {
    if (!chunkResults || rerankedResults.length === 0) {
        return false
    }

    const anchors = extractQueryAnchors(query)
    if (anchors.length === 0) {
        return false
    }

    return rerankedResults.some((result) => {
        const chunk = chunkResults[result.index]?.chunk
        if (!chunk) {
            return false
        }

        const memo = memoPropertiesMap?.get(chunk.memo_uuid)
        const searchableText = [result.document, chunk.chunk_content, memo?.title, memo?.summary, memo?.content]
            .filter(Boolean)
            .join('\n')

        return anchors.some((anchor) => anchorMatchesText(anchor, searchableText))
    })
}

function checkFallbackCondition(results: MemoChunkWithDistance[], topK: number, threshold: number): boolean {
    if (results.length >= topK * 0.5) return false
    const avgScore = calculateAverageScore(results)
    return avgScore < threshold
}

async function executeFallbackSearch(
    query: string,
    project: Project,
    filters: MemoFilter[] | undefined,
    topK: number,
    threshold: number
): Promise<MemoChunkWithDistance[]> {
    const variants = await rewriteMultiQuery(query)
    const searchQueries = uniqueQueries([query, ...buildIdentifierFallbackQueries(query), ...variants])

    const expandedTopK = Math.ceil(topK * 3)

    const fallbackResults = await mapWithConcurrency(searchQueries, 3, async (searchQuery) => {
        const embeddingVector = await EmbeddingService.generateEmbedding(searchQuery, 'search')
        return memoChunkVectorSearch(project, embeddingVector, expandedTopK, threshold, filters, true)
    })

    return deduplicateByBestScore(fallbackResults)
}

function mergeSearchResults(
    primary: MemoChunkWithDistance[],
    fallback: MemoChunkWithDistance[]
): MemoChunkWithDistance[] {
    const seenMemoUuids = new Set(primary.map((r) => r.chunk.memo_uuid))
    const merged = [...primary]

    for (const result of fallback) {
        if (!seenMemoUuids.has(result.chunk.memo_uuid)) {
            merged.push(result)
            seenMemoUuids.add(result.chunk.memo_uuid)
        }
    }

    return merged.sort((a, b) => a.distance - b.distance)
}

async function vectorSearchNode(state: typeof RAGState.State) {
    const {
        rewrittenQuery,
        query,
        project,
        filters,
        ragConfig,
        queryUnderstanding,
        precomputedQueryEmbedding,
        subQuestions,
    } = state

    // Use dynamic search strategy from query understanding if available, otherwise use defaults
    const strategy = queryUnderstanding || {
        multiQuery: ragConfig.queryRewrite.multiQuery || false,
        hyde: false,
        jiraHyde: false,
        topK: ragConfig.vectorSearch.topK,
        rerank: ragConfig.reranking.enabled,
        mmr: ragConfig.reranking.mmrEnabled || false,
    }

    // P2-2: Dynamic HNSW ef_search based on topK
    await HNSWOptimizationService.applyRuntimeSearchTuning(DI.em, strategy.topK)

    const searchQueries = uniqueQueries([
        ...expandTechnicalQueryVariants(query),
        ...buildIdentifierFallbackQueries(query),
    ])
    if (rewrittenQuery && rewrittenQuery !== query) {
        searchQueries.push(...expandTechnicalQueryVariants(rewrittenQuery))
    }

    if (subQuestions && subQuestions.length > 1) {
        searchQueries.push(...subQuestions.slice(1).flatMap((subQuestion) => expandTechnicalQueryVariants(subQuestion)))
    }

    const [variants, hypothetical, jiraHypothetical] = await Promise.all([
        strategy.multiQuery ? rewriteMultiQuery(query) : Promise.resolve<string[]>([]),
        strategy.hyde ? generateHyDE(query) : Promise.resolve(''),
        strategy.jiraHyde ? generateJiraHyDE(query) : Promise.resolve(''),
    ])

    if (variants.length > 0) {
        searchQueries.push(...variants)
    }

    if (hypothetical) {
        searchQueries.push(hypothetical)
    }

    if (jiraHypothetical) {
        searchQueries.push(jiraHypothetical)
    }

    const uniqueSearchQueries = uniqueQueries(searchQueries)

    // Check if hybrid search is enabled (default: true for Korean optimization)
    const useHybridSearch = ragConfig.hybridSearch?.enabled ?? true

    logger.info(
        {
            searchQueriesCount: searchQueries.length,
            searchQueries,
            useHybridSearch,
            originalQuery: query,
            activeQuery: rewrittenQuery || query,
            similarityThreshold: ragConfig.vectorSearch.similarityThreshold,
            topK: strategy.topK,
            vectorWeight: ragConfig.hybridSearch?.vectorWeight ?? 0.7,
            bm25Weight: ragConfig.hybridSearch?.bm25Weight ?? 0.3,
        },
        'RAG vectorSearchNode starting'
    )

    if (useHybridSearch) {
        // Use hybrid search combining vector + BM25
        // P0-2 + P1-6: Use precomputed embedding for original query, batch the rest
        try {
            // Separate original query (already embedded in analyzeAndRewrite) from remaining queries
            const remainingQueries = uniqueSearchQueries.slice(1)
            const remainingEmbeddings =
                remainingQueries.length > 0
                    ? await EmbeddingService.generateEmbeddingsBatch(remainingQueries, 'search')
                    : []
            const allEmbeddings = [
                precomputedQueryEmbedding || (await EmbeddingService.generateEmbedding(query, 'search')),
                ...remainingEmbeddings,
            ]
            const allHybridResults = await mapWithConcurrency(
                uniqueSearchQueries.map((sq, i) => ({ query: sq, embedding: allEmbeddings[i] })),
                4,
                async ({ query: searchQuery, embedding: embeddingVector }) => {
                    return HybridSearchService.hybridSearch(project, embeddingVector, searchQuery, {
                        vectorWeight: ragConfig.hybridSearch?.vectorWeight ?? 0.7,
                        bm25Weight: ragConfig.hybridSearch?.bm25Weight ?? 0.3,
                        topK: strategy.topK,
                        similarityThreshold: ragConfig.vectorSearch.similarityThreshold,
                        filters: filters?.[0], // Use first filter if available
                    })
                }
            )

            // Merge results from all queries, keeping best score per document
            const mergedResults = deduplicateByBestScore(
                allHybridResults.map((results) => results.map(hybridResultToMemoChunk))
            )

            logger.info(
                {
                    searchQueriesUsed: searchQueries.length,
                    perQueryCounts: allHybridResults.map((r, i) => ({
                        query: uniqueSearchQueries[i].slice(0, 50),
                        count: r.length,
                    })),
                    mergedResultsCount: mergedResults.length,
                    topResults: mergedResults.slice(0, 5).map((r) => ({
                        memo_uuid: r.chunk.memo_uuid,
                        distance: r.distance,
                        chunk_content_preview: r.chunk.chunk_content?.slice(0, 80),
                    })),
                },
                'RAG hybrid search completed (multi-query merge)'
            )

            return { chunkResults: mergedResults }
        } catch (error) {
            logger.warn({ err: error }, 'Hybrid search failed, falling back to vector-only search')
            // Fall through to vector-only search
        }
    }

    // P0-2 + P1-6: Batch embedding for vector-only search path (reuse precomputed embedding)
    const remainingQueriesFallback = uniqueSearchQueries.slice(1)
    const remainingEmbeddingsFallback =
        remainingQueriesFallback.length > 0
            ? await EmbeddingService.generateEmbeddingsBatch(remainingQueriesFallback, 'search')
            : []
    const allEmbeddings = [
        precomputedQueryEmbedding || (await EmbeddingService.generateEmbedding(query, 'search')),
        ...remainingEmbeddingsFallback,
    ]
    const allResults = await mapWithConcurrency(
        uniqueSearchQueries.map((sq, i) => ({ query: sq, embedding: allEmbeddings[i] })),
        4,
        async ({ embedding: embeddingVector }) => {
            return memoChunkVectorSearch(
                project,
                embeddingVector,
                strategy.topK,
                ragConfig.vectorSearch.similarityThreshold,
                filters,
                true
            )
        }
    )

    const uniqueResults = deduplicateByBestScore(allResults)

    const shouldTriggerFallback = checkFallbackCondition(uniqueResults, strategy.topK, 0.4)

    if (shouldTriggerFallback) {
        logger.debug(
            {
                resultCount: uniqueResults.length,
                avgScore: calculateAverageScore(uniqueResults),
            },
            'Triggering fallback search'
        )

        const fallbackBaseQuery = uniqueSearchQueries[0] || query
        const fallbackResults = await executeFallbackSearch(fallbackBaseQuery, project, filters, strategy.topK, 0.45)

        return { chunkResults: mergeSearchResults(uniqueResults, fallbackResults) }
    }

    return { chunkResults: uniqueResults }
}

async function getMemoPropertiesNode(state: typeof RAGState.State) {
    const { chunkResults, project } = state
    // Need memo properties if reranking is enabled OR if references are enabled
    if (!chunkResults) {
        return { memoPropertiesMap: null }
    }

    const relevantMemoUuids = Array.from(new Set(chunkResults.map((c) => c.chunk.memo_uuid)))

    const memoPropertiesMap = await getTitleAndSummaryAndContentForMemoList(project.uuid, relevantMemoUuids)

    return { memoPropertiesMap }
}

async function rerankNode(state: typeof RAGState.State) {
    const { chunkResults, memoPropertiesMap, query, rewrittenQuery, ragConfig } = state
    if (!chunkResults) {
        return { rerankedResults: [] }
    }

    logger.info(
        {
            inputChunksCount: chunkResults.length,
            rerankingEnabled: ragConfig.reranking.enabled,
            searchQuery: rewrittenQuery || query,
            originalQuery: query,
            topK: ragConfig.reranking.topK,
        },
        'RAG rerankNode starting'
    )

    if (!ragConfig.reranking.enabled) {
        // map chunks to rerank results with embeddings for MMR
        const rerankedResults: RerankResult[] = []
        for (let i = 0; i < chunkResults.length; i++) {
            const chunk = chunkResults[i]
            const similarity = Math.max(0, Math.min(1, 1 - chunk.distance / 2))

            rerankedResults.push({
                index: i,
                document: chunk.chunk.chunk_content,
                relevance_score: similarity,
                memo_uuid: chunk.chunk.memo_uuid,
                memo_title: memoPropertiesMap?.get(chunk.chunk.memo_uuid)?.title || '',
                source_url: memoPropertiesMap?.get(chunk.chunk.memo_uuid)?.source_url || '',
                embedding: chunk.chunk.embedding as number[], // Pass embedding for MMR
            })
        }
        return {
            rerankedResults: preserveAnchorMatches({
                query,
                rerankedResults,
                chunkResults,
                memoPropertiesMap,
                topK: ragConfig.reranking.topK,
            }),
        }
    }

    const searchQuery = rewrittenQuery || query
    const rerankData: string[] = []
    const rerankMetadata: Array<{ memo_uuid: string; memo_title: string; source_url?: string }> = []

    for (const chunkResult of chunkResults) {
        const chunk = chunkResult.chunk

        let rerankSnippet = chunk.chunk_content
        if (memoPropertiesMap) {
            const memo = memoPropertiesMap.get(chunk.memo_uuid)
            rerankSnippet = `Title: ${memo?.title}\n\nFull content summary: ${memo?.summary}\n\nChunk content: ${chunk.chunk_content}\n\n`
        }

        rerankData.push(rerankSnippet)
        rerankMetadata.push({
            memo_uuid: chunk.memo_uuid,
            memo_title: memoPropertiesMap?.get(chunk.memo_uuid)?.title || '',
            source_url: memoPropertiesMap?.get(chunk.memo_uuid)?.source_url || '',
        })
    }

    // Dynamic batch size calculation based on reranker model
    const VOYAGE_RERANK_MODEL = process.env.VOYAGE_RERANK_MODEL || 'rerank-2-lite'
    const modelTokenLimits: Record<string, number> = {
        'rerank-2-lite': 32000,
        'rerank-2': 32000,
        default: 16000,
    }
    const avgTokensPerChunk = 1000
    const maxTokens = modelTokenLimits[VOYAGE_RERANK_MODEL] || modelTokenLimits['default']
    const batchSize = Math.max(10, Math.min(50, Math.floor((maxTokens * 0.7) / avgTokensPerChunk)))

    const rerankCutoff = Math.min(ragConfig.reranking.topK * 4, chunkResults.length)
    const truncatedRerankData = rerankData.slice(0, rerankCutoff)
    const truncatedRerankMetadata = rerankMetadata.slice(0, rerankCutoff)

    const truncatedDataBatches: string[][] = []
    const truncatedMetadataBatches: Array<Array<{ memo_uuid: string; memo_title: string; source_url?: string }>> = []
    for (let i = 0; i < truncatedRerankData.length; i += batchSize) {
        truncatedDataBatches.push(truncatedRerankData.slice(i, i + batchSize))
        truncatedMetadataBatches.push(truncatedRerankMetadata.slice(i, i + batchSize))
    }

    const results = (
        await mapWithConcurrency(truncatedDataBatches, 3, async (batch, idx) =>
            RerankService.rerank(searchQuery, batch, truncatedMetadataBatches[idx], {
                originalQuery: query,
            })
        )
    ).flat()

    // sort and add embeddings to results for MMR
    results.sort((a, b) => b.relevance_score - a.relevance_score)
    const resultsWithEmbeddings = results.map((result) => ({
        ...result,
        embedding: chunkResults[result.index]?.chunk.embedding as number[],
    }))
    const finalReranked = resultsWithEmbeddings.slice(0, ragConfig.reranking.topK)

    logger.info(
        {
            totalRerankResults: results.length,
            afterTopKFilter: finalReranked.length,
            topK: ragConfig.reranking.topK,
            topResults: finalReranked.slice(0, 5).map((r) => ({
                memo_uuid: r.memo_uuid,
                memo_title: r.memo_title,
                source_url: r.source_url,
                relevance_score: r.relevance_score,
            })),
        },
        'RAG rerankNode completed'
    )

    return {
        rerankedResults: preserveAnchorMatches({
            query,
            rerankedResults: finalReranked,
            chunkResults,
            memoPropertiesMap,
            topK: ragConfig.reranking.topK,
        }),
    }
}

async function cragValidationNode(state: typeof RAGState.State) {
    const { rerankedResults, query, ragConfig } = state

    logger.info(
        {
            cragEnabled: ragConfig.crag?.enabled,
            rerankedResultsCount: rerankedResults.length,
        },
        'RAG cragValidationNode starting'
    )

    if (!ragConfig.crag?.enabled || rerankedResults.length === 0) {
        logger.info(
            { cragEnabled: ragConfig.crag?.enabled, resultCount: rerankedResults.length },
            'CRAG skipped (disabled or no results)'
        )
        return { cragValidation: null }
    }

    const scoreThreshold = ragConfig.crag.scoreThreshold ?? 0.5
    const avgScore = rerankedResults.reduce((sum, r) => sum + r.relevance_score, 0) / rerankedResults.length
    const HIGH_CONFIDENCE_THRESHOLD = 0.75

    if (avgScore >= HIGH_CONFIDENCE_THRESHOLD) {
        logger.info({ avgScore, threshold: HIGH_CONFIDENCE_THRESHOLD }, 'CRAG skipped: high confidence scores')
        return { cragValidation: null }
    }

    if (avgScore >= scoreThreshold) {
        logger.debug({ avgScore, threshold: scoreThreshold }, 'CRAG skipped: scores above threshold')
        return { cragValidation: null }
    }

    logger.debug({ avgScore, threshold: scoreThreshold }, 'CRAG validation triggered')

    const validation = await validateRetrieval(query, rerankedResults, scoreThreshold)

    if (validation.needsRetry) {
        const retryInfo = getRetryStrategy(validation)
        logger.warn(
            {
                avgRelevance: validation.averageRelevance,
                suggestedStrategy: retryInfo.strategy,
                reason: retryInfo.reason,
            },
            'CRAG detected low quality retrieval'
        )
    }

    if (ragConfig.crag.filterLowRelevance && validation.scores.length > 0) {
        const filteredResults = rerankedResults.filter((_, idx) => {
            const score = validation.scores.find((s) => s.index === idx)
            return score?.relevance !== '무관'
        })

        if (filteredResults.length > 0 && filteredResults.length < rerankedResults.length) {
            logger.info(
                {
                    original: rerankedResults.length,
                    filtered: filteredResults.length,
                    removedCount: rerankedResults.length - filteredResults.length,
                    filterLowRelevance: true,
                },
                'CRAG filtered low relevance results'
            )
            return { rerankedResults: filteredResults, cragValidation: validation }
        }
    }

    return { cragValidation: validation }
}

function cosineSimilarityEmbedding(vec1: number[], vec2: number[]): number {
    // Calculate cosine similarity between two embedding vectors
    const dot = vec1.reduce((sum, v, i) => sum + v * vec2[i], 0)
    const norm1 = Math.sqrt(vec1.reduce((sum, v) => sum + v * v, 0))
    const norm2 = Math.sqrt(vec2.reduce((sum, v) => sum + v * v, 0))
    return norm1 && norm2 ? dot / (norm1 * norm2) : 0
}

function cosineSimilarity(doc1: string, doc2: string): number {
    // Simple word overlap-based similarity (DEPRECATED - not used in MMR, kept for reference)
    // In production, consider using TF-IDF or embeddings for better accuracy
    const words1 = new Set(doc1.toLowerCase().split(/\s+/))
    const words2 = new Set(doc2.toLowerCase().split(/\s+/))

    const intersection = new Set([...words1].filter((x) => words2.has(x)))
    const union = new Set([...words1, ...words2])

    return union.size === 0 ? 0 : intersection.size / union.size
}

async function mmrNode(state: typeof RAGState.State) {
    const { rerankedResults, ragConfig } = state

    logger.info(
        {
            mmrEnabled: ragConfig.reranking.mmrEnabled,
            inputCount: rerankedResults.length,
            lambda: ragConfig.reranking.mmrLambda ?? 0.5,
            topK: ragConfig.reranking.topK,
        },
        'RAG mmrNode starting'
    )

    if (!ragConfig.reranking.mmrEnabled || rerankedResults.length < 2) {
        logger.info('MMR skipped (disabled or < 2 results)')
        return { rerankedResults }
    }

    const lambda = ragConfig.reranking.mmrLambda ?? 0.5

    // Pre-compute similarity matrix for O(n²) → O(n²/2) optimization
    // simMatrix[i][j] = cosine similarity between rerankedResults[i] and rerankedResults[j]
    const n = rerankedResults.length
    const simMatrix: (number | null)[][] = Array.from({ length: n }, () => Array(n).fill(null))

    for (let i = 0; i < n; i++) {
        const embeddingI = rerankedResults[i].embedding
        if (!embeddingI) continue
        for (let j = i + 1; j < n; j++) {
            const embeddingJ = rerankedResults[j].embedding
            if (!embeddingJ) continue
            const sim = cosineSimilarityEmbedding(embeddingI, embeddingJ)
            simMatrix[i][j] = sim
            simMatrix[j][i] = sim
        }
    }

    // Track selected indices into the original array
    const selectedIndices: number[] = []
    const remainingIndices = rerankedResults.map((_, i) => i)

    // Greedy MMR algorithm with embedding-based diversity
    while (selectedIndices.length < Math.min(n, ragConfig.reranking.topK)) {
        let bestIndex = 0
        let bestScore = -Infinity

        for (let i = 0; i < remainingIndices.length; i++) {
            const resultIndex = remainingIndices[i]
            const relevance = rerankedResults[resultIndex].relevance_score

            // Use embedding-based diversity only; skip diversity when embeddings unavailable
            let diversity = 0
            if (selectedIndices.length > 0) {
                // Check if this result has an embedding
                if (rerankedResults[resultIndex].embedding) {
                    // Find max similarity with any selected item
                    let maxSim = -Infinity
                    for (const selectedIdx of selectedIndices) {
                        const sim = simMatrix[resultIndex][selectedIdx]
                        if (sim !== null && sim > maxSim) {
                            maxSim = sim
                        }
                    }
                    diversity = maxSim === -Infinity ? 0 : maxSim
                }
            }

            const mmrScore = lambda * relevance - (1 - lambda) * diversity
            if (mmrScore > bestScore) {
                bestScore = mmrScore
                bestIndex = i
            }
        }

        selectedIndices.push(remainingIndices[bestIndex])
        remainingIndices.splice(bestIndex, 1)
    }

    const selected = selectedIndices.map((i) => rerankedResults[i])

    logger.info(
        {
            mmrInputCount: rerankedResults.length,
            mmrOutputCount: selected.length,
        },
        'RAG mmrNode completed'
    )

    return { rerankedResults: selected }
}

function contextReorderNode(state: typeof RAGState.State) {
    const { rerankedResults, ragConfig } = state

    if (!ragConfig.contextReorder?.enabled || rerankedResults.length < 4) {
        return { rerankedResults }
    }

    const strategy = ragConfig.contextReorder.autoSelect
        ? selectOptimalStrategy(rerankedResults)
        : ragConfig.contextReorder.strategy || 'sandwich'

    const reorderedResults = reorderForLongContext(rerankedResults, { strategy })

    logger.debug(
        { strategy, originalCount: rerankedResults.length, reorderedCount: reorderedResults.length },
        'Context reorder applied'
    )

    return { rerankedResults: reorderedResults }
}

/**
 * Fetch parent chunks for reranked child chunks.
 *
 * Parent-child chunking strategy:
 * - Child chunks (small, 512 chars) are used for semantic search
 * - Parent chunks (large, 2048 chars) are used for LLM context
 *
 * This node fetches the parent chunk content for each child chunk
 * to provide richer context to the LLM.
 */
async function fetchParentChunksNode(state: typeof RAGState.State) {
    const { chunkResults } = state

    if (!chunkResults || chunkResults.length === 0) {
        return { parentChunkMap: null }
    }

    // Get unique child chunk UUIDs that have parent chunks
    const childChunkUuids = chunkResults.map((c) => c.chunk.uuid).filter((uuid) => uuid) // Filter out empty uuids

    if (childChunkUuids.length === 0) {
        return { parentChunkMap: null }
    }

    try {
        // Query to get parent chunk content for each child chunk
        const placeholders = childChunkUuids.map(() => '?').join(', ')
        const sql = `
            SELECT 
                c.uuid as child_uuid,
                p.chunk_content as parent_content
            FROM skald_memochunk c
            LEFT JOIN skald_memoparentchunk p ON c.parent_chunk_id = p.uuid
            WHERE c.uuid IN (${placeholders})
            AND p.uuid IS NOT NULL
        `

        const results = await DI.em.getConnection().execute<
            Array<{
                child_uuid: string
                parent_content: string
            }>
        >(sql, childChunkUuids)

        // Build map: child_chunk_uuid -> parent_chunk_content
        const parentChunkMap = new Map<string, string>()
        for (const row of results || []) {
            parentChunkMap.set(row.child_uuid, row.parent_content)
        }

        logger.debug(
            { childChunksWithParent: parentChunkMap.size, totalChildChunks: childChunkUuids.length },
            'Fetched parent chunks for child chunks'
        )

        return { parentChunkMap }
    } catch (error) {
        logger.warn({ err: error }, 'Failed to fetch parent chunks, falling back to child content')
        return { parentChunkMap: null }
    }
}

function buildWikiTraversalBlock(wikiTraversal: WikiTraversalContext | null): string {
    if (!wikiTraversal) {
        return ''
    }

    let block = ''

    if (wikiTraversal.pages.length > 0) {
        block += '[Related Wiki Pages]\n'
        for (const page of wikiTraversal.pages) {
            block += `- ${page.title} (${page.slug})`
            if (page.summary) {
                block += `: ${page.summary}`
            }
            block += '\n'
        }
        block += '[End of Related Wiki Pages]\n\n'
    }

    if (wikiTraversal.nodes.length > 0) {
        block += '[Wiki Graph Nodes]\n'
        for (const node of wikiTraversal.nodes) {
            block += `- ${node.displayName} <${node.nodeType}>`
            if (node.description) {
                block += `: ${node.description}`
            }
            block += '\n'
        }
        block += '[End of Wiki Graph Nodes]\n\n'
    }

    if (wikiTraversal.edges.length > 0) {
        block += '[Wiki Graph Relationships]\n'
        for (const edge of wikiTraversal.edges) {
            block += `- ${edge.fromCanonicalName} --[${edge.edgeType}]--> ${edge.toCanonicalName} (weight=${edge.weight})\n`
        }
        block += '[End of Wiki Graph Relationships]\n\n'
    }

    return block
}

async function wikiTraversalNode(state: typeof RAGState.State) {
    const { project, rerankedResults } = state
    const em = DI.orm.em.fork()

    if (!rerankedResults || rerankedResults.length === 0) {
        return { wikiTraversal: null }
    }

    const memoUuids = Array.from(
        new Set(rerankedResults.map((result) => result.memo_uuid).filter((value): value is string => Boolean(value)))
    ).slice(0, 8)

    if (memoUuids.length === 0) {
        return { wikiTraversal: null }
    }

    const rawSourceDocuments = await em.find(
        RawSourceDocument,
        {
            project,
            external_reference: { $in: memoUuids },
        },
        { fields: ['uuid', 'external_reference'] }
    )

    if (rawSourceDocuments.length === 0) {
        return { wikiTraversal: null }
    }

    const rawSourceDocumentIds = rawSourceDocuments.map((document) => document.uuid)
    const sourceLinks = await em.find(
        WikiPageSourceLink,
        {
            project,
            raw_source_document: { $in: rawSourceDocumentIds },
        },
        {
            populate: ['wiki_page_revision', 'wiki_page_revision.wiki_page'],
            orderBy: { created_at: 'DESC' },
        }
    )

    if (sourceLinks.length === 0) {
        return { wikiTraversal: null }
    }

    const pageByUuid = new Map<string, WikiPage>()
    for (const sourceLink of sourceLinks) {
        const page = sourceLink.wiki_page_revision?.wiki_page
        if (!page || pageByUuid.has(page.uuid)) {
            continue
        }
        pageByUuid.set(page.uuid, page)
    }

    const pages = Array.from(pageByUuid.values()).slice(0, 5)
    if (pages.length === 0) {
        return { wikiTraversal: null }
    }

    const canonicalNames = Array.from(
        new Set(
            pages.map((page) => page.canonical?.trim().toLowerCase()).filter((value): value is string => Boolean(value))
        )
    )

    const directNodes = canonicalNames.length
        ? await em.find(WikiNode, {
              project,
              canonical_name: { $in: canonicalNames },
          })
        : []

    const directNodeIds = directNodes.map((node) => node.uuid)
    const directEdges = directNodeIds.length
        ? await em.find(
              WikiEdge,
              {
                  project,
                  from_node: { $in: directNodeIds },
              },
              {
                  populate: ['from_node', 'to_node'],
                  orderBy: { weight: 'DESC', updated_at: 'DESC' },
                  limit: 12,
              }
          )
        : []

    const nodeByCanonicalName = new Map<string, WikiNode>()
    for (const node of directNodes) {
        nodeByCanonicalName.set(node.canonical_name, node)
    }
    for (const edge of directEdges) {
        if (edge.from_node?.canonical_name && !nodeByCanonicalName.has(edge.from_node.canonical_name)) {
            nodeByCanonicalName.set(edge.from_node.canonical_name, edge.from_node)
        }
        if (edge.to_node?.canonical_name && !nodeByCanonicalName.has(edge.to_node.canonical_name)) {
            nodeByCanonicalName.set(edge.to_node.canonical_name, edge.to_node)
        }
    }

    return {
        wikiTraversal: {
            pages: pages.map((page) => ({
                slug: page.slug,
                title: page.title,
                summary: page.summary || null,
                canonical: page.canonical || null,
                confidence: page.confidence,
                freshness: page.freshness,
            })),
            nodes: Array.from(nodeByCanonicalName.values())
                .slice(0, 10)
                .map((node) => ({
                    canonicalName: node.canonical_name,
                    displayName: node.display_name,
                    description: node.description || null,
                    nodeType: node.node_type,
                    confidence: node.confidence,
                    freshness: node.freshness,
                })),
            edges: directEdges.slice(0, 12).map((edge) => ({
                fromCanonicalName: edge.from_node.canonical_name,
                toCanonicalName: edge.to_node.canonical_name,
                edgeType: edge.edge_type,
                weight: edge.weight,
            })),
        },
    }
}

function buildLLMInputsNode(state: typeof RAGState.State) {
    const {
        conversationHistory,
        query,
        ragConfig,
        rerankedResults,
        clientSystemPrompt,
        userContext,
        memoPropertiesMap,
        parentChunkMap,
        chunkResults,
        exactLookupResults,
        lookupHit,
        subQuestions,
        wikiTraversal,
    } = state

    const queryAnchors = extractQueryAnchors(query)
    const hasAnchorEvidence = hasStrongLiteralAnchorEvidence({
        query,
        rerankedResults,
        chunkResults,
        memoPropertiesMap,
    })

    // P0-4: Confidence-based abstain — compute average relevance score
    const baseConfidenceThreshold = ragConfig.confidence?.threshold ?? 0.35
    const avgRelevanceScore =
        rerankedResults.length > 0
            ? rerankedResults.reduce((sum, r) => sum + r.relevance_score, 0) / rerankedResults.length
            : 0
    const confidenceThreshold = calculateDynamicConfidenceThreshold(rerankedResults, baseConfidenceThreshold)
    const hasUserContext = Boolean(userContext?.trim())
    const hasKeyMisses = Boolean(exactLookupResults?.some((result) => result.status === 'miss'))
    const lowConfidenceMode = getLowConfidenceGuidanceMode({
        lookupHit,
        rerankedResults,
        confidenceThreshold,
        hasStrongLiteralAnchorEvidence: hasAnchorEvidence,
        hasUserContext,
        hasKeyMisses,
    })

    if (lowConfidenceMode !== 'none') {
        logger.info(
            {
                mode: lowConfidenceMode,
                avgRelevanceScore: avgRelevanceScore.toFixed(3),
                threshold: confidenceThreshold,
                baseThreshold: baseConfidenceThreshold,
                resultCount: rerankedResults.length,
            },
            'Low confidence retrieval detected — injecting limitation guidance'
        )
    }

    // Build context string using parent chunk content when available (better for LLM)
    // Falls back to child chunk content if no parent is available
    let contextStr = ''

    // Task 7: Prepend exact lookup results to context string
    // Found keys get their full content inserted first (highest priority evidence)
    // Missing keys get an explicit "not found" notice so the LLM can surface it
    if (exactLookupResults && exactLookupResults.length > 0) {
        // Task 12: Separate hit, archived_only, and miss statuses
        const hitResults = exactLookupResults.filter((r) => r.status === 'hit')
        const archivedOnlyResults = exactLookupResults.filter((r) => r.status === 'archived_only')
        const missResults = exactLookupResults.filter((r) => r.status === 'miss')

        if (hitResults.length > 0) {
            contextStr += 'Primary exact-match evidence:\n'
            for (const result of hitResults) {
                contextStr += `Document: ${result.title}\n${result.content}\n`
                if (result.source_url) contextStr += `Source: ${result.source_url}\n`
                contextStr += '\n'
            }
            contextStr += 'End of primary exact-match evidence.\n\n'
        }

        // Task 12: Surface archived-only hits as distinct information
        if (archivedOnlyResults.length > 0) {
            contextStr += '[Archived Document Notice]\n'
            for (const result of archivedOnlyResults) {
                contextStr += `The document with key "${result.key}" exists but has been archived.\n`
                if (result.archivedContent) {
                    contextStr += `Archived content preview: ${result.archivedContent.substring(0, 200)}...\n`
                }
            }
            contextStr += '[End of Archived Document Notice]\n\n'
        }

        // Task 12: Provide explicit missing key notice
        if (missResults.length > 0) {
            contextStr += '[Key-Not-Found Notice]\n'
            for (const result of missResults) {
                contextStr += `The document with key "${result.key}" was NOT found in the knowledge base (neither active nor archived).\n`
            }
            contextStr += '[End of Key-Not-Found Notice]\n\n'
        }
    }

    contextStr += buildUserContextEvidenceBlock(userContext)

    contextStr += buildLiteralQueryAnchorBlock(query)

    if (subQuestions && subQuestions.length > 1) {
        contextStr += '[Mixed-Question Decomposition]\n'
        contextStr += subQuestions
            .map(
                (subQuestion, index) => `${index === 0 ? 'Original Question' : `Sub-question ${index}`}: ${subQuestion}`
            )
            .join('\n')
        contextStr += '\n[End of Mixed-Question Decomposition]\n\n'
    }

    contextStr += buildWikiTraversalBlock(wikiTraversal)

    for (let i = 0; i < rerankedResults.length; i++) {
        const result = rerankedResults[i]

        // Try to get parent chunk content for richer context
        let documentContent = result.document
        const childChunkContent = chunkResults?.[result.index]?.chunk.chunk_content || result.document

        // Find the corresponding chunk UUID to look up parent content
        if (parentChunkMap && chunkResults) {
            // Match by index since rerankedResults preserves chunk order
            const chunkUuid = chunkResults[result.index]?.chunk.uuid
            if (chunkUuid && parentChunkMap.has(chunkUuid)) {
                const parentContent = parentChunkMap.get(chunkUuid)!
                const childHasAnchor = queryAnchors.some((anchor) => anchorMatchesText(anchor, childChunkContent))

                // Preserve exact child evidence for literal-anchor queries before expanded parent context.
                documentContent = childHasAnchor
                    ? `${childChunkContent}\n\n[Expanded Parent Context]\n${parentContent}`
                    : parentContent
            }
        }

        contextStr += `Result ${i + 1}: ${documentContent}\n\n`
    }

    let systemPrompt = ragConfig.references.enabled ? CHAT_AGENT_INSTRUCTIONS_WITH_SOURCES : CHAT_AGENT_INSTRUCTIONS

    // P0-4: Inject low-confidence guidance into system prompt
    if (lowConfidenceMode !== 'none') {
        systemPrompt += buildLowConfidenceGuidance({
            mode: lowConfidenceMode,
            avgRelevanceScore,
        })
    }

    if (subQuestions && subQuestions.length > 1) {
        systemPrompt +=
            '\n\n[Mixed-Question Answer Format]\n' +
            'The query has been decomposed into bounded sub-questions. Answer in separated grounded sections.\n' +
            '- Use one short section per sub-question after the overall answer.\n' +
            '- Clearly label each section with the matching sub-question.\n' +
            '- Distinguish grounded facts from limited recommendations or unknown parts.\n' +
            '- If one sub-question lacks evidence, explicitly say that section is unverified instead of collapsing the whole answer.\n'
    }

    // Task 7: Inject key-not-found guidance if explicit keys were requested but not found
    if (
        exactLookupResults &&
        exactLookupResults.some((r) => !r.found) &&
        lowConfidenceMode !== 'key_miss_with_alternatives'
    ) {
        const missingKeys = exactLookupResults.filter((r) => !r.found).map((r) => r.key)
        const keyNotFoundGuidance =
            '\n\n[Key-Not-Found Guidance]\n' +
            `The user requested specific document(s) with key(s): ${missingKeys.join(', ')}\n` +
            'These documents were NOT found in the knowledge base.\n' +
            'You MUST explicitly inform the user that the requested key(s) are not available.\n' +
            'Do NOT provide a generic "no information found" response.\n' +
            'Instead, clearly state: "The document with key [KEY] is not present in the knowledge base."\n' +
            'If semantic search results are available, you may offer them as alternatives, but make it clear they are NOT the requested document.'
        systemPrompt += keyNotFoundGuidance
    }

    if (clientSystemPrompt) {
        // escape curly braces in clientSystemPrompt so they're treated as literal text
        // langchain uses {{ and }} to escape braces
        const escapedPrompt = (clientSystemPrompt || '').replace(/{/g, '{{').replace(/}/g, '}}')
        // append to main system prompt since multiple system messages are not allowed with cli-proxy-api
        systemPrompt += `\n\nAdditional instructions: ${escapedPrompt}`
    }

    const prompts: [string, string][] = [['system', systemPrompt]]

    // Escape curly braces in conversation history to prevent LangChain template variable interpretation
    // This is necessary because chat history may contain code snippets or variable references like ${projectId}
    const escapedHistory = (conversationHistory || []).map(([role, content]) => {
        const escapedContent = content.replace(/{/g, '{{').replace(/}/g, '}}')
        return [role, escapedContent] as ['human' | 'ai' | 'system', string]
    })
    prompts.push(...escapedHistory)
    prompts.push(['human', '{input}'])

    const prompt = ChatPromptTemplate.fromMessages(prompts)

    return { prompt, contextStr }
}

// ideally we'd dynamically skip nodes based on the ragConfig but
// that's annoyingly very hard with TypeScript it seems
// so we let the nodes themselves decide whether to run or not
const ragGraphDefinition = new StateGraph(RAGState)
    .addNode('getChatHistory', getChatHistoryNode)
    .addNode('exactLookup', exactLookupNode)
    .addNode('analyzeAndRewrite', analyzeAndRewriteNode)
    .addNode('vectorSearch', vectorSearchNode)
    .addNode('getMemoProperties', getMemoPropertiesNode)
    .addNode('rerank', rerankNode)
    .addNode('validateCrag', cragValidationNode)
    .addNode('mmr', mmrNode)
    .addNode('contextReorder', contextReorderNode)
    .addNode('fetchParentChunks', fetchParentChunksNode)
    .addNode('collectWikiTraversal', wikiTraversalNode)
    .addNode('buildLLMInputs', buildLLMInputsNode)
    .addEdge('__start__', 'getChatHistory')
    // exactLookup and analyzeAndRewrite can run in parallel after chat history is loaded
    .addEdge('getChatHistory', 'exactLookup')
    .addEdge('getChatHistory', 'analyzeAndRewrite')
    // Fan-in: vectorSearch waits for both exactLookup and analyzeAndRewrite
    .addEdge(['exactLookup', 'analyzeAndRewrite'], 'vectorSearch')
    // Fan-out: getMemoProperties and fetchParentChunks run in parallel after vectorSearch
    .addEdge('vectorSearch', 'getMemoProperties')
    .addEdge('vectorSearch', 'fetchParentChunks')
    .addEdge('getMemoProperties', 'rerank')
    .addEdge('rerank', 'validateCrag')
    .addEdge('validateCrag', 'mmr')
    .addEdge('mmr', 'contextReorder')
    .addEdge('contextReorder', 'collectWikiTraversal')
    // Fan-in: buildLLMInputs waits for both collectWikiTraversal and fetchParentChunks
    .addEdge(['collectWikiTraversal', 'fetchParentChunks'], 'buildLLMInputs')
    .addEdge('buildLLMInputs', END)

export const ragGraph = ragGraphDefinition.compile()

export const __testables__ = {
    analyzeAndRewriteNode,
    extractQueryAnchors,
    preserveAnchorMatches,
    buildLLMInputsNode,
    buildLiteralQueryAnchorBlock,
    buildUserContextEvidenceBlock,
    hasStrongLiteralAnchorEvidence,
    buildLowConfidenceGuidance,
    vectorSearchNode,
    wikiTraversalNode,
    buildWikiTraversalBlock,
}
