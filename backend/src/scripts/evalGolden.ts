/**
 * Golden-set retrieval evaluation against a live Skald /api/v1/search endpoint.
 *
 * Reports, per query and in aggregate:
 *   - recall@1 / recall@3 / recall@10 (queries with expected memo UUIDs)
 *   - MRR@10 (first expected memo rank)
 *   - distinct memos returned (duplicate-chunk / per-memo domination signal)
 *   - top-1 distance (lower is better; /api/v1/search reports 1 - rerank relevance)
 *   - p95 request latency
 *   - negative queries (expected []): a confident hit is top-1 distance <= threshold
 *
 * Usage (from backend/):
 *   SKALD_API_KEY=... pnpm eval:golden -- \
 *     --base-url https://ui.skald.sparrow.local/api/v1 \
 *     --golden eval/golden.json \
 *     --out eval/baseline-YYYY-MM-DD.json
 *
 * The API key is read from the environment (or --api-key) and is never written to the report.
 */
import * as fs from 'fs'
import * as path from 'path'

interface GoldenQuery {
    id: string
    query: string
    expected: string[]
    titles?: string[]
    negative?: boolean
    notes?: string
}

interface GoldenFile {
    version?: string | number
    project_id?: string
    created_at?: string
    dataset?: string
    queries: GoldenQuery[]
}

interface SearchApiResult {
    chunk_uuid?: string
    memo_uuid: string
    memo_title?: string
    distance: number
}

interface SearchApiResponse {
    results: SearchApiResult[]
}

interface CliOptions {
    baseUrl: string
    apiKey: string
    goldenPath: string
    outPath: string | null
    limit: number
    concurrency: number
    confidentDistance: number
}

const DEFAULT_LIMIT = 10
const DEFAULT_CONCURRENCY = 2
const DEFAULT_CONFIDENT_DISTANCE = 0.5
const REQUEST_RETRIES = 2
const REQUEST_TIMEOUT_MS = 60_000

function parseArgs(argv: string[]): CliOptions {
    const values = new Map<string, string>()
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        if (!arg.startsWith('--')) continue
        const [rawKey, inlineValue] = arg.slice(2).split('=', 2)
        if (inlineValue !== undefined) {
            values.set(rawKey, inlineValue)
        } else {
            const next = argv[i + 1]
            if (next && !next.startsWith('--')) {
                values.set(rawKey, next)
                i++
            }
        }
    }

    const baseUrl = values.get('base-url') ?? process.env.SKALD_BASE_URL ?? ''
    if (!baseUrl) {
        throw new Error('Missing --base-url (or SKALD_BASE_URL)')
    }

    const apiKey = values.get('api-key') ?? process.env.SKALD_API_KEY ?? ''
    if (!apiKey) {
        throw new Error('Missing --api-key (or SKALD_API_KEY)')
    }

    const limit = Number(values.get('limit') ?? DEFAULT_LIMIT)
    const concurrency = Number(values.get('concurrency') ?? DEFAULT_CONCURRENCY)
    const confidentDistance = Number(values.get('confident-distance') ?? DEFAULT_CONFIDENT_DISTANCE)
    if (!Number.isFinite(limit) || limit <= 0) throw new Error('--limit must be a positive number')
    if (!Number.isFinite(concurrency) || concurrency <= 0) throw new Error('--concurrency must be a positive number')
    if (!Number.isFinite(confidentDistance) || confidentDistance < 0 || confidentDistance > 2) {
        throw new Error('--confident-distance must be between 0 and 2')
    }

    return {
        baseUrl,
        apiKey,
        goldenPath: path.resolve(values.get('golden') ?? 'eval/golden.json'),
        outPath: values.get('out') ? path.resolve(values.get('out') as string) : null,
        limit,
        concurrency,
        confidentDistance,
    }
}

function searchEndpoint(baseUrl: string): string {
    const trimmed = baseUrl.replace(/\/+$/, '')
    return trimmed.endsWith('/search') ? trimmed : `${trimmed}/search`
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function searchOnce(endpoint: string, apiKey: string, query: string, limit: number): Promise<SearchApiResult[]> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({ query, limit }),
            signal: controller.signal,
        })
        if (!response.ok) {
            const text = await response.text().catch(() => '')
            throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`)
        }
        const body = (await response.json()) as SearchApiResponse
        if (!Array.isArray(body?.results)) {
            throw new Error('Malformed response: results is not an array')
        }
        return body.results
    } finally {
        clearTimeout(timeout)
    }
}

async function searchWithRetry(
    endpoint: string,
    apiKey: string,
    query: string,
    limit: number
): Promise<{ results: SearchApiResult[]; latencyMs: number }> {
    let lastError: unknown
    for (let attempt = 0; attempt <= REQUEST_RETRIES; attempt++) {
        const startedAt = performance.now()
        try {
            const results = await searchOnce(endpoint, apiKey, query, limit)
            return { results, latencyMs: performance.now() - startedAt }
        } catch (error) {
            lastError = error
            if (attempt < REQUEST_RETRIES) {
                await sleep(1000 * (attempt + 1))
            }
        }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

function recallAt(expected: Set<string>, returnedMemoUuids: string[], k: number): number {
    if (expected.size === 0) return 0
    const topK = returnedMemoUuids.slice(0, k)
    let hits = 0
    for (const memoUuid of expected) {
        if (topK.includes(memoUuid)) hits++
    }
    return hits / expected.size
}

function firstRelevantRank(expected: Set<string>, returnedMemoUuids: string[]): number | null {
    for (let i = 0; i < returnedMemoUuids.length; i++) {
        if (expected.has(returnedMemoUuids[i])) return i + 1
    }
    return null
}

function percentile(values: number[], p: number): number {
    if (values.length === 0) return 0
    const sorted = [...values].sort((a, b) => a - b)
    const rank = Math.ceil((p / 100) * sorted.length)
    return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]
}

function mean(values: number[]): number {
    if (values.length === 0) return 0
    return values.reduce((sum, value) => sum + value, 0) / values.length
}

function round(value: number, digits = 4): number {
    return Number(value.toFixed(digits))
}

async function runPool<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length)
    let nextIndex = 0
    const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (true) {
            const index = nextIndex++
            if (index >= items.length) return
            results[index] = await worker(items[index])
        }
    })
    await Promise.all(runners)
    return results
}

interface PerQueryReport {
    id: string
    query: string
    negative: boolean
    expected: string[]
    latency_ms: number
    result_count: number
    distinct_memos: number
    top_distance: number | null
    first_relevant_rank: number | null
    recall_at_1: number | null
    recall_at_3: number | null
    recall_at_10: number | null
    reciprocal_rank: number | null
    confident_hit: boolean | null
    returned: Array<{ memo_uuid: string; memo_title: string; distance: number }>
    error?: string
}

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2))
    const golden = JSON.parse(fs.readFileSync(options.goldenPath, 'utf-8')) as GoldenFile
    if (!Array.isArray(golden.queries) || golden.queries.length === 0) {
        throw new Error(`No queries found in ${options.goldenPath}`)
    }

    const endpoint = searchEndpoint(options.baseUrl)
    console.log(`Evaluating ${golden.queries.length} golden queries against ${endpoint}`)

    const perQuery = await runPool(golden.queries, options.concurrency, async (query): Promise<PerQueryReport> => {
        const expected = new Set(query.expected ?? [])
        const isNegative = (query.expected ?? []).length === 0
        try {
            const { results, latencyMs } = await searchWithRetry(endpoint, options.apiKey, query.query, options.limit)
            const memoUuids = results.map((result) => result.memo_uuid)
            const distinctMemos = new Set(memoUuids).size
            const topDistance = results.length > 0 ? Number(results[0].distance) : null
            const rank = firstRelevantRank(expected, memoUuids)
            const report: PerQueryReport = {
                id: query.id,
                query: query.query,
                negative: Boolean(query.negative) || isNegative,
                expected: query.expected ?? [],
                latency_ms: round(latencyMs, 1),
                result_count: results.length,
                distinct_memos: distinctMemos,
                top_distance: topDistance === null ? null : round(topDistance, 4),
                first_relevant_rank: rank,
                recall_at_1: isNegative ? null : round(recallAt(expected, memoUuids, 1)),
                recall_at_3: isNegative ? null : round(recallAt(expected, memoUuids, 3)),
                recall_at_10: isNegative ? null : round(recallAt(expected, memoUuids, 10)),
                reciprocal_rank: isNegative ? null : rank === null ? 0 : round(1 / rank),
                confident_hit: isNegative
                    ? topDistance !== null && topDistance <= options.confidentDistance
                    : null,
                returned: results.map((result) => ({
                    memo_uuid: result.memo_uuid,
                    memo_title: result.memo_title ?? '',
                    distance: round(Number(result.distance), 4),
                })),
            }
            const status = isNegative
                ? report.confident_hit
                    ? 'CONFIDENT-HIT'
                    : 'ok'
                : `r@1=${report.recall_at_1} r@3=${report.recall_at_3} r@10=${report.recall_at_10} rr=${report.reciprocal_rank}`
            console.log(`  ${query.id}: ${report.latency_ms}ms ${report.result_count} results, ${status}`)
            return report
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            console.error(`  ${query.id}: ERROR ${message}`)
            return {
                id: query.id,
                query: query.query,
                negative: Boolean(query.negative) || isNegative,
                expected: query.expected ?? [],
                latency_ms: 0,
                result_count: 0,
                distinct_memos: 0,
                top_distance: null,
                first_relevant_rank: null,
                recall_at_1: isNegative ? null : 0,
                recall_at_3: isNegative ? null : 0,
                recall_at_10: isNegative ? null : 0,
                reciprocal_rank: isNegative ? null : 0,
                confident_hit: null,
                returned: [],
                error: message,
            }
        }
    })

    const successful = perQuery.filter((report) => !report.error)
    const positives = successful.filter((report) => !report.negative)
    const negatives = successful.filter((report) => report.negative)
    const latencies = successful.map((report) => report.latency_ms)

    const metrics = {
        'recall@1': round(mean(positives.map((report) => report.recall_at_1 ?? 0))),
        'recall@3': round(mean(positives.map((report) => report.recall_at_3 ?? 0))),
        'recall@10': round(mean(positives.map((report) => report.recall_at_10 ?? 0))),
        'mrr@10': round(mean(positives.map((report) => report.reciprocal_rank ?? 0))),
        mean_distinct_memos: round(mean(successful.map((report) => report.distinct_memos))),
        mean_top_distance: round(
            mean(successful.filter((report) => report.top_distance !== null).map((report) => report.top_distance as number))
        ),
        p95_latency_ms: round(percentile(latencies, 95), 1),
        mean_latency_ms: round(mean(latencies), 1),
        negative_queries: negatives.length,
        negative_confident_hits: negatives.filter((report) => report.confident_hit).length,
        errors: perQuery.filter((report) => report.error).length,
        positive_queries: positives.length,
    }

    const report = {
        schema_version: 1,
        generated_at: new Date().toISOString(),
        base_url: options.baseUrl,
        endpoint,
        limit: options.limit,
        config: {
            concurrency: options.concurrency,
            confident_distance_threshold: options.confidentDistance,
        },
        golden: {
            version: golden.version,
            dataset: golden.dataset,
            created_at: golden.created_at,
            project_id: golden.project_id,
            query_count: golden.queries.length,
        },
        metrics,
        per_query: perQuery,
    }

    console.log('\nAggregate metrics:')
    console.log(JSON.stringify(metrics, null, 2))

    if (options.outPath) {
        fs.mkdirSync(path.dirname(options.outPath), { recursive: true })
        fs.writeFileSync(options.outPath, `${JSON.stringify(report, null, 2)}\n`)
        console.log(`\nWrote ${options.outPath}`)
    } else {
        console.log(`\n${JSON.stringify(report, null, 2)}`)
    }
}

void main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error))
    process.exit(1)
})
