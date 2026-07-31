import { createHash } from 'crypto'
import express, { NextFunction, Request, Response } from 'express'
import { z } from 'zod'
import { DI } from '@/di'
import { requirePromotedSpecScope, resolveEffectiveProject } from '@/middleware/authMiddleware'

import { SpecRevisionError, SpecRevisionService } from '@/services/specRevisionService'
import { SpecPromotionStatus } from '@/entities/SpecPromotionState'
import { Project } from '@/entities/Project'

const Hash = z.string().regex(/^[0-9a-f]{64}$/)
const NullableString = z.string().nullable()
const Source = z.object({
    source_key: z.string().min(1).max(512),
    source_system: z.string().min(1).max(100),
    source_type: z.string().min(1).max(100),
    immutable_source_id: z.string().min(1).max(512),
    title: z.string().min(1).max(255),
    code: NullableString,
    source_url: z.string().url().nullable(),
    status: NullableString,
    aliases: z.array(z.string().max(512)).max(100),
}).strict()
const Target = Source.pick({
    source_system: true,
    source_type: true,
    immutable_source_id: true,
    source_key: true,
    title: true,
    code: true,
    source_url: true,
}).strict()
const Relation = z.object({
    relation_type: z.string().min(1).max(100),
    target: Target,
    source_relation_id: NullableString,
    provenance: z.string().min(1).max(512),
    evidence: z.object({ path: z.string().min(1), label: z.string() }).strict(),
    properties: z.array(z.string()).max(100),
}).strict()
const Claim = z.object({
    subject: z.string().min(1),
    predicate: z.string().min(1),
    value: z.any(),
    unit: NullableString,
    condition: NullableString,
    object: NullableString,
    evidence: z.object({ path: z.string().min(1), excerpt: z.string(), hash: Hash }).strict(),
    rule_version: z.string().min(1).max(100),
}).strict()
const PublishRequest = z.object({
    project_id: z.string().uuid().optional(),
    idempotency_key: z.string().min(1).max(512),
    source: Source,
    revision: z.object({
        source_revision: z.string().min(1).max(512),
        source_updated_at: z.string().datetime().nullable(),
        parser_version: z.string().min(1).max(100),
        extractor_version: z.string().min(1).max(100),
        schema_version: z.literal('1'),
        canonical_payload: z.record(z.string(), z.unknown()),
        source_payload_hash: Hash,
        content_hash: Hash,
        metadata_hash: Hash,
        relation_hash: Hash,
        claim_hash: Hash,
        relation_input_hash: Hash,
    }).strict(),
    memo: z.object({
        memo_uuid: z.string().uuid().nullable(),
        client_reference_id: z.string().min(1).max(512),
        title: z.string().min(1).max(255),
        content: z.string(),
        metadata: z.record(z.string(), z.unknown()),
        source: z.string().min(1).max(255),
    }).strict(),
    relations: z.array(Relation).max(5000),
    claims: z.array(Claim).max(5000),
    expected_relation_count: z.number().int().min(0).max(5000),
    expected_relation_hash: Hash,
    expected_claim_count: z.number().int().min(0).max(5000),
    expected_claim_hash: Hash,
}).strict()

const ProjectQuery = z.object({ project_id: z.string().uuid().optional() })
const ScopeKey = z.string().min(1).max(512).default('spms:all')
const CapabilitiesQuery = ProjectQuery.extend({ scope_key: ScopeKey })
const ExactQuery = ProjectQuery.extend({ scope_key: ScopeKey, locator: z.string().min(1).max(1024) })
const GraphQuery = ExactQuery.extend({ limit: z.coerce.number().int().min(1).max(500).default(100) })
const TraverseRequest = z.object({
    project_id: z.string().uuid().optional(),
    scope_key: ScopeKey,
    locator: z.string().min(1).max(1024),
    max_depth: z.number().int().min(1).max(5).default(3),
    max_nodes: z.number().int().min(1).max(500).default(100),
    page_size: z.number().int().min(1).max(100).default(100),
    cursor: z.string().min(1).optional(),
}).strict()
const BatchRequest = z.object({
    project_id: z.string().uuid().optional(),
    scope_key: ScopeKey,
    locators: z.array(z.string().min(1).max(1024)).min(1).max(50),
    limit: z.number().int().min(1).max(500).default(100),
}).strict()

function validationError(res: Response, error: z.ZodError) {
    return res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'Request validation failed', issues: error.issues } })
}

async function projectFor(req: Request, supplied: unknown) {
    return resolveEffectiveProject(req, typeof supplied === 'string' ? supplied : undefined)
}

function traversalAuthScopeHash(req: Request, projectId: string, scopeKey: string): string {
    const requestUser = req.context?.requestUser
    if (requestUser?.userType === 'projectAPIKeyUser') {
        const authorization = req.headers.authorization
        const credential = typeof authorization === 'string'
            ? authorization.match(/^(?:Token|Bearer)\s+(\S+)$/i)?.[1]
            : undefined
        if (!credential) {
            throw new SpecRevisionError('AUTH_SCOPE_UNAVAILABLE', 'Project API key identity is unavailable', 401)
        }
        return createHash('sha256')
            .update(`project_api_key:${createHash('sha256').update(credential, 'utf8').digest('hex')}:project:${projectId}:scope:${scopeKey}`, 'utf8')
            .digest('hex')
    }
    if (requestUser?.userType === 'authenticatedUser' && requestUser.userInstance) {
        return createHash('sha256')
            .update(`user:${requestUser.userInstance.id.toString()}:project:${projectId}:scope:${scopeKey}`, 'utf8')
            .digest('hex')
    }
    throw new SpecRevisionError('AUTH_SCOPE_UNAVAILABLE', 'Authenticated principal identity is unavailable', 401)
}

function requireQualityReady(surface: 'related' | 'conflict_candidates') {
    return async (req: Request, res: Response, next: NextFunction) => {
        try {
            const project = await projectFor(req, req.body?.project_id)
            const scopeKey = typeof req.body?.scope_key === 'string' ? req.body.scope_key : 'spms:all'
            const promotion = await DI.specPromotionStates.findOne({
                project,
                scope_key: scopeKey,
                state: SpecPromotionStatus.PROMOTED,
            })
            if (!promotion?.nativeCapabilityReadiness?.()[surface]) {
                return res.status(409).json({
                    error: { code: 'SPEC_CAPABILITY_NOT_READY', message: `Spec ${surface} capability is not quality-ready` },
                })
            }
            return next()
        } catch (error) {
            return sendError(res, error)
        }
    }
}

function sendError(res: Response, error: unknown) {
    if (error instanceof SpecRevisionError) {
        return res.status(error.status).json({ error: { code: error.code, message: error.message } })
    }
    if (error && typeof error === 'object' && 'status' in error && 'code' in error && 'message' in error) {
        const scoped = error as { status: number; code: string; message: string }
        return res.status(scoped.status).json({ error: { code: scoped.code, message: scoped.message } })
    }
    throw error
}

export const specRevisionRouter = express.Router({ mergeParams: true })

specRevisionRouter.get('/spec-capabilities', async (req, res) => {
    const parsed = CapabilitiesQuery.safeParse(req.query)
    if (!parsed.success) return validationError(res, parsed.error)
    try {
        const project = await projectFor(req, parsed.data.project_id)
        const promotion = await DI.specPromotionStates.findOne({
            project,
            scope_key: parsed.data.scope_key,
            state: SpecPromotionStatus.PROMOTED,
        })
        const native = promotion !== null
        const readiness = promotion?.nativeCapabilityReadiness?.() || {
            exact: native,
            outgoing: native,
            incoming: native,
            traversal: native,
            related: false,
            conflict_candidates: false,
        }
        return res.json({
            protocol_version: '1',
            scope_key: parsed.data.scope_key,
            native,
            exact: readiness.exact,
            outgoing: readiness.outgoing,
            incoming: readiness.incoming,
            traversal: {
                supported: readiness.traversal,
                max_depth: readiness.traversal ? 5 : 0,
                max_nodes: readiness.traversal ? 500 : 0,
                snapshot_cursor: readiness.traversal,
                max_page_size: readiness.traversal ? 100 : 0,
                snapshot_ttl_seconds: readiness.traversal ? 900 : 0,
            },
            related: readiness.related,
            conflict_candidates: readiness.conflict_candidates,

            semantic_search: false,
            opensearch: false,
        })
    } catch (error) {
        return sendError(res, error)
    }
})

specRevisionRouter.post('/spec-revisions/stage-and-publish', async (req, res) => {
    const parsed = PublishRequest.safeParse(req.body)
    if (!parsed.success) return validationError(res, parsed.error)
    try {
        const project = await projectFor(req, parsed.data.project_id)
        const projectId = project.uuid
        const detachedProject = await DI.em.fork({ clear: true, useContext: false }).findOneOrFail(Project, { uuid: projectId })
        const receipt = await new SpecRevisionService(DI.em).stageAndPublish(detachedProject, parsed.data as Parameters<SpecRevisionService['stageAndPublish']>[1])
        return res.status(receipt.idempotent_replay ? 200 : 201).json(receipt)
    } catch (error) {
        return sendError(res, error)
    }
})

specRevisionRouter.get('/specs/exact', requirePromotedSpecScope(), async (req, res) => {
    const parsed = ExactQuery.safeParse(req.query)
    if (!parsed.success) return validationError(res, parsed.error)
    try {
        const project = await projectFor(req, parsed.data.project_id)
        return res.json(await new SpecRevisionService(DI.em).exact(project, parsed.data.locator))
    } catch (error) {
        return sendError(res, error)
    }
})

specRevisionRouter.get('/specs/outgoing', requirePromotedSpecScope(), async (req, res) => {
    const parsed = GraphQuery.safeParse(req.query)
    if (!parsed.success) return validationError(res, parsed.error)
    try {
        const project = await projectFor(req, parsed.data.project_id)
        const relations = await new SpecRevisionService(DI.em).relations(project, parsed.data.locator, 'outgoing')
        return res.json({ direction: 'outgoing', relations: relations.slice(0, parsed.data.limit), complete: relations.length <= parsed.data.limit })
    } catch (error) {
        return sendError(res, error)
    }
})

specRevisionRouter.get('/specs/incoming', requirePromotedSpecScope(), async (req, res) => {
    const parsed = GraphQuery.safeParse(req.query)
    if (!parsed.success) return validationError(res, parsed.error)
    try {
        const project = await projectFor(req, parsed.data.project_id)
        const relations = await new SpecRevisionService(DI.em).relations(project, parsed.data.locator, 'incoming')
        return res.json({ direction: 'incoming', relations: relations.slice(0, parsed.data.limit), complete: relations.length <= parsed.data.limit })
    } catch (error) {
        return sendError(res, error)
    }
})

specRevisionRouter.post('/specs/traverse', requirePromotedSpecScope(), async (req, res) => {
    const parsed = TraverseRequest.safeParse(req.body)
    if (!parsed.success) return validationError(res, parsed.error)
    try {
        const project = await projectFor(req, parsed.data.project_id)
        return res.json(
            await new SpecRevisionService(DI.em).traverse(project, {
                locator: parsed.data.locator,
                max_depth: parsed.data.max_depth,
                max_nodes: parsed.data.max_nodes,
                page_size: parsed.data.page_size,
                cursor: parsed.data.cursor,
                auth_scope_hash: traversalAuthScopeHash(req, project.uuid, parsed.data.scope_key),
            })
        )
    } catch (error) {
        return sendError(res, error)
    }
})

specRevisionRouter.post('/specs/related', requirePromotedSpecScope(), requireQualityReady('related'), async (req, res) => {
    const parsed = BatchRequest.safeParse(req.body)
    if (!parsed.success) return validationError(res, parsed.error)
    try {
        const project = await projectFor(req, parsed.data.project_id)
        return res.json({ results: await new SpecRevisionService(DI.em).related(project, parsed.data.locators, parsed.data.limit) })
    } catch (error) {
        return sendError(res, error)
    }
})

specRevisionRouter.post('/specs/conflict-candidates', requirePromotedSpecScope(), requireQualityReady('conflict_candidates'), async (req, res) => {
    const parsed = BatchRequest.safeParse(req.body)
    if (!parsed.success) return validationError(res, parsed.error)
    try {
        const project = await projectFor(req, parsed.data.project_id)
        return res.json({
            candidates: await new SpecRevisionService(DI.em).conflictCandidates(
                project,
                parsed.data.locators,
                parsed.data.limit
            ),
            determination: 'candidate_only',
        })
    } catch (error) {
        return sendError(res, error)
    }
})
