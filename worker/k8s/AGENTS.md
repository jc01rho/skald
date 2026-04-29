# WORKER K8S SOURCE MANIFESTS

**Generated:** 2026-04-29
**Domain:** Worker Config/Secret Templates (Score 9)

## OVERVIEW

Worker config/secret local manifest source that root deploy can consume as fallback. Normal runtime Deployment/Service/SA live in root `k8s/`.

## WHERE TO LOOK

| File | Purpose | Notes |
| --- | --- | --- |
| `configmap.local.yaml` | non-secret worker env | feature toggles, backend URL, schedules |
| `secret.local.yaml` | local secret manifest | ignored live credential source |
| `deployment.yaml`, `service.yaml`, `serviceaccount.yaml` | standalone worker apply path | root `k8s/` owns normal runtime deployment |
| local ignored secret files | live credentials | created outside git |

## CONVENTIONS

- Root `k8s/deploy.sh` can apply these manifests as fallbacks.
- Live worker config updates require updating `skald-worker-config`/`skald-worker-secrets` and restarting `deployment/skald-worker`.
- Base URLs and feature toggles belong in ConfigMap; tokens/passwords belong in Secret.

## ANTI-PATTERNS

- Do not add real `NOTION_TOKEN`, Jira token, or backend API keys to tracked files.
- Do not assume root `k8s/worker-secret.local.yaml` and this directory are interchangeable; document which manifest is live.
