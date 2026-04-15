# BACKEND API LAYER

**Generated:** 2026-04-15
**Domain:** Core API (Score 15)

## OVERVIEW

Express route handlers for all REST endpoints, including streaming chat with SSE.

## WHERE TO LOOK

| Endpoint                 | File                 | Purpose                         |
| ------------------------ | -------------------- | ------------------------------- |
| `/api/chat`              | chat.ts              | RAG chat with streaming support |
| `/api/memo`              | memo.ts              | Memo CRUD operations            |
| `/api/auth`              | auth.ts              | Auth (login, signup)            |
| `/api/auth/google`       | googleAuth.ts        | Google OAuth flow               |
| `/api/organization`      | organization.ts      | Multi-tenant management         |
| `/api/project`           | project.ts           | Project CRUD                    |
| `/api/evaluationDataset` | evaluationDataset.ts | Evaluation datasets             |
| `/api/experiment`        | experiment.ts        | A/B testing                     |

## CONVENTIONS

**Route Pattern**

```typescript
export const handlerName = async (req: Request, res: Response) => {
    // Handler logic
    return res.status(200).json({ data })
}
export const router = express.Router({ mergeParams: true })
router.get('/path', [middleware], handlerName)
```

**Middleware Application**

- Array syntax: `[rateLimiter, trackUsage], handler`
- Auth middleware populates `req.context.requestUser`
- Rate limiting: per-endpoint via chatRateLimiter

**Streaming (Chat)**

- SSE headers sent BEFORE RAG graph invocation
- `_setStreamingResponseHeaders()` sets `text/event-stream`
- Response sent immediately: `res.write(': ping\n\n')`

**Error Handling**

```typescript
return res.status(400).json({ error: 'Error message' })
```

**Validation**

- Request body validation via `zod.parse()`
- Filter parsing: `parseFilter()` in lib/filterUtils.ts

**Request Context**

- `req.context.requestUser.userInstance` - Auth user
- `req.context.requestUser.project` - Current project

## ANTI-PATTERNS

- NEVER send SSE headers after invoking async work
- NEVER skip middleware arrays in route definitions
- NEVER return plain objects - always use `res.status().json()`

## LLM ENDPOINT POLICY

- 모든 모델 호출(Gemini 포함)은 **코드 하드코딩 금지**이며, 환경변수(`CLI_PROXY_API_BASE_URL`, `GEMINI_API_BASE_URL`)로만 지정합니다.
- `CLI_PROXY_API_BASE_URL`와 `GEMINI_API_BASE_URL`는 동일한 값을 사용해야 합니다.
