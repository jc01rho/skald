import { createHash } from 'crypto'
import { parseSpecOperationArgs, runSpecOperation, type Queryable } from '@/scripts/specOperationsLib'

const PROJECT = '11111111-1111-4111-8111-111111111111'
class FakeDb implements Queryable {
    calls: string[] = []
    constructor(private readonly responder: (sql: string, params?: unknown[]) => any = () => []) {}
    async execute<T>(sql: string, params?: unknown[]): Promise<T> {
        this.calls.push(sql)
        const value = this.responder(sql, params)
        if (value instanceof Error) throw value
        return value as T
    }
}
function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
    if (value && typeof value === 'object') return `{${Object.keys(value as any).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as any)[key])}`).join(',')}}`
    return JSON.stringify(value)
}
function signed<T extends Record<string, unknown>>(value: T): T & { canonical_digest: string } {
    return { ...value, canonical_digest: createHash('sha256').update(canonical(value)).digest('hex') }
}
function response(body: unknown, status = 200): any {
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body), json: async () => body }
}

describe('spec operations CLI', () => {
    it('parses a bounded global Worker backfill and rejects narrow or resumable flags', () => {
        const parsed = parseSpecOperationArgs(['backfill', '--project-uuid', PROJECT, '--worker-url', 'https://worker.test', '--worker-api-key', 'secret', '--batch-size', '250'])
        expect(parsed).toMatchObject({ operation: 'backfill', scopeKey: 'spms:all', batchSize: 250, dryRun: true, execute: false })
        expect(() => parseSpecOperationArgs(['backfill', '--worker-url', 'https://worker.test'])).toThrow('requires --project-uuid for evidence binding')
        expect(() => parseSpecOperationArgs(['backfill', '--project-uuid', PROJECT, '--scope-key', 'spms:functions'])).toThrow('requires --scope-key spms:all')
        expect(() => parseSpecOperationArgs(['backfill', '--project-uuid', PROJECT, '--source-system', 'spms'])).toThrow('--source-system and --source-type are unsupported')
        expect(() => parseSpecOperationArgs(['backfill', '--project-uuid', PROJECT, '--source-type', 'functions'])).toThrow('--source-system and --source-type are unsupported')
        expect(() => parseSpecOperationArgs(['backfill', '--project-uuid', PROJECT, '--resume'])).toThrow('not resumable')
        expect(() => parseSpecOperationArgs(['backfill', '--project-uuid', PROJECT, '--checkpoint', '/tmp/checkpoint.json'])).toThrow('not resumable')
        expect(() => parseSpecOperationArgs(['promotion-check', '--window', '1h'])).toThrow('Unknown argument')
        expect(() => parseSpecOperationArgs(['backfill', '--project-uuid', PROJECT, '--mode', 'incremental'])).toThrow('unsupported')
    })

    it('returns an explicitly bounded global full_backfill request without mutation on dry-run', async () => {
        const fetchMock = jest.fn()
        const output = await runSpecOperation(new FakeDb(), parseSpecOperationArgs([
            'backfill', '--project-uuid', PROJECT, '--worker-url', 'https://worker.test', '--worker-api-key', 'secret', '--batch-size', '250',
        ]), { fetch: fetchMock as any })
        expect(output.ok).toBe(true)
        expect(output.project_scope).toEqual({ project_uuid: PROJECT, scope_key: 'spms:all', source_system: null, source_type: null })
        expect(output.data).toMatchObject({
            scope: 'global', scope_key: 'spms:all', evidence_binding: { project_uuid: PROJECT, scope_key: 'spms:all' }, executed: false, progress_persisted: false,
            intended_request: { url: 'https://worker.test/sync', body: { source: 'docs', mode: 'full_backfill', options: { max_documents: 250 } } },
        })
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('executes authenticated global backfill without checkpoint persistence', async () => {
        const writeFile = jest.fn()
        const rename = jest.fn()
        const fetchMock = jest.fn().mockResolvedValue(response({ status: 'completed', processed: 4, failed: 0, run_id: '22222222-2222-4222-8222-222222222222' }))
        const output = await runSpecOperation(new FakeDb(), parseSpecOperationArgs([
            'backfill', '--execute', '--project-uuid', PROJECT, '--worker-url', 'https://worker.test', '--worker-api-key', 'secret',
        ]), { fetch: fetchMock as any, writeFile: writeFile as any, rename: rename as any })
        expect(output.ok).toBe(true)
        expect(fetchMock).toHaveBeenCalledWith('https://worker.test/sync', expect.objectContaining({ headers: expect.objectContaining({ 'X-API-Key': 'secret' }) }))
        expect(writeFile).not.toHaveBeenCalled()
        expect(rename).not.toHaveBeenCalled()
        expect(output.data).toMatchObject({ scope: 'global', receipt: { status: 'completed', processed: 4, failed: 0 }, progress_persisted: false })
        expect(output.data).not.toHaveProperty('checkpoint')
    })

    it.each([
        { receipt: { status: 'completed', processed: 4, failed: 1 }, caseName: 'failed work' },
        { receipt: { status: 'incomplete', processed: 4, failed: 0, complete: false }, caseName: 'incomplete work' },
    ])('returns nonzero readiness for $caseName and never persists progress', async ({ receipt }) => {
        const writeFile = jest.fn()
        const fetchMock = jest.fn().mockResolvedValue(response(receipt))
        const output = await runSpecOperation(new FakeDb(), parseSpecOperationArgs([
            'backfill', '--execute', '--project-uuid', PROJECT, '--worker-url', 'https://worker.test', '--worker-api-key', 'secret',
        ]), { fetch: fetchMock as any, writeFile: writeFile as any })
        expect(output.ok).toBe(false)
        expect(output.data).toMatchObject({ scope: 'global', receipt, progress_persisted: false })
        expect(writeFile).not.toHaveBeenCalled()
        expect(output.errors[0]).toContain('no progress was persisted')
    })

    it('triggers authoritative reconciliation only on execute', async () => {
        const fetchMock = jest.fn().mockResolvedValue(response({ status: 'completed', complete: true, run_id: 'run-1', processed: 10 }))
        const output = await runSpecOperation(new FakeDb(), parseSpecOperationArgs([
            'reconcile', '--execute', '--project-uuid', PROJECT, '--worker-url', 'https://worker.test', '--worker-api-key', 'secret', '--mode', 'authoritative',
        ]), { fetch: fetchMock as any })
        expect(output.ok).toBe(true)
        expect(fetchMock).toHaveBeenCalledWith('https://worker.test/sync', expect.objectContaining({ body: expect.stringContaining('authoritative') }))
    })

    it('requires a real signed e2e artifact and rejects unsupported failure stages', async () => {
        const artifact = signed({ kind: 'spec-e2e', project_uuid: PROJECT, ok: true, exit_code: 0 })
        const e2e = await runSpecOperation(new FakeDb(), parseSpecOperationArgs([
            'e2e', '--project-uuid', PROJECT, '--through', 'artifact', '--fixture', '/tmp/e2e.json',
        ]), { readFile: (async () => JSON.stringify(artifact)) as any })
        expect(e2e.ok).toBe(true)
        const failure = await runSpecOperation(new FakeDb(), parseSpecOperationArgs([
            'failure-injection', '--through', 'artifact', '--fixture', '/tmp/failure.json', '--matrix', 'unknown-step',
        ]), { readFile: (async () => '{}') as any })
        expect(failure.ok).toBe(false)
        expect(failure.errors).toContain('Unsupported failure-injection stage requested')
    })

    it('enforces signed, bound, fresh shadow rollout minima', async () => {
        const now = new Date('2026-07-30T12:00:00.000Z')
        const metrics = signed({
            project_uuid: PROJECT, scope_key: 'spms:all', run_id: 'run-2', generated_at: '2026-07-30T11:55:00.000Z',
            window_start: '2026-07-23T11:55:00.000Z', window_end: '2026-07-30T11:55:00.000Z', requests: 10000,
            duration_seconds: 604800, error_rate: 0, mismatch_rate: 0, partial_publish_count: 0, authorization_leak_count: 0,
        })
        const db = new FakeDb((sql) => sql.includes('from skald_spec_promotion_state') ? [{ state: 'promoted' }] : [])
        const output = await runSpecOperation(db, parseSpecOperationArgs([
            'rollout-check', '--project-uuid', PROJECT, '--phase', 'shadow', '--metrics-json', JSON.stringify(metrics),
        ]), { now: () => now })
        expect(output.ok).toBe(true)
    })

    it('rehearses rollback from actual capability and fallback HTTP responses', async () => {
        const fetchMock = jest.fn()
            .mockResolvedValueOnce(response({ 'memo-exact': false }))
            .mockResolvedValueOnce(response({ uuid: 'memo-1' }))
        const output = await runSpecOperation(new FakeDb(), parseSpecOperationArgs([
            'rollback-rehearse', '--execute', '--target', 'legacy', '--feature-flag-disabled', '--fallback-capability', 'memo-exact',
            '--capability-url', 'https://api.test/spec-capabilities', '--fallback-url', 'https://api.test/memos/exact', '--worker-api-key', 'secret',
        ]), { fetch: fetchMock as any })
        expect(output.ok).toBe(true)
        expect(fetchMock).toHaveBeenCalledTimes(2)
        expect(output.data).toMatchObject({ deploy_performed: false, executed: true })
    })
})
