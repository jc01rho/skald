import { createHash, randomUUID } from 'crypto'
import { EntityManager } from '@mikro-orm/postgresql'
import { Project } from '@/entities/Project'
import { SpecConflictReviewEvent } from '@/entities/SpecConflictReviewEvent'
import { SpecPromotionState, SpecPromotionStatus } from '@/entities/SpecPromotionState'
import { SpecReconciliationRun } from '@/entities/SpecReconciliationRun'

export const CONFLICT_REVIEW_DECISIONS = ['approve', 'reject', 'needs_more_evidence', 'supersede'] as const
export type ConflictReviewDecision = (typeof CONFLICT_REVIEW_DECISIONS)[number]

const MIN_ABSENCE_INTERVAL_MS = 6 * 60 * 60 * 1000
const TOMBSTONE_GRACE_MS = 24 * 60 * 60 * 1000

export function exactRefetchCertificateHash(referenceId: string, checkedAt: Date, runId: string): string {
    const canonical = JSON.stringify({
        checked_at: checkedAt.toISOString(),
        outcome: 'absent',
        reference_id: referenceId,
        run_id: runId,
    })
    return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

export function validateExactRefetchCertificate(
    certificate: NonNullable<LifecycleEvidenceInput['exact_refetch']>,
    memoReferenceId: string,
    manifestRunId: string,
    completedAt: Date
): void {
    if (certificate.reference_id !== memoReferenceId) {
        throw new SpecLifecycleError('INVALID_REFETCH_CERTIFICATE', 'Exact-refetch certificate reference does not match the memo', 400)
    }
    if (certificate.run_id !== manifestRunId) {
        throw new SpecLifecycleError('INVALID_REFETCH_CERTIFICATE', 'Exact-refetch certificate run does not match the manifest', 400)
    }
    if (Math.abs(completedAt.getTime() - certificate.checked_at.getTime()) > 15 * 60 * 1000) {
        throw new SpecLifecycleError('INVALID_REFETCH_CERTIFICATE', 'Exact-refetch certificate is stale', 400)
    }
    const expectedHash = exactRefetchCertificateHash(certificate.reference_id, certificate.checked_at, certificate.run_id)
    if (expectedHash !== certificate.certificate_hash) {
        throw new SpecLifecycleError('INVALID_REFETCH_CERTIFICATE', 'Exact-refetch certificate hash is invalid', 400)
    }
}

export interface LifecycleEvidenceInput {
    memo_reference_id: string
    absent: boolean
    reason: string
    observed_at: Date
    exact_refetch?: {
        reference_id: string
        outcome: 'absent'
        checked_at: Date
        run_id: string
        certificate_hash: string
    } | null
}

export interface ReconciliationManifestInput {
    run_id: string
    scope_key: string
    source_system?: string | null
    source_type?: string | null
    authoritative: boolean
    complete: boolean
    manifest_hash?: string | null
    identity_drift: number
    revision_drift: number
    authorization_drift: number
    relation_drift: number
    claim_drift: number
    memo_link_drift: number
    started_at: Date
    completed_at?: Date | null
    lifecycle_evidence: LifecycleEvidenceInput[]
}

export interface ConflictReviewInput {
    candidate_key: string
    left_claim_id: string
    right_claim_id: string
    left_revision_id: string
    right_revision_id: string
    left_evidence_hash: string
    right_evidence_hash: string
    decision: ConflictReviewDecision
    reason: string
    supersedes_event_id?: string | null
}

export class SpecLifecycleError extends Error {
    constructor(
        public readonly code: string,
        message: string,
        public readonly status: number
    ) {
        super(message)
    }
}

function promotionResponse(state: SpecPromotionState | null, scopeKey: string) {
    return state
        ? {
              scope_key: state.scope_key,
              state: state.state,
              consecutive_clean_runs: state.consecutive_clean_runs,
              previous_clean_run_id: state.previous_clean_run_id || null,
              last_clean_run_id: state.last_clean_run_id || null,
              last_clean_completed_at: state.last_clean_completed_at || null,
              promoted_at: state.promoted_at || null,
              updated_at: state.updated_at,
          }
        : {
              scope_key: scopeKey,
              state: SpecPromotionStatus.SHADOW,
              consecutive_clean_runs: 0,
              previous_clean_run_id: null,
              last_clean_run_id: null,
              last_clean_completed_at: null,
              promoted_at: null,
              updated_at: null,
          }
}

function candidateKey(leftClaimId: string, rightClaimId: string): string {
    return [leftClaimId, rightClaimId].sort().join(':')
}

export class SpecLifecycleService {
    constructor(private readonly rootEm: EntityManager) {}

    async submitManifest(project: Project, input: ReconciliationManifestInput) {
        return this.rootEm.transactional(async (em) => {
            await em.getConnection().execute('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?))', [
                project.uuid,
                input.scope_key,
            ])
            const runs = em.getRepository(SpecReconciliationRun)
            const existing = await runs.findOne({ project, scope_key: input.scope_key, run_id: input.run_id })
            if (existing) {
                const same =
                    existing.authoritative === input.authoritative &&
                    existing.complete === input.complete &&
                    (existing.manifest_hash || null) === (input.manifest_hash || null)
                if (!same) throw new SpecLifecycleError('RUN_ID_CONFLICT', 'Run ID was already used for another manifest', 409)
                const state = await em.getRepository(SpecPromotionState).findOne({ project, scope_key: input.scope_key })
                return { run: existing, promotion: promotionResponse(state, input.scope_key), idempotent_replay: true }
            }

            if (input.complete && (!input.completed_at || !input.manifest_hash)) {
                throw new SpecLifecycleError('INVALID_COMPLETION_CERTIFICATE', 'Complete manifests require completion time and hash', 400)
            }
            if (!input.complete && (input.completed_at || input.manifest_hash)) {
                throw new SpecLifecycleError('INVALID_COMPLETION_CERTIFICATE', 'Incomplete manifests cannot carry completion proof', 400)
            }
            if (input.complete && input.completed_at && input.completed_at < input.started_at) {
                throw new SpecLifecycleError('INVALID_COMPLETION_CERTIFICATE', 'Completion time cannot precede start time', 400)
            }
            if (input.lifecycle_evidence.some((evidence) => evidence.observed_at > (input.completed_at || evidence.observed_at))) {
                throw new SpecLifecycleError('INVALID_LIFECYCLE_OBSERVATION', 'Lifecycle observation cannot follow run completion', 400)
            }
            if (input.lifecycle_evidence.length && (!input.authoritative || !input.complete)) {
                throw new SpecLifecycleError(
                    'INCOMPLETE_LIFECYCLE_EVIDENCE',
                    'Only authoritative complete manifests may advance lifecycle evidence',
                    409
                )
            }
            const referenceIds = input.lifecycle_evidence.map((evidence) => evidence.memo_reference_id)
            if (new Set(referenceIds).size !== referenceIds.length) {
                throw new SpecLifecycleError('DUPLICATE_LIFECYCLE_EVIDENCE', 'A manifest may observe each memo only once', 400)
            }

            const run = runs.create({
                uuid: randomUUID(),
                project,
                run_id: input.run_id,
                scope_key: input.scope_key,
                source_system: input.source_system || null,
                source_type: input.source_type || null,
                authoritative: input.authoritative,
                complete: input.complete,
                manifest_hash: input.manifest_hash || null,
                identity_drift: input.identity_drift,
                revision_drift: input.revision_drift,
                authorization_drift: input.authorization_drift,
                relation_drift: input.relation_drift,
                claim_drift: input.claim_drift,
                memo_link_drift: input.memo_link_drift,
                started_at: input.started_at,
                completed_at: input.completed_at || null,
            })
            em.persist(run)

            const states = em.getRepository(SpecPromotionState)
            let state = await states.findOne({ project, scope_key: input.scope_key })
            if (!state) {
                const now = input.completed_at || new Date()
                state = states.create({
                    uuid: randomUUID(),
                    project,
                    scope_key: input.scope_key,
                    consecutive_clean_runs: 0,
                    state: SpecPromotionStatus.SHADOW,
                    created_at: now,
                    updated_at: now,
                })
            }
            state.applyAuthoritativeRun(run)
            em.persist(state)

            for (const evidence of input.lifecycle_evidence) {
                const rows = await em.getConnection().execute<Array<{ uuid: string; metadata: Record<string, unknown> }>>(
                    `SELECT uuid, metadata FROM skald_memo WHERE project_id = ? AND client_reference_id = ? FOR UPDATE`,
                    [project.uuid, evidence.memo_reference_id]
                )
                if (rows.length !== 1) {
                    throw new SpecLifecycleError('MEMO_NOT_FOUND', `Memo ${evidence.memo_reference_id} was not found`, 404)
                }
                if (evidence.exact_refetch) {
                    validateExactRefetchCertificate(
                        evidence.exact_refetch,
                        evidence.memo_reference_id,
                        input.run_id,
                        input.completed_at as Date
                    )
                }

                const observedAt = input.completed_at as Date
                let disposition: 'present' | 'quarantined' | 'tombstoned' = evidence.absent ? 'quarantined' : 'present'
                let firstAbsence: { run_id: string; observed_at: Date } | undefined
                if (evidence.absent) {
                    const prior = await em.getConnection().execute<Array<{ run_id: string; observed_at: Date }>>(
                        `SELECT run_id, observed_at
                           FROM skald_spec_lifecycle_event
                          WHERE project_id = ? AND scope_key = ? AND memo_reference_id = ? AND absent
                            AND run_id <> ? AND observed_at <= ?
                            AND NOT EXISTS (
                                SELECT 1 FROM skald_spec_lifecycle_event present_event
                                 WHERE present_event.project_id = skald_spec_lifecycle_event.project_id
                                   AND present_event.scope_key = skald_spec_lifecycle_event.scope_key
                                   AND present_event.memo_reference_id = skald_spec_lifecycle_event.memo_reference_id
                                   AND NOT present_event.absent
                                   AND present_event.observed_at > skald_spec_lifecycle_event.observed_at
                            )
                          ORDER BY observed_at ASC, created_at ASC
                          LIMIT 1`,
                        [
                            project.uuid,
                            input.scope_key,
                            evidence.memo_reference_id,
                            input.run_id,
                            new Date(observedAt.getTime() - MIN_ABSENCE_INTERVAL_MS),
                        ]
                    )
                    firstAbsence = prior[0]
                    if (
                        firstAbsence &&
                        observedAt.getTime() - new Date(firstAbsence.observed_at).getTime() >= TOMBSTONE_GRACE_MS &&
                        evidence.exact_refetch?.outcome === 'absent'
                    ) {
                        disposition = 'tombstoned'
                    }
                }

                const eventId = randomUUID()
                const recordedAt = new Date()
                await em.getConnection().execute(
                    `INSERT INTO skald_spec_lifecycle_event
                        (uuid, project_id, scope_key, memo_reference_id, memo_id, run_id, manifest_hash, absent,
                         disposition, reason, observed_at, exact_refetch_reference_id, exact_refetch_outcome,
                         exact_refetch_certificate_hash, first_absence_run_id, first_absence_observed_at, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        eventId,
                        project.uuid,
                        input.scope_key,
                        evidence.memo_reference_id,
                        rows[0].uuid,
                        input.run_id,
                        input.manifest_hash,
                        evidence.absent,
                        disposition,
                        evidence.reason,
                        observedAt,
                        evidence.exact_refetch?.reference_id || null,
                        evidence.exact_refetch?.outcome || null,
                        evidence.exact_refetch?.certificate_hash || null,
                        firstAbsence?.run_id || null,
                        firstAbsence?.observed_at || null,
                        recordedAt,
                    ]
                )

                const metadata = rows[0].metadata || {}
                const lifecycle = (metadata.spec_lifecycle || {}) as Record<string, unknown>
                const previousHistory = Array.isArray(lifecycle.history) ? lifecycle.history : []
                const lifecycleRecord = {
                    event_id: eventId,
                    disposition,
                    reason: evidence.reason,
                    scope_key: input.scope_key,
                    run_id: input.run_id,
                    manifest_hash: input.manifest_hash,
                    observed_at: observedAt.toISOString(),
                    recorded_at: recordedAt.toISOString(),
                    exact_refetch_certificate_hash: evidence.exact_refetch?.certificate_hash || null,
                    first_absence_run_id: firstAbsence?.run_id || null,
                    first_absence_observed_at: firstAbsence ? new Date(firstAbsence.observed_at).toISOString() : null,
                }
                await em.getConnection().execute(
                    `UPDATE skald_memo SET metadata = ?::jsonb, updated_at = ? WHERE project_id = ? AND uuid = ?`,
                    [
                        JSON.stringify({
                            ...metadata,
                            spec_lifecycle: {
                                ...lifecycle,
                                ...lifecycleRecord,
                                history: [...previousHistory, lifecycleRecord],
                            },
                        }),
                        recordedAt,
                        project.uuid,
                        rows[0].uuid,
                    ]
                )
            }

            await em.flush()
            return { run, promotion: promotionResponse(state, input.scope_key), idempotent_replay: false }
        })
    }

    async promotionStatus(project: Project, scopeKey: string) {
        const state = await this.rootEm.getRepository(SpecPromotionState).findOne({ project, scope_key: scopeKey })
        return promotionResponse(state, scopeKey)
    }

    async recordConflictReview(project: Project, actorId: string, input: ConflictReviewInput) {
        return this.rootEm.transactional(async (em) => {
            if (input.left_claim_id === input.right_claim_id || input.left_revision_id === input.right_revision_id) {
                throw new SpecLifecycleError('INVALID_CLAIM_PAIR', 'Conflict claims and revisions must be distinct', 400)
            }
            if (candidateKey(input.left_claim_id, input.right_claim_id) !== input.candidate_key) {
                throw new SpecLifecycleError('INVALID_CANDIDATE_KEY', 'Candidate key does not identify the submitted claim pair', 409)
            }
            if (input.decision === 'supersede' && !input.supersedes_event_id) {
                throw new SpecLifecycleError('SUPERSEDED_EVENT_REQUIRED', 'Supersede decisions require an earlier event', 400)
            }

            const candidates = await em.getConnection().execute<Array<{
                left_claim_id: string
                right_claim_id: string
                left_revision_id: string
                right_revision_id: string
                left_evidence_hash: string
                right_evidence_hash: string
            }>>(
                `SELECT a.uuid AS left_claim_id, b.uuid AS right_claim_id,
                        a.source_revision_id AS left_revision_id, b.source_revision_id AS right_revision_id,
                        a.evidence_hash AS left_evidence_hash, b.evidence_hash AS right_evidence_hash
                   FROM skald_spec_claim a
                   JOIN skald_spec_source sa ON sa.project_id = a.project_id AND sa.uuid = a.source_id
                       AND sa.active_revision_id = a.source_revision_id
                   JOIN skald_spec_claim b ON b.project_id = a.project_id AND b.uuid = ?
                   JOIN skald_spec_source sb ON sb.project_id = b.project_id AND sb.uuid = b.source_id
                       AND sb.active_revision_id = b.source_revision_id
                  WHERE a.project_id = ? AND a.uuid = ?
                    AND a.source_id <> b.source_id
                    AND a.subject IS NOT DISTINCT FROM b.subject
                    AND a.predicate IS NOT DISTINCT FROM b.predicate
                    AND a.value IS DISTINCT FROM b.value
                    AND a.unit IS NOT DISTINCT FROM b.unit
                    AND a.condition IS NOT DISTINCT FROM b.condition
                    AND a.evidence_hash IS NOT NULL AND b.evidence_hash IS NOT NULL
                    AND jsonb_array_length(a.evidence) > 0 AND jsonb_array_length(b.evidence) > 0
                    AND COALESCE((
                        SELECT lifecycle.disposition FROM skald_spec_lifecycle_event lifecycle
                         WHERE lifecycle.project_id = sa.project_id AND lifecycle.memo_id = sa.memo_id
                         ORDER BY lifecycle.observed_at DESC, lifecycle.created_at DESC LIMIT 1
                    ), 'present') = 'present'
                    AND COALESCE((
                        SELECT lifecycle.disposition FROM skald_spec_lifecycle_event lifecycle
                         WHERE lifecycle.project_id = sb.project_id AND lifecycle.memo_id = sb.memo_id
                         ORDER BY lifecycle.observed_at DESC, lifecycle.created_at DESC LIMIT 1
                    ), 'present') = 'present'`,
                [input.right_claim_id, project.uuid, input.left_claim_id]
            )
            const candidate = candidates[0]
            if (
                !candidate ||
                candidate.left_revision_id !== input.left_revision_id ||
                candidate.right_revision_id !== input.right_revision_id ||
                candidate.left_evidence_hash !== input.left_evidence_hash ||
                candidate.right_evidence_hash !== input.right_evidence_hash
            ) {
                throw new SpecLifecycleError(
                    'STALE_CONFLICT_CANDIDATE',
                    'Conflict candidate is stale, lifecycle-ineligible, unrelated, or has mismatched evidence',
                    409
                )
            }

            if (input.supersedes_event_id) {
                const previous = await em.getRepository(SpecConflictReviewEvent).findOne({
                    project,
                    uuid: input.supersedes_event_id,
                    candidate_key: input.candidate_key,
                })
                if (!previous) throw new SpecLifecycleError('SUPERSEDED_EVENT_NOT_FOUND', 'Superseded event was not found', 404)
                const alreadySuperseded = await em.getRepository(SpecConflictReviewEvent).findOne({
                    project,
                    supersedes_event_id: input.supersedes_event_id,
                })
                if (alreadySuperseded) {
                    throw new SpecLifecycleError('EVENT_ALREADY_SUPERSEDED', 'Conflict review event was already superseded', 409)
                }
            }

            const event = em.getRepository(SpecConflictReviewEvent).create({
                uuid: randomUUID(),
                project,
                candidate_key: input.candidate_key,
                left_claim_id: input.left_claim_id,
                right_claim_id: input.right_claim_id,
                left_revision_id: input.left_revision_id,
                right_revision_id: input.right_revision_id,
                left_evidence_hash: input.left_evidence_hash,
                right_evidence_hash: input.right_evidence_hash,
                actor_id: actorId,
                decision: input.decision,
                reason: input.reason.trim(),
                request_id: randomUUID(),
                supersedes_event_id: input.supersedes_event_id || null,
                created_at: new Date(),
            })
            em.persist(event)
            await em.flush()
            return event
        })
    }

    async conflictReviewHistory(project: Project, candidateKeyValue: string) {
        return this.rootEm.getRepository(SpecConflictReviewEvent).find(
            { project, candidate_key: candidateKeyValue },
            { orderBy: { created_at: 'asc', uuid: 'asc' } }
        )
    }
}
