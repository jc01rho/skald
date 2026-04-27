import { EntityManager } from '@mikro-orm/core'
import { randomUUID, createHash } from 'crypto'
import { Memo } from '@/entities/Memo'
import { MemoChunk } from '@/entities/MemoChunk'
import { MemoContent } from '@/entities/MemoContent'
import { MemoSummary } from '@/entities/MemoSummary'
import { Project } from '@/entities/Project'
import { RawSourceContent } from '@/entities/RawSourceContent'
import { RawSourceDocument } from '@/entities/RawSourceDocument'
import { User } from '@/entities/User'
import { WikiClaim } from '@/entities/WikiClaim'
import { WikiClaimSourceRef } from '@/entities/WikiClaimSourceRef'
import { WikiCompileRun } from '@/entities/WikiCompileRun'
import { WikiEdge } from '@/entities/WikiEdge'
import { WikiNode } from '@/entities/WikiNode'
import { WikiPage } from '@/entities/WikiPage'
import { WikiPageLink } from '@/entities/WikiPageLink'
import { WikiPageRevision } from '@/entities/WikiPageRevision'
import { WikiPageSourceLink } from '@/entities/WikiPageSourceLink'
import { WikiRefreshRequest } from '@/entities/WikiRefreshRequest'
import { WikiRule } from '@/entities/WikiRule'
import { WikiSourceRef } from '@/entities/WikiSourceRef'
import { logger } from '@/lib/logger'
import { publishWikiRefresh } from '@/lib/wikiQueueClient'
import { LLMService } from '@/services/llmService'
import { buildWikiCompileUserPrompt, WIKI_COMPILE_SYSTEM_PROMPT } from '@/services/wiki/wikiCompilePrompts'
import {
    WIKI_ASYNC_MODE,
    WIKI_BATCH_SIZE,
    WIKI_CLAIM_TTL_SECONDS,
    WIKI_COMPILE_ON_MEMO_PROCESS,
    WIKI_ENABLED,
    WIKI_MAX_SOURCE_CHUNKS,
    WIKI_STALE_THRESHOLD_SECONDS,
} from '@/settings'

interface PageDelta {
    slug: string
    title: string
    pageType: WikiPage['page_type']
    summary?: string
    bodyMarkdown: string
    canonical?: string | null
    confidence?: number
    freshness?: number
    reviewStatus?: WikiPage['review_status']
    sourceCoverageScore?: number
    relatedPageSlugs?: string[]
    claims?: Array<{
        claimText: string
        claimType: WikiClaim['claim_type']
        confidence?: number
        freshness?: number
        contradictionStatus?: WikiClaim['contradiction_status']
        nodeCanonicalName?: string | null
        sourceExcerpt?: string | null
    }>
    nodes?: Array<{
        nodeType: WikiNode['node_type']
        canonicalName: string
        displayName: string
        description?: string
        confidence?: number
        freshness?: number
    }>
    edges?: Array<{
        fromCanonicalName: string
        toCanonicalName: string
        edgeType: WikiEdge['edge_type']
        weight?: number
    }>
}

interface WikiCompileOutput {
    pages: PageDelta[]
    notes?: string[]
}

interface SyncedRawSourceDocument {
    document: RawSourceDocument
    isNewDocument: boolean
    isNewContent: boolean
    contentHash: string
}

function normalizeSlug(raw: string): string {
    return raw
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
}

function clampNumber(value: number | undefined, fallback: number): number {
    if (typeof value !== 'number' || Number.isNaN(value)) {
        return fallback
    }

    return Math.min(1, Math.max(0, value))
}

function asCompileOutput(raw: string): WikiCompileOutput {
    const normalized = raw
        .trim()
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/```$/i, '')
        .trim()
    const parsed = JSON.parse(normalized) as WikiCompileOutput
    if (!parsed || !Array.isArray(parsed.pages)) {
        throw new Error('Invalid wiki compile output: pages array missing')
    }
    return parsed
}

async function createRevision(
    em: EntityManager,
    page: WikiPage,
    actor: User | null,
    changeNote: string,
    version: number
): Promise<WikiPageRevision> {
    const revision = em.create(WikiPageRevision, {
        uuid: randomUUID(),
        wiki_page: page,
        project: page.project,
        created_by: actor,
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
        change_note: changeNote,
    })

    em.persist(revision)
    return revision
}

export class WikiCompilerService {
    static isEnabled(): boolean {
        const wikiEnabled = process.env.WIKI_ENABLED?.toLowerCase() === 'true' || WIKI_ENABLED
        const compileOnMemoProcess =
            process.env.WIKI_COMPILE_ON_MEMO_PROCESS?.toLowerCase() === 'true' || WIKI_COMPILE_ON_MEMO_PROCESS
        return wikiEnabled && compileOnMemoProcess
    }

    static async syncRawSourceFromMemo(em: EntityManager, memoUuid: string): Promise<SyncedRawSourceDocument | null> {
        const memo = await em.findOne(Memo, { uuid: memoUuid }, { populate: ['project'] })
        if (!memo) {
            return null
        }

        const memoContent = await em.findOne(MemoContent, { memo })
        if (!memoContent?.content) {
            return null
        }

        const existingDocument = await em.findOne(RawSourceDocument, {
            project: memo.project,
            source_type: memo.type === 'document' ? 'document' : 'memo',
            external_reference: memo.uuid,
        })

        const now = new Date()
        const contentHash = createHash('sha256').update(memoContent.content).digest('hex')

        const isNewDocument = !existingDocument
        const rawSourceDocument =
            existingDocument ||
            em.create(RawSourceDocument, {
                uuid: randomUUID(),
                created_at: now,
                updated_at: now,
                source_type: memo.type === 'document' ? 'document' : 'memo',
                external_reference: memo.uuid,
                title: memo.title,
                description: memo.source || null,
                metadata: {
                    memoUuid: memo.uuid,
                    memoType: memo.type || 'plaintext',
                    source: memo.source || null,
                },
                project: memo.project,
            })

        rawSourceDocument.updated_at = now
        rawSourceDocument.title = memo.title
        rawSourceDocument.description = memo.source || rawSourceDocument.description || null
        rawSourceDocument.metadata = {
            ...(rawSourceDocument.metadata || {}),
            memoUuid: memo.uuid,
            memoType: memo.type || 'plaintext',
            source: memo.source || null,
            processingStatus: memo.processing_status,
        }
        em.persist(rawSourceDocument)

        const existingContent = await em.findOne(RawSourceContent, {
            raw_source_document: rawSourceDocument,
            content_hash: contentHash,
        })

        const isNewContent = !existingContent

        if (isNewContent) {
            em.persist(
                em.create(RawSourceContent, {
                    uuid: randomUUID(),
                    created_at: now,
                    content: memoContent.content,
                    content_hash: contentHash,
                    content_length: memoContent.content.length,
                    extraction_metadata: {
                        memoProcessingStatus: memo.processing_status,
                        memoUpdatedAt: memo.updated_at,
                    },
                    raw_source_document: rawSourceDocument,
                    project: memo.project,
                })
            )
        }

        await em.flush()
        return {
            document: rawSourceDocument,
            isNewDocument,
            isNewContent,
            contentHash,
        }
    }

    static async enqueueRefreshForMemo(
        em: EntityManager,
        memoUuid: string,
        trigger: WikiRefreshRequest['trigger']
    ): Promise<WikiRefreshRequest | null> {
        if (!this.isEnabled()) {
            return null
        }

        const syncResult = await this.syncRawSourceFromMemo(em, memoUuid)
        if (!syncResult) {
            return null
        }
        const { document: rawSourceDocument, isNewDocument, isNewContent, contentHash } = syncResult

        const existingPending = await em.findOne(WikiRefreshRequest, {
            project: rawSourceDocument.project,
            raw_source_document: rawSourceDocument,
            status: { $in: ['pending', 'claimed', 'processing'] },
        })

        const existingRequest = await em.findOne(WikiRefreshRequest, {
            project: rawSourceDocument.project,
            raw_source_document: rawSourceDocument,
        })

        const shouldEnqueue = isNewDocument || isNewContent || !existingRequest
        const effectiveTrigger: WikiRefreshRequest['trigger'] = isNewDocument ? 'memo_created' : trigger

        if (!shouldEnqueue) {
            return null
        }

        if (existingPending) {
            existingPending.trigger = effectiveTrigger
            existingPending.updated_at = new Date()
            existingPending.error_message = null
            existingPending.metadata = {
                ...(existingPending.metadata || {}),
                memoUuid,
                contentHash,
                refreshedAt: new Date().toISOString(),
            }
            await em.flush()
            return existingPending
        }

        const refreshRequest = em.create(WikiRefreshRequest, {
            uuid: randomUUID(),
            created_at: new Date(),
            updated_at: null,
            trigger: effectiveTrigger,
            status: 'pending',
            metadata: { memoUuid, contentHash },
            claimed_at: null,
            claim_token: null,
            priority: 100,
            batch_key: rawSourceDocument.project.uuid,
            raw_source_document: rawSourceDocument,
            project: rawSourceDocument.project,
        })
        em.persist(refreshRequest)
        await em.flush()
        return refreshRequest
    }

    static async dispatchRefreshRequest(em: EntityManager, request: WikiRefreshRequest): Promise<void> {
        if (WIKI_ASYNC_MODE === 'queue') {
            await publishWikiRefresh({
                request_uuid: request.uuid,
                project_uuid: request.project.uuid,
                reason: 'memo_refresh',
            })
        }
    }

    static async cleanupStaleRequests(em: EntityManager): Promise<number> {
        if (!this.isEnabled()) {
            return 0
        }

        const staleBefore = new Date(Date.now() - WIKI_STALE_THRESHOLD_SECONDS * 1000)
        const staleRequests = await em.find(WikiRefreshRequest, {
            status: { $in: ['claimed', 'processing'] },
            claimed_at: { $lte: staleBefore },
        })

        for (const request of staleRequests) {
            request.status = 'pending'
            request.error_message = null
            request.claim_token = null
            request.claimed_at = null
            request.process_started_at = null
            request.updated_at = new Date()
        }

        if (staleRequests.length > 0) {
            await em.flush()
        }
        return staleRequests.length
    }

    static async claimProjectBatch(
        rootEm: EntityManager,
        projectUuid?: string | null,
        limit = WIKI_BATCH_SIZE
    ): Promise<string[]> {
        if (!this.isEnabled()) {
            return []
        }

        const em = rootEm.fork()
        await this.cleanupStaleRequests(em)

        const pendingRequests = await em.find(
            WikiRefreshRequest,
            {
                status: 'pending',
                ...(projectUuid ? { project: projectUuid } : {}),
            },
            {
                populate: ['project', 'raw_source_document'],
                orderBy: { priority: 'ASC', created_at: 'ASC' },
                limit: limit * 3,
            }
        )

        if (pendingRequests.length === 0) {
            return []
        }

        const targetProjectUuid = projectUuid || pendingRequests[0]?.project?.uuid
        const claimToken = randomUUID()
        const now = new Date()
        const claimedUuids: string[] = []
        const seenSourceDocument = new Set<string>()

        for (const request of pendingRequests) {
            if (request.project.uuid !== targetProjectUuid) {
                continue
            }

            const rawSourceUuid = request.raw_source_document?.uuid || request.uuid
            if (seenSourceDocument.has(rawSourceUuid)) {
                request.status = 'completed'
                request.updated_at = now
                request.process_completed_at = now
                request.error_message = 'Superseded by newer refresh request in the same batch'
                continue
            }

            seenSourceDocument.add(rawSourceUuid)
            request.status = 'claimed'
            request.claim_token = claimToken
            request.claimed_at = now
            request.updated_at = now
            claimedUuids.push(request.uuid)

            if (claimedUuids.length >= limit) {
                break
            }
        }

        if (claimedUuids.length > 0) {
            await em.flush()
        }

        return claimedUuids
    }

    static async processPendingRefreshes(
        em: EntityManager,
        limit = WIKI_BATCH_SIZE,
        projectUuid?: string | null
    ): Promise<void> {
        if (!this.isEnabled()) {
            return
        }

        const claimedRequestUuids = await this.claimProjectBatch(em, projectUuid, limit)

        for (const requestUuid of claimedRequestUuids) {
            await this.processRefreshRequest(em, requestUuid)
        }
    }

    static async processRefreshRequest(rootEm: EntityManager, requestUuid: string): Promise<void> {
        const em = rootEm.fork()
        const request = await em.findOne(
            WikiRefreshRequest,
            { uuid: requestUuid },
            { populate: ['project', 'raw_source_document'] }
        )

        if (!request || !['pending', 'claimed'].includes(request.status)) {
            return
        }

        request.status = 'processing'
        request.claimed_at = request.claimed_at || new Date()
        request.claim_token = request.claim_token || randomUUID()
        request.process_started_at = new Date()
        request.updated_at = new Date()
        await em.flush()

        const compileRun = em.create(WikiCompileRun, {
            uuid: randomUUID(),
            started_at: new Date(),
            trigger_type: request.trigger,
            status: 'processing',
            memos_considered: 1,
            pages_created: 0,
            pages_updated: 0,
            claims_created: 0,
            edges_created: 0,
            conflicts_found: 0,
            notes: null,
            project: request.project,
        })
        em.persist(compileRun)
        await em.flush()

        try {
            const rawSourceDocument = request.raw_source_document
            if (!rawSourceDocument) {
                throw new Error('Refresh request has no raw source document')
            }

            const latestContent = await em.findOne(
                RawSourceContent,
                { raw_source_document: rawSourceDocument },
                { orderBy: { created_at: 'DESC' } }
            )

            if (!latestContent?.content) {
                throw new Error('Raw source content not found')
            }

            const memoSummary = rawSourceDocument.external_reference
                ? await em.findOne(MemoSummary, { memo: rawSourceDocument.external_reference })
                : null
            const memoChunks = rawSourceDocument.external_reference
                ? await em.find(
                      MemoChunk,
                      { memo: rawSourceDocument.external_reference },
                      { orderBy: { chunk_index: 'ASC' }, limit: WIKI_MAX_SOURCE_CHUNKS }
                  )
                : []

            const existingPages = await em.find(
                WikiPage,
                { project: request.project },
                {
                    orderBy: { updated_at: 'DESC' },
                    limit: 20,
                }
            )

            const activeRules = await em.find(
                WikiRule,
                { project: request.project, is_active: true },
                { orderBy: { priority: 'ASC', created_at: 'ASC' } }
            )

            const prompt = buildWikiCompileUserPrompt({
                projectName: (request.project as Project).name,
                sourceTitle: rawSourceDocument.title,
                sourceType: rawSourceDocument.source_type,
                sourceContent: latestContent.content.slice(0, WIKI_MAX_SOURCE_CHUNKS * 2000),
                sourceSummary: memoSummary?.summary || null,
                sourceMetadata: rawSourceDocument.metadata || null,
                representativeChunks: memoChunks.map((chunk) => chunk.chunk_content.slice(0, 1000)),
                existingPages: existingPages.map((page) => ({
                    slug: page.slug,
                    title: page.title,
                    summary: page.summary || null,
                    pageType: page.page_type,
                })),
                activeRules: activeRules.map((rule) => ({
                    ruleType: rule.rule_type,
                    name: rule.name,
                    description: rule.description,
                    config: rule.config,
                })),
            })

            const response = await LLMService.invokeWithRetry({
                messages: [
                    { role: 'system', content: WIKI_COMPILE_SYSTEM_PROMPT },
                    { role: 'user', content: prompt },
                ],
                temperature: 0,
            })

            const parsed = asCompileOutput(response.content?.toString() || '{}')

            for (const pageDelta of parsed.pages.slice(0, 3)) {
                const slug = normalizeSlug(pageDelta.slug || pageDelta.title)
                if (!slug) {
                    continue
                }

                const now = new Date()
                const existingPage = await em.findOne(WikiPage, { project: request.project, slug })
                const page =
                    existingPage ||
                    em.create(WikiPage, {
                        uuid: randomUUID(),
                        created_at: now,
                        updated_at: now,
                        revision_count: 0,
                        slug,
                        title: pageDelta.title,
                        content: pageDelta.bodyMarkdown,
                        summary: pageDelta.summary || null,
                        metadata: { sourceDocumentUuid: rawSourceDocument.uuid },
                        page_type: pageDelta.pageType || 'source_digest_page',
                        canonical: pageDelta.canonical || null,
                        confidence: clampNumber(pageDelta.confidence, 0.5),
                        freshness: clampNumber(pageDelta.freshness, 0.5),
                        review_status: pageDelta.reviewStatus || 'draft',
                        source_coverage_score: clampNumber(pageDelta.sourceCoverageScore, 0.5),
                        management_mode: 'llm',
                        project: request.project,
                        created_by: null,
                        updated_by: null,
                    })

                const nextVersion = page.revision_count + 1
                page.title = pageDelta.title
                page.content = pageDelta.bodyMarkdown
                page.summary = pageDelta.summary || null
                page.metadata = {
                    ...(page.metadata || {}),
                    sourceDocumentUuid: rawSourceDocument.uuid,
                    compileTrigger: request.trigger,
                    compileNotes: parsed.notes || [],
                }
                page.page_type = pageDelta.pageType || page.page_type
                page.canonical = pageDelta.canonical || null
                page.confidence = clampNumber(pageDelta.confidence, page.confidence || 0.5)
                page.freshness = clampNumber(pageDelta.freshness, page.freshness || 0.5)
                page.review_status = pageDelta.reviewStatus || page.review_status
                page.source_coverage_score = clampNumber(
                    pageDelta.sourceCoverageScore,
                    page.source_coverage_score || 0.5
                )
                page.management_mode = 'llm'
                page.updated_at = now
                page.revision_count = nextVersion
                em.persist(page)

                const revision = await createRevision(
                    em,
                    page,
                    null,
                    `wiki compile from ${rawSourceDocument.source_type}`,
                    nextVersion
                )
                em.persist(
                    em.create(WikiPageSourceLink, {
                        uuid: randomUUID(),
                        created_at: now,
                        contribution_metadata: {
                            trigger: request.trigger,
                            notes: parsed.notes || [],
                        },
                        wiki_page_revision: revision,
                        raw_source_document: rawSourceDocument,
                        project: request.project,
                    })
                )

                const sourceRef = em.create(WikiSourceRef, {
                    uuid: randomUUID(),
                    created_at: now,
                    source_kind: rawSourceDocument.source_type === 'document' ? 'raw_source' : 'memo',
                    locator_text: rawSourceDocument.external_reference || rawSourceDocument.uuid,
                    excerpt: latestContent.content.slice(0, 1000),
                    memo: rawSourceDocument.external_reference || null,
                    memo_chunk: null,
                    memo_summary: memoSummary || null,
                    raw_source_document: rawSourceDocument,
                    project: request.project,
                })
                em.persist(sourceRef)

                const nodeByCanonical = new Map<string, WikiNode>()
                for (const nodeDelta of pageDelta.nodes || []) {
                    const canonicalName = nodeDelta.canonicalName.trim().toLowerCase()
                    if (!canonicalName) {
                        continue
                    }

                    const existingNode = await em.findOne(WikiNode, {
                        project: request.project,
                        node_type: nodeDelta.nodeType,
                        canonical_name: canonicalName,
                    })

                    const node =
                        existingNode ||
                        em.create(WikiNode, {
                            uuid: randomUUID(),
                            created_at: now,
                            updated_at: now,
                            node_type: nodeDelta.nodeType,
                            canonical_name: canonicalName,
                            display_name: nodeDelta.displayName,
                            description: nodeDelta.description || null,
                            metadata: { pageSlug: slug },
                            confidence: clampNumber(nodeDelta.confidence, 0.5),
                            freshness: clampNumber(nodeDelta.freshness, 0.5),
                            project: request.project,
                        })

                    node.display_name = nodeDelta.displayName
                    node.description = nodeDelta.description || node.description || null
                    node.confidence = clampNumber(nodeDelta.confidence, node.confidence || 0.5)
                    node.freshness = clampNumber(nodeDelta.freshness, node.freshness || 0.5)
                    node.updated_at = now
                    em.persist(node)
                    nodeByCanonical.set(canonicalName, node)
                }

                for (const claimDelta of pageDelta.claims || []) {
                    const node = claimDelta.nodeCanonicalName
                        ? nodeByCanonical.get(claimDelta.nodeCanonicalName.trim().toLowerCase()) || null
                        : null
                    const claim = em.create(WikiClaim, {
                        uuid: randomUUID(),
                        created_at: now,
                        updated_at: now,
                        claim_text: claimDelta.claimText,
                        claim_type: claimDelta.claimType,
                        confidence: clampNumber(claimDelta.confidence, 0.5),
                        freshness: clampNumber(claimDelta.freshness, 0.5),
                        contradiction_status: claimDelta.contradictionStatus || 'compatible',
                        page,
                        node,
                        project: request.project,
                    })
                    em.persist(claim)
                    em.persist(
                        em.create(WikiClaimSourceRef, {
                            uuid: randomUUID(),
                            support_type:
                                claimDelta.contradictionStatus === 'contradicts'
                                    ? 'contradicts'
                                    : claimDelta.claimType === 'relationship'
                                      ? 'mentions'
                                      : 'supports',
                            confidence: clampNumber(claimDelta.confidence, 0.5),
                            excerpt: claimDelta.sourceExcerpt || null,
                            claim,
                            source_ref: sourceRef,
                        })
                    )
                    compileRun.claims_created += 1
                    if (claim.contradiction_status === 'contradicts') {
                        compileRun.conflicts_found += 1
                    }
                }

                for (const edgeDelta of pageDelta.edges || []) {
                    const fromNode = nodeByCanonical.get(edgeDelta.fromCanonicalName.trim().toLowerCase())
                    const toNode = nodeByCanonical.get(edgeDelta.toCanonicalName.trim().toLowerCase())
                    if (!fromNode || !toNode) {
                        continue
                    }

                    const edge =
                        (await em.findOne(WikiEdge, {
                            project: request.project,
                            from_node: fromNode,
                            to_node: toNode,
                            edge_type: edgeDelta.edgeType,
                        })) ||
                        em.create(WikiEdge, {
                            uuid: randomUUID(),
                            created_at: now,
                            updated_at: now,
                            edge_type: edgeDelta.edgeType,
                            weight: edgeDelta.weight || 1,
                            provenance_type: request.trigger,
                            from_node: fromNode,
                            to_node: toNode,
                            project: request.project,
                        })

                    edge.weight = edgeDelta.weight || edge.weight || 1
                    edge.updated_at = now
                    em.persist(edge)
                    compileRun.edges_created += 1
                }

                for (const relatedSlug of pageDelta.relatedPageSlugs || []) {
                    const normalizedRelatedSlug = normalizeSlug(relatedSlug)
                    if (!normalizedRelatedSlug || normalizedRelatedSlug === slug) {
                        continue
                    }

                    const relatedPage = await em.findOne(WikiPage, {
                        project: request.project,
                        slug: normalizedRelatedSlug,
                    })
                    if (!relatedPage) {
                        continue
                    }

                    const existingLink = await em.findOne(WikiPageLink, {
                        from_page: page,
                        to_page: relatedPage,
                        link_type: 'related',
                    })
                    if (!existingLink) {
                        em.persist(
                            em.create(WikiPageLink, {
                                uuid: randomUUID(),
                                link_type: 'related',
                                anchor_text: relatedPage.title,
                                from_page: page,
                                to_page: relatedPage,
                            })
                        )
                    }
                }

                if (existingPage) {
                    compileRun.pages_updated += 1
                } else {
                    compileRun.pages_created += 1
                }
            }

            request.status = 'completed'
            request.process_completed_at = new Date()
            request.updated_at = new Date()
            request.claim_token = null
            compileRun.status = 'completed'
            compileRun.completed_at = new Date()
            compileRun.notes = { notes: parsed.notes || [] }
            await em.flush()
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown wiki compile error'
            request.status = 'failed'
            request.error_message = message
            request.updated_at = new Date()
            request.process_completed_at = new Date()
            request.claim_token = null
            compileRun.status = 'failed'
            compileRun.completed_at = new Date()
            compileRun.notes = { error: message }
            await em.flush()
            logger.error({ err: error, requestUuid }, 'Wiki refresh processing failed')
        }
    }

    static claimHasExpired(request: WikiRefreshRequest): boolean {
        if (!request.claimed_at) {
            return true
        }

        return request.claimed_at.getTime() + WIKI_CLAIM_TTL_SECONDS * 1000 < Date.now()
    }
}
