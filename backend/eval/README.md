# Retrieval golden set

`golden.json` is a hand-checked set of 30 questions over the production Skald project
`66c94d7d-e530-4b59-837e-efa496c6b265`. Positive questions list the memo UUIDs that must appear in
the top 10; questions with `expected: []` are negatives that must not produce a confident hit.

## Run the live evaluation

From `backend/`:

```bash
export SKALD_API_KEY=...   # project API key; never commit or echo it
NODE_TLS_REJECT_UNAUTHORIZED=0 \
  npx ts-node src/scripts/evalGolden.ts \
    --base-url https://ui.skald.sparrow.local/api/v1 \
    --golden eval/golden.json \
    --out eval/after-YYYY-MM-DD.json \
    --limit 10 \
    --concurrency 1
```

`NODE_TLS_REJECT_UNAUTHORIZED=0` is only needed because the internal host uses a private CA; do not
put it in a committed environment file. `pnpm eval:golden -- ...` is the equivalent script entry.

Reported metrics: recall@1/@3/@10, MRR@10, distinct memos per query, top-1 distance, p95 latency,
and negative queries whose top-1 distance is at or below `--confident-distance` (default `0.5`).

## Baseline

`baseline-2026-11-01.json` was recorded against the production API **before** the answer-quality
changes were deployed. Use it as the comparison point for `after-*.json`.

## Search indexes

The Korean keyword arm uses `to_tsvector('simple', ...)` on chunk content, memo title, and
`metadata->>'search_text'`. Build the supporting GIN indexes after deploy with:

```bash
node dist/scripts/createSearchIndexes.js
```

The script uses `CREATE INDEX CONCURRENTLY IF NOT EXISTS`, so it is safe to run on a live database
and is idempotent.
