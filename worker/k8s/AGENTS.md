# WORKER KUBERNETES MANIFESTS

**Generated:** 2026-03-09
**Domain:** Worker Deployment (Score 9)

## OVERVIEW

Worker ConfigMap/Secret source manifests live here. Root `k8s/deploy.sh` uses this directory as the fallback source for worker configuration.

## WHERE TO LOOK

| Task                     | Location                                                 | Notes                                  |
| ------------------------ | -------------------------------------------------------- | -------------------------------------- |
| Worker env defaults      | `configmap.yaml`                                         | Non-secret worker runtime settings     |
| Worker credentials       | `secret.yaml`                                            | `skald-worker-secrets` source manifest |
| Standalone worker deploy | `deployment.yaml`, `service.yaml`, `serviceaccount.yaml` | Worker-only Kubernetes apply path      |
| Root deploy integration  | `../../k8s/deploy.sh`                                    | Fallback path consumer                 |

## CONVENTIONS

- Root deploy flow first checks `k8s/worker-configmap.local.yaml`, then `k8s/worker-configmap.yaml`, then this directory's `configmap.yaml`.
- Secret lookup follows the same precedence ending at this directory's `secret.yaml`.
- Root runtime manifests for the worker still live in `k8s/worker-deployment.yaml`, `k8s/worker-service.yaml`, and `k8s/worker-serviceaccount.yaml`.

## ANTI-PATTERNS

- NEVER assume `k8s/worker-configmap.yaml` or `k8s/worker-secret.yaml` exists in the repo root; the tracked fallback source is this directory.
- NEVER update worker config keys in only one place if root `k8s/` deployment docs also reference the same behavior.
