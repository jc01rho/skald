import express, { Request, Response } from 'express'
import { z } from 'zod'
import { randomUUID } from 'crypto'
import { DI } from '@/di'
import { logger } from '@/lib/logger'

const CreateMemoSubmissionRequest = z.object({
    project_id: z.string().uuid('Project ID must be a valid UUID').optional(),
    title: z.string().min(1, 'Title is required').max(255, 'Title must be 255 characters or less'),
    content: z.string().min(1, 'Content is required'),
    source: z.string().max(255).optional().nullable(),
    type: z.string().max(100).optional().nullable(),
    reference_id: z.string().max(255).optional().nullable(),
    tags: z.array(z.string()).optional().nullable(),
    metadata: z.record(z.string(), z.unknown()).optional().nullable(),
    submitter_name: z.string().max(255).optional().nullable(),
    submitter_email: z.string().email().max(255).optional().nullable(),
    file_name: z.string().max(500).optional().nullable(),
    expiration_date: z.coerce.date().optional().nullable(),
})

const ListMemoSubmissionQuery = z.object({
    project_id: z.string().uuid('Project ID must be a valid UUID'),
    status: z.enum(['pending', 'approved', 'rejected']).optional(),
    page: z.coerce.number().int().min(1).default(1),
    page_size: z.coerce.number().int().min(1).max(100).default(20),
})

const GetMemoSubmissionQuery = z.object({
    project_id: z.string().uuid('Project ID must be a valid UUID'),
})

// Helper to build response with all frontend-expected fields
const buildSubmissionResponse = (
    submission: {
        uuid: string
        created_at: Date
        updated_at: Date
        title: string
        content?: string
        status: string
        reviewed_at?: Date | null
        rejection_reason?: string | null
        metadata?: Record<string, unknown>
    },
    includeContent = false,
    memoUuid: string | null = null
) => ({
    uuid: submission.uuid,
    created_at: submission.created_at,
    updated_at: submission.updated_at,
    title: submission.title,
    content: includeContent ? submission.content : undefined,
    status: submission.status,
    summary: null,
    source: null,
    type: null,
    submitter_name: null,
    submitter_email: null,
    reviewed_at: submission.reviewed_at || null,
    review_note: submission.rejection_reason || null,
    rejection_reason: submission.rejection_reason || null,
    metadata: submission.metadata || {},
    client_reference_id: null,
    expiration_date: null,
    tags: [],
    file_name: null,
    memo_uuid: memoUuid,
})

export const createMemoSubmission = async (req: Request, res: Response) => {
    // Support project_id from body or query
    const projectId = req.body.project_id || req.query.project_id
    if (!projectId) {
        return res.status(400).json({ error: 'Project ID is required' })
    }

    const bodyWithProjectId = { ...req.body, project_id: projectId }
    const validatedData = CreateMemoSubmissionRequest.safeParse(bodyWithProjectId)
    if (!validatedData.success) {
        const errorMessages = validatedData.error.errors.map((err) => err.message)
        return res.status(400).json({ error: errorMessages.join(', ') })
    }

    const { title, content } = validatedData.data
    const project_id = projectId

    const project = await DI.projects.findOne({ uuid: project_id })
    if (!project) {
        return res.status(404).json({ error: 'Project not found' })
    }

    try {
        const submission = DI.memoSubmissions.create({
            uuid: randomUUID(),
            project,
            title,
            content,
            status: 'pending',
            created_at: new Date(),
            updated_at: new Date(),
        })

        await DI.em.persistAndFlush(submission)

        return res.status(201).json({ submission_uuid: submission.uuid })
    } catch (error) {
        logger.error({ err: error }, 'Error creating memo submission')
        return res.status(500).json({ error: 'Failed to create memo submission' })
    }
}

export const listMemoSubmissions = async (req: Request, res: Response) => {
    const validatedQuery = ListMemoSubmissionQuery.safeParse(req.query)
    if (!validatedQuery.success) {
        const errorMessages = validatedQuery.error.errors.map((err) => err.message)
        return res.status(400).json({ error: errorMessages.join(', ') })
    }

    const { project_id, status, page, page_size } = validatedQuery.data

    const project = await DI.projects.findOne({ uuid: project_id })
    if (!project) {
        return res.status(404).json({ error: 'Project not found' })
    }

    const offset = (page - 1) * page_size

    const whereClause: Record<string, unknown> = { project }
    if (status) {
        whereClause.status = status
    }

    const [submissions, totalCount] = await DI.memoSubmissions.findAndCount(whereClause, {
        orderBy: { created_at: 'DESC' },
        limit: page_size,
        offset,
    })

    const submissionIds = submissions.map((submission) => submission.uuid)
    const memoRows = submissionIds.length
        ? await DI.em.getConnection().execute<{ submission_id: string; memo_uuid: string }[]>(
              `
                SELECT metadata->>'submission_id' AS submission_id, uuid AS memo_uuid
                FROM skald_memo
                WHERE project_id = ?
                  AND metadata->>'submission_id' IN (?)
              `,
              [project_id, submissionIds]
          )
        : []
    const memoUuidBySubmissionId = new Map(memoRows.map((row) => [row.submission_id, row.memo_uuid]))

    const results = submissions.map((submission) =>
        buildSubmissionResponse(submission, false, memoUuidBySubmissionId.get(submission.uuid) || null)
    )

    return res.status(200).json({
        results,
        count: totalCount,
        page,
        page_size,
        total_pages: Math.ceil(totalCount / page_size),
    })
}

export const getMemoSubmission = async (req: Request, res: Response) => {
    const { id } = req.params

    const validatedQuery = GetMemoSubmissionQuery.safeParse(req.query)
    if (!validatedQuery.success) {
        const errorMessages = validatedQuery.error.errors.map((err) => err.message)
        return res.status(400).json({ error: errorMessages.join(', ') })
    }

    const { project_id } = validatedQuery.data

    const project = await DI.projects.findOne({ uuid: project_id })
    if (!project) {
        return res.status(404).json({ error: 'Project not found' })
    }

    const submission = await DI.memoSubmissions.findOne({ uuid: id, project })

    if (!submission) {
        return res.status(404).json({ error: 'Memo submission not found' })
    }

    return res.status(200).json(buildSubmissionResponse(submission, true))
}

// Auth-protected routes
export const listAuthMemoSubmissions = async (req: Request, res: Response) => {
    const project = req.context?.requestUser?.project
    if (!project) {
        return res.status(404).json({ error: 'Project not found' })
    }

    const status = req.query.status as 'pending' | 'approved' | 'rejected' | undefined
    const page = parseInt(req.query.page as string) || 1
    const pageSize = parseInt(req.query.page_size as string) || 20
    const maxPageSize = 100

    if (pageSize > maxPageSize) {
        return res.status(400).json({ error: `page_size must be less than or equal to ${maxPageSize}` })
    }

    if (page < 1) {
        return res.status(400).json({ error: 'page must be greater than or equal to 1' })
    }

    const offset = (page - 1) * pageSize

    if (status === 'approved') {
        const [countRow] = await DI.em.getConnection().execute<{ count: string }[]>(
            `
                SELECT COUNT(*)::text AS count
                FROM skald_memo_submission submission
                INNER JOIN skald_memo memo
                    ON memo.project_id = ?
                   AND memo.metadata->>'submission_id' = submission.uuid::text
                WHERE submission.project_id = ?
                  AND submission.status = 'approved'
            `,
            [project.uuid, project.uuid]
        )

        const rows = await DI.em.getConnection().execute<
            {
                uuid: string
                created_at: Date
                updated_at: Date
                title: string
                status: string
                reviewed_at: Date | null
                rejection_reason: string | null
                memo_uuid: string
                source: string | null
                summary: string | null
            }[]
        >(
            `
                SELECT
                    submission.uuid,
                    submission.created_at,
                    submission.updated_at,
                    submission.title,
                    submission.status,
                    submission.reviewed_at,
                    submission.rejection_reason,
                    memo.uuid AS memo_uuid,
                    memo.source,
                    COALESCE(summary.summary, LEFT(content.content, 280)) AS summary
                FROM skald_memo_submission submission
                INNER JOIN skald_memo memo
                    ON memo.project_id = ?
                   AND memo.metadata->>'submission_id' = submission.uuid::text
                LEFT JOIN skald_memosummary summary ON memo.uuid = summary.memo_id
                LEFT JOIN skald_memocontent content ON memo.uuid = content.memo_id
                WHERE submission.project_id = ?
                  AND submission.status = 'approved'
                ORDER BY submission.created_at DESC
                LIMIT ? OFFSET ?
            `,
            [project.uuid, project.uuid, pageSize, offset]
        )

        return res.status(200).json({
            results: rows.map((row) => ({
                uuid: row.uuid,
                created_at: row.created_at,
                updated_at: row.updated_at,
                title: row.title,
                content: undefined,
                status: row.status,
                summary: row.summary,
                source: row.source,
                type: null,
                submitter_name: null,
                submitter_email: null,
                reviewed_at: row.reviewed_at || null,
                review_note: row.rejection_reason || null,
                rejection_reason: row.rejection_reason || null,
                metadata: {},
                client_reference_id: null,
                expiration_date: null,
                tags: [],
                file_name: null,
                memo_uuid: row.memo_uuid,
            })),
            count: Number(countRow?.count || 0),
            page,
            page_size: pageSize,
            total_pages: Math.ceil(Number(countRow?.count || 0) / pageSize),
        })
    }

    const whereClause: Record<string, unknown> = { project }
    if (status) {
        whereClause.status = status
    }

    const [submissions, totalCount] = await DI.memoSubmissions.findAndCount(whereClause, {
        orderBy: { created_at: 'DESC' },
        limit: pageSize,
        offset,
    })

    const submissionIds = submissions.map((submission) => submission.uuid)
    const memoRows = submissionIds.length
        ? await DI.em.getConnection().execute<{ submission_id: string; memo_uuid: string }[]>(
              `
                SELECT metadata->>'submission_id' AS submission_id, uuid AS memo_uuid
                FROM skald_memo
                WHERE project_id = ?
                  AND metadata->>'submission_id' IN (?)
              `,
              [project.uuid, submissionIds]
          )
        : []
    const memoUuidBySubmissionId = new Map(memoRows.map((row) => [row.submission_id, row.memo_uuid]))

    const results = submissions.map((submission) =>
        buildSubmissionResponse(submission, false, memoUuidBySubmissionId.get(submission.uuid) || null)
    )

    return res.status(200).json({
        results,
        count: totalCount,
        page,
        page_size: pageSize,
        total_pages: Math.ceil(totalCount / pageSize),
    })
}

export const getAuthMemoSubmission = async (req: Request, res: Response) => {
    const project = req.context?.requestUser?.project
    if (!project) {
        return res.status(404).json({ error: 'Project not found' })
    }

    const { id } = req.params

    const submission = await DI.memoSubmissions.findOne({ uuid: id, project })

    if (!submission) {
        return res.status(404).json({ error: 'Memo submission not found' })
    }

    const [memoRow] = await DI.em.getConnection().execute<{ memo_uuid: string }[]>(
        `
            SELECT uuid AS memo_uuid
            FROM skald_memo
            WHERE project_id = ?
              AND metadata->>'submission_id' = ?
            ORDER BY created_at DESC
            LIMIT 1
        `,
        [project.uuid, submission.uuid]
    )

    return res.status(200).json(buildSubmissionResponse(submission, true, memoRow?.memo_uuid || null))
}

export const approveMemoSubmission = async (req: Request, res: Response) => {
    const project = req.context?.requestUser?.project
    if (!project) {
        return res.status(404).json({ error: 'Project not found' })
    }

    const user = req.context?.requestUser?.userInstance
    if (!user) {
        return res.status(401).json({ error: 'Unauthorized' })
    }

    const { id } = req.params
    const { review_note } = req.body

    const submission = await DI.memoSubmissions.findOne({ uuid: id, project })

    if (!submission) {
        return res.status(404).json({ error: 'Memo submission not found' })
    }

    if (submission.status !== 'pending') {
        return res.status(400).json({ error: 'Only pending submissions can be approved' })
    }

    const { createNewMemo } = await import('@/lib/createMemoUtils')

    try {
        const memo = await createNewMemo(
            {
                title: submission.title,
                content: submission.content,
                type: 'plaintext',
                source: 'public-submission',
                metadata: { submission_id: submission.uuid, is_public: true },
            },
            project
        )

        submission.status = 'approved'
        submission.reviewed_at = new Date()
        submission.updated_at = new Date()
        submission.reviewer = user
        if (review_note) {
            submission.rejection_reason = review_note
        }

        await DI.em.persistAndFlush(submission)

        return res.status(200).json({ memo_uuid: memo.uuid })
    } catch (error) {
        logger.error({ err: error }, 'Error approving memo submission')
        return res.status(500).json({ error: 'Failed to approve memo submission' })
    }
}

export const rejectMemoSubmission = async (req: Request, res: Response) => {
    const project = req.context?.requestUser?.project
    if (!project) {
        return res.status(404).json({ error: 'Project not found' })
    }

    const user = req.context?.requestUser?.userInstance
    if (!user) {
        return res.status(401).json({ error: 'Unauthorized' })
    }

    const { id } = req.params
    // Support both review_note and rejection_reason
    const { review_note, rejection_reason } = req.body
    const rejectionReason = rejection_reason || review_note

    const submission = await DI.memoSubmissions.findOne({ uuid: id, project })

    if (!submission) {
        return res.status(404).json({ error: 'Memo submission not found' })
    }

    if (submission.status !== 'pending') {
        return res.status(400).json({ error: 'Only pending submissions can be rejected' })
    }

    submission.status = 'rejected'
    submission.reviewed_at = new Date()
    submission.updated_at = new Date()
    submission.reviewer = user
    if (rejectionReason) {
        submission.rejection_reason = rejectionReason
    }

    await DI.em.persistAndFlush(submission)

    return res.status(200).json({ ok: true })
}

// List public memos (is_public = true in metadata)
export const listPublicMemos = async (req: Request, res: Response) => {
    const projectId = req.query.project_id as string
    if (!projectId) {
        return res.status(400).json({ error: 'Project ID is required' })
    }

    const page = parseInt(req.query.page as string) || 1
    const pageSize = parseInt(req.query.page_size as string) || 20
    const maxPageSize = 100

    if (pageSize > maxPageSize) {
        return res.status(400).json({ error: `page_size must be less than or equal to ${maxPageSize}` })
    }

    if (page < 1) {
        return res.status(400).json({ error: 'page must be greater than or equal to 1' })
    }

    const project = await DI.projects.findOne({ uuid: projectId })
    if (!project) {
        return res.status(404).json({ error: 'Project not found' })
    }

    const offset = (page - 1) * pageSize

    const [countRow] = await DI.em.getConnection().execute<{ count: string }[]>(
        `
            SELECT COUNT(*)::text AS count
            FROM skald_memo
            WHERE project_id = ?
              AND processing_status = 'processed'
              AND archived = false
              AND COALESCE(metadata->>'is_public', 'false') = 'true'
        `,
        [projectId]
    )

    const rows = await DI.em.getConnection().execute<
        {
            uuid: string
            title: string
            summary: string | null
            source: string | null
            created_at: Date
            approved_at: Date | null
        }[]
    >(
        `
            SELECT
                skald_memo.uuid,
                skald_memo.title,
                COALESCE(skald_memosummary.summary, LEFT(skald_memocontent.content, 280)) AS summary,
                skald_memo.source,
                skald_memo.created_at,
                COALESCE(skald_memo.processing_completed_at, skald_memo.updated_at, skald_memo.created_at) AS approved_at
            FROM skald_memo
            LEFT JOIN skald_memosummary ON skald_memo.uuid = skald_memosummary.memo_id
            LEFT JOIN skald_memocontent ON skald_memo.uuid = skald_memocontent.memo_id
            WHERE skald_memo.project_id = ?
              AND skald_memo.processing_status = 'processed'
              AND skald_memo.archived = false
              AND COALESCE(skald_memo.metadata->>'is_public', 'false') = 'true'
            ORDER BY skald_memo.created_at DESC
            LIMIT ? OFFSET ?
        `,
        [projectId, pageSize, offset]
    )

    const totalCount = Number(countRow?.count || 0)

    return res.status(200).json({
        results: rows,
        count: totalCount,
        page,
        page_size: pageSize,
        total_pages: Math.ceil(totalCount / pageSize),
    })
}

export const getPublicMemo = async (req: Request, res: Response) => {
    const { id } = req.params

    const validatedQuery = GetMemoSubmissionQuery.safeParse(req.query)
    if (!validatedQuery.success) {
        const errorMessages = validatedQuery.error.errors.map((err) => err.message)
        return res.status(400).json({ error: errorMessages.join(', ') })
    }

    const { project_id } = validatedQuery.data

    const project = await DI.projects.findOne({ uuid: project_id })
    if (!project) {
        return res.status(404).json({ error: 'Project not found' })
    }

    const memo = await DI.memos.findOne(
        { uuid: id, project },
        {
            populate: ['project'],
            orderBy: { updated_at: 'desc', created_at: 'desc' },
        }
    )

    if (!memo || memo.archived || memo.processing_status !== 'processed' || memo.metadata?.is_public !== true) {
        return res.status(404).json({ error: 'Memo not found' })
    }

    const [memoContent, memoSummary, memoTags, memoChunks] = await Promise.all([
        DI.memoContents.findOne({ memo }),
        DI.memoSummaries.findOne({ memo }),
        DI.memoTags.find({ memo }),
        DI.memoChunks.find({ memo }, { orderBy: { chunk_index: 'asc' } }),
    ])

    return res.status(200).json({
        uuid: memo.uuid,
        created_at: memo.created_at,
        updated_at: memo.updated_at,
        title: memo.title,
        content: memoContent?.content || null,
        summary: memoSummary?.summary || memoContent?.content?.slice(0, 280) || null,
        metadata: memo.metadata,
        client_reference_id: memo.client_reference_id,
        source: memo.source,
        type: memo.type,
        expiration_date: memo.expiration_date,
        archived: memo.archived,
        processing_status: memo.processing_status,
        tags: memoTags.map((tag) => ({ uuid: tag.uuid, tag: tag.tag })),
        chunks: memoChunks.map((chunk) => ({
            uuid: chunk.uuid,
            chunk_content: chunk.chunk_content,
            chunk_index: chunk.chunk_index,
        })),
    })
}

// Public memos router (no auth)
export const publicMemosRouter = express.Router({ mergeParams: true })
publicMemosRouter.get('/', listPublicMemos)
publicMemosRouter.get('/:id', getPublicMemo)

// Public router (no auth)
export const publicMemoSubmissionRouter = express.Router({ mergeParams: true })
publicMemoSubmissionRouter.post('/', createMemoSubmission)
publicMemoSubmissionRouter.get('/', listMemoSubmissions)
publicMemoSubmissionRouter.get('/:id', getMemoSubmission)

// Auth router (requires project access)
export const authMemoSubmissionRouter = express.Router({ mergeParams: true })
authMemoSubmissionRouter.get('/', listAuthMemoSubmissions)
authMemoSubmissionRouter.get('/:id', getAuthMemoSubmission)
authMemoSubmissionRouter.post('/:id/approve', approveMemoSubmission)
authMemoSubmissionRouter.post('/:id/reject', rejectMemoSubmission)
