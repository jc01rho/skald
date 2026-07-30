import express, { Request, Response } from 'express'
import { z } from 'zod'
import { DI } from '@/di'
import { resolveEffectiveProject } from '@/middleware/authMiddleware'
import {
    CONFLICT_REVIEW_DECISIONS,
    SpecLifecycleError,
    SpecLifecycleService,
} from '@/services/specLifecycleService'

const Hash = z.string().regex(/^[0-9a-f]{64}$/)
const ProjectId = z.string().uuid().optional()
const Drift = z.number().int().min(0)
const LifecycleEvidence = z.object({
    memo_reference_id: z.string().min(1).max(512),
    absent: z.boolean(),
    reason: z.string().trim().min(1),
    observed_at: z.string().datetime(),
    exact_refetch: z.object({
        reference_id: z.string().min(1).max(512),
        outcome: z.literal('absent'),
        checked_at: z.string().datetime(),
        run_id: z.string().min(1).max(512),
        certificate_hash: Hash,
    }).strict().nullable().optional(),
    absence_proof: z.object({
        first_run_id: z.string().min(1).max(512),
        first_observed_at: z.string().datetime(),
        second_run_id: z.string().min(1).max(512),
        second_observed_at: z.string().datetime(),
        grace_deadline: z.string().datetime(),
    }).strict().nullable().optional(),
}).strict()
const Manifest = z.object({
    project_id: ProjectId,
    run_id: z.string().min(1).max(512),
    scope_key: z.string().min(1).max(512),
    source_system: z.string().min(1).max(100).nullable().optional(),
    source_type: z.string().min(1).max(100).nullable().optional(),
    authoritative: z.boolean(),
    complete: z.boolean(),
    manifest_hash: Hash.nullable().optional(),
    count: z.number().int().min(0).optional(),
    errors: z.array(z.record(z.string(), z.unknown())).max(5000).optional(),
    identity_drift: Drift.default(0),
    revision_drift: Drift.default(0),
    authorization_drift: Drift.default(0),
    relation_drift: Drift.default(0),
    claim_drift: Drift.default(0),
    memo_link_drift: Drift.default(0),
    started_at: z.string().datetime(),
    completed_at: z.string().datetime().nullable().optional(),
    lifecycle_evidence: z.array(LifecycleEvidence).max(5000).default([]),
}).strict()
const PromotionQuery = z.object({ project_id: ProjectId, scope_key: z.string().min(1).max(512) })
const ConflictReview = z.object({
    project_id: ProjectId,
    left_claim_id: z.string().uuid(),
    right_claim_id: z.string().uuid(),
    left_revision_id: z.string().uuid(),
    right_revision_id: z.string().uuid(),
    left_evidence_hash: Hash,
    right_evidence_hash: Hash,
    decision: z.enum(CONFLICT_REVIEW_DECISIONS),
    reason: z.string().trim().min(1),
    supersedes_event_id: z.string().uuid().nullable().optional(),
}).strict()
const ConflictHistoryQuery = z.object({ project_id: ProjectId })
const CandidateParams = z.object({ candidate_key: z.string().min(1).max(512) })
const QualityThresholds = z.object({
    related_recall_at_50: z.literal(0.95),
    conflict_recall_at_20: z.literal(0.90),
    conflict_precision_at_20: z.literal(0.80),
    conflict_false_positives_per_query_max: z.literal(10),
    evidence_validity: z.literal(1),
    phrase_recall_at_10: z.literal(0.95),
    korean_no_result: z.literal(true),
}).strict()
const QualityMetrics = z.object({
    related_recall_at_50: z.number().min(0).max(1),
    conflict_recall_at_20: z.number().min(0).max(1),
    conflict_precision_at_20: z.number().min(0).max(1),
    conflict_false_positives_per_query_max: z.number().min(0),
    evidence_validity: z.number().min(0).max(1),
    phrase_recall_at_10: z.number().min(0).max(1),
    korean_no_result: z.boolean(),
}).strict()
const QualityChecks = z.record(z.string(), z.object({
    value: z.union([z.number(), z.boolean()]),
    operator: z.enum(['>=', '<=', '==']),
    threshold: z.union([z.number(), z.boolean()]),
    passed: z.boolean(),
}).strict())
const QueryManifestRegistration = z.object({
    project_id: z.string().uuid(),
    scope_key: z.string().min(1).max(512),
    reconciliation_run_id: z.string().min(1).max(512),
    dataset: z.string().trim().min(1).max(512),
    version: z.string().trim().min(1).max(512),
    content: z.string().min(1).max(10_000_000),
}).strict()
const QualityEvaluation = z.object({
    schema_version: z.literal('1.0'),
    kind: z.literal('skald.spec-quality-readiness'),
    status: z.literal('completed'),
    pass: z.boolean(),
    artifact_sha256: Hash,
    generated_at: z.string().datetime(),
    reviewed_at: z.string().datetime(),
    dataset: z.string().trim().min(1).max(512),
    version: z.string().trim().min(1).max(512),
    owner: z.string().trim().min(1).max(512),
    project_id: z.string().uuid(),
    scope_key: z.string().min(1).max(512),
    reconciliation_run_id: z.string().min(1).max(512),
    query_manifest_sha256: Hash,
    thresholds: QualityThresholds,
    metrics: QualityMetrics,
    checks: QualityChecks,
}).strict()

function validationError(res: Response, error: z.ZodError) {
    return res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'Request validation failed', issues: error.issues } })
}

function sendError(res: Response, error: unknown) {
    if (error instanceof SpecLifecycleError) {
        return res.status(error.status).json({ error: { code: error.code, message: error.message } })
    }
    if (error && typeof error === 'object' && 'status' in error && 'code' in error && 'message' in error) {
        const scoped = error as { status: number; code: string; message: string }
        return res.status(scoped.status).json({ error: { code: scoped.code, message: scoped.message } })
    }
    throw error
}

function actorFor(req: Request, projectId: string): string {
    return req.context?.requestUser?.userInstance?.email || `project-api-key:${projectId}`
}

async function qualityEvaluationProject(req: Request, projectId: string) {
    const requestUser = req.context?.requestUser
    if (!requestUser || requestUser.userType === 'unauthenticatedUser') {
        throw new SpecLifecycleError('UNAUTHORIZED', 'Unauthorized', 401)
    }
    if (requestUser.userType === 'projectAPIKeyUser' || !requestUser.userInstance) {
        throw new SpecLifecycleError('OPERATIONS_AUTHORIZATION_REQUIRED', 'Operations authorization is required', 403)
    }
    const user = requestUser.userInstance
    if (!user.is_superuser && user.role !== 'operations') {
        throw new SpecLifecycleError('OPERATIONS_AUTHORIZATION_REQUIRED', 'Operations authorization is required', 403)
    }
    if (user.is_superuser) {
        const project = await DI.projects.findOne({ uuid: projectId }, { populate: ['organization'] })
        if (!project) throw new SpecLifecycleError('PROJECT_NOT_FOUND', 'Project not found', 404)
        return project
    }
    return resolveEffectiveProject(req, projectId)
}

export const specLifecycleRouter = express.Router({ mergeParams: true })

specLifecycleRouter.post('/spec-reconciliation/manifests', async (req, res) => {
    const parsed = Manifest.safeParse(req.body)
    if (!parsed.success) return validationError(res, parsed.error)
    try {
        const project = await resolveEffectiveProject(req, parsed.data.project_id)
        const receipt = await new SpecLifecycleService(DI.em).submitManifest(project, {
            ...parsed.data,
            started_at: new Date(parsed.data.started_at),
            completed_at: parsed.data.completed_at ? new Date(parsed.data.completed_at) : null,
            lifecycle_evidence: parsed.data.lifecycle_evidence.map(({ absence_proof: _untrustedAbsenceProof, ...evidence }) => ({
                ...evidence,
                observed_at: new Date(evidence.observed_at),
                exact_refetch: evidence.exact_refetch
                    ? { ...evidence.exact_refetch, checked_at: new Date(evidence.exact_refetch.checked_at) }
                    : evidence.exact_refetch,
            })),
        })
        return res.status(receipt.idempotent_replay ? 200 : 201).json(receipt)
    } catch (error) {
        return sendError(res, error)
    }
})

specLifecycleRouter.get('/spec-promotion-status', async (req, res) => {
    const parsed = PromotionQuery.safeParse(req.query)
    if (!parsed.success) return validationError(res, parsed.error)
    try {
        const project = await resolveEffectiveProject(req, parsed.data.project_id)
        return res.json(await new SpecLifecycleService(DI.em).promotionStatus(project, parsed.data.scope_key))
    } catch (error) {
        return sendError(res, error)
    }
})
specLifecycleRouter.post('/spec-quality-readiness/query-manifests', async (req, res) => {
    const parsed = QueryManifestRegistration.safeParse(req.body)
    if (!parsed.success) return validationError(res, parsed.error)
    try {
        const project = await qualityEvaluationProject(req, parsed.data.project_id)
        return res.status(201).json(await new SpecLifecycleService(DI.em).registerQualityQueryManifest(
            project,
            actorFor(req, project.uuid),
            parsed.data
        ))
    } catch (error) {
        return sendError(res, error)
    }
})

specLifecycleRouter.post('/spec-quality-readiness/evaluations', async (req, res) => {
    const parsed = QualityEvaluation.safeParse(req.body)
    if (!parsed.success) return validationError(res, parsed.error)
    try {
        const project = await qualityEvaluationProject(req, parsed.data.project_id)
        return res.status(201).json(await new SpecLifecycleService(DI.em).recordQualityEvaluation(
            project,
            actorFor(req, project.uuid),
            {
                ...parsed.data,
                generated_at: new Date(parsed.data.generated_at),
                reviewed_at: new Date(parsed.data.reviewed_at),
            }
        ))
    } catch (error) {
        return sendError(res, error)
    }
})

specLifecycleRouter.post('/conflict-review-cases/:candidate_key/events', async (req, res) => {
    const body = ConflictReview.safeParse(req.body)
    const params = CandidateParams.safeParse(req.params)
    if (!body.success) return validationError(res, body.error)
    if (!params.success) return validationError(res, params.error)
    try {
        const project = await resolveEffectiveProject(req, body.data.project_id)
        const event = await new SpecLifecycleService(DI.em).recordConflictReview(
            project,
            actorFor(req, project.uuid),
            { ...body.data, candidate_key: params.data.candidate_key }
        )
        return res.status(201).json(event)
    } catch (error) {
        return sendError(res, error)
    }
})

specLifecycleRouter.get('/conflict-review-cases/:candidate_key/events', async (req, res) => {
    const query = ConflictHistoryQuery.safeParse(req.query)
    const params = CandidateParams.safeParse(req.params)
    if (!query.success) return validationError(res, query.error)
    if (!params.success) return validationError(res, params.error)
    try {
        const project = await resolveEffectiveProject(req, query.data.project_id)
        return res.json({
            candidate_key: params.data.candidate_key,
            events: await new SpecLifecycleService(DI.em).conflictReviewHistory(project, params.data.candidate_key),
        })
    } catch (error) {
        return sendError(res, error)
    }
})
