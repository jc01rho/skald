import { SpecPromotionState, SpecPromotionStatus } from '@/entities/SpecPromotionState'
import { SpecReconciliationRun } from '@/entities/SpecReconciliationRun'
import { SpecLifecycleService } from '@/services/specLifecycleService'
import type { Project } from '@/entities/Project'

const project = { uuid: '11111111-1111-4111-8111-111111111111' } as Project
const TRANSACTION = { transaction: 'manifest-tx' }

// Function specs project onto memos keyed by their function code (e.g. ENTERPRISE-MCP-ANALYZE-FILE),
// while the worker reports lifecycle evidence by canonical spec id (spms:function:<id>).
const specSourceMemos: Record<string, string> = { 'spms:function:1247': 'memo-function-1247' }
const memoReferenceMemos: Record<string, string> = { 'spms:information:1247': 'memo-information-1247' }

function serviceWithMemoLookup() {
    const execute = jest.fn().mockImplementation((sql: string, params: unknown[] = []) => {
        if (!sql.includes('FROM skald_memo')) return Promise.resolve([])
        const referenceId = String(params[1])
        const uuids = new Set<string>()
        if (memoReferenceMemos[referenceId]) uuids.add(memoReferenceMemos[referenceId])
        if (sql.includes('skald_spec_source') && specSourceMemos[referenceId]) uuids.add(specSourceMemos[referenceId])
        return Promise.resolve([...uuids].map((uuid) => ({ uuid, metadata: {} })))
    })
    const state = Object.assign(new SpecPromotionState(), {
        scope_key: 'spms:all',
        state: SpecPromotionStatus.SHADOW,
        consecutive_clean_runs: 0,
        created_at: new Date('2026-09-23T00:00:00.000Z'),
        updated_at: new Date('2026-09-23T00:00:00.000Z'),
    })
    const em = {
        getConnection: () => ({ execute }),
        getTransactionContext: () => TRANSACTION,
        getRepository: (entity: unknown) => ({
            findOne: jest.fn().mockResolvedValue(entity === SpecReconciliationRun ? null : state),
            create: (data: object) => Object.assign(entity === SpecReconciliationRun ? new SpecReconciliationRun() : new SpecPromotionState(), data),
        }),
        persist: jest.fn(),
        flush: jest.fn().mockResolvedValue(undefined),
    }
    const service = new SpecLifecycleService({ transactional: (callback: (tx: typeof em) => unknown) => callback(em) } as any)
    return { service, execute }
}

function manifest(memoReferenceId: string) {
    return {
        run_id: 'run-1',
        scope_key: 'spms:all',
        source_system: 'spms',
        source_type: 'all',
        authoritative: true,
        complete: true,
        manifest_hash: 'a'.repeat(64),
        identity_drift: 0,
        revision_drift: 0,
        authorization_drift: 0,
        relation_drift: 0,
        claim_drift: 0,
        memo_link_drift: 0,
        started_at: new Date('2026-09-23T06:00:00.000Z'),
        completed_at: new Date('2026-09-23T06:30:00.000Z'),
        lifecycle_evidence: [{
            memo_reference_id: memoReferenceId,
            absent: false,
            reason: 'Present in complete authoritative SPMS snapshot',
            observed_at: new Date('2026-09-23T06:30:00.000Z'),
        }],
    }
}

describe('reconciliation lifecycle evidence memo resolution', () => {
    it('resolves function evidence through the canonical spec source projection', async () => {
        const { service, execute } = serviceWithMemoLookup()

        await expect(service.submitManifest(project, manifest('spms:function:1247'))).resolves.toMatchObject({ idempotent_replay: false })

        const insert = execute.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO skald_spec_lifecycle_event'))
        expect(insert?.[1]).toEqual(expect.arrayContaining(['spms:function:1247', 'memo-function-1247']))
    })

    it('still resolves memos whose reference id equals the spec id', async () => {
        const { service, execute } = serviceWithMemoLookup()

        await service.submitManifest(project, manifest('spms:information:1247'))

        const insert = execute.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO skald_spec_lifecycle_event'))
        expect(insert?.[1]).toEqual(expect.arrayContaining(['spms:information:1247', 'memo-information-1247']))
    })

    it('runs every raw statement on the manifest transaction', async () => {
        // Raw execute() without a transaction context runs on a separate pooled connection, so the
        // lifecycle event insert cannot see the uncommitted run row and violates its foreign key.
        const { service, execute } = serviceWithMemoLookup()

        await service.submitManifest(project, manifest('spms:function:1247'))

        expect(execute.mock.calls.length).toBeGreaterThan(0)
        for (const call of execute.mock.calls) {
            expect(call[3]).toBe(TRANSACTION)
        }
    })

    it('keeps rejecting evidence for specs with no projected memo', async () => {
        const { service } = serviceWithMemoLookup()

        await expect(service.submitManifest(project, manifest('spms:function:9999'))).rejects.toMatchObject({ code: 'MEMO_NOT_FOUND' })
    })
})
