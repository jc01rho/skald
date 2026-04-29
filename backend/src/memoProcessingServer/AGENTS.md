# MEMO PROCESSING SERVER

**Generated:** 2026-04-29
**Domain:** Async Memo/Wiki Processing (Score 12)

## OVERVIEW

Dedicated backend mode for memo-processing workers, queue consumers, and source-specific async agents.

## WHERE TO LOOK

| Task | File | Notes |
| --- | --- | --- |
| Server entry | `index` imports via `backend/src/index.ts --mode=memo-processing-server` | process mode selected at root index |
| Memo processing | `processMemo.ts` | memo content processing, wiki refresh enqueue hooks |
| RabbitMQ consumer | `rabbitMqConsumer.ts` | `MemoMessage`, `runRabbitMQConsumer`, connection lifecycle |
| Source agents | `agents/` | async source-specific handlers |

## CONVENTIONS

- Queue consumers must fork/request their own MikroORM context when running outside HTTP request scope.
- `processMemo.ts` enqueues wiki refresh via `enqueueRefreshForMemo()` and wakes queue mode with batch ticks.
- RabbitMQ self-host templates default to user/password `skald` and vhost `/` only for new-node bootstrap.
- Processing must be idempotent around unchanged memo inputs and file hashes.

## ANTI-PATTERNS

- Do not assume queue workers share Express request context.
- Do not delete PostgreSQL/RabbitMQ PVCs while repairing credentials or processing state.
- Do not swallow consumer failures; log and nack/retry according to queue semantics.
