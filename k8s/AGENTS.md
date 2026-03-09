# KUBERNETES DEPLOYMENT

**Generated:** 2026-03-09
**Domain:** Infrastructure (Score 15)

## OVERVIEW

Kubernetes manifests and deployment automation for Skald services. Worker runtime manifests live in `k8s/`, while worker config/secret source manifests live under `worker/k8s/` and are consumed by `deploy.sh` fallback logic.

## WHERE TO LOOK

| Service        | Files                         | Purpose                                  |
| -------------- | ----------------------------- | ---------------------------------------- |
| PostgreSQL     | postgres-\*.yaml              | Database                                 |
| Redis          | redis-\*.yaml                 | Cache                                    |
| RabbitMQ       | rabbitmq-\*.yaml              | Message queue                            |
| Worker runtime | worker-\*.yaml                | Worker deployment/service/serviceaccount |
| Worker config  | `../worker/k8s/*.yaml`        | Worker ConfigMap/Secret fallback source  |
| API            | api-\*.yaml                   | Backend Express                          |
| UI             | ui-\*.yaml                    | Frontend Vite                            |
| Embedding      | embedding-service-\*.yaml     | Python embeddings                        |
| Docling        | docling-\*.yaml               | Document parsing                         |
| Ingress        | ingress.yaml, traefik-\*.yaml | Routing                                  |
| Config         | configmap.yaml                | Environment vars                         |
| Secrets        | secret.yaml.example           | Credentials template                     |

## CONVENTIONS

**Deployment Pattern**

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
    name: service-name
spec:
    replicas: 1
    selector:
        matchLabels:
            app: service-name
    template:
        spec:
            containers:
                - name: service-name
                  image: registry/image:tag
```

**Service Pattern**

```yaml
apiVersion: v1
kind: Service
spec:
    selector:
        app: service-name
    ports:
        - port: 3000
```

**ConfigMaps**

- Environment variables shared across deployments
- Non-sensitive config only

**Secrets**

- Use `.secret.yaml.example` as template
- Create actual `secret.yaml` from template

**Ingress**

- `ingress.yaml` is written for NGINX Ingress
- `deploy.sh` skips Traefik deployment when an existing ingress controller is already present

**Scripts**

- `build-ui-for-k8s.sh`: Build UI for K8s
- `deploy.sh`: Full deployment automation
- `deploy.sh` worker precedence: `worker-configmap.local.yaml` → `worker-configmap.yaml` → `../worker/k8s/configmap.yaml` (secret도 동일)
- RabbitMQ bootstrap credentials: `RABBITMQ_USER`는 ConfigMap, `RABBITMQ_DEFAULT_PASS`/`RABBITMQ_PASSWORD`는 Secret에서 옵니다. 현재 템플릿 기준 self-host/K8s 문서값은 `skald`/`skald`, vhost `/` 입니다.

**Documentation**

- `README.md`: Canonical deployment and ops guide
- `api-url-architecture-design.md`: Durable UI/API routing design reference

## ANTI-PATTERNS

- NEVER commit actual secret files
- NEVER skip resource limits in deployments
- NEVER use hardcoded image tags without versioning
- NEVER 문서에 `skald_user`나 root `k8s/worker-configmap.yaml`를 현재 기본 경로처럼 적지 마세요. 실제 기준은 `RABBITMQ_USER=skald` 와 `worker/k8s` fallback 입니다.

## NOTES

- RabbitMQ 기본 사용자/비밀번호 설정은 신규 노드 bootstrap 시점에만 적용됩니다. PVC가 남아 있으면 브로커 내부 계정은 이전 값일 수 있습니다.
- `k8s/README.md`를 수정할 때는 root `k8s/` 매니페스트와 `worker/k8s/` 원본 문서를 같이 갱신해야 합니다.

## LLM ENDPOINT POLICY

- 모든 모델 호출(Gemini 포함)은 **코드 하드코딩 금지**이며, 환경변수(`CLI_PROXY_API_BASE_URL`, `GEMINI_API_BASE_URL`)로만 지정합니다.
- `CLI_PROXY_API_BASE_URL`와 `GEMINI_API_BASE_URL`는 동일한 값을 사용해야 합니다.
