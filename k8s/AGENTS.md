# KUBERNETES DEPLOYMENT

**Generated:** 2026-04-29
**Domain:** Production Manifests + Deploy Script (Score 16)

## OVERVIEW

Root `k8s/` owns live runtime manifests and deployment orchestration. Worker config/secret source manifests are under `worker/k8s/`, but deploy fallbacks apply them from here.

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| Deploy orchestration | `deploy.sh` | staged apply, secret checks, rollout/readiness |
| Backend API | `api-deployment.yaml`, `api-service.yaml` | Express API pods/service |
| Frontend UI | `ui-deployment.yaml`, `ui-service.yaml`, `ui-nginx-configmap.yaml` | Vite-built UI container and nginx config |
| Memo processing | `memo-processing-deployment.yaml` | async memo processing backend mode |
| Wiki processing | `wiki-processing-deployment.yaml` | `--mode=wiki-processing-server`; requires both wiki flags |
| Worker runtime | `worker-deployment.yaml`, `worker-service.yaml`, `worker-serviceaccount.yaml` | collector worker runtime |
| Worker config fallbacks | `worker-configmap.yaml`, `worker-secret*.yaml` | root fallback consumes `worker/k8s` source intent |
| Embedding service | `embedding-service-*.yaml` | embeddings/rerank/chat proxy microservice |
| Discord bot | `discord-bot-*.yaml` | Discord mention integration deployment/config/secret |
| Datastores | `postgres-*`, `redis-*`, `rabbitmq-*` | PVC-backed stateful dependencies |
| Secrets | `secret.yaml`, `secret.yaml.example`, `secret.local.yaml` | root app secrets; local files ignored |

## CONVENTIONS

- Deployment order is `commit` → `push` → GitHub Actions build 확인 → `./deploy.sh -y`.
- `deploy.sh` still requires root app secret `k8s/secret.yaml`; worker local secret does not satisfy this.
- Local secret manifests (`*.local.yaml`) are preferred for live credentials and must stay ignored.
- Worker Deployment reads `skald-worker-config` and `skald-worker-secrets` via `envFrom`; after live config changes, restart `deployment/skald-worker`.
- `wiki-processing-deployment.yaml` must set both `WIKI_ENABLED=true` and `WIKI_COMPILE_ON_MEMO_PROCESS=true`.
- Mutable image tags require explicit rollout/restart; `kubectl apply` alone may not create new Pods.

## ANTI-PATTERNS

- Never commit real Secret manifests or credentials in tracked templates.
- Do not delete PostgreSQL PVCs during credential repair or undeploy unless explicitly requested for data loss.
- Do not place proxy base URLs in Secret; base URLs belong in ConfigMap, proxy keys in local Secret.
- Do not assume `NOTION_TOKEN` is injected by `deploy.sh`; it must exist in live worker secret/config.
- Do not deploy without resource limits for app/datastore containers.

## NOTES

- GitHub Actions image builds live in `.github/workflows/build-*.yml`.
- Discord bot local secret resolution applies `k8s/discord-bot-secret.local.yaml` before tracked template files.
