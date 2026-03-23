# Skald Worker Kubernetes Manifests

This directory contains the worker-specific Kubernetes manifests used as the fallback config source for the root `k8s/deploy.sh` flow.

## CI/CD

- **Build**: `.github/workflows/build-worker.yml` builds and pushes the worker image used by the main deployment flow.
- There is **no tracked `test-worker.yml` workflow** in this repository right now. Validate locally with `uv sync --extra dev`, `pytest`, and `ruff` as needed.

## Files

- `configmap.yaml` - Non-sensitive runtime configuration
- `secret.yaml` - Sensitive credentials and external system secrets
- `deployment.yaml` - Standalone worker deployment example
- `service.yaml` - ClusterIP service for worker access
- `serviceaccount.yaml` - Service account for the worker

When the root deployment script `../../k8s/deploy.sh` runs from the repository `k8s/` directory, it uses this directory as the fallback source for worker configuration:

- `../worker/k8s/configmap.yaml`
- `../worker/k8s/secret.yaml`

## Deployment

### 1. Create the namespace if needed

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
```

### 3. Configure settings

Edit `configmap.yaml` as needed:

```yaml
data:
    SKALD_BASE_URL: 'http://api-service:8000'
    SKALD_PROJECT_ID: 'your-project-id'
    JIRA_JQL_FILTER: 'TYPE IN (인시던트, 장애) AND updated >= -1d ORDER BY updated DESC'
    JIRA_POLL_INTERVAL_MINUTES: '10'
    JIRA_URL: 'https://jira.example.com'
    DOCS_SYNC_CRON_HOUR: '3'
    DOCS_SYNC_CRON_MINUTE: '0'
    DOCS_SYNC_DAYS: '7'
    HOST: '0.0.0.0'
    PORT: '8080'
```

### 4. Build and push the Docker image

```bash
cd worker
docker build -t your-registry/skald-worker:latest .
docker push your-registry/skald-worker:latest
```

Then update the image in `deployment.yaml` before applying it.

### 5. Apply manifests from this directory

If you are inside `worker/k8s/`:

```bash
kubectl apply -f .
```

If you are at the repository root:

```bash
kubectl apply -f worker/k8s/
```

If you are deploying through the root `k8s/` directory instead, `k8s/deploy.sh` resolves worker config in this order:

1. `worker-configmap.local.yaml` / `worker-secret.local.yaml`
2. `worker-configmap.yaml` / `worker-secret.yaml`
3. `../worker/k8s/configmap.yaml` / `../worker/k8s/secret.yaml`

### 6. Verify deployment

```bash
kubectl -n skald get pods -l app=skald-worker
kubectl -n skald logs -l app=skald-worker -f
```

## Endpoints

The standalone worker manifests expose port `8080`.

| Endpoint          | Method | Description              |
| ----------------- | ------ | ------------------------ |
| `/health`         | GET    | Health check             |
| `/metrics`        | GET    | Prometheus metrics       |
| `/search`         | POST   | RAG search               |
| `/similar-issues` | POST   | Find similar Jira issues |
| `/chat`           | POST   | RAG chat                 |
| `/sync`           | POST   | Manual sync trigger      |

## Prometheus Integration

The deployment includes these annotations:

```yaml
annotations:
    prometheus.io/scrape: 'true'
    prometheus.io/port: '8080'
    prometheus.io/path: '/metrics'
```

## Configuration

### Environment Variables

| Variable                     | Description                                   | Default                                                             |
| ---------------------------- | --------------------------------------------- | ------------------------------------------------------------------- |
| `SKALD_BASE_URL`             | Skald API base URL                            | `http://api-service:8000`                                           |
| `SKALD_API_KEY`              | Skald API key                                 | required                                                            |
| `SKALD_PROJECT_ID`           | Skald project ID                              | required                                                            |
| `JIRA_SERVER`                | Jira API base URL used by the collector       | optional                                                            |
| `JIRA_URL`                   | Jira browser base URL used for links/metadata | optional                                                            |
| `JIRA_USER`                  | Jira username                                 | optional                                                            |
| `JIRA_PASSWORD`              | Jira password/token                           | optional                                                            |
| `JIRA_JQL_FILTER`            | Default Jira issue filter                     | `TYPE IN (인시던트, 장애) AND updated >= -1d ORDER BY updated DESC` |
| `JIRA_POLL_INTERVAL_MINUTES` | Jira sync interval                            | `10`                                                                |
| `JIRA_ENABLED`               | Enable Jira collector                         | `true`                                                              |
| `SPMS_BASE_URL`              | SPMS/docs API URL                             | optional                                                            |
| `DOCS_ENABLED`               | Enable docs collector                         | `true`                                                              |
| `DOCS_SYNC_CRON_HOUR`        | Daily docs sync hour                          | `3`                                                                 |
| `DOCS_SYNC_CRON_MINUTE`      | Daily docs sync minute                        | `0`                                                                 |
| `DOCS_SYNC_DAYS`             | Docs lookback window in days                  | `7`                                                                 |
| `WORKER_CONCURRENCY`         | Parallel workers                              | `4`                                                                 |
| `HOST`                       | Worker bind host                              | `0.0.0.0`                                                           |
| `PORT`                       | Worker bind port                              | `8080`                                                              |
| `LOG_LEVEL`                  | Log level                                     | `INFO`                                                              |
| `LOG_FORMAT`                 | Log format (`json` or `console`)              | `json`                                                              |
