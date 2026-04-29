# BACKEND API ROUTES

**Generated:** 2026-04-29
**Domain:** Express Route Handlers (Score 13)

## OVERVIEW

Each file owns one API surface. Handlers combine middleware arrays, zod validation, DI repositories/services, and explicit error responses.

## WHERE TO LOOK

| Surface | File | Notes |
| --- | --- | --- |
| Chat/SSE | `chat.ts` | flush SSE headers before async work; preview + references events |
| Public wiki | `publicWiki.ts`, `wiki.ts` | public/shared wiki readers |
| Auth/session | `auth.ts`, `googleAuth.ts` | email/password and Google OAuth login |
| Memo CRUD | `memo.ts` | document/manual memo paths |
| Memo submissions | `memoSubmission.ts` | approved product IDs, preview enrichment, public review |
| Search | `search.ts` | query endpoints and retrieval diagnostics |
| Projects | `project.ts` | project config, API keys, chat UI slug |
| Users/auth | `user.ts`, `emailVerification.ts`, `passwordReset.ts`, `onboarding.ts` | email/password/OAuth/profile setup |
| Admin/config | `admin.ts`, `config.ts`, `health.ts` | runtime/admin checks |
| Billing | `plan.ts`, `subscription.ts`, `stripe_webhook.ts` | plans, usage, Stripe webhook |
| Evaluation | `evaluationDataset.ts`, `experiment.ts` | datasets, experiments, result APIs |
| Jira/docs/notion | `jira.ts`, `docs.ts`, `notion.ts` | source-specific integration APIs |

## CONVENTIONS

- Route exports are `express.Router({ mergeParams: true })` when nested under project/public routes.
- Validate request bodies/query with `zod`; coerce/normalize at API boundary.
- Use DI repositories/services from `backend/src/di.ts`; do not instantiate ORM repositories ad hoc.
- SSE handlers must set/flush headers before retrieval or LLM work starts.
- Chat references must keep exact lookup hits citeable, even if reranking changes order.
- `user_context` accepts only string or plain object; reject arrays and other non-object values with 400.

## ANTI-PATTERNS

- Do not call provider SDKs directly from routes; route → service/agent → `LLMService`.
- Do not accept free-text product IDs for memo submission approval; use allowed `PRODUCT_ID_VALUES`.
- Do not cache chat responses when references are required.
- Do not swallow webhook or upload errors silently; log with `logger` and return explicit status.
