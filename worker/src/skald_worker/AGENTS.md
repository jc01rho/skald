# PYTHON WORKER SERVICE

**Generated:** 2026-01-12
**Domain:** Data Collection Layer (Score 12)

## OVERVIEW

FastAPI worker for external data collection (Jira, docs) with circuit breaker pattern and retry logic.

## STRUCTURE

```
skald_worker/
├── api/           # FastAPI routes + schemas
├── clients/       # External API clients (Skald backend)
├── collectors/    # Data collectors (Jira, docs)
├── middleware/    # Auth middleware
├── main.py        # FastAPI entry point
├── config.py      # Environment config
├── circuit_breaker.py  # Fault tolerance
├── retry.py       # Retry logic
└── errors.py      # Custom exceptions
```

## WHERE TO LOOK

| Task           | Location                     | Notes                    |
| -------------- | ---------------------------- | ------------------------ |
| API routes     | api/routes.py                | FastAPI endpoints        |
| Jira sync      | collectors/jira_collector.py | Jira issue collection    |
| Docs sync      | collectors/docs_collector.py | Documentation collection |
| Backend client | clients/skald.py             | Skald API integration    |
| Auth           | middleware/auth.py           | Request authentication   |

## CONVENTIONS

- **Linting:** Ruff (E, F, I, UP, B, SIM), 120 char lines
- **Circuit Breaker:** Use for external API calls
- **Retry:** Exponential backoff for transient failures
- **Config:** Pydantic settings from environment
- **Testing:** pytest with conftest.py fixtures

## ANTI-PATTERNS

- NEVER call external APIs without circuit breaker
- NEVER skip retry logic for network calls
- NEVER hardcode config values - use config.py
