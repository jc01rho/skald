# SHARED UTILITIES

**Generated:** 2026-01-12
**Domain:** Core Utilities (Score 15)

## OVERVIEW

Cross-cutting backend utilities: logging, database/Redis connections, DI, parsing.

## WHERE TO LOOK

| Utility    | File              | Purpose                    |
| ---------- | ----------------- | -------------------------- |
| Logging    | logger.ts         | Pino logger with redaction |
| PostgreSQL | postgresClient.ts | Connection validation      |
| Redis      | redisClient.ts    | Connection validation      |
| Filters    | filterUtils.ts    | Memo filter parsing        |
| Chat       | chatUtils.ts      | Chat message creation      |
| RAG        | ragUtils.ts       | RAG config validation      |
| PostHog    | posthogUtils.ts   | Analytics tracking         |
| DI         | di.ts             | Dependency injection       |

## CONVENTIONS

**Logger**

```typescript
import { logger } from '@/lib/logger'
logger.info({ context }, 'Message')
logger.error({ err }, 'Error message')
```

- Dev: console fallback
- Prod: Pino with automatic redaction

**Connection Validation**

```typescript
await canConnectToPostgres() // Exits on failure
await canConnectToRedis() // Exits on failure
```

**Redaction Paths**

- `password`, `token`, `apiKey`, `authorization`, `cookie`, `stripe_key`

**DI Pattern**

```typescript
import { DI } from '@/di'
const entity = await DI.em.findOne(...)
const service = DI.someService
```

**Utility Functions**

- Pure functions for parsing/validation
- Exported as named functions

## ANTI-PATTERNS

- NEVER use console.log directly (use logger)
- NEVER skip connection validation at startup
- NEVER inline complex parsing logic (use lib utilities)

## LLM ENDPOINT POLICY

- 모든 모델 호출(Gemini 포함)은 **코드 하드코딩 금지**이며, 환경변수(`CLI_PROXY_API_BASE_URL`, `GEMINI_API_BASE_URL`)로만 지정합니다.
- `CLI_PROXY_API_BASE_URL`와 `GEMINI_API_BASE_URL`는 동일한 값을 사용해야 합니다.
