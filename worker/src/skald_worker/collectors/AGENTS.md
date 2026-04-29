# WORKER COLLECTORS

**Generated:** 2026-04-29
**Domain:** Source Ingestion Connectors (Score 13)

## OVERVIEW

Collectors normalize external systems into backend memo/source payloads. Keep source-specific auth, pagination, and retry behavior local to each collector.

## WHERE TO LOOK

| Source | Location | Notes |
| --- | --- | --- |
| Jira | `jira_collector.py` | issue/project ingestion |
| Docs/web | docs collector files | website/document collection |
| Notion | Notion collector files + `../utils/notion_blocks.py` | SDK retries, block rendering |
| Release/user data | release/userdata collector files | release memo surfaces and user content |
| Base/shared | base collector files | common payload contracts |

## CONVENTIONS

- Collector env toggles are modeled in `config.py`; `worker/.env.example` sets `JIRA_ENABLED=false`.
- Notion collector uses internal `tenacity.AsyncRetrying` because shared retry helpers are `httpx`-centric.
- Release memos should include metadata `product_id='sparrow'`, `version`, `release_date`, and a `## 릴리즈 노트` section.
- Source payloads should preserve stable identifiers for idempotent backend updates.

## ANTI-PATTERNS

- Do not copy production secrets into `.env.example` or tracked k8s templates.
- Do not assume Notion response block payloads are fully populated; render nullable fields defensively.
- Do not add a collector without corresponding settings and deployment config review.
- Do not bypass backend memo APIs with direct DB writes from the worker.
