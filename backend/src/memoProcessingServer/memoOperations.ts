import { memoSummaryAgent } from '@/agents/memoSummaryAgent'
import { memoTagsAgent } from '@/agents/memoTagsAgent'
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters'
import { EmbeddingService } from '@/services/embeddingService'
import { EntityManager } from '@mikro-orm/core'
import { randomUUID } from 'crypto'
import { MemoChunk } from '@/entities/MemoChunk'
import { MemoParentChunk } from '@/entities/MemoParentChunk'
import { MemoTag } from '@/entities/MemoTag'
import { MemoSummary } from '@/entities/MemoSummary'
import { logger } from '@/lib/logger'
import { processChunksWithContext } from '@/lib/chunkProcessor'

const MAX_TOKENS_FOR_LLM = 4096
// Rough estimate: 1 token is approximately 4 characters (conservative)
const CHARS_PER_TOKEN = 4
const MAX_CHARS_FOR_LLM = MAX_TOKENS_FOR_LLM * CHARS_PER_TOKEN
// Short document threshold: skip parent-child chunking for small documents
const SHORT_DOCUMENT_THRESHOLD = 1000 // chars

// Contextual Retrieval: use LLM to generate per-chunk context descriptions for richer embeddings
// Enable via env var (expensive: 1 LLM call per chunk)
export const CONTEXTUAL_RETRIEVAL_ENABLED = process.env.CONTEXTUAL_RETRIEVAL_ENABLED === 'true'

// Parent-child chunking configuration
const PARENT_CHUNK_SIZE = 2048 // Larger chunks for LLM context
const CHILD_CHUNK_SIZE = 512 // Smaller chunks for precise semantic search
const PARENT_CHUNK_OVERLAP = 256 // 12.5% overlap for context continuity
const CHILD_CHUNK_OVERLAP = 128 // 25% overlap for semantic search precision

// Korean-friendly separators (large units to small units)
const CHUNK_SEPARATORS = ['\n\n', '\n', '。', '.', '，', ',', ' ', '']

const truncateContentForLLM = (content: string): string => {
    if (content.length <= MAX_CHARS_FOR_LLM) {
        return content
    }

    const truncated = content.substring(0, MAX_CHARS_FOR_LLM)
    logger.warn(
        {
            originalLength: content.length,
            truncatedLength: truncated.length,
            estimatedTokens: Math.ceil(content.length / CHARS_PER_TOKEN),
        },
        'Truncating memo content to fit within LLM token limits'
    )
    return truncated
}

// Initialize splitters for parent-child chunking strategy
let parentSplitter: RecursiveCharacterTextSplitter | null = null
let childSplitter: RecursiveCharacterTextSplitter | null = null

const initParentSplitter = (): RecursiveCharacterTextSplitter => {
    if (!parentSplitter) {
        parentSplitter = new RecursiveCharacterTextSplitter({
            chunkSize: PARENT_CHUNK_SIZE,
            chunkOverlap: PARENT_CHUNK_OVERLAP,
            separators: CHUNK_SEPARATORS,
        })
    }
    return parentSplitter
}

const initChildSplitter = (): RecursiveCharacterTextSplitter => {
    if (!childSplitter) {
        childSplitter = new RecursiveCharacterTextSplitter({
            chunkSize: CHILD_CHUNK_SIZE,
            chunkOverlap: CHILD_CHUNK_OVERLAP,
            separators: CHUNK_SEPARATORS,
        })
    }
    return childSplitter
}

/**
 * Build contextual content for embedding by prepending memo title to chunk.
 * This follows the Anthropic Contextual Retrieval approach:
 * https://www.anthropic.com/news/contextual-retrieval
 *
 * The contextual content is used for generating embeddings, while the
 * original chunk content is stored for display in search results.
 */
const buildContextualContent = (chunkContent: string, title: string | null): string => {
    if (!title || title.trim() === '') {
        return chunkContent
    }

    // Format: [제목: {title}]\n---\n{chunk}
    return `[제목: ${title.trim()}]\n---\n${chunkContent}`
}

/**
 * Create a child chunk linked to a parent chunk.
 * Child chunks are smaller (512 chars) and have embeddings for semantic search.
 */
const _createChildChunk = async (
    em: EntityManager,
    memoUuid: string,
    projectId: string,
    chunkContent: string,
    chunkIndex: number,
    parentChunk: MemoParentChunk,
    title: string | null = null,
    embeddingContent?: string // Optional override: used by Contextual Retrieval
): Promise<MemoChunk> => {
    // Use provided embedding content (contextual) or fall back to title-prefix approach
    const contentForEmbedding = embeddingContent || buildContextualContent(chunkContent, title)
    const vectorEmbedding = await EmbeddingService.generateEmbedding(contentForEmbedding, 'storage')
    return em.create(MemoChunk, {
        uuid: randomUUID(),
        memo: memoUuid,
        project: projectId,
        memo_uuid: memoUuid,
        project_uuid: projectId,
        // Store original chunk content (without title) for display
        chunk_content: chunkContent,
        chunk_index: chunkIndex,
        embedding: JSON.stringify(vectorEmbedding) as any,
        // Link to parent chunk
        parent_chunk: parentChunk,
        parent_chunk_uuid: parentChunk.uuid,
    })
}

/**
 * Create a parent chunk (no embedding - used for LLM context only).
 */
const _createParentChunk = (
    em: EntityManager,
    memoUuid: string,
    projectId: string,
    chunkContent: string,
    chunkIndex: number
): MemoParentChunk => {
    return em.create(MemoParentChunk, {
        uuid: randomUUID(),
        memo: memoUuid,
        project: projectId,
        memo_uuid: memoUuid,
        project_uuid: projectId,
        chunk_content: chunkContent,
        chunk_index: chunkIndex,
    })
}

/**
 * Create memo chunks using parent-child chunking strategy.
 *
 * Strategy:
 * 1. Create large parent chunks (2048 chars) for LLM context
 * 2. Split each parent into smaller child chunks (512 chars) for semantic search
 * 3. Child chunks have embeddings, parent chunks do not
 * 4. At retrieval time: search children → fetch parent → use parent content for LLM
 *
 * This provides precise semantic search (small chunks) while maintaining
 * rich context for LLM responses (large chunks).
 */
export const createMemoChunks = async (
    em: EntityManager,
    memoUuid: string,
    projectId: string,
    content: string,
    title: string | null = null
): Promise<void> => {
    // Short document optimization: skip parent-child chunking for small documents.
    // Avoids unnecessary splits that hurt retrieval quality for short content.
    if (content.length <= SHORT_DOCUMENT_THRESHOLD) {
        logger.debug({ memoUuid, contentLength: content.length }, 'Short document: using single-chunk strategy')
        const singleParent = _createParentChunk(em, memoUuid, projectId, content, 0)
        const contextualContent = buildContextualContent(content, title)
        const vectorEmbedding = await EmbeddingService.generateEmbedding(contextualContent, 'storage')
        const singleChild = em.create(MemoChunk, {
            uuid: randomUUID(),
            memo: memoUuid,
            project: projectId,
            memo_uuid: memoUuid,
            project_uuid: projectId,
            chunk_content: content,
            chunk_index: 0,
            embedding: JSON.stringify(vectorEmbedding) as any,
            parent_chunk: singleParent,
            parent_chunk_uuid: singleParent.uuid,
        })
        await em.persistAndFlush([singleParent, singleChild])
        logger.info({ memoUuid, contentLength: content.length }, 'Created single chunk for short document')
        return
    }
    const parentSplitterInstance = initParentSplitter()
    const childSplitterInstance = initChildSplitter()
    const parentChunksText = await parentSplitterInstance.splitText(content)
    const allChildChunks: MemoChunk[] = []
    const allParentChunks: MemoParentChunk[] = []
    let globalChildIndex = 0
    for (let parentIndex = 0; parentIndex < parentChunksText.length; parentIndex++) {
        const parentText = parentChunksText[parentIndex]
        const parentChunk = _createParentChunk(em, memoUuid, projectId, parentText, parentIndex)
        allParentChunks.push(parentChunk)
        const childChunksText = await childSplitterInstance.splitText(parentText)
        let embeddingContents: Array<string | undefined>

        if (CONTEXTUAL_RETRIEVAL_ENABLED && title) {
            // Contextual Retrieval: generate LLM context for each chunk to enrich embeddings.
            // processChunksWithContext returns '[CONTEXT: ...]\n\n{chunk}' format.
            logger.debug({ memoUuid, chunkCount: childChunksText.length }, 'Contextual Retrieval: generating chunk contexts')
            const contextualChunks = await processChunksWithContext(
                childChunksText.map((text, i) => ({ content: text, index: globalChildIndex + i })),
                content,
                title
            )
            embeddingContents = contextualChunks.map((c) => c.content)
        } else {
            // Default: use title-prefix approach (fast, no LLM call per chunk)
            embeddingContents = childChunksText.map(() => undefined)
        }
        // Create child chunks with embeddings, linked to parent
        const childPromises = childChunksText.map((childText, localChildIndex) =>
            _createChildChunk(
                em,
                memoUuid,
                projectId,
                childText,
                globalChildIndex + localChildIndex,
                parentChunk,
                title,
                embeddingContents[localChildIndex]
            )
        )
        const childChunks = await Promise.all(childPromises)
        allChildChunks.push(...childChunks)
        globalChildIndex += childChunksText.length
    }
    // Persist all chunks in order: parents first (for FK integrity), then children
    await em.persistAndFlush([...allParentChunks, ...allChildChunks])
    logger.info(
        {
            memoUuid,
            parentChunks: allParentChunks.length,
            childChunks: allChildChunks.length,
            contextualRetrieval: CONTEXTUAL_RETRIEVAL_ENABLED,
        },
        'Created parent-child chunks for memo'
    )
}

export const extractTagsFromMemo = async (em: EntityManager, memoUuid: string, content: string, projectId: string) => {
    const truncatedContent = truncateContentForLLM(content)
    const tags = await memoTagsAgent.extractTags(truncatedContent)
    const memoTags = tags.tags.map((tag) =>
        em.create(MemoTag, { uuid: randomUUID(), memo: memoUuid, project: projectId, tag })
    )
    await em.persistAndFlush(memoTags)
}

export const generateMemoSummary = async (em: EntityManager, memoUuid: string, content: string, projectId: string) => {
    const truncatedContent = truncateContentForLLM(content)
    const summary = await memoSummaryAgent.summarize(truncatedContent)
    const embedding = await EmbeddingService.generateEmbedding(summary.summary, 'storage')
    const memoSummary = em.create(MemoSummary, {
        uuid: randomUUID(),
        memo: memoUuid,
        project: projectId,
        summary: summary.summary,
        embedding: JSON.stringify(embedding) as any,
    })
    await em.persistAndFlush(memoSummary)
}
