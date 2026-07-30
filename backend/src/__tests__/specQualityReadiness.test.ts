import express from 'express'
import request from 'supertest'
import { specLifecycleRouter } from '@/api/specLifecycle'
import { DI } from '@/di'
import { SpecPromotionState, SpecPromotionStatus } from '@/entities/SpecPromotionState'
import { SpecReconciliationRun } from '@/entities/SpecReconciliationRun'
import { RequestUser } from '@/middleware/requestUser'
import {
    qualityEvaluationArtifactHash,
    SPEC_QUALITY_THRESHOLDS,
    SpecLifecycleService,
    SpecQualityEvaluationInput,
} from '@/services/specLifecycleService'
import type { Project } from '@/entities/Project'
import type { User } from '@/entities/User'

function checks(metrics: SpecQualityEvaluationInput['metrics']) {
    return {
        related_recall_at_50: { value: metrics.related_recall_at_50, operator: '>=' as const, threshold: 0.95, passed: metrics.related_recall_at_50 >= 0.95 },
        conflict_recall_at_20: { value: metrics.conflict_recall_at_20, operator: '>=' as const, threshold: 0.9, passed: metrics.conflict_recall_at_20 >= 0.9 },
        conflict_precision_at_20: { value: metrics.conflict_precision_at_20, operator: '>=' as const, threshold: 0.8, passed: metrics.conflict_precision_at_20 >= 0.8 },
        conflict_false_positives_per_query_max: { value: metrics.conflict_false_positives_per_query_max, operator: '<=' as const, threshold: 10, passed: metrics.conflict_false_positives_per_query_max <= 10 },
        evidence_validity: { value: metrics.evidence_validity, operator: '>=' as const, threshold: 1, passed: metrics.evidence_validity >= 1 },
        phrase_recall_at_10: { value: metrics.phrase_recall_at_10, operator: '>=' as const, threshold: 0.95, passed: metrics.phrase_recall_at_10 >= 0.95 },
        korean_no_result: { value: metrics.korean_no_result, operator: '==' as const, threshold: true, passed: metrics.korean_no_result === true },
    }
}

const project = { uuid: '11111111-1111-4111-8111-111111111111' } as Project
const now = new Date('2026-07-30T12:00:00.000Z')

function promotedState(): SpecPromotionState {
    return Object.assign(new SpecPromotionState(), {
        scope_key: 'github:specs',
        state: SpecPromotionStatus.PROMOTED,
        consecutive_clean_runs: 2,
        previous_clean_run_id: 'run-1',
        last_clean_run_id: 'run-2',
        last_clean_completed_at: new Date('2026-07-30T11:00:00.000Z'),
        promoted_at: new Date('2026-07-30T11:00:00.000Z'),
        created_at: new Date('2026-07-30T10:00:00.000Z'),
        updated_at: new Date('2026-07-30T11:00:00.000Z'),
    })
}

function serviceFor(state: SpecPromotionState, registeredManifest: string | null = 'b'.repeat(64)) {
    const reconciliationRun = Object.assign(new SpecReconciliationRun(), {
        run_id: 'run-2',
        scope_key: 'github:specs',
        authoritative: true,
        complete: true,
        manifest_hash: 'a'.repeat(64),
        identity_drift: 0,
        revision_drift: 0,
        authorization_drift: 0,
        relation_drift: 0,
        claim_drift: 0,
        memo_link_drift: 0,
        completed_at: new Date('2026-07-30T09:00:00.000Z'),
    })
    const execute = jest.fn().mockImplementation((sql: string) => Promise.resolve(
        sql.includes('skald_spec_quality_query_manifest') && registeredManifest
            ? [{ query_manifest_sha256: registeredManifest }]
            : []
    ))
    const em = {
        getConnection: () => ({ execute }),
        getRepository: (entity: unknown) => ({
            findOne: jest.fn().mockResolvedValue(entity === SpecReconciliationRun ? reconciliationRun : state),
        }),
        persist: jest.fn(),
        flush: jest.fn().mockResolvedValue(undefined),
    }
    return new SpecLifecycleService({ transactional: (callback: (tx: typeof em) => unknown) => callback(em) } as any)
}

function report(overrides: Partial<SpecQualityEvaluationInput> = {}): SpecQualityEvaluationInput {
    const metrics = {
        related_recall_at_50: 0.95,
        conflict_recall_at_20: 0.90,
        conflict_precision_at_20: 0.80,
        conflict_false_positives_per_query_max: 10,
        evidence_validity: 1,
        phrase_recall_at_10: 0.95,
        korean_no_result: true,
        ...overrides.metrics,
    }
    const payload = {
        schema_version: '1.0' as const,
        kind: 'skald.spec-quality-readiness' as const,
        status: 'completed' as const,
        pass: true,
        generated_at: new Date('2026-07-30T10:00:00.000Z'),
        reviewed_at: new Date('2026-07-30T11:00:00.000Z'),
        dataset: 'golden-spec-capabilities',
        version: '2026-07-30.1',
        owner: 'search-quality',
        project_id: project.uuid,
        scope_key: 'github:specs',
        reconciliation_run_id: 'run-2',
        query_manifest_sha256: 'b'.repeat(64),
        thresholds: { ...SPEC_QUALITY_THRESHOLDS },
        metrics,
        checks: checks(metrics),
        ...overrides,
    }
    return { ...payload, artifact_sha256: qualityEvaluationArtifactHash(payload) }
}

function wireReport(input: SpecQualityEvaluationInput) {
    return {
        ...input,
        generated_at: input.generated_at.toISOString(),
        reviewed_at: input.reviewed_at.toISOString(),
    }
}

describe('spec quality readiness', () => {
    beforeEach(() => jest.useFakeTimers().setSystemTime(now))
    afterEach(() => {
        jest.useRealTimers()
        jest.restoreAllMocks()
    })

    it('persists a complete immutable passing report and enables native surfaces', async () => {
        const state = promotedState()
        const input = report()
        const result = await serviceFor(state).recordQualityEvaluation(project, 'reviewer@example.com', input)

        expect(result.capabilities).toMatchObject({ related: true, conflict_candidates: true })
        expect(state.quality_readiness).toEqual(expect.objectContaining({
            schema_version: '1.0',
            kind: 'skald.spec-quality-readiness',
            status: 'completed',
            pass: true,
            artifact_sha256: input.artifact_sha256,
            project_id: project.uuid,
            scope_key: 'github:specs',
            reconciliation_run_id: 'run-2',
            query_manifest_sha256: 'b'.repeat(64),
            thresholds: SPEC_QUALITY_THRESHOLDS,
            metrics: input.metrics,
            recorded_by: 'reviewer@example.com',
        }))
    })

    it('rejects forged metrics whose caller-provided artifact digest no longer matches', async () => {
        const valid = report()
        const forged = { ...valid, metrics: { ...valid.metrics, related_recall_at_50: 1 } }
        await expect(serviceFor(promotedState()).recordQualityEvaluation(project, 'reviewer@example.com', forged))
            .rejects.toMatchObject({ code: 'INVALID_QUALITY_ARTIFACT' })
    })

    it('rejects a missing or mismatched server-registered query manifest', async () => {
        await expect(serviceFor(promotedState(), null).recordQualityEvaluation(project, 'reviewer@example.com', report()))
            .rejects.toMatchObject({ code: 'UNREGISTERED_QUERY_MANIFEST' })
        await expect(serviceFor(promotedState(), 'c'.repeat(64)).recordQualityEvaluation(project, 'reviewer@example.com', report()))
            .rejects.toMatchObject({ code: 'UNREGISTERED_QUERY_MANIFEST' })
    })

    it('rejects stale artifacts and wrong project, scope, or reconciliation run', async () => {
        await expect(serviceFor(promotedState()).recordQualityEvaluation(project, 'reviewer@example.com', report({
            generated_at: new Date('2026-07-20T10:00:00.000Z'),
            reviewed_at: new Date('2026-07-20T11:00:00.000Z'),
        }))).rejects.toMatchObject({ code: 'STALE_QUALITY_REPORT' })
        await expect(serviceFor(promotedState()).recordQualityEvaluation(project, 'reviewer@example.com', report({
            project_id: '22222222-2222-4222-8222-222222222222',
        }))).rejects.toMatchObject({ code: 'QUALITY_REPORT_SCOPE_MISMATCH' })
        await expect(serviceFor(promotedState()).recordQualityEvaluation(project, 'reviewer@example.com', report({
            scope_key: 'github:other',
        }))).rejects.toMatchObject({ code: 'QUALITY_REPORT_SCOPE_MISMATCH' })
        await expect(serviceFor(promotedState()).recordQualityEvaluation(project, 'reviewer@example.com', report({
            reconciliation_run_id: 'run-1',
        }))).rejects.toMatchObject({ code: 'STALE_QUALITY_REPORT' })
    })

    it.each([
        { phrase_recall_at_10: 0.949 },
        { korean_no_result: false },
    ])('rejects missing phrase and Korean gates: %j', async (metrics) => {
        const base = report()
        const failing = report({ metrics: { ...base.metrics, ...metrics } })
        await expect(serviceFor(promotedState()).recordQualityEvaluation(project, 'reviewer@example.com', failing))
            .rejects.toMatchObject({ code: 'QUALITY_GATES_FAILED' })
    })

    it('invalidates evidence on every newer reconciliation run, including clean runs', async () => {
        const state = promotedState()
        await serviceFor(state).recordQualityEvaluation(project, 'reviewer@example.com', report())
        state.applyAuthoritativeRun(Object.assign(new SpecReconciliationRun(), {
            run_id: 'run-3',
            scope_key: 'github:specs',
            authoritative: true,
            complete: true,
            manifest_hash: 'c'.repeat(64),
            identity_drift: 0,
            revision_drift: 0,
            authorization_drift: 0,
            relation_drift: 0,
            claim_drift: 0,
            memo_link_drift: 0,
            completed_at: new Date('2026-07-30T11:31:00.000Z'),
        }))
        expect(state.quality_readiness).toBeNull()
        expect(state.nativeCapabilityReadiness()).toMatchObject({ related: false, conflict_candidates: false })
    })

    it('rejects an ordinary project API key at the readiness endpoint', async () => {
        const app = express()
        app.use(express.json())
        app.use((req, _res, next) => {
            req.context = { requestUser: new RequestUser(null, 'projectAPIKeyUser', project) }
            next()
        })
        app.use(specLifecycleRouter)

        const response = await request(app).post('/spec-quality-readiness/evaluations').send(wireReport(report()))
        expect(response.status).toBe(403)
        expect(response.body.error.code).toBe('OPERATIONS_AUTHORIZATION_REQUIRED')
    })

    it('accepts a passing immutable report from a superuser for the derived project', async () => {
        const user = { email: 'admin@example.com', is_superuser: true } as User
        DI.projects = { findOne: jest.fn().mockResolvedValue(project) } as any
        DI.em = {} as any
        const record = jest.spyOn(SpecLifecycleService.prototype, 'recordQualityEvaluation').mockResolvedValue({
            capabilities: { related: true, conflict_candidates: true },
        } as any)
        const app = express()
        app.use(express.json())
        app.use((req, _res, next) => {
            req.context = { requestUser: new RequestUser(user, 'authenticatedUser', null) }
            next()
        })
        app.use(specLifecycleRouter)

        const input = report()
        const response = await request(app).post('/spec-quality-readiness/evaluations').send(wireReport(input))
        expect(response.status).toBe(201)
        expect(record).toHaveBeenCalledWith(project, 'admin@example.com', input)
    })
})
