# KUBERNETES DEPLOYMENTS

## OVERVIEW

Kubernetes manifests for all Skald services (API, UI, DB, Redis, RabbitMQ, embeddings).

## WHERE TO LOOK

| Service    | Files                         | Purpose              |
| ---------- | ----------------------------- | -------------------- |
| PostgreSQL | postgres-\*.yaml              | Database             |
| Redis      | redis-\*.yaml                 | Cache                |
| RabbitMQ   | rabbitmq-\*.yaml              | Message queue        |
| API        | api-\*.yaml                   | Backend Express      |
| UI         | ui-\*.yaml                    | Frontend Vite        |
| Embedding  | embedding-service-\*.yaml     | Python embeddings    |
| Docling    | docling-\*.yaml               | Document parsing     |
| Ingress    | ingress.yaml, traefik-\*.yaml | Routing              |
| Config     | configmap.yaml                | Environment vars     |
| Secrets    | secret.yaml.example           | Credentials template |

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

- Traefik as ingress controller
- Routes defined in ingress.yaml

**Scripts**

- `build-ui-for-k8s.sh`: Build UI for K8s
- `deploy.sh`: Full deployment automation

**Documentation**

- `VALIDATION_REPORT.md`: Known issues
- `FIX-SUMMARY.md`: Bug fixes

## ANTI-PATTERNS

- NEVER commit actual secret files
- NEVER skip resource limits in deployments
- NEVER use hardcoded image tags without versioning
