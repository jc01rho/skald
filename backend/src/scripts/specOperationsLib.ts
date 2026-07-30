import { createHash, randomUUID } from 'crypto'
import { readFile, rename, unlink, writeFile } from 'fs/promises'

export const SPEC_OPERATIONS_SCHEMA_VERSION = '1'
export type SpecOperation =
    | 'migration-verify' | 'backfill' | 'relation-repair' | 'reconcile' | 'promotion-check'
    | 'e2e' | 'failure-injection' | 'rollout-check' | 'rollback-rehearse'

export interface CliOptions {
    operation: SpecOperation
    projectUuid: string | null
    sourceSystem: string | null
    sourceType: string | null
    scopeKey: string
    dryRun: boolean
    execute: boolean
    batchSize: number
    requireConsecutiveClean: number
    minGapMinutes: number
    metricsJson: string | null
    metricsFile: string | null
    phase: string | null
    minRequests: number | null
    minDurationSeconds: number | null
    trafficPercent: number | null
    matrix: string[]
    target: string | null
    featureFlagEnabled: boolean | null
    fallbackCapability: string | null
    workerUrl: string | null
    workerApiKey: string | null
    capabilityUrl: string | null
    fallbackUrl: string | null
    fixture: string | null
    through: string | null
    mode: string | null
    output: string | null
}

export interface OperationResult {
    schema_version: string
    run_id: string
    operation: SpecOperation
    project_scope: { project_uuid: string | null; scope_key: string; source_system: string | null; source_type: string | null }
    ok: boolean
    dry_run: boolean
    checks: Array<{ name: string; ok: boolean; details?: unknown }>
    data?: Record<string, unknown>
    errors: string[]
}

type Row = Record<string, any>
export interface Queryable { execute<T = Row[]>(sql: string, params?: unknown[]): Promise<T> }
export interface OperationDependencies {
    fetch: typeof fetch
    readFile: typeof readFile
    writeFile: typeof writeFile
    rename: typeof rename
    unlink: typeof unlink
    now: () => Date
}

const DEFAULT_DEPS: OperationDependencies = { fetch, readFile, writeFile, rename, unlink, now: () => new Date() }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const OPERATIONS = new Set<SpecOperation>([
    'migration-verify', 'backfill', 'relation-repair', 'reconcile', 'promotion-check', 'e2e',
    'failure-injection', 'rollout-check', 'rollback-rehearse',
])

export function asQueryable(connection: { execute(sql: string, params?: unknown[]): Promise<unknown> }): Queryable {
    return { execute: async <T = Row[]>(sql: string, params?: unknown[]) => connection.execute(sql, params) as Promise<T> }
}

function value(argv: string[], index: number, flag: string): string {
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) throw new Error(`${flag} requires a value`)
    return next
}
function positiveInteger(raw: string, flag: string): number {
    const parsed = Number(raw)
    if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer`)
    return parsed
}
function durationSeconds(raw: string, flag: string): number {
    const match = /^(\d+)(s|m|h|d)$/.exec(raw)
    if (!match) throw new Error(`${flag} must use s, m, h, or d (for example 24h)`)
    return Number(match[1]) * ({ s: 1, m: 60, h: 3600, d: 86400 }[match[2]] || 1)
}

export function parseSpecOperationArgs(argv: string[]): CliOptions {
    const operation = argv[0] as SpecOperation
    if (!OPERATIONS.has(operation)) throw new Error(`Unknown spec operation: ${argv[0] || '(missing)'}`)
    const options: CliOptions = {
        operation, projectUuid: null, sourceSystem: null, sourceType: null, scopeKey: 'spms:all', dryRun: true,
        execute: false, batchSize: 100, requireConsecutiveClean: 2, minGapMinutes: 30,
        metricsJson: null, metricsFile: null, phase: null, minRequests: null, minDurationSeconds: null, trafficPercent: null,
        matrix: [], target: null, featureFlagEnabled: null, fallbackCapability: null, workerUrl: process.env.SPEC_WORKER_URL || null,
        workerApiKey: process.env.SPEC_WORKER_API_KEY || null, capabilityUrl: null, fallbackUrl: null,
        fixture: null, through: null, mode: null, output: null,
    }
    for (let i = 1; i < argv.length; i++) {
        const arg = argv[i]
        if (arg === '--') continue
        if (arg === '--dry-run') { options.dryRun = true; options.execute = false; continue }
        if (arg === '--execute') { options.execute = true; options.dryRun = false; continue }
        if (arg === '--resume') {
            if (operation === 'backfill') throw new Error('spec:backfill is not resumable; --resume and checkpoint flags are unsupported')
            throw new Error(`Unknown argument: ${arg}`)
        }
        if (operation === 'backfill' && (arg === '--source-system' || arg === '--source-type')) {
            throw new Error('spec:backfill is global; --source-system and --source-type are unsupported')
        }
        if (operation === 'backfill' && arg === '--checkpoint') {
            throw new Error('spec:backfill is not resumable; --resume and checkpoint flags are unsupported')
        }
        if (arg === '--feature-flag-enabled') { options.featureFlagEnabled = true; continue }
        if (arg === '--feature-flag-disabled') { options.featureFlagEnabled = false; continue }
        const raw = value(argv, i, arg); i++
        if (arg === '--project-uuid') options.projectUuid = raw
        else if (arg === '--source-system') options.sourceSystem = raw
        else if (arg === '--source-type') options.sourceType = raw
        else if (arg === '--scope-key') options.scopeKey = raw
        else if (arg === '--checkpoint') throw new Error(`Unknown argument: ${arg}`)
        else if (arg === '--batch-size') options.batchSize = positiveInteger(raw, arg)
        else if (arg === '--require-consecutive-clean') options.requireConsecutiveClean = positiveInteger(raw, arg)
        else if (arg === '--min-gap-minutes') options.minGapMinutes = positiveInteger(raw, arg)
        else if (arg === '--metrics-json') options.metricsJson = raw
        else if (arg === '--metrics-file') options.metricsFile = raw
        else if (arg === '--phase') options.phase = raw
        else if (arg === '--min-requests') options.minRequests = positiveInteger(raw, arg)
        else if (arg === '--min-duration') options.minDurationSeconds = durationSeconds(raw, arg)
        else if (arg === '--traffic-percent') options.trafficPercent = positiveInteger(raw, arg)
        else if (arg === '--matrix') options.matrix = raw.split(',').map((item) => item.trim()).filter(Boolean)
        else if (arg === '--target') options.target = raw
        else if (arg === '--fallback-capability') options.fallbackCapability = raw
        else if (arg === '--worker-url') options.workerUrl = raw
        else if (arg === '--worker-api-key') options.workerApiKey = raw
        else if (arg === '--capability-url') options.capabilityUrl = raw
        else if (arg === '--fallback-url') options.fallbackUrl = raw
        else if (arg === '--fixture') options.fixture = raw
        else if (arg === '--through') options.through = raw
        else if (arg === '--mode') options.mode = raw
        else if (arg === '--output') options.output = raw
        else throw new Error(`Unknown argument: ${arg}`)
    }
    if (options.projectUuid && !UUID.test(options.projectUuid)) throw new Error('--project-uuid must be a UUID')
    if (options.metricsJson && options.metricsFile) throw new Error('Use only one of --metrics-json or --metrics-file')
    if (operation === 'backfill') {
        if (!options.projectUuid) throw new Error('spec:backfill requires --project-uuid for evidence binding')
        if (options.scopeKey !== 'spms:all') throw new Error('spec:backfill is global and requires --scope-key spms:all')
        if (options.sourceSystem || options.sourceType) throw new Error('spec:backfill is global; --source-system and --source-type are unsupported')
    }
    if (operation === 'relation-repair' && !options.projectUuid) throw new Error('spec:relation:repair requires --project-uuid')
    if (['backfill', 'reconcile', 'rollback-rehearse'].includes(operation) && options.execute && !options.workerApiKey) {
        throw new Error('--execute requires --worker-api-key or SPEC_WORKER_API_KEY')
    }
    if (options.workerUrl) validateHttpUrl(options.workerUrl, '--worker-url')
    if (options.capabilityUrl) validateHttpUrl(options.capabilityUrl, '--capability-url')
    if (options.fallbackUrl) validateHttpUrl(options.fallbackUrl, '--fallback-url')
    if (options.mode && !((operation === 'backfill' && options.mode === 'full_backfill') || (operation === 'reconcile' && options.mode === 'authoritative'))) {
        throw new Error(`--mode ${options.mode} is unsupported for ${operation}`)
    }
    if (options.through && !(['e2e', 'failure-injection'].includes(operation) && options.through === 'artifact')) {
        throw new Error(`--through ${options.through} is unsupported for ${operation}`)
    }
    if (options.fixture && !['e2e', 'failure-injection'].includes(operation)) throw new Error(`--fixture is unsupported for ${operation}`)
    return options
}

function validateHttpUrl(raw: string, flag: string): void {
    let url: URL
    try { url = new URL(raw) } catch { throw new Error(`${flag} must be an absolute HTTP(S) URL`) }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`${flag} must be an absolute HTTP(S) URL`)
}
function result(options: CliOptions): OperationResult {
    return {
        schema_version: SPEC_OPERATIONS_SCHEMA_VERSION, run_id: randomUUID(), operation: options.operation,
        project_scope: { project_uuid: options.projectUuid, scope_key: options.scopeKey, source_system: options.sourceSystem, source_type: options.sourceType },
        ok: true, dry_run: options.dryRun, checks: [], errors: [],
    }
}
function check(out: OperationResult, name: string, ok: boolean, details?: unknown): void {
    out.checks.push({ name, ok, ...(details === undefined ? {} : { details }) })
    if (!ok) out.ok = false
}
async function scalar(db: Queryable, sql: string, params: unknown[] = []): Promise<number> {
    const rows = await db.execute<Row[]>(sql, params)
    return Number(rows[0]?.count || 0)
}
function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
    if (value && typeof value === 'object') return `{${Object.keys(value as Row).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Row)[key])}`).join(',')}}`
    return JSON.stringify(value)
}
function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex') }
async function atomicJson(path: string, payload: unknown, deps: OperationDependencies): Promise<void> {
    const temporary = `${path}.tmp-${randomUUID()}`
    try {
        await deps.writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { flag: 'wx' })
        await deps.rename(temporary, path)
    } catch (error) {
        await deps.unlink(temporary).catch(() => undefined)
        throw error
    }
}

const REQUIRED_TABLES = ['skald_spec_source','skald_spec_revision','skald_spec_relation','skald_spec_claim','skald_spec_reconciliation_run','skald_spec_promotion_state','skald_spec_lifecycle_event','skald_spec_traversal_snapshot','skald_spec_traversal_snapshot_item']
const REQUIRED_CONSTRAINTS = ['skald_spec_source_project_memo_foreign','skald_spec_source_project_active_revision_foreign','skald_spec_revision_project_source_foreign','skald_spec_relation_project_revision_foreign','skald_spec_relation_project_target_foreign','skald_spec_claim_project_revision_foreign','skald_spec_promotion_state_last_clean_run_foreign','skald_spec_lifecycle_event_project_run_foreign']
async function migrationVerify(db: Queryable, options: CliOptions): Promise<OperationResult> {
    const out = result(options)
    const tables = await db.execute<Row[]>(`select tablename from pg_tables where schemaname = current_schema() and tablename = any(?)`, [REQUIRED_TABLES])
    const foundTables = new Set(tables.map((row) => row.tablename))
    check(out, 'required_tables', REQUIRED_TABLES.every((name) => foundTables.has(name)), { missing: REQUIRED_TABLES.filter((name) => !foundTables.has(name)) })
    const constraints = await db.execute<Row[]>(`select conname, convalidated from pg_constraint where conname = any(?)`, [REQUIRED_CONSTRAINTS])
    const foundConstraints = new Map(constraints.map((row) => [row.conname, row.convalidated]))
    check(out, 'required_constraints', REQUIRED_CONSTRAINTS.every((name) => foundConstraints.get(name) === true), { missing_or_unvalidated: REQUIRED_CONSTRAINTS.filter((name) => foundConstraints.get(name) !== true) })
    if (!out.ok) out.errors.push('Required spec schema prerequisites are absent or unvalidated')
    return out
}

function workerRequest(options: CliOptions, mode: 'full_backfill' | 'authoritative'): { url: string; body: Row } {
    if (!options.workerUrl) throw new Error('--worker-url or SPEC_WORKER_URL is required')
    const requestOptions = mode === 'full_backfill'
        ? { max_documents: options.batchSize }
        : { project_uuid: options.projectUuid, scope_key: options.scopeKey, source_system: options.sourceSystem, source_type: options.sourceType, max_documents: options.batchSize }
    return {
        url: `${options.workerUrl.replace(/\/$/, '')}/sync`,
        body: { source: 'docs', mode, options: requestOptions },
    }
}
async function callWorker(options: CliOptions, mode: 'full_backfill' | 'authoritative', deps: OperationDependencies): Promise<Row> {
    const request = workerRequest(options, mode)
    const response = await deps.fetch(request.url, { method: 'POST', headers: { 'content-type': 'application/json', 'X-API-Key': options.workerApiKey! }, body: JSON.stringify(request.body) })
    const text = await response.text()
    let receipt: Row
    try { receipt = JSON.parse(text) } catch { throw new Error(`Worker returned non-JSON HTTP ${response.status}`) }
    if (!response.ok) throw new Error(`Worker HTTP ${response.status}: ${String(receipt.detail || receipt.error || 'request failed')}`)
    return receipt
}
async function backfill(_db: Queryable, options: CliOptions, deps: OperationDependencies): Promise<OperationResult> {
    const out = result(options)
    const request = workerRequest(options, 'full_backfill')
    check(out, 'global_worker_request_valid', Boolean(options.workerApiKey), {
        scope: 'global', scope_key: 'spms:all', bounded_max_documents: options.batchSize,
        url: request.url, authenticated: Boolean(options.workerApiKey), body: request.body,
    })
    if (options.execute) {
        const receipt = await callWorker(options, 'full_backfill', deps)
        const processed = receipt.processed
        const failed = receipt.failed
        if (!Number.isInteger(processed) || processed < 0) throw new Error('Worker receipt processed count is invalid')
        if (!Number.isInteger(failed) || failed < 0) throw new Error('Worker receipt failed count is invalid')
        check(out, 'global_worker_full_backfill_completed', receipt.status === 'completed' && failed === 0 && receipt.complete !== false, receipt)
        out.data = { scope: 'global', scope_key: 'spms:all', evidence_binding: { project_uuid: options.projectUuid, scope_key: options.scopeKey }, intended_request: request, receipt, executed: true, progress_persisted: false }
    } else {
        out.data = { scope: 'global', scope_key: 'spms:all', evidence_binding: { project_uuid: options.projectUuid, scope_key: options.scopeKey }, intended_request: request, executed: false, progress_persisted: false }
    }
    if (!out.ok) out.errors.push('Global Worker full_backfill prerequisites or receipt failed validation; no progress was persisted')
    return out
}

async function relationRepair(db: Queryable, options: CliOptions): Promise<OperationResult> {
    const out = result(options)
    const rows = await db.execute<Row[]>(`select count(*)::text count from skald_spec_relation r where r.project_id=? and r.target_source_id is null and r.unresolved_target_spec_id is not null`, [options.projectUuid])
    const pending = Number(rows[0]?.count || 0)
    let repaired = 0
    if (options.execute) {
        const update = await db.execute<any>(`update skald_spec_relation r set target_source_id=t.uuid, unresolved_target_spec_id=null from skald_spec_source t where r.project_id=? and r.target_source_id is null and r.unresolved_target_spec_id=t.spec_id and t.project_id=r.project_id`, [options.projectUuid])
        repaired = Number(update.rowCount || 0)
    }
    check(out, 'relation_repair_scoped', true, { pending, repaired })
    out.data = { pending, repaired, executed: options.execute }
    return out
}
async function reconcile(_db: Queryable, options: CliOptions, deps: OperationDependencies): Promise<OperationResult> {
    const out = result(options)
    if (!options.projectUuid) { check(out, 'project_scope', false); out.errors.push('--project-uuid is required'); return out }
    const request = workerRequest(options, 'authoritative')
    check(out, 'worker_request_valid', Boolean(options.workerApiKey), { url: request.url, authenticated: Boolean(options.workerApiKey), body: request.body })
    if (options.execute) {
        const receipt = await callWorker(options, 'authoritative', deps)
        check(out, 'authoritative_complete', receipt.status === 'completed' && receipt.complete === true && Boolean(receipt.run_id), receipt)
        out.data = { intended_request: request, receipt, executed: true }
    } else out.data = { intended_request: request, executed: false }
    if (!out.ok) out.errors.push('Worker authoritative reconciliation prerequisites or receipt failed validation')
    return out
}

async function promotionRows(db: Queryable, options: CliOptions): Promise<Row[]> {
    if (!options.projectUuid) return []
    return db.execute<Row[]>(`select state, consecutive_clean_runs, last_clean_run_id, previous_clean_run_id, last_clean_completed_at, promoted_at from skald_spec_promotion_state where project_id=? and scope_key=?`, [options.projectUuid, options.scopeKey])
}
async function promotionCheck(db: Queryable, options: CliOptions): Promise<OperationResult> {
    const out = result(options)
    if (!options.projectUuid) { check(out, 'project_scope', false); out.errors.push('--project-uuid is required'); return out }
    const state = (await promotionRows(db, options))[0]
    check(out, 'promotion_state_present', Boolean(state), state || null)
    check(out, 'consecutive_clean_runs', Number(state?.consecutive_clean_runs || 0) >= options.requireConsecutiveClean)
    const distinct = Boolean(state?.last_clean_run_id && state?.previous_clean_run_id && state.last_clean_run_id !== state.previous_clean_run_id)
    check(out, 'distinct_clean_runs', distinct)
    if (distinct) {
        const runs = await db.execute<Row[]>(`select run_id, completed_at from skald_spec_reconciliation_run where project_id=? and scope_key=? and run_id=any(?)`, [options.projectUuid, options.scopeKey, [state.last_clean_run_id, state.previous_clean_run_id]])
        const times = runs.map((row) => new Date(row.completed_at).getTime()).sort((a, b) => a - b)
        check(out, 'minimum_clean_run_gap', times.length === 2 && times[1] - times[0] >= options.minGapMinutes * 60_000)
    } else check(out, 'minimum_clean_run_gap', false)
    check(out, 'promoted', state?.state === 'promoted', { state: state?.state || null })
    if (!out.ok) out.errors.push('Persisted promotion gate is not satisfied')
    return out
}

async function verifiedArtifact(options: CliOptions, deps: OperationDependencies, kind: string): Promise<Row> {
    if (!options.fixture || options.through !== 'artifact') throw new Error(`${kind} requires --through artifact and --fixture`)
    const artifact = JSON.parse(await deps.readFile(options.fixture, 'utf8')) as Row
    const supplied = artifact.canonical_digest
    const { canonical_digest: _ignored, ...unsigned } = artifact
    if (artifact.kind !== kind || typeof supplied !== 'string' || digest(unsigned) !== supplied) throw new Error(`${kind} artifact kind or canonical digest is invalid`)
    if (options.projectUuid && artifact.project_uuid !== options.projectUuid) throw new Error(`${kind} artifact project binding is invalid`)
    return artifact
}
async function e2e(_db: Queryable, options: CliOptions, deps: OperationDependencies): Promise<OperationResult> {
    const out = result(options)
    const artifact = await verifiedArtifact(options, deps, 'spec-e2e')
    check(out, 'executable_artifact_passed', artifact.ok === true && artifact.exit_code === 0, artifact)
    if (!out.ok) out.errors.push('E2E executable artifact did not pass')
    return out
}
const FAILURE_STAGES = new Set(['memo','publish_revision','publish_relations','publish_claims','publish_outbox','publish_pointer','response_loss'])
async function failureInjection(_db: Queryable, options: CliOptions, deps: OperationDependencies): Promise<OperationResult> {
    const out = result(options)
    const requested = options.matrix.length ? options.matrix : [...FAILURE_STAGES]
    for (const name of requested) if (!FAILURE_STAGES.has(name)) check(out, `failure_${name}`, false, { reason: 'unsupported publish stage' })
    if (!out.ok) { out.errors.push('Unsupported failure-injection stage requested'); return out }
    const artifact = await verifiedArtifact(options, deps, 'spec-failure-injection')
    const stages = artifact.stages as Row
    for (const name of requested) check(out, `failure_${name}`, stages?.[name]?.injected === true && stages?.[name]?.failed_closed === true, stages?.[name] || null)
    if (!out.ok) out.errors.push('One or more publish-stage failure injections did not fail closed')
    return out
}

function finiteMetric(metrics: Row, key: string): number | null {
    const item = metrics[key]
    return typeof item === 'number' && Number.isFinite(item) && item >= 0 ? item : null
}
async function rolloutCheck(db: Queryable, options: CliOptions, deps: OperationDependencies): Promise<OperationResult> {
    const out = result(options)
    if (!options.projectUuid || !options.phase || (!options.metricsJson && !options.metricsFile)) { check(out, 'metrics_input', false); out.errors.push('--project-uuid, --phase, and metrics input are required'); return out }
    if (!['shadow', 'canary'].includes(options.phase)) { check(out, 'phase_allowlist', false, { phase: options.phase }); out.errors.push('Rollout phase must be shadow or canary'); return out }
    let metrics: Row
    try { metrics = JSON.parse(options.metricsJson || await deps.readFile(options.metricsFile!, 'utf8')) } catch (error) { check(out, 'metrics_json', false, String(error)); out.errors.push('Metrics input is not valid JSON'); return out }
    const suppliedDigest = metrics.canonical_digest
    const { canonical_digest: _ignored, ...unsigned } = metrics
    check(out, 'canonical_digest', typeof suppliedDigest === 'string' && digest(unsigned) === suppliedDigest)
    check(out, 'artifact_binding', metrics.project_uuid === options.projectUuid && metrics.scope_key === options.scopeKey && typeof metrics.run_id === 'string' && metrics.run_id.length > 0)
    const generated = Date.parse(metrics.generated_at)
    const windowStart = Date.parse(metrics.window_start)
    const windowEnd = Date.parse(metrics.window_end)
    const now = deps.now().getTime()
    check(out, 'timestamp_freshness', Number.isFinite(generated) && Number.isFinite(windowStart) && Number.isFinite(windowEnd) && windowStart < windowEnd && windowEnd <= generated && generated <= now && now - generated <= 15 * 60_000)
    const required = ['requests','duration_seconds','error_rate','mismatch_rate','partial_publish_count','authorization_leak_count']
    const valid = required.every((key) => finiteMetric(metrics, key) !== null)
    check(out, 'numeric_metrics_complete', valid, { required })
    if (!valid) { out.errors.push('Required numeric rollout metrics are absent or invalid'); return out }
    const planRequests = options.phase === 'shadow' ? 10_000 : 1_000
    const planDuration = options.phase === 'shadow' ? 7 * 86400 : 24 * 3600
    const requiredRequests = Math.max(planRequests, options.minRequests || 0)
    const requiredDuration = Math.max(planDuration, options.minDurationSeconds || 0)
    check(out, 'minimum_requests', metrics.requests >= requiredRequests, { actual: metrics.requests, required: requiredRequests })
    check(out, 'minimum_duration', metrics.duration_seconds >= requiredDuration && (windowEnd - windowStart) / 1000 >= requiredDuration, { required: requiredDuration })
    check(out, 'error_rate', metrics.error_rate <= 0.01)
    check(out, 'mismatch_rate', metrics.mismatch_rate <= 0.001)
    check(out, 'partial_publish_zero', metrics.partial_publish_count === 0)
    check(out, 'authorization_leak_zero', metrics.authorization_leak_count === 0)
    if (options.phase === 'canary') check(out, 'traffic_percent', options.trafficPercent === 5 && metrics.traffic_percent === 5, { required: 5 })
    const promotion = (await promotionRows(db, options))[0]
    check(out, 'persisted_promotion', promotion?.state === 'promoted')
    if (!out.ok) out.errors.push('Rollout gate failed')
    return out
}

async function rollbackRehearse(_db: Queryable, options: CliOptions, deps: OperationDependencies): Promise<OperationResult> {
    const out = result(options)
    check(out, 'legacy_target', options.target === 'legacy')
    check(out, 'flag_disabled', options.featureFlagEnabled === false)
    check(out, 'fallback_capability_supplied', Boolean(options.fallbackCapability))
    if (!options.capabilityUrl || !options.fallbackUrl) { check(out, 'http_prerequisites', false); out.errors.push('--capability-url and --fallback-url are required'); return out }
    if (!options.execute) {
        check(out, 'authenticated_http_plan', Boolean(options.workerApiKey), { capability_url: options.capabilityUrl, fallback_url: options.fallbackUrl })
        out.data = { deploy_performed: false, executed: false }
        return out
    }
    const headers = { 'X-API-Key': options.workerApiKey! }
    const capabilityResponse = await deps.fetch(options.capabilityUrl, { headers })
    const capability = await capabilityResponse.json() as Row
    const nativeDisabled = capabilityResponse.ok && capability[options.fallbackCapability!] === false
    check(out, 'native_capability_disabled', nativeDisabled, capability)
    const fallbackResponse = await deps.fetch(options.fallbackUrl, { headers })
    check(out, 'fallback_http_available', fallbackResponse.ok, { status: fallbackResponse.status })
    out.data = { deploy_performed: false, executed: true, capability_status: capabilityResponse.status, fallback_status: fallbackResponse.status }
    if (!out.ok) out.errors.push('Rollback capability/fallback HTTP rehearsal failed')
    return out
}

async function dispatch(db: Queryable, options: CliOptions, deps: OperationDependencies): Promise<OperationResult> {
    if (options.operation === 'migration-verify') return migrationVerify(db, options)
    if (options.operation === 'backfill') return backfill(db, options, deps)
    if (options.operation === 'relation-repair') return relationRepair(db, options)
    if (options.operation === 'reconcile') return reconcile(db, options, deps)
    if (options.operation === 'promotion-check') return promotionCheck(db, options)
    if (options.operation === 'e2e') return e2e(db, options, deps)
    if (options.operation === 'failure-injection') return failureInjection(db, options, deps)
    if (options.operation === 'rollout-check') return rolloutCheck(db, options, deps)
    return rollbackRehearse(db, options, deps)
}
export async function runSpecOperation(db: Queryable, options: CliOptions, overrides: Partial<OperationDependencies> = {}): Promise<OperationResult> {
    const deps = { ...DEFAULT_DEPS, ...overrides }
    let out: OperationResult
    try { out = await dispatch(db, options, deps) } catch (error) {
        out = result(options); out.ok = false; out.errors.push(error instanceof Error ? error.message : String(error))
    }
    if (options.output) {
        try { await atomicJson(options.output, out, deps) } catch (error) {
            out.ok = false; out.errors.push(`Failed to write output atomically: ${error instanceof Error ? error.message : String(error)}`)
        }
    }
    return out
}
