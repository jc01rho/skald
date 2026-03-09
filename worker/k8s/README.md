# Skald Worker Kubernetes Manifests

This directory contains Kubernetes manifests for deploying the Skald Worker service.

## CI/CD

The worker service has automated CI/CD via GitHub Actions:

- **Test**: `.github/workflows/test-worker.yml` - Runs Ruff linting and pytest tests on every push/PR
- **Build**: `.github/workflows/build-worker.yml` - Builds and pushes Docker image to GHCR

## Files

- `configmap.yaml` - Non-sensitive configuration
- `secret.yaml` - Sensitive credentials (API keys, passwords)
- `deployment.yaml` - Worker deployment specification
- `service.yaml` - Kubernetes service for internal access
- `serviceaccount.yaml` - Service account for the worker

When the root deployment script `../k8s/deploy.sh` runs from the repository `k8s/` directory, it uses these files as the fallback source for worker configuration:

- `../worker/k8s/configmap.yaml`
- `../worker/k8s/secret.yaml`

## Deployment

### 1. Create the namespace (if not exists)

```bash
kubectl create namespace skald
```

### 2. Configure secrets

Edit `secret.yaml` and fill in your credentials:

```yaml
stringData:
    SKALD_API_KEY: 'your-skald-api-key'
    JIRA_SERVER: 'https://jira.example.com'
    JIRA_USER: 'your-jira-username'
    JIRA_PASSWORD: 'your-jira-password-or-token'
    SPMS_BASE_URL: 'https://docs.example.com'
    SPMS_API_KEY: 'your-docs-api-key'
```

### 3. Configure settings

Edit `configmap.yaml` as needed:

```yaml
data:
    SKALD_BASE_URL: 'http://api-service:8000'
    SKALD_PROJECT_ID: 'your-project-id'
    JIRA_JQL_FILTER: 'project = PROJ AND updated >= -1d ORDER BY updated DESC'
    JIRA_POLL_INTERVAL_MINUTES: '10'
```

### 4. Build and push the Docker image

```bash
cd worker
docker build -t your-registry/skald-worker:latest .
docker push your-registry/skald-worker:latest
```

Update the image in `deployment.yaml`:

```yaml
image: your-registry/skald-worker:latest
```

### 5. Apply manifests

```bash
kubectl apply -f k8s/
```

If you are deploying from the repository root `k8s/` directory instead of this directory, `k8s/deploy.sh` resolves worker config in this order:

1. `worker-configmap.local.yaml` / `worker-secret.local.yaml`
2. `worker-configmap.yaml` / `worker-secret.yaml`
3. `../worker/k8s/configmap.yaml` / `../worker/k8s/secret.yaml`

### 6. Verify deployment

```bash
kubectl -n skald get pods -l app=skald-worker
kubectl -n skald logs -l app=skald-worker -f
```

## Endpoints

The worker exposes the following endpoints on port 8080:

| Endpoint          | Method | Description              |
| ----------------- | ------ | ------------------------ |
| `/health`         | GET    | Health check             |
| `/metrics`        | GET    | Prometheus metrics       |
| `/search`         | POST   | RAG search               |
| `/similar-issues` | POST   | Find similar Jira issues |
| `/chat`           | POST   | RAG chat                 |
| `/sync`           | POST   | Manual sync trigger      |

## Prometheus Integration

The worker exposes Prometheus metrics at `/metrics`. To enable scraping, the deployment includes annotations:

```yaml
annotations:
    prometheus.io/scrape: 'true'
    prometheus.io/port: '8080'
    prometheus.io/path: '/metrics'
```

### Available Metrics

| Metric                                       | Type      | Description                                     |
| -------------------------------------------- | --------- | ----------------------------------------------- |
| `skald_worker_http_requests_total`           | Counter   | Total HTTP requests by method, endpoint, status |
| `skald_worker_http_request_duration_seconds` | Histogram | HTTP request duration                           |
| `skald_worker_external_api_calls_total`      | Counter   | External API calls by service, endpoint, status |
| `skald_worker_sync_jobs_total`               | Counter   | Sync jobs by source and status                  |
| `skald_worker_sync_items_processed_total`    | Counter   | Items processed during sync                     |
| `skald_worker_search_requests_total`         | Counter   | Search requests by status                       |
| `skald_worker_chat_requests_total`           | Counter   | Chat requests by status                         |

## Configuration

### Environment Variables

| Variable                     | Description               | Default                                |
| ---------------------------- | ------------------------- | -------------------------------------- |
| `SKALD_BASE_URL`             | Skald API base URL        | `http://api-service:8000`              |
| `SKALD_API_KEY`              | Skald API key             | (required)                             |
| `SKALD_PROJECT_ID`           | Skald project ID          | (required)                             |
| `JIRA_SERVER`                | Jira server URL           | (optional)                             |
| `JIRA_USER`                  | Jira username             | (optional)                             |
| `JIRA_PASSWORD`              | Jira password/token       | (optional)                             |
| `JIRA_JQL_FILTER`            | JQL query for issues      | `updated >= -1d ORDER BY updated DESC` |
| `JIRA_POLL_INTERVAL_MINUTES` | Jira sync interval        | `10`                                   |
| `JIRA_ENABLED`               | Enable Jira collector     | `true`                                 |
| `SPMS_BASE_URL`              | SPMS/docs API URL         | (optional)                             |
| `SPMS_API_KEY`               | SPMS API key              | (optional)                             |
| `DOCS_POLL_INTERVAL_MINUTES` | Docs sync interval        | `30`                                   |
| `DOCS_ENABLED`               | Enable docs collector     | `true`                                 |
| `WORKER_CONCURRENCY`         | Parallel workers          | `4`                                    |
| `LOG_LEVEL`                  | Log level                 | `INFO`                                 |
| `LOG_FORMAT`                 | Log format (json/console) | `json`                                 |
