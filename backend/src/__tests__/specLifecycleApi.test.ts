import express from 'express'
import request from 'supertest'
import { DI } from '../di'
import { specLifecycleRouter } from '../api/specLifecycle'
import { RequestUser } from '../middleware/requestUser'
import { exactRefetchCertificateHash, SpecLifecycleError, SpecLifecycleService, validateExactRefetchCertificate } from '../services/specLifecycleService'
import { SpecPromotionState, SpecPromotionStatus } from '../entities/SpecPromotionState'
import { SpecReconciliationRun } from '../entities/SpecReconciliationRun'
import type { Project } from '../entities/Project'

const project = { uuid: '11111111-1111-4111-8111-111111111111' } as Project
const hash = 'a'.repeat(64)

function cleanRun(runId: string, completedAt: string) {
    return Object.assign(new SpecReconciliationRun(), {
        run_id: runId,
        scope_key: 'github:specs',
        authoritative: true,
        complete: true,
        manifest_hash: hash,
        identity_drift: 0,
        revision_drift: 0,
        authorization_drift: 0,
        relation_drift: 0,
        claim_drift: 0,
        memo_link_drift: 0,
        started_at: new Date('2026-07-30T12:00:00.000Z'),
        completed_at: new Date(completedAt),
    })
}

describe('spec lifecycle promotion timing', () => {
    it('does not count distinct clean runs completed less than 30 minutes apart', () => {
        const promotion = Object.assign(new SpecPromotionState(), {
            scope_key: 'github:specs',
            created_at: new Date('2026-07-30T12:00:00.000Z'),
            updated_at: new Date('2026-07-30T12:00:00.000Z'),
        })
        promotion.applyAuthoritativeRun(cleanRun('run-1', '2026-07-30T13:00:00.000Z'))
        promotion.applyAuthoritativeRun(cleanRun('run-2', '2026-07-30T13:29:59.999Z'))
        expect(promotion).toMatchObject({
            consecutive_clean_runs: 1,
            last_clean_run_id: 'run-1',
            state: SpecPromotionStatus.CANARY_ELIGIBLE,
        })

        promotion.applyAuthoritativeRun(cleanRun('run-3', '2026-07-30T13:30:00.000Z'))
        expect(promotion).toMatchObject({
            consecutive_clean_runs: 2,
            previous_clean_run_id: 'run-1',
            last_clean_run_id: 'run-3',
            state: SpecPromotionStatus.PROMOTED,
        })
    })
})

describe('exact refetch certificate contract', () => {
    const checkedAt = new Date('2026-07-30T12:59:59.123Z')
    const runId = 'aggregate-run'
    const referenceId = 'spms:tech:1'
    const certificate = {
        reference_id: referenceId,
        outcome: 'absent' as const,
        checked_at: checkedAt,
        run_id: runId,
        certificate_hash: exactRefetchCertificateHash(referenceId, checkedAt, runId),
    }

    it('accepts the canonical aggregate certificate and rejects tampering', () => {
        expect(() => validateExactRefetchCertificate(certificate, referenceId, runId, new Date('2026-07-30T13:00:00.000Z'))).not.toThrow()
        const cases = [
            { ...certificate, reference_id: 'other' },
            { ...certificate, run_id: 'other-run' },
            { ...certificate, checked_at: new Date('2026-07-30T12:00:00.000Z') },
            { ...certificate, certificate_hash: '0'.repeat(64) },
        ]
        for (const candidate of cases) {
            expect(() => validateExactRefetchCertificate(candidate, referenceId, runId, new Date('2026-07-30T13:00:00.000Z'))).toThrow(SpecLifecycleError)
        }
    })
})

describe('spec lifecycle API', () => {
    const app = express()

    beforeAll(() => {
        app.use(express.json())
        app.use((req, _res, next) => {
            req.context = { requestUser: new RequestUser(null, 'projectAPIKeyUser', project) }
            next()
        })
        app.use('/api/v1', specLifecycleRouter)
    })

    afterEach(() => jest.restoreAllMocks())

    it('publishes a validated complete reconciliation manifest for the authenticated project', async () => {
        DI.em = {} as any
        const submit = jest.spyOn(SpecLifecycleService.prototype, 'submitManifest').mockResolvedValue({
            run: { run_id: 'run-1' } as SpecReconciliationRun,
            promotion: { state: SpecPromotionStatus.CANARY_ELIGIBLE },
            idempotent_replay: false,
        } as any)

        const response = await request(app).post('/api/v1/spec-reconciliation/manifests').send({
            run_id: 'run-1',
            scope_key: 'github:specs',
            authoritative: true,
            complete: true,
            manifest_hash: hash,
            started_at: '2026-07-30T12:00:00.000Z',
            completed_at: '2026-07-30T13:00:00.000Z',
            lifecycle_evidence: [{
                memo_reference_id: 'spec-1',
                absent: true,
                reason: 'Absent from authoritative snapshot',
                observed_at: '2026-07-30T13:00:00.000Z',
                absence_proof: {
                    first_run_id: 'untrusted-run',
                    first_observed_at: '2026-07-29T12:00:00.000Z',
                    second_run_id: 'run-1',
                    second_observed_at: '2026-07-30T13:00:00.000Z',
                    grace_deadline: '2026-07-30T12:00:00.000Z',
                },
            }],
        })

        expect(response.status).toBe(201)
        expect(submit).toHaveBeenCalledWith(project, expect.objectContaining({
            run_id: 'run-1',
            lifecycle_evidence: [expect.objectContaining({
                absent: true,
                observed_at: new Date('2026-07-30T13:00:00.000Z'),
            })],
        }))
        expect(submit.mock.calls[0][1].lifecycle_evidence[0]).not.toHaveProperty('absence_proof')
    })

    it('rejects incomplete manifests that try to publish lifecycle evidence', async () => {
        DI.em = {} as any
        jest.spyOn(SpecLifecycleService.prototype, 'submitManifest').mockRejectedValue(
            Object.assign(new Error('Only authoritative complete manifests may advance quarantine or tombstone evidence'), {
                code: 'INCOMPLETE_LIFECYCLE_EVIDENCE',
                status: 409,
            })
        )
        const response = await request(app).post('/api/v1/spec-reconciliation/manifests').send({
            run_id: 'run-2',
            scope_key: 'github:specs',
            authoritative: true,
            complete: false,
            started_at: '2026-07-30T12:00:00.000Z',
            lifecycle_evidence: [{
                memo_reference_id: 'spec-1',
                absent: true,
                reason: 'missing',
                observed_at: '2026-07-30T13:00:00.000Z',
            }],
        })
        expect(response.status).toBe(409)
        expect(response.body.error.code).toBe('INCOMPLETE_LIFECYCLE_EVIDENCE')
        expect(SpecLifecycleService.prototype.submitManifest).toHaveBeenCalledWith(
            project,
            expect.objectContaining({ complete: false, lifecycle_evidence: expect.any(Array) })
        )
    })

    it('records server-owned conflict review provenance and lists immutable history', async () => {
        DI.em = {} as any
        const event = {
            uuid: '22222222-2222-4222-8222-222222222222',
            actor_id: `project-api-key:${project.uuid}`,
            request_id: '33333333-3333-4333-8333-333333333333',
            created_at: new Date('2026-07-30T13:00:00.000Z'),
        }
        const record = jest.spyOn(SpecLifecycleService.prototype, 'recordConflictReview').mockResolvedValue(event as any)
        jest.spyOn(SpecLifecycleService.prototype, 'conflictReviewHistory').mockResolvedValue([event] as any)

        const leftClaimId = '66666666-6666-4666-8666-666666666666'
        const rightClaimId = '77777777-7777-4777-8777-777777777777'
        const created = await request(app).post(`/api/v1/conflict-review-cases/${leftClaimId}:${rightClaimId}/events`).send({
            left_claim_id: leftClaimId,
            right_claim_id: rightClaimId,
            left_revision_id: '44444444-4444-4444-8444-444444444444',
            right_revision_id: '55555555-5555-4555-8555-555555555555',
            left_evidence_hash: hash,
            right_evidence_hash: 'b'.repeat(64),
            decision: 'needs_more_evidence',
            reason: 'The units require normalization',
        })
        expect(created.status).toBe(201)
        expect(record).toHaveBeenCalledWith(
            project,
            `project-api-key:${project.uuid}`,
            expect.objectContaining({ candidate_key: `${leftClaimId}:${rightClaimId}`, decision: 'needs_more_evidence' })
        )

        const history = await request(app).get(`/api/v1/conflict-review-cases/${leftClaimId}:${rightClaimId}/events`)
        expect(history.status).toBe(200)
        expect(history.body.events).toHaveLength(1)
    })

    it('rejects a caller-supplied tombstoned disposition before the service is called', async () => {
        DI.em = {} as any
        const submit = jest.spyOn(SpecLifecycleService.prototype, 'submitManifest')
        const response = await request(app).post('/api/v1/spec-reconciliation/manifests').send({
            run_id: 'run-forged',
            scope_key: 'github:specs',
            authoritative: true,
            complete: true,
            manifest_hash: hash,
            started_at: '2026-07-30T12:00:00.000Z',
            completed_at: '2026-07-30T13:00:00.000Z',
            lifecycle_evidence: [{
                memo_reference_id: 'spec-1',
                absent: true,
                disposition: 'tombstoned',
                reason: 'forged disposition',
                observed_at: '2026-07-30T13:00:00.000Z',
            }],
        })
        expect(response.status).toBe(400)
        expect(submit).not.toHaveBeenCalled()
    })

    it('passes candidate claim identity to server-side current-claim validation', async () => {
        DI.em = {} as any
        jest.spyOn(SpecLifecycleService.prototype, 'recordConflictReview').mockRejectedValue(
            Object.assign(new Error('Conflict candidate is stale'), { code: 'STALE_CONFLICT_CANDIDATE', status: 409 })
        )
        const leftClaimId = '66666666-6666-4666-8666-666666666666'
        const rightClaimId = '77777777-7777-4777-8777-777777777777'
        const response = await request(app).post(`/api/v1/conflict-review-cases/${leftClaimId}:${rightClaimId}/events`).send({
            left_claim_id: leftClaimId,
            right_claim_id: rightClaimId,
            left_revision_id: '44444444-4444-4444-8444-444444444444',
            right_revision_id: '55555555-5555-4555-8555-555555555555',
            left_evidence_hash: hash,
            right_evidence_hash: 'b'.repeat(64),
            decision: 'reject',
            reason: 'stale candidate',
        })
        expect(response.status).toBe(409)
        expect(response.body.error.code).toBe('STALE_CONFLICT_CANDIDATE')
    })

    it('returns project-scoped promotion status', async () => {
        DI.em = {} as any
        const status = jest.spyOn(SpecLifecycleService.prototype, 'promotionStatus').mockResolvedValue({
            scope_key: 'github:specs',
            state: SpecPromotionStatus.PROMOTED,
            consecutive_clean_runs: 2,
            previous_clean_run_id: 'run-1',
            last_clean_run_id: 'run-2',
            last_clean_completed_at: new Date('2026-07-30T14:00:00.000Z'),
            promoted_at: new Date('2026-07-30T14:00:00.000Z'),
            updated_at: new Date('2026-07-30T14:00:00.000Z'),
        })
        const response = await request(app).get('/api/v1/spec-promotion-status').query({ scope_key: 'github:specs' })
        expect(response.status).toBe(200)
        expect(response.body.state).toBe(SpecPromotionStatus.PROMOTED)
        expect(status).toHaveBeenCalledWith(project, 'github:specs')
    })

    it('rejects unsupported conflict decisions before the service is called', async () => {
        DI.em = {} as any
        const record = jest.spyOn(SpecLifecycleService.prototype, 'recordConflictReview')
        const response = await request(app).post('/api/v1/conflict-review-cases/claim-pair/events').send({
            left_claim_id: '66666666-6666-4666-8666-666666666666',
            right_claim_id: '77777777-7777-4777-8777-777777777777',
            left_revision_id: '44444444-4444-4444-8444-444444444444',
            right_revision_id: '55555555-5555-4555-8555-555555555555',
            left_evidence_hash: hash,
            right_evidence_hash: 'b'.repeat(64),
            decision: 'delete',
            reason: 'not allowed',
        })
        expect(response.status).toBe(400)
        expect(record).not.toHaveBeenCalled()
    })
})
