# DATA COLLECTORS

**Generated:** 2026-04-15
**Domain:** External Data Ingestion (Score 12)

## OVERVIEW

Worker collectors for external data sources (Jira, docs, Notion, release notes, user data). Each collector is a specialized Python module with sync and health check capabilities.

## WHERE TO LOOK

| Collector          | File                    | Source Type          |
| ------------------ | ---------------------- | ------------------- |
| Jira               | jira_collector.py     | Jira REST API       |
| Docs               | docs_collector.py      | HTML/markdown URL  |
| Notion             | notion_collector.py   | Notion API         |
| Release            | release_collector.py   | GitHub releases    |
| User data          | userdata_collector.py | Custom API       |

## CONVENTIONS

- Each collector: `class Collector` with `sync()`, `health()`, `get_source_type()`
- Sync returns `{ processed, failed, skipped }` counts
- Error handling: retry logic + circuit breaker pattern
- Rate limiting via asyncio.Semaphore

## ANTI-PATTERNS

- NEVER hardcode credentials (use config/env)
- NEVER skip error handling in sync loops
- NEVER assume source availability

## LLM ENDPOINT POLICY

- 모든 모델 호출(Gemini 포함)은 **코드 하드코딩 금지**이며, 환경변수(`CLI_PROXY_API_BASE_URL`, `GEMINI_API_BASE_URL`)로만 지정합니다.
- `CLI_PROXY_API_BASE_URL`와 `GEMINI_API_BASE_URL`는 동일한 값을 사용해야 합니다.