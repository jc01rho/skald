# Skald Worker Kubernetes Manifests

This directory contains the worker-specific Kubernetes manifests used as the fallback config source for the root `k8s/deploy.sh` flow.

## CI/CD

- **Build**: `.github/workflows/build-worker.yml` builds and pushes the worker image used by the main deployment flow.
- There is **no tracked `test-worker.yml` workflow** in this repository right now. Validate locally with `uv sync --extra dev`, `pytest`, and `ruff` as needed.

## Files

- `../../k8s/worker-configmap.yaml` - Tracked, complete non-sensitive production configuration contract
- `secret.local.yaml` - Ignored sensitive credentials, including the required production `WORKER_API_KEY`
- `deployment.yaml` - Standalone worker deployment example
- `service.yaml` - ClusterIP service for worker access
- `serviceaccount.yaml` - Service account for the worker

When the root deployment script `../../k8s/deploy.sh` runs from the repository `k8s/` directory, it uses the tracked `../../k8s/worker-configmap.yaml` fallback or an ignored local replacement. Secret fallback is always an ignored local manifest:

- `../../k8s/worker-configmap.yaml` or `../../k8s/worker-configmap.local.yaml`
- `../../k8s/worker-secret.local.yaml` or `secret.local.yaml`

## Deployment

### 1. Create the namespace if needed

```bash
kubectl create namespace skald
```

### 2. Configure secrets

Create an ignored `secret.local.yaml` (or the root deploy path's ignored `worker-secret.local.yaml`) for credentials. Production must provide `WORKER_API_KEY`; it must also provide `SPMS_API_KEY` when `DOCS_ENABLED=true` and `SPMS_BASE_URL` is configured, unless the non-secret ConfigMap setting `SPMS_AUTH_REQUIRED=false` explicitly identifies an internal unauthenticated SPMS. The worker refuses to start when a required credential is absent or blank. Do not commit the Secret.

```yaml
apiVersion: v1
kind: Secret
metadata:
    name: skald-worker-secrets
    namespace: skald
type: Opaque
stringData:
    WORKER_API_KEY: 'replace-with-a-random-worker-api-key'
    SKALD_API_KEY: 'replace-with-the-skald-api-key'
    SPMS_API_KEY: 'replace-when-docs-spms-is-enabled'
    JIRA_USER: 'replace-when-jira-is-enabled'
    JIRA_PASSWORD: 'replace-when-jira-is-enabled'
    NOTION_TOKEN: 'replace-when-notion-is-enabled'
```

`WORKER_API_KEY` protects `/search`, `/similar-issues`, `/chat`, and the mutating `/sync` route through `X-API-Key`. Health and metrics remain public. Empty authentication is allowed only outside production for local development.

`SPMS_API_KEY` is sent to SPMS as `Authorization: Bearer <key>` by the shared docs collector used for scheduled, manual, and startup synchronization. Keep it only in the ignored Secret. `SPMS_AUTH_REQUIRED` is a non-secret ConfigMap setting whose safe default is `true`; set it to `false` only when the configured production SPMS is an internal endpoint intentionally operating without authentication.

### 3. Configure settings

The tracked `../../k8s/worker-configmap.yaml` is the complete safe base contract used by the normal root deployment fallback. It contains every non-secret URL, identifier, feature toggle, schedule, limit, host/port/log setting, and spec-operation setting consumed by the worker. Applying it therefore cannot erase unrelated base runtime configuration.

`SKALD_BASE_URL` uses the same in-cluster `http://api-service:8000` convention as the existing manifests. Replace the tracked `SKALD_PROJECT_ID` placeholder before production use; the project ID is an identifier, not a credential. Keep all collectors and startup operations disabled until their URLs, identifiers, credentials, and intended scope are configured. Use an ignored `../../k8s/worker-configmap.local.yaml` only as a complete site-specific replacement, because a ConfigMap with the same name replaces the tracked object rather than merging with it.

The standalone manifests in this directory do not include a tracked ConfigMap. Create an ignored `configmap.local.yaml` with the same complete `skald-worker-config` contract when using that path.

Safe collector, reconciliation, and startup defaults are:

```yaml
data:
    JIRA_ENABLED: 'false'
    SPMS_BASE_URL: ''
    SPMS_AUTH_REQUIRED: 'true'
    DOCS_ENABLED: 'false'
    RELEASE_ENABLED: 'false'
    USERDATA_ENABLED: 'false'
    NOTION_ENABLED: 'false'
    DOCS_RECONCILIATION_INTERVAL_HOURS: '24'
    DOCS_RECONCILIATION_GRACE_HOURS: '48'
    SPEC_RECONCILIATION_INTERVAL_SECONDS: '86400'
    SPEC_RECONCILIATION_GRACE_SECONDS: '172800'
    SPEC_STARTUP_BACKFILL_ENABLED: 'false'
    SPEC_STARTUP_AUTHORITATIVE_ENABLED: 'false'
    SPEC_BACKFILL_MAX_DOCUMENTS: '5000'
```

Keep URLs, schedules, limits, identifiers, feature toggles, and `SPMS_AUTH_REQUIRED` in the ConfigMap. Keep `SPMS_API_KEY`, API keys, tokens, passwords, and other credentials in an ignored Secret manifest. Never add `SPMS_API_KEY` to a tracked ConfigMap.

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

1. `worker-configmap.local.yaml`
2. tracked `worker-configmap.yaml`
3. `../worker/k8s/configmap.local.yaml`

It resolves the ignored worker Secret separately as `worker-secret.local.yaml` and then `../worker/k8s/secret.local.yaml`. Production cannot start without a Secret containing a non-empty `WORKER_API_KEY`.

### Applying configuration changes

ConfigMap values imported with `envFrom` are read only when a worker Pod starts. Applying a changed ConfigMap does not update the environment of an existing Pod. After applying the intended root or standalone ConfigMap, restart and observe the rollout:

```bash
kubectl -n skald rollout restart deployment/skald-worker
kubectl -n skald rollout status deployment/skald-worker
```

A restart with both startup flags at their default `false` does not request a startup one-shot. Set `SPEC_STARTUP_BACKFILL_ENABLED=true` only for a deliberate bounded startup backfill. `SPEC_STARTUP_AUTHORITATIVE_ENABLED=true` has effect only when startup backfill is also enabled; keep it false unless that same rollout is explicitly intended to submit authoritative reconciliation evidence. Restore one-shot flags to `false`, apply, and restart again before later routine rollouts.

Scheduled reconciliation remains part of the existing docs scheduler whenever `DOCS_ENABLED=true` and `SPMS_BASE_URL` is configured. `DOCS_RECONCILIATION_INTERVAL_HOURS` is its relative trigger cadence; it is not a wall-clock cron schedule, and restarts reset the next interval-run time. All authoritative runs—including scheduled, manual, and startup runs—use `SPEC_RECONCILIATION_INTERVAL_SECONDS` for minimum clean-observation spacing and `SPEC_RECONCILIATION_GRACE_SECONDS` for minimum absence age before evidence can become tombstone-ready. `DOCS_RECONCILIATION_GRACE_HOURS` remains accepted for deployment compatibility but does not control the authoritative path. None of these settings itself deletes production data.

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

| Variable                                 | Description                                                                    | Default                                                             |
| ---------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| `SKALD_BASE_URL`                         | Skald API base URL                                                             | `http://api-service:8000`                                           |
| `SKALD_API_KEY`                          | Skald API key                                                                  | required                                                            |
| `SKALD_PROJECT_ID`                       | Non-secret project identifier; replace the tracked placeholder before use      | required                                                            |
| `JIRA_SERVER`                            | Jira API base URL used by the collector                                        | optional                                                            |
| `JIRA_URL`                               | Jira browser base URL used for links/metadata                                  | optional                                                            |
| `JIRA_USER`                              | Jira username                                                                  | optional                                                            |
| `JIRA_PASSWORD`                          | Jira password/token                                                            | optional                                                            |
| `JIRA_JQL_FILTER`                        | Default Jira issue filter                                                      | `TYPE IN (인시던트, 장애) AND updated >= -1d ORDER BY updated DESC` |
| `JIRA_POLL_INTERVAL_MINUTES`             | Jira sync interval                                                             | `10`                                                                |
| `JIRA_ENABLED`                           | Enable Jira collector                                                          | `false` in tracked production fallback                              |
| `SPMS_BASE_URL`                          | Non-secret SPMS/docs API URL                                                    | empty in tracked production fallback                                |
| `SPMS_API_KEY`                           | Secret sent to SPMS as an `Authorization: Bearer` credential                    | required from `skald-worker-secrets` when protected docs collection is enabled |
| `SPMS_AUTH_REQUIRED`                     | Require SPMS auth for enabled production docs collection; disable only internally | `true`                                                              |
| `DOCS_ENABLED`                           | Enable docs collector and its scheduled reconciliation                         | `false` in tracked production fallback                              |
| `DOCS_SYNC_CRON_HOUR`                    | Daily incremental docs sync hour                                               | `3`                                                                 |
| `DOCS_SYNC_CRON_MINUTE`                  | Daily incremental docs sync minute                                             | `0`                                                                 |
| `DOCS_SYNC_DAYS`                         | Docs lookback window in days                                                   | `7`                                                                 |
| `RELEASE_ENABLED`                        | Enable SPMS release collector                                                   | `false` in tracked production fallback                              |
| `USERDATA_ENABLED`                       | Enable SPMS userdata collector                                                  | `false` in tracked production fallback                              |
| `DOCS_RECONCILIATION_INTERVAL_HOURS`     | Relative scheduler cadence; restart resets the next interval                    | `24`                                                                |
| `DOCS_RECONCILIATION_GRACE_HOURS`        | Accepted compatibility setting for existing deployments                         | `48`                                                                |
| `SPEC_RECONCILIATION_INTERVAL_SECONDS`   | Minimum clean-observation spacing for all authoritative runs                    | `86400`                                                             |
| `SPEC_RECONCILIATION_GRACE_SECONDS`      | Minimum absence grace for all authoritative runs                                | `172800`                                                            |
| `SPEC_STARTUP_BACKFILL_ENABLED`          | Opt in to a bounded SPMS backfill on worker startup                             | `false`                                                             |
| `SPEC_STARTUP_AUTHORITATIVE_ENABLED`     | Opt in to authoritative reconciliation after an enabled startup backfill       | `false`                                                             |
| `SPEC_BACKFILL_MAX_DOCUMENTS`            | Positive upper bound for documents processed by the startup backfill           | `5000`                                                              |
| `WORKER_CONCURRENCY`                     | Parallel workers                                                               | `4`                                                                 |
| `HOST`                                   | Worker bind host                                                               | `0.0.0.0`                                                           |
| `PORT`                                   | Worker bind port                                                               | `8080`                                                              |
| `LOG_LEVEL`                              | Log level                                                                      | `INFO`                                                              |
| `LOG_FORMAT`                             | Log format (`json` or `console`)                                                | `json`                                                              |
| `ENVIRONMENT`                            | Runtime environment; production enables fail-closed auth validation             | `production` in tracked production fallback                         |
| `WORKER_API_KEY`                         | Secret for `X-API-Key` authentication; required in production                   | required from `skald-worker-secrets`                                 |
