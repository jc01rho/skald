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
import { DI } from '@/lib/di'
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
