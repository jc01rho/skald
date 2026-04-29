# SKALD WORKER RUNTIME

**Generated:** 2026-04-29
**Domain:** Python Collector Worker (Score 15)

## OVERVIEW

FastAPI-based worker process for source ingestion, scheduled sync, metrics, and Skald backend callbacks.

## STRUCTURE

```text
skald_worker/
├── main.py          # FastAPI app and lifecycle
├── config.py        # pydantic-settings env model
├── scheduler.py     # scheduled sync orchestration
├── sync_state.py    # idempotency/state tracking
├── metrics.py       # Prometheus metrics
├── api/clients/middleware/ # HTTP routes, backend client, auth middleware
├── circuit_breaker.py, retry.py, errors.py # fault tolerance and shared errors
├── collectors/      # Jira/docs/Notion/release/userdata collectors
└── utils/           # Notion block rendering and shared helpers
```

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| Runtime entry | `main.py` | app startup, health, scheduler lifecycle |
| Env settings | `config.py` | pydantic-settings source of truth |
| Scheduling | `scheduler.py` | periodic/bootstrap sync jobs |
| Idempotency | `sync_state.py` | sync state persistence |
| Metrics | `metrics.py` | Prometheus counters/timers |
| Fault tolerance | `circuit_breaker.py`, `retry.py`, `errors.py` | external API resilience |
| Backend client/API | `clients/`, `api/`, `middleware/` | Skald API integration and worker endpoints |
| Collectors | `collectors/` | source-specific ingestion |
| Notion rendering | `utils/notion_blocks.py` | nullable-rich-text-safe Markdown conversion |

## CONVENTIONS

- Run from `worker/` with `uv run python -m skald_worker.main`.
- Test/lint from `worker/`: `uv run pytest`, `uv run ruff check .`.
- Runtime dependencies live in `worker/pyproject.toml` `[project].dependencies`.
- Bootstrap sync checks for empty databases and can trigger full sync on startup.
- `SKALD_BASE_URL` points to backend (`http://api-service:8000` in cluster).
- Notion integration requires target pages/databases to be explicitly shared with the integration.

## ANTI-PATTERNS

- Do not assume private Notion workspace content is visible just because a token exists.
- Do not treat Notion rich_text/text/link/equation fields as non-null.
- Do not store live tokens in tracked `worker/k8s` templates.
- Do not run full pytest without dev/test extras and then treat import failures as product regressions.
