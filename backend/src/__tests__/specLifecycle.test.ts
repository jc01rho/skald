import { readFileSync } from 'fs'
import { join } from 'path'
import { SpecPromotionState, SpecPromotionStatus } from '@/entities/SpecPromotionState'
import { SpecReconciliationRun } from '@/entities/SpecReconciliationRun'

const completedAt = new Date('2026-07-30T13:00:00.000Z')

function run(overrides: Partial<SpecReconciliationRun> = {}): SpecReconciliationRun {
    return Object.assign(new SpecReconciliationRun(), {
        run_id: 'run-1',
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
        started_at: new Date('2026-07-30T12:00:00.000Z'),
        completed_at: completedAt,
        ...overrides,
    })
}

function state(): SpecPromotionState {
    return Object.assign(new SpecPromotionState(), {
        scope_key: 'github:specs',
        created_at: new Date('2026-07-30T12:00:00.000Z'),
        updated_at: new Date('2026-07-30T12:00:00.000Z'),
    })
}

describe('spec lifecycle entities', () => {
    it('recognizes only complete authoritative zero-drift runs as clean', () => {
        expect(run().isCleanAuthoritative()).toBe(true)
        expect(run({ complete: false, completed_at: null, manifest_hash: null }).isCleanAuthoritative()).toBe(false)
        expect(run({ authoritative: false }).isCleanAuthoritative()).toBe(false)
        expect(run({ relation_drift: 1 }).isCleanAuthoritative()).toBe(false)
    })

    it('requires two distinct clean runs before promotion', () => {
        const promotion = state()
        const first = run()

        promotion.applyAuthoritativeRun(first)
        expect(promotion).toMatchObject({
            consecutive_clean_runs: 1,
            previous_clean_run_id: null,
            last_clean_run_id: 'run-1',
            state: SpecPromotionStatus.CANARY_ELIGIBLE,
            promoted_at: null,
        })

        promotion.applyAuthoritativeRun(first)
        expect(promotion.consecutive_clean_runs).toBe(1)

        const second = run({ run_id: 'run-2', completed_at: new Date('2026-07-30T14:00:00.000Z') })
        promotion.applyAuthoritativeRun(second)
        expect(promotion).toMatchObject({
            consecutive_clean_runs: 2,
            previous_clean_run_id: 'run-1',
            last_clean_run_id: 'run-2',
            state: SpecPromotionStatus.PROMOTED,
            promoted_at: second.completed_at,
        })
    })

    it('resets promotion evidence after incomplete or drifting runs and rejects another scope', () => {
        const promotion = state()
        promotion.applyAuthoritativeRun(run())
        promotion.applyAuthoritativeRun(run({ run_id: 'run-2' }))
        promotion.applyAuthoritativeRun(run({ run_id: 'run-3', complete: false, completed_at: null, manifest_hash: null }))

        expect(promotion).toMatchObject({
            consecutive_clean_runs: 0,
            previous_clean_run_id: null,
            last_clean_run_id: null,
            last_clean_completed_at: null,
            state: SpecPromotionStatus.SHADOW,
            promoted_at: null,
        })
        expect(() => promotion.applyAuthoritativeRun(run({ scope_key: 'notion:specs' }))).toThrow(
            'Reconciliation run scope does not match promotion scope'
        )
    })
})

describe('spec lifecycle migration', () => {
    const sql = readFileSync(join(__dirname, '../migrations/Migration20260730130000.ts'), 'utf8')

    it('is additive and project-scopes lifecycle identities and revision pins', () => {
        expect(sql).toContain('create table "skald_spec_reconciliation_run"')
        expect(sql).toContain('skald_spec_reconciliation_run_project_scope_run_id_key')
        expect(sql).toContain('skald_spec_promotion_state_project_scope_key')
        expect(sql).toContain('skald_spec_conflict_review_event_project_request_id_key')
        expect(sql).toContain('foreign key ("project_id", "left_revision_id")')
        expect(sql).toContain('foreign key ("project_id", "right_revision_id")')
        expect(sql).not.toMatch(/drop table[^`]+override async up/)
    })

    it('enforces two distinct clean run identities for represented promotion', () => {
        expect(sql).toContain('skald_spec_promotion_state_two_clean_check')
        expect(sql).toContain('"consecutive_clean_runs" = 2')
        expect(sql).toContain('"last_clean_run_id" <> "previous_clean_run_id"')
    })

    it('makes conflict review events append-only with an update/delete trigger', () => {
        expect(sql).toContain('skald_spec_conflict_review_event_immutable')
        expect(sql).toContain('before update or delete')
        expect(sql).toContain("raise exception 'skald_spec_conflict_review_event is append-only'")
    })
})
