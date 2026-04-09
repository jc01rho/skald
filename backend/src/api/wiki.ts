import express, { Request, Response } from 'express'
import { randomUUID } from 'crypto'
import { z } from 'zod'
import { EntityManager } from '@mikro-orm/postgresql'
import { RequestContext } from '@mikro-orm/postgresql'
import { DI } from '@/di'
import { requireProjectAccess } from '@/middleware/authMiddleware'
import { Project } from '@/entities/Project'
import { WikiManagementMode, WikiPage, WikiPageType, WikiReviewStatus } from '@/entities/WikiPage'
import { WikiPageRevision } from '@/entities/WikiPageRevision'
import { User } from '@/entities/User'

const WikiPageTypeSchema = z.enum([
    'concept_page',
    'entity_page',
    'process_page',
    'faq_page',
    'comparison_page',
    'synthesis_page',
    'source_digest_page',
    'index_page',
])

const WikiReviewStatusSchema = z.enum(['draft', 'verified', 'needs_review'])
const WikiManagementModeSchema = z.enum(['manual', 'llm'])

const CreateWikiPageRequest = z.object({
    title: z.string().min(1, 'Title is required').max(255, 'Title must be 255 characters or less'),
    slug: z.string().min(1, 'Slug is required').max(255, 'Slug must be 255 characters or less'),
    content: z.string().min(1, 'Content is required'),
    summary: z.string().max(5000).optional().nullable(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    page_type: WikiPageTypeSchema.optional(),
    canonical: z.string().max(255).optional().nullable(),
    confidence: z.number().min(0).max(1).optional(),
    freshness: z.number().min(0).max(1).optional(),
    review_status: WikiReviewStatusSchema.optional(),
    source_coverage_score: z.number().min(0).max(1).optional(),
    management_mode: WikiManagementModeSchema.optional(),
    change_note: z.string().max(1000).optional().nullable(),
})

const UpdateWikiPageRequest = z.object({
    title: z.string().min(1).max(255).optional(),
    content: z.string().min(1).optional(),
    summary: z.string().max(5000).optional().nullable(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    page_type: WikiPageTypeSchema.optional(),
    canonical: z.string().max(255).optional().nullable(),
    confidence: z.number().min(0).max(1).optional(),
    freshness: z.number().min(0).max(1).optional(),
    review_status: WikiReviewStatusSchema.optional(),
    source_coverage_score: z.number().min(0).max(1).optional(),
    management_mode: WikiManagementModeSchema.optional(),
    change_note: z.string().max(1000).optional().nullable(),
})

const ListWikiPagesQuery = z.object({
    project_id: z.string().uuid('Project ID must be a valid UUID'),
})

const WikiSlugParams = z.object({
    slug: z.string().min(1, 'Slug is required'),
})

const RevisionsQuery = z.object({
    project_id: z.string().uuid('Project ID must be a valid UUID'),
    limit: z.coerce.number().int().min(1).max(100).optional(),
})

interface WikiPageResponse {
    uuid: string
    title: string
    slug: string
    content: string
    summary: string | null
    metadata: Record<string, unknown>
    page_type: WikiPageType
    canonical: string | null
    confidence: number
    freshness: number
    review_status: WikiReviewStatus
    source_coverage_score: number
    management_mode: WikiManagementMode
    revision_count: number
    created_at: Date
    updated_at: Date
}

interface WikiPageRevisionResponse {
    uuid: string
    version: number
    title: string
    slug: string
    content: string
    summary: string | null
    metadata: Record<string, unknown>
    page_type: string | null
    canonical: string | null
    confidence: number | null
    freshness: number | null
    review_status: string | null
    source_coverage_score: number | null
    management_mode: string | null
    change_note: string | null
    created_at: Date
}

function normalizeSlug(rawSlug: string) {
    return rawSlug
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
}

function getProjectFromRequest(req: Request) {
    return req.context?.requestUser?.project as Project | undefined
}

function isUniqueConstraintError(error: unknown) {
    if (!error || typeof error !== 'object') {
        return false
    }

    const code = (error as { code?: string; cause?: { code?: string } }).code
    const causeCode = (error as { code?: string; cause?: { code?: string } }).cause?.code
    return code === '23505' || causeCode === '23505'
}

function getRequestedProjectId(req: Request) {
    return typeof req.query.project_id === 'string' ? req.query.project_id : undefined
}

function ensureBoundProject(req: Request, res: Response) {
    const project = getProjectFromRequest(req)
    const requestedProjectId = getRequestedProjectId(req)

    if (!project) {
        res.status(404).json({ error: 'Project not found' })
        return null
    }

    if (requestedProjectId && project.uuid !== requestedProjectId) {
        res.status(400).json({ error: 'project_id must match the authenticated project context' })
        return null
    }

    return project
}

function getActorFromRequest(req: Request) {
    return req.context?.requestUser?.userInstance as User | undefined
}

function toWikiPageResponse(page: WikiPage): WikiPageResponse {
    return {
        uuid: page.uuid,
        title: page.title,
        slug: page.slug,
        content: page.content,
        summary: page.summary || null,
        metadata: page.metadata,
        page_type: page.page_type,
        canonical: page.canonical || null,
        confidence: page.confidence,
        freshness: page.freshness,
        review_status: page.review_status,
        source_coverage_score: page.source_coverage_score,
        management_mode: page.management_mode,
        revision_count: page.revision_count,
        created_at: page.created_at,
        updated_at: page.updated_at,
    }
}

function toWikiPageRevisionResponse(revision: WikiPageRevision): WikiPageRevisionResponse {
    return {
        uuid: revision.uuid,
        version: revision.version,
        title: revision.title,
        slug: revision.slug,
        content: revision.content,
        summary: revision.summary || null,
        metadata: revision.metadata,
        page_type: revision.page_type || null,
        canonical: revision.canonical || null,
        confidence: revision.confidence ?? null,
        freshness: revision.freshness ?? null,
        review_status: revision.review_status || null,
        source_coverage_score: revision.source_coverage_score ?? null,
        management_mode: revision.management_mode || null,
        change_note: revision.change_note || null,
        created_at: revision.created_at,
    }
}

async function createRevision(
    em: EntityManager,
    page: WikiPage,
    actor: User | undefined,
    changeNote: string | null | undefined,
    version: number
) {
    const revision = em.create(WikiPageRevision, {
        uuid: randomUUID(),
        wiki_page: page,
        project: page.project,
        created_by: actor || null,
        created_at: new Date(),
        version,
        title: page.title,
        slug: page.slug,
        content: page.content,
        page_type: page.page_type,
        canonical: page.canonical || null,
        confidence: page.confidence,
        freshness: page.freshness,
        review_status: page.review_status,
        source_coverage_score: page.source_coverage_score,
        management_mode: page.management_mode,
        metadata: page.metadata,
        summary: page.summary || null,
        change_note: changeNote || null,
    })
    em.persist(revision)
    return revision
}

const listPages = async (req: Request, res: Response) => {
    const validatedQuery = ListWikiPagesQuery.safeParse(req.query)
    if (!validatedQuery.success) {
        return res.status(400).json({ error: validatedQuery.error.errors.map((err) => err.message).join(', ') })
    }

    const project = ensureBoundProject(req, res)
    if (!project) {
        return
    }

    const pages = await DI.orm.em.fork().find(
        WikiPage,
        { project },
        {
            orderBy: { updated_at: 'DESC', created_at: 'DESC' },
        }
    )

    return res.status(200).json(pages.map(toWikiPageResponse))
}

const getPage = async (req: Request, res: Response) => {
    const validatedQuery = ListWikiPagesQuery.safeParse(req.query)
    if (!validatedQuery.success) {
        return res.status(400).json({ error: validatedQuery.error.errors.map((err) => err.message).join(', ') })
    }

    const validatedParams = WikiSlugParams.safeParse(req.params)
    if (!validatedParams.success) {
        return res.status(400).json({ error: validatedParams.error.errors.map((err) => err.message).join(', ') })
    }

    const project = ensureBoundProject(req, res)
    if (!project) {
        return
    }

    const page = await DI.orm.em.fork().findOne(WikiPage, {
        project,
        slug: normalizeSlug(validatedParams.data.slug),
    })

    if (!page) {
        return res.status(404).json({ error: 'Wiki page not found' })
    }

    return res.status(200).json(toWikiPageResponse(page))
}

const createPage = async (req: Request, res: Response) => {
    const validatedQuery = ListWikiPagesQuery.safeParse(req.query)
    if (!validatedQuery.success) {
        return res.status(400).json({ error: validatedQuery.error.errors.map((err) => err.message).join(', ') })
    }

    const validatedBody = CreateWikiPageRequest.safeParse(req.body)
    if (!validatedBody.success) {
        return res.status(400).json({ error: validatedBody.error.errors.map((err) => err.message).join(', ') })
    }

    const project = ensureBoundProject(req, res)
    if (!project) {
        return
    }

    const actor = getActorFromRequest(req)
    const slug = normalizeSlug(validatedBody.data.slug)
    if (!slug) {
        return res.status(400).json({ error: 'Slug must contain at least one alphanumeric character' })
    }

    return RequestContext.create(DI.orm.em, async () => {
        try {
            let createdPage: WikiPage | null = null

            await DI.em.transactional(async (em) => {
                const existingPage = await em.findOne(WikiPage, { project, slug })
                if (existingPage) {
                    throw new Error('WIKI_PAGE_EXISTS')
                }

                const now = new Date()
                const page = em.create(WikiPage, {
                    uuid: randomUUID(),
                    title: validatedBody.data.title,
                    slug,
                    content: validatedBody.data.content,
                    metadata: validatedBody.data.metadata || {},
                    summary: validatedBody.data.summary || null,
                    page_type: validatedBody.data.page_type || 'source_digest_page',
                    canonical: validatedBody.data.canonical || null,
                    confidence: validatedBody.data.confidence ?? 0.5,
                    freshness: validatedBody.data.freshness ?? 0.5,
                    review_status: validatedBody.data.review_status || 'draft',
                    source_coverage_score: validatedBody.data.source_coverage_score ?? 0,
                    management_mode: validatedBody.data.management_mode || 'manual',
                    revision_count: 1,
                    created_at: now,
                    updated_at: now,
                    project,
                    created_by: actor || null,
                    updated_by: actor || null,
                })

                em.persist(page)
                await createRevision(em, page, actor, validatedBody.data.change_note, 1)
                await em.flush()
                createdPage = page
            })

            if (!createdPage) {
                return res.status(500).json({ error: 'Failed to create wiki page' })
            }

            return res.status(201).json(toWikiPageResponse(createdPage))
        } catch (error) {
            if (error instanceof Error && error.message === 'WIKI_PAGE_EXISTS') {
                return res.status(409).json({ error: 'Wiki page with this slug already exists' })
            }

            if (isUniqueConstraintError(error)) {
                return res.status(409).json({ error: 'Wiki page with this slug already exists' })
            }

            throw error
        }
    })
}

const updatePage = async (req: Request, res: Response) => {
    const validatedQuery = ListWikiPagesQuery.safeParse(req.query)
    if (!validatedQuery.success) {
        return res.status(400).json({ error: validatedQuery.error.errors.map((err) => err.message).join(', ') })
    }

    const validatedParams = WikiSlugParams.safeParse(req.params)
    if (!validatedParams.success) {
        return res.status(400).json({ error: validatedParams.error.errors.map((err) => err.message).join(', ') })
    }

    const validatedBody = UpdateWikiPageRequest.safeParse(req.body)
    if (!validatedBody.success) {
        return res.status(400).json({ error: validatedBody.error.errors.map((err) => err.message).join(', ') })
    }

    const project = ensureBoundProject(req, res)
    if (!project) {
        return
    }

    const actor = getActorFromRequest(req)

    return RequestContext.create(DI.orm.em, async () => {
        try {
            let updatedPage: WikiPage | null = null

            await DI.em.transactional(async (em) => {
                const pageRows = (await em
                    .getConnection()
                    .execute('select uuid from "skald_wiki_page" where "project_id" = ? and "slug" = ? for update', [
                        project.uuid,
                        normalizeSlug(validatedParams.data.slug),
                    ])) as { uuid: string }[]

                const pageRow = pageRows[0]
                if (!pageRow) {
                    throw new Error('WIKI_PAGE_NOT_FOUND')
                }

                const page = await em.findOneOrFail(WikiPage, { uuid: pageRow.uuid })
                const nextVersion = page.revision_count + 1

                if (validatedBody.data.title !== undefined) {
                    page.title = validatedBody.data.title
                }
                if (validatedBody.data.content !== undefined) {
                    page.content = validatedBody.data.content
                }
                if (validatedBody.data.summary !== undefined) {
                    page.summary = validatedBody.data.summary || null
                }
                if (validatedBody.data.metadata !== undefined) {
                    page.metadata = validatedBody.data.metadata
                }
                if (validatedBody.data.page_type !== undefined) {
                    page.page_type = validatedBody.data.page_type
                }
                if (validatedBody.data.canonical !== undefined) {
                    page.canonical = validatedBody.data.canonical || null
                }
                if (validatedBody.data.confidence !== undefined) {
                    page.confidence = validatedBody.data.confidence
                }
                if (validatedBody.data.freshness !== undefined) {
                    page.freshness = validatedBody.data.freshness
                }
                if (validatedBody.data.review_status !== undefined) {
                    page.review_status = validatedBody.data.review_status
                }
                if (validatedBody.data.source_coverage_score !== undefined) {
                    page.source_coverage_score = validatedBody.data.source_coverage_score
                }
                if (validatedBody.data.management_mode !== undefined) {
                    page.management_mode = validatedBody.data.management_mode
                }

                page.revision_count = nextVersion
                page.updated_at = new Date()
                page.updated_by = actor || null

                await createRevision(em, page, actor, validatedBody.data.change_note, nextVersion)
                await em.flush()
                updatedPage = page
            })

            if (!updatedPage) {
                return res.status(500).json({ error: 'Failed to update wiki page' })
            }

            return res.status(200).json(toWikiPageResponse(updatedPage))
        } catch (error) {
            if (error instanceof Error && error.message === 'WIKI_PAGE_NOT_FOUND') {
                return res.status(404).json({ error: 'Wiki page not found' })
            }

            if (isUniqueConstraintError(error)) {
                return res.status(409).json({ error: 'Wiki page revision conflict detected, retry the request' })
            }

            throw error
        }
    })
}

const listRevisions = async (req: Request, res: Response) => {
    const validatedQuery = RevisionsQuery.safeParse(req.query)
    if (!validatedQuery.success) {
        return res.status(400).json({ error: validatedQuery.error.errors.map((err) => err.message).join(', ') })
    }

    const validatedParams = WikiSlugParams.safeParse(req.params)
    if (!validatedParams.success) {
        return res.status(400).json({ error: validatedParams.error.errors.map((err) => err.message).join(', ') })
    }

    const project = ensureBoundProject(req, res)
    if (!project) {
        return
    }

    const em = DI.orm.em.fork()
    const page = await em.findOne(WikiPage, {
        project,
        slug: normalizeSlug(validatedParams.data.slug),
    })

    if (!page) {
        return res.status(404).json({ error: 'Wiki page not found' })
    }

    const revisions = await em.find(
        WikiPageRevision,
        { wiki_page: page, project },
        {
            orderBy: { version: 'DESC', created_at: 'DESC' },
            limit: validatedQuery.data.limit || 20,
        }
    )

    return res.status(200).json(revisions.map(toWikiPageRevisionResponse))
}

export const wikiRouter = express.Router({ mergeParams: true })
wikiRouter.use(requireProjectAccess())
wikiRouter.get('/', listPages)
wikiRouter.post('/', createPage)
wikiRouter.get('/:slug', getPage)
wikiRouter.patch('/:slug', updatePage)
wikiRouter.get('/:slug/revisions', listRevisions)
