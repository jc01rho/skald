# BACKEND LIBRARY UTILITIES

**Generated:** 2026-04-29
**Domain:** Infrastructure + Retrieval Helpers (Score 13)

## OVERVIEW

Shared backend helpers cover logging, persistence, auth utilities, retrieval/scoring, queues, caching, and usage metering.

## WHERE TO LOOK

| Area | Files | Notes |
| --- | --- | --- |
| Logging/errors | `logger.ts`, `errors.ts` | structured logging and typed failures |
| DB/cache | `postgresClient.ts`, `redisClient.ts`, `ragCache.ts` | PostgreSQL/Redis connectivity and RAG cache |
| Retrieval | `fastRetrieve.ts`, `searchGraph.ts`, `referenceResults.ts`, `retrievalValidator.ts`, `hnswOptimization.ts` | search graph, preview retrieval, validation |
| Scoring/ranking | `scoringService.ts`, `searchRanking.ts`, `selfRagEvaluator.ts`, `contextReorder.ts`, `ragMetrics.ts`, `complexityCalculator.ts` | quality and context ordering |
| Query helpers | `queryNormalization.ts`, `queryRouter.ts`, `keyExtractor.ts`, `languageDetector.ts` | release/error-code and routing normalization |
| Memo processing | `createMemoUtils.ts`, `chunkProcessor.ts`, `memoSourceUrl.ts`, `memoStatusUtils.ts`, `lazyReprocessService.ts` | content creation/reprocessing |
| Auth/user | `passwordUtils.ts`, `googleOAuthUtils.ts`, `emailUtils.ts`, `tokenUtils.ts` | login, OAuth, mail, tokens |
| Storage/queues | `s3Utils.ts`, `sqsClient.ts`, `wikiQueueClient.ts`, `asyncUtils.ts` | object storage and async queues |
| Usage | `usageTrackingUtils.ts`, `usageAlertEmail.ts`, `embeddingVersion.ts`, `hashUtils.ts` | billing, alerts, embedding/hash metadata |

## CONVENTIONS

- `logger` is the only logging surface; no `console.log`.
- Query normalization should add variants while preserving the original query.
- Reference assembly must merge exact-lookup hits with reranked results so cited evidence remains available.
- Wiki traversal DB reads use forked MikroORM `EntityManager` when outside request context.
- Hash/idempotency helpers should gate expensive processing before queue enqueue.

## ANTI-PATTERNS

- Do not make provider SDK calls from `lib/`; model calls belong in services/agents via `LLMService`.
- Do not make cache hits bypass reference-required chat requests.
- Do not assume vector index settings are safe for every collection; keep HNSW tuning explicit.
- Do not introduce new queue clients without documenting deployment env/config implications.
