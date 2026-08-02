# Skald Worker

Data collection worker for Skald. It syncs Jira issues, technical documents, and Notion wiki pages, exposes search/chat helper APIs, and runs background schedulers for ingestion.

## Features

- **Jira issue sync** via scheduled polling and manual `/sync`
- **Technical docs sync** via scheduled daily sync and manual `/sync`
- **Notion wiki sync** via scheduled daily sync and manual `/sync`
- **Search proxy** to the main Skald API
- **Similar issues lookup** based on Jira issue content
- **RAG chat proxy** to the main Skald API

## Quick Start

### Local Development

1. Copy environment file:

    ```bash
    cp .env.example .env
    ```

2. Edit `.env` with your credentials and base URLs.

3. Install dependencies:

    ```bash
    uv sync --extra dev
    ```

4. Run the server on port `8080`:

    ```bash
    uv run python -m skald_worker.main
    ```

### Docker

```bash
docker build -t skald-worker .
docker run -p 8080:8080 --env-file .env skald-worker
```

### Kubernetes

See [k8s/README.md](k8s/README.md) for worker-only manifests and [../k8s/README.md](../k8s/README.md) for the root deployment flow.

## Runtime Behavior

- Jira sync runs every `JIRA_POLL_INTERVAL_MINUTES` when `JIRA_ENABLED=true` and `JIRA_SERVER` is set.
- Docs sync runs daily at `DOCS_SYNC_CRON_HOUR:DOCS_SYNC_CRON_MINUTE` and fetches documents updated within the last `DOCS_SYNC_DAYS` days when `DOCS_ENABLED=true` and `SPMS_BASE_URL` is set.
- Notion sync runs daily at `NOTION_SYNC_CRON_HOUR:NOTION_SYNC_CRON_MINUTE` when `NOTION_ENABLED=true`, `NOTION_TOKEN`, and `NOTION_ROOT_PAGE_ID` are all set.
- The service listens on `HOST` / `PORT` and defaults to `0.0.0.0:8080`.

## API Endpoints

All endpoints are served from the worker process on port `8080`.

| Endpoint          | Method | Description                                      |
| ----------------- | ------ | ------------------------------------------------ |
| `/health`         | GET    | Health check with collector/scheduler/sync state |
| `/metrics`        | GET    | Prometheus metrics                               |
| `/search`         | POST   | Search via Skald backend                         |
| `/similar-issues` | POST   | Find similar Jira issues                         |
| `/chat`           | POST   | Chat via Skald backend                           |
| `/sync`           | POST   | Manual sync trigger for `jira`, `docs`, or `notion` |

### Example: Search

```bash
curl -X POST http://localhost:8080/search \
  -H "Content-Type: application/json" \
  -d '{"query": "database connection error", "limit": 5}'
```

### Example: Find Similar Issues

```bash
curl -X POST http://localhost:8080/similar-issues \
  -H "Content-Type: application/json" \
  -d '{"issue_key": "PROJ-123", "limit": 5}'
```

### Example: Chat

```bash
curl -X POST http://localhost:8080/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "How do I fix database connection issues?"}'
```

### Example: Manual Sync

```bash
# Sync Jira issues
curl -X POST http://localhost:8080/sync \
  -H "Content-Type: application/json" \
  -d '{"source": "jira", "options": {"max_results": 100}}'

# Sync technical docs
curl -X POST http://localhost:8080/sync \
  -H "Content-Type: application/json" \
  -d '{"source": "docs", "options": {"max_documents": 500}}'

# Sync Notion wiki pages
curl -X POST http://localhost:8080/sync \
  -H "Content-Type: application/json" \
  -d '{"source": "notion"}'
```

## Configuration Highlights

See `src/skald_worker/config.py` for the full settings model.

| Variable                     | Purpose                                | Default                                                             |
| ---------------------------- | -------------------------------------- | ------------------------------------------------------------------- |
| `SKALD_BASE_URL`             | Base URL for Skald backend API         | `http://localhost:3000`                                             |
| `SKALD_API_KEY`              | API key used by worker API client      | empty                                                               |
| `SKALD_PROJECT_ID`           | Target project for ingested memos      | empty                                                               |
| `JIRA_SERVER`                | Jira server URL used for API access    | empty                                                               |
| `JIRA_URL`                   | Jira browser URL used for issue links  | empty                                                               |
| `JIRA_JQL_FILTER`            | Default Jira sync filter               | `TYPE IN (인시던트, 장애) AND updated >= -1d ORDER BY updated DESC` |
| `JIRA_POLL_INTERVAL_MINUTES` | Jira sync interval                     | `10`                                                                |
| `SPMS_BASE_URL`              | Technical docs API base URL            | empty                                                               |
| `DOCS_SYNC_CRON_HOUR`        | Daily docs sync hour                   | `3`                                                                 |
| `DOCS_SYNC_CRON_MINUTE`      | Daily docs sync minute                 | `0`                                                                 |
| `DOCS_SYNC_DAYS`             | Docs lookback window in days           | `7`                                                                 |
| `NOTION_ENABLED`             | Enable Notion wiki sync                | `False`                                                             |
| `NOTION_ROOT_PAGE_ID`        | Root Notion page ID to crawl           | empty                                                               |
| `NOTION_SYNC_CRON_HOUR`      | Daily Notion sync hour                 | `1`                                                                 |
| `NOTION_SYNC_CRON_MINUTE`    | Daily Notion sync minute               | `0`                                                                 |
| `WORKER_API_KEY`             | Optional auth key for worker endpoints | empty                                                               |
| `SYNC_STATE_FILE`            | Durable sync state persistence file    | `/var/lib/skald-worker/sync-state.json`                              |

The root production Worker deployment mounts `/var/lib/skald-worker` from the `skald-worker-state` PVC, so successful cursors and authoritative reconciliation manifests survive Pod replacement and Deployment rollouts.
## Architecture

```text
worker/
├── src/skald_worker/
│   ├── api/              # FastAPI routes and schemas
│   ├── clients/          # HTTP clients (Skald API)
│   ├── collectors/       # Data collectors (Jira, Docs, Notion)
│   ├── config.py         # Settings from environment
│   ├── scheduler.py      # Background scheduler
│   └── main.py           # Application entry point
├── k8s/                  # Worker-only Kubernetes manifests
├── Dockerfile
└── pyproject.toml
```

## Known Limitations

- Notion sync currently does not handle deleted or archived pages.
- Notion database blocks are not traversed or queried; only page trees are supported.

## License

MIT
