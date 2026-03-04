# Skald Worker

Data collection worker for Skald - collects Jira issues and technical documentation, provides RAG endpoints.

## Features

- **Jira Issue Collector**: Periodically syncs Jira issues to Skald
- **Technical Docs Collector**: Periodically syncs technical documentation to Skald
- **RAG Search Endpoint**: Search documents using vector similarity
- **Similar Issues Finder**: Find similar Jira issues for a given issue key
- **RAG Chat Endpoint**: Chat with the RAG system

## Quick Start

### Local Development

1. Copy environment file:

    ```bash
    cp .env.example .env
    ```

2. Edit `.env` with your credentials

3. Install dependencies:

    ```bash
    pip install -e .
    ```

4. Run the server:
    ```bash
    python -m skald_worker.main
    ```

### Docker

```bash
docker build -t skald-worker .
docker run -p 8080:8080 --env-file .env skald-worker
```

### Kubernetes

See [k8s/README.md](k8s/README.md) for deployment instructions.

## API Endpoints

| Endpoint          | Method | Description                        |
| ----------------- | ------ | ---------------------------------- |
| `/health`         | GET    | Health check with scheduler status |
| `/metrics`        | GET    | Prometheus metrics                 |
| `/search`         | POST   | RAG search                         |
| `/similar-issues` | POST   | Find similar Jira issues           |
| `/chat`           | POST   | RAG chat                           |
| `/sync`           | POST   | Manual sync trigger                |

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
```

## Configuration

See [.env.example](.env.example) for all available environment variables.

## Architecture

```
skald-worker/
├── src/skald_worker/
│   ├── api/              # FastAPI routes and schemas
│   ├── clients/          # HTTP clients (Skald API)
│   ├── collectors/       # Data collectors (Jira, Docs)
│   ├── config.py         # Settings from environment
│   ├── scheduler.py      # Background job scheduler
│   └── main.py           # Application entry point
├── k8s/                  # Kubernetes manifests
├── Dockerfile
└── pyproject.toml
```

## License

MIT
