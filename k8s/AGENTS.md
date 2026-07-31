# KUBERNETES DEPLOYMENT

**Generated:** 2026-04-29
**Domain:** Production Manifests + Deploy Script (Score 16)

## OVERVIEW

Root `k8s/` owns live runtime manifests and deployment orchestration. Worker config/secret source manifests are under `worker/k8s/`, but deploy fallbacks apply them from here. Hermes is the production Discord target; the standalone bot remains rollback-only through soak.

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
| Hermes gateway | `hermes-gateway-*`, `hermes-discord-deploy-lease.yaml`, `hermes-deploy-operator-rbac.yaml`, `hermes/` | immutable native Discord gateway, operation mutex, durable recovery |
| Datastores | `postgres-*`, `redis-*`, `rabbitmq-*` | PVC-backed stateful dependencies |
| Secrets | `secret.yaml`, `secret.yaml.example`, `secret.local.yaml` | root app secrets; local files ignored |

## CONVENTIONS

- Deployment order is `commit` → `push` → GitHub Actions build/digest 확인 → export caller-only immutable `HERMES_IMAGE` plus `HERMES_CI_RECEIPT_FILE` → `./deploy.sh -y` with the intended caller-only `HERMES_DEPLOY_MODE` and operator identity where required.
- `deploy.sh` still requires root app secret `k8s/secret.yaml`; worker local secret does not satisfy this.
- Local secret manifests (`*.local.yaml`) are preferred for live credentials and must stay ignored.
- Worker Deployment reads `skald-worker-config` and `skald-worker-secrets` via `envFrom`; after live config changes, restart `deployment/skald-worker`.
- `wiki-processing-deployment.yaml` must set both `WIKI_ENABLED=true` and `WIKI_COMPILE_ON_MEMO_PROCESS=true`.
- Mutable image tags require explicit rollout/restart; `kubectl apply` alone may not create new Pods.
- Hermes Pod argv is exactly `hermes gateway run`; do not add flags, wrappers, compound readiness, or Skald policy-parity gates.
- `HERMES_IMAGE` is a dedicated required `registry/repository@sha256:<64hex>` reference and is independent of legacy `IMAGE_TAG`.
- `ENV_FILE` is strict data-only dotenv with an explicit allowlist: `POSTGRES_DB`, `POSTGRES_USER`, `RABBITMQ_USER`, `UI_DOMAIN`, `API_DOMAIN`, `LLM_PROVIDER`, `CLI_PROXY_API_BASE_URL`, `LLM_DEFAULT_CHAT_MODEL`, `LLM_DEFAULT_CLASSIFICATION_MODEL`, `LLM_FALLBACK_CHAIN`, `EMBEDDING_PROVIDER`, `DOCUMENT_EXTRACTION_PROVIDER`, `EMBEDDING_SERVICE_URL`, `LOCAL_EMBEDDING_MODEL`, `LOCAL_RERANK_MODEL`, `RERANK_PROVIDER`, `QUERY_LANGUAGE`, `EXTERNAL_EMBEDDING_URL`, `INTERNAL_RERANK_URL`, `LOG_LEVEL`. Reject every other key before verifier or Kubernetes access; caller environment remains unaffected. Blank lines, full-line comments, optional `export`, valid identifiers, and unquoted or whole single/double quoted values are supported without shell expansion. `HERMES_IMAGE`, `HERMES_CI_RECEIPT_FILE`, `HERMES_PROVENANCE_BUNDLE`, `HERMES_DEPLOY_MODE`, and `HERMES_DEPLOY_IDENTITY` remain caller-only.
- Candidate receipt, GitHub run/artifact, and GHCR digest verification must complete through the pure `verify-candidate` state command before the first `kubectl` invocation.
- The precreated `skald-discord-deploy-operation` Lease is a non-expiring deploy-operation mutex, not runtime/session fencing. A nonempty or ambiguous operation blocks until privileged audited recovery.
- Durable active-owner and immutable snapshot records are rollback authority; workload existence is not.
- Hermes uses native Discord policy with functional-spec-only `sparrow-function-spec`; its existing credential/TLS/updater/install behavior and current Calico/egress posture are intentionally unchanged accepted risks.
- Never run Hermes and the legacy bot as simultaneous production token owners. Retain legacy manifests/image/config compatibility for rollback through soak.

## ANTI-PATTERNS

- Never commit real Secret manifests or credentials in tracked templates.
- Do not delete PostgreSQL PVCs during credential repair or undeploy unless explicitly requested for data loss.
- Do not place proxy base URLs in Secret; base URLs belong in ConfigMap, proxy keys in local Secret.
- Do not assume `NOTION_TOKEN` is injected by `deploy.sh`; it must exist in live worker secret/config.
- Do not deploy without resource limits for app/datastore containers.
- Never clear or recreate the Hermes operation Lease based on age, Pod state, or an automated retry after `RECOVERY_REQUIRED`.
- Never claim compound readiness, Skald Discord/RAG parity, Discord session exclusivity, MCP hardening, or Calico/egress remediation.

## NOTES

- GitHub Actions image builds live in `.github/workflows/build-*.yml`.
- Discord bot local secret resolution applies `k8s/discord-bot-secret.local.yaml` before tracked template files.
- Hermes image builds live in `.github/workflows/build-hermes-gateway.yml` and publish commit-tagged images resolved to immutable digests; no `latest` tag is published.
