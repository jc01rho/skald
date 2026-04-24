import { MemoNotFoundError, ProjectNotFoundError } from '@/lib/errors'
import {
    createMemoChunks,
    generateMemoSummary,
    CONTEXTUAL_RETRIEVAL_ENABLED,
} from '@/memoProcessingServer/memoOperations'
import { EntityManager } from '@mikro-orm/core'
import { updateMemoStatus } from '@/lib/memoStatusUtils'
import { logger } from '@/lib/logger'
import { DocumentProcessingService } from '@/services/documentProcessingService'
import { MemoContent } from '@/entities/MemoContent'
import { randomUUID } from 'node:crypto'
import { UsageTrackingService } from '@/services/usageTrackingService'
import { calculateMemoWritesUsage } from '@/lib/usageTrackingUtils'
import { Project } from '@/entities/Project'
import { Organization } from '@/entities/Organization'
import { LLM_PROVIDER, WIKI_ASYNC_MODE } from '@/settings'
import { WikiCompilerService } from '@/services/wiki/wikiCompilerService'

const runMemoProcessingAgents = async (em: EntityManager, memoUuid: string) => {
    const sql = `
        SELECT 
            m.uuid as memo_uuid,
            m.project_id,
            m.type,
            m.title,
            mc.content
        FROM skald_memo m
        LEFT JOIN skald_memocontent mc ON mc.memo_id = m.uuid
        WHERE m.uuid = ?
    `

    const result: Array<{
        memo_uuid: string
        project_id: string
        type: string | null
        title: string | null
        content: string | null
    }> = await em.getConnection().execute(sql, [memoUuid])

    if (!result || result.length === 0) {
        throw new MemoNotFoundError(memoUuid)
    }

    const row = result[0]

    if (row.type === 'document') {
        // KLUDGE: this is problematic because a large document can take a long time to process, and we're holding up the
        // queue in the meantime. Document memos should either be handled by a separate queue, or we should restructure our queue
        // setup to read from sqs and add to an in-memory queue that we chug along at our own pace.
        const markdown = await DocumentProcessingService.sendDocumentForProcessing(row.project_id, row.memo_uuid)

        // documents only have content set after being processed by the document processing service
        // whereas plaintext memos have content set immediately by the api service
        const memoContent = em.create(MemoContent, {
            uuid: randomUUID(),
            memo: row.memo_uuid,
            content: markdown,
            project: row.project_id,
        })
        await em.persistAndFlush(memoContent)

        row.content = markdown

        const writeOperationsUsed = calculateMemoWritesUsage(markdown)
        const project = await em.findOne(Project, { uuid: row.project_id })
        if (!project) {
            throw new ProjectNotFoundError(row.project_id)
        }
        await new UsageTrackingService(em).incrementMemoOperations(
            { uuid: project.organization.uuid } as Organization,
            writeOperationsUsed
        )
    }

    if (!row.content) {
        logger.warn({ memoUuid }, 'No content found for memo, skipping processing')
        return
    }

    // Delete existing chunks and summaries before re-processing to prevent accumulation.
    // Without this, repeated reprocessing creates duplicate chunks (root cause of DB bloat:
    // 4.4M parent chunks for ~15K memos). Child chunks must be deleted before parent chunks
    // to avoid FK constraint violations on parent_chunk_id.
    const conn = em.getConnection()
    await conn.execute(`DELETE FROM skald_memochunk WHERE memo_id = ?`, [row.memo_uuid])
    await conn.execute(`DELETE FROM skald_memoparentchunk WHERE memo_id = ?`, [row.memo_uuid])
    await conn.execute(`DELETE FROM skald_memosummary WHERE memo_id = ?`, [row.memo_uuid])
    logger.info({ memoUuid: row.memo_uuid }, 'Cleared existing chunks and summaries before re-processing')

    const promises = [createMemoChunks(em, row.memo_uuid, row.project_id, row.content, row.title)]

    if (['openai', 'anthropic', 'gemini', 'local'].includes(LLM_PROVIDER)) {
        // promises.push(extractTagsFromMemo(em, row.memo_uuid, row.content, row.project_id))
        promises.push(generateMemoSummary(em, row.memo_uuid, row.content, row.project_id))
    }

    await Promise.all(promises)
}

export const processMemo = async (em: EntityManager, memoUuid: string) => {
    try {
        await updateMemoStatus(em, memoUuid, {
            processing_status: 'processing',
            processing_started_at: new Date(),
        })

        await runMemoProcessingAgents(em, memoUuid)

        const refreshRequest = await WikiCompilerService.enqueueRefreshForMemo(em, memoUuid, 'memo_updated')
        if (refreshRequest) {
            await WikiCompilerService.dispatchRefreshRequest(em, refreshRequest)
            if (WIKI_ASYNC_MODE !== 'queue') {
                await WikiCompilerService.processPendingRefreshes(em, 1)
            }
        }

        await updateMemoStatus(em, memoUuid, {
            processing_status: 'processed',
            processing_completed_at: new Date(),
            processing_error: null,
            metadata_updates: {
                contextual_retrieval_applied: CONTEXTUAL_RETRIEVAL_ENABLED,
            },
        })

        logger.info({ memoUuid }, 'Memo processing completed successfully')
    } catch (error) {
        // If memo doesn't exist, we can't update its status - just log and re-throw
        if (error instanceof MemoNotFoundError) {
            logger.warn({ memoUuid: error.memoUuid }, 'Memo not found, skipping processing')
            throw error
        }

        const errorMessage = error instanceof Error ? error.message : 'Unknown processing error'

        try {
            await updateMemoStatus(em, memoUuid, {
                processing_status: 'error',
                processing_completed_at: new Date(),
                processing_error: errorMessage,
            })
        } catch (statusUpdateError) {
            logger.error({ err: statusUpdateError, memoUuid }, 'Failed to update memo status after error')
        }

        logger.error({ err: error, memoUuid }, 'Memo processing failed')

        // re-throw to let the queue retry logic handle it
        throw error
    }
}
