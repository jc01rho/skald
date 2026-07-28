# Skald Kubernetes 배포 가이드

이 문서는 Skald 애플리케이션을 온프레미스 Kubernetes 클러스터에 배포하는 방법을 안내합니다.

## 검증 상태

이 문서는 현재 배포 절차와 운영 기준을 유지하는 **정본 문서**입니다. 일회성 수정 보고서/중간 산출물 문서는 저장소 정리 과정에서 제거될 수 있으므로, 최신 배포 검증 기준은 본 README와 각 매니페스트를 기준으로 확인하세요.

## 목차

1. [개요](#1-개요)
2. [사전 요구사항](#2-사전-요구사항)
3. [이미지 빌드](#3-이미지-빌드)
4. [배포 순서](#4-배포-순서)
5. [환경변수 설정 가이드](#5-환경변수-설정-가이드)
6. [NGINX Ingress Controller 설치](#6-nginx-ingress-controller-설치)
7. [배포 확인](#7-배포-확인)
8. [접속 및 테스트](#8-접속-및-테스트)
9. [유지보수](#9-유지보수)
10. [트러블슈팅](#10-트러블슈팅)
11. [참고 자료](#11-참고-자료)
12. [검증 보고서](#12-검증-보고서)

---

## 1. 개요

### Skald 애플리케이션 소개

Skald는 AI 기반의 지식 관리 및 문서 처리 플랫폼입니다. 다음과 같은 주요 구성 요소로 이루어져 있습니다:

- **Frontend UI**: React 기반의 웹 인터페이스
- **Backend API**: Node.js/Express 기반의 API 서버
- **Memo Processing Server**: 백그라운드 메모 처리 서비스
- **Skald Worker**: Python FastAPI 기반의 Jira/Docs 데이터 수집 서비스
- **Embedding Service**: Python FastAPI 기반의 임베딩 서비스
- **Docling Service**: 문서 처리 서비스
- **PostgreSQL**: pgvector 확장이 포함된 데이터베이스
- **RabbitMQ**: 메시지 큐 시스템

### Kubernetes 배포 아키텍처

```
┌─────────────────────────────────────────────────────────────┐
│                    External Traffic                         │
│                        (HTTPS)                             │
└─────────────────────┬───────────────────────────────────────┘
                       │
               ┌───────▼───────┐
               │   Ingress     │
               │   (NGINX)     │
               └───────┬───────┘
                       │
         ┌─────────────┼─────────────┐
         │             │             │
    ┌────▼────┐   ┌────▼────┐   ┌────▼────┐
    │   UI    │   │   API   │   │ RabbitMQ│
    │ Service │   │ Service │   │ Service │
    └────┬────┘   └────┬────┘   └─────────┘
         │             │
         │             ├─────────────┐
         │             │             │
    ┌────▼────┐   ┌────▼────┐   ┌────▼────┐
    │   UI    │   │   API   │   │ Memo    │
    │   Pod   │   │   Pod   │   │Processing│
    └─────────┘   └─────────┘   │   Pod   │
                               └─────────┘
                                      │
                       ┌──────────────┼──────────────┐
                       │              │              │
                  ┌────▼────┐   ┌─────▼─────┐   ┌─────▼─────┐
                  │PostgreSQL│   │Embedding  │   │ Docling   │
                  │ Service  │   │ Service   │   │ Service   │
                  └──────────┘   └───────────┘   └───────────┘
                                      │
                               ┌──────▼──────┐
                               │  Skald      │
                               │  Worker     │
                               │  Service    │
                               └─────────────┘
```

### 필요한 리소스 요구사항

#### 최소 사양

- **CPU**: 8 코어
- **메모리**: 16GB RAM
- **스토리지**: 50GB (PostgreSQL 20GB, RabbitMQ 10GB, 여유 20GB)
- **네트워크**: LoadBalancer 또는 NodePort 지원

#### 권장 사양

- **CPU**: 12 코어 이상
- **메모리**: 32GB RAM 이상
- **스토리지**: 100GB 이상 (SSD 권장)
- **네트워크**: 고가용성 LoadBalancer

---

## 2. 사전 요구사항

### Kubernetes 클러스터

- **버전**: 1.24 이상 권장
- **노드**: 최소 2개 이상 (고가용성)
- **스토리지**: 동적 프로비저닝 지원 (local-path, NFS 등)
- **네트워크**: CNI 플러그인 설치 (Calico, Flannel 등)

### kubectl 설치 및 설정

```bash
# kubectl 설치 (Linux)
curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
sudo install -o root -g root -m 0755 kubectl /usr/local/bin/kubectl

# 클러스터 접속 확인
kubectl cluster-info
kubectl get nodes
```

### Helm 설치

```bash
# Helm 설치
curl https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash

# Helm 리포지토리 추가
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm repo update
```

### 스토리지 프로비저너

#### 온프레미스 환경 권장 옵션

1. **Local Path Provisioner** (권장):

```bash
kubectl apply -f https://raw.githubusercontent.com/rancher/local-path-provisioner/v0.0.26/deploy/local-path-storage.yaml
```

2. **NFS Provisioner** (공유 스토리지 필요):

```bash
# NFS 서버 설정 후
helm repo add nfs-subdir-external-provisioner https://kubernetes-sigs.github.io/nfs-subdir-external-provisioner/
helm install nfs-subdir-external-provisioner nfs-subdir-external-provisioner/nfs-subdir-external-provisioner \
  --set nfs.server=<NFS_SERVER_IP> \
  --set nfs.path=<NFS_SHARE_PATH>
```

### 도커 이미지 레지스트리 (선택적)

프라이빗 레지스트리 사용 시:

```bash
# 레지스트리 접속 정보 설정
kubectl create secret docker-registry registry-secret \
  --docker-server=<REGISTRY_URL> \
  --docker-username=<USERNAME> \
  --docker-password=<PASSWORD> \
  --namespace=skald
```

---

## 3. 이미지 빌드

### Backend 이미지 빌드

```bash
# Backend 디렉토리로 이동
cd backend

# 이미지 빌드
docker build -t backend:latest .

# 태그 지정 (레지스트리에 푸시할 경우)
docker tag backend:latest <REGISTRY_URL>/backend:latest

# 레지스트리에 푸시
docker push <REGISTRY_URL>/backend:latest
```

### Frontend UI 이미지 빌드

현재 저장소는 루트의 `ui.Dockerfile`과 `k8s/build-ui-for-k8s.sh`를 사용합니다.

```bash
# 루트에서 직접 빌드
docker build \
  --build-arg VITE_API_HOST= \
  --build-arg VITE_IS_SELF_HOSTED_DEPLOY=true \
  --file ui.Dockerfile \
  --tag <REGISTRY_URL>/ui:latest \
  .

# 또는 K8s 전용 로컬 빌드 스크립트 사용
./k8s/build-ui-for-k8s.sh
```

배포 매니페스트는 현재 `ghcr.io/jc01rho/skald/ui:latest`를 참조합니다.

### Embedding Service 이미지 빌드

```bash
# Embedding Service 디렉토리로 이동
cd embedding-service

# 이미지 빌드
docker build -t embedding-service:latest .

# 태그 지정 및 푸시
docker tag embedding-service:latest <REGISTRY_URL>/embedding-service:latest
docker push <REGISTRY_URL>/embedding-service:latest
```

### 이미지 태그 관리

```bash
# 버전 태그 지정
VERSION=v1.0.0

# 모든 이미지에 동일한 버전 태그 적용
docker tag backend:latest <REGISTRY_URL>/backend:${VERSION}
docker tag ui:latest <REGISTRY_URL>/ui:${VERSION}
docker tag embedding-service:latest <REGISTRY_URL>/embedding-service:${VERSION}

# 배포 시 환경변수 설정
export IMAGE_TAG=${VERSION}
export DOCKER_REGISTRY=<REGISTRY_URL>
```

---

## 4. 배포 순서

### Step 1: 네임스페이스 생성

```bash
# 네임스페이스 생성
kubectl apply -f namespace.yaml

# 확인
kubectl get namespace skald
```

### Step 2: ConfigMap 및 Secret 생성

```bash
# ConfigMap 생성
kubectl apply -f configmap.yaml

# Secret 생성 (먼저 복사 및 설정 필요)
cp secret.yaml.example secret.yaml
# secret.yaml 파일의 값을 실제 환경에 맞게 검토/교체
# 현재 추적 템플릿은 RabbitMQ를 skald / skald 기준으로 맞춰 둠
# base64 인코딩 예시: echo -n "your-secret-value" | base64

# Secret 적용
kubectl apply -f secret.yaml

# 초기화 스크립트 ConfigMap 생성
kubectl apply -f init-scripts-configmap.yaml

# 확인
kubectl get configmap -n skald
kubectl get secret -n skald
```

### Step 3: PersistentVolumeClaim 생성

PostgreSQL과 RabbitMQ는 별도 PVC manifest를 적용하지 않고 StatefulSet의 `volumeClaimTemplates`로 PVC를 생성합니다.

```bash
# 확인
kubectl get pvc -n skald
```

### Step 4: PostgreSQL 및 RabbitMQ 배포

```bash
# PostgreSQL 배포
kubectl apply -f postgres-deployment.yaml
kubectl apply -f postgres-service.yaml

# RabbitMQ 배포
kubectl apply -f rabbitmq-deployment.yaml
kubectl apply -f rabbitmq-service.yaml

# 상태 확인
kubectl get pods -n skald -l component=postgres
kubectl get pods -n skald -l component=rabbitmq

# 준비될 때까지 대기
kubectl wait --for=condition=ready pod -l component=postgres -n skald --timeout=300s
kubectl wait --for=condition=ready pod -l component=rabbitmq -n skald --timeout=300s
```

### Step 5: Backend 서비스 배포

```bash
# API 서비스 배포
kubectl apply -f api-deployment.yaml
kubectl apply -f api-service.yaml

# Memo Processing 서비스 배포
kubectl apply -f memo-processing-deployment.yaml

# 상태 확인
kubectl get pods -n skald -l component=api
kubectl get pods -n skald -l component=memo-processing

# 준비될 때까지 대기
kubectl wait --for=condition=ready pod -l component=api -n skald --timeout=1800s
kubectl wait --for=condition=ready pod -l component=memo-processing -n skald --timeout=300s
```

### Step 6: AI 서비스 배포

> 참고: `embedding-service`는 현재 `k8s/embedding-service-deployment.yaml`에서 GPU 노드 `ml.node.k8s.sparrow.local`로 고정 배치됩니다.

```bash
# Embedding Service 배포
kubectl apply -f embedding-service-deployment.yaml
kubectl apply -f embedding-service-service.yaml

# Docling Service 배포
kubectl apply -f docling-deployment.yaml
kubectl apply -f docling-service.yaml

# 상태 확인
kubectl get pods -n skald -l component=embedding-service
kubectl get pods -n skald -l component=docling-service

# 준비될 때까지 대기
kubectl wait --for=condition=ready pod -l component=embedding-service -n skald --timeout=300s
kubectl wait --for=condition=ready pod -l component=docling-service -n skald --timeout=300s
```

### Step 6.5: Skald Worker 배포

```bash
# Worker ConfigMap/Secret 원본은 worker/k8s 디렉터리에 있음
kubectl apply -f ../worker/k8s/configmap.yaml
kubectl apply -f ../worker/k8s/secret.yaml

# Worker 런타임 매니페스트는 root k8s 디렉터리에 있음
kubectl apply -f worker-serviceaccount.yaml
kubectl apply -f worker-deployment.yaml
kubectl apply -f worker-service.yaml

# 상태 확인
kubectl get pods -n skald -l component=worker

# 준비될 때까지 대기
kubectl wait --for=condition=ready pod -l component=worker -n skald --timeout=300s
```

`deploy.sh`는 Worker 설정 파일을 다음 순서로 찾습니다.

1. `worker-configmap.local.yaml` / `worker-secret.local.yaml`
2. `worker-configmap.yaml` / `worker-secret.yaml`
3. `../worker/k8s/configmap.yaml` / `../worker/k8s/secret.yaml`

### Step 7: Frontend UI 배포

```bash
# UI 배포
kubectl apply -f ui-deployment.yaml
kubectl apply -f ui-service.yaml

# 상태 확인
kubectl get pods -n skald -l component=ui

# 준비될 때까지 대기
kubectl wait --for=condition=ready pod -l component=ui -n skald --timeout=300s
```

### Step 8: Ingress 설정

```bash
# Ingress 배포
kubectl apply -f ingress.yaml

# 확인
kubectl get ingress -n skald
kubectl describe ingress skald-ingress -n skald
```

---

## 5. 환경변수 설정 가이드

### Secret 설정 방법

#### Base64 인코딩

```bash
# 일반 텍스트를 base64로 인코딩
echo -n "your-secret-value" | base64

# 예시: 데이터베이스 비밀번호
echo -n "my-secure-password" | base64
# 출력: bXktc2VjdXJlLXBhc3N3b3Jk

# 인코딩된 값 확인
echo "bXktc2VjdXJlLXBhc3N3b3Jk" | base64 -d
```

#### 필수 Secret 항목

```yaml
# secret.yaml의 주요 항목들
data:
    # 애플리케이션 보안
    SECRET_KEY: 'your-base64-encoded-secret-key'
    JWT_SECRET: 'your-base64-encoded-jwt-secret'

    # 데이터베이스
    DATABASE_URL: 'postgresql://user:pass@host:port/dbname'
    DB_PASSWORD: 'your-base64-encoded-db-password'
    POSTGRES_PASSWORD: 'your-base64-encoded-postgres-password'

    # RabbitMQ (tracked template default: skald / skald)
    RABBITMQ_PASSWORD: 'c2thbGQ=' # echo -n "skald" | base64
    RABBITMQ_DEFAULT_PASS: 'c2thbGQ=' # echo -n "skald" | base64

    # AI 서비스 API 키
    OPENAI_API_KEY: 'your-base64-encoded-openai-key'
    VOYAGE_API_KEY: 'your-base64-encoded-voyage-key'
    ANTHROPIC_API_KEY: 'your-base64-encoded-anthropic-key'

    # OAuth
    GOOGLE_CLIENT_ID: 'your-base64-encoded-google-client-id'
    GOOGLE_CLIENT_SECRET: 'your-base64-encoded-google-client-secret'

    # 결제
    STRIPE_SECRET_KEY: 'your-base64-encoded-stripe-key'
    STRIPE_WEBHOOK_SECRET: 'your-base64-encoded-stripe-webhook-secret'

    # 이메일
    RESEND_API_KEY: 'your-base64-encoded-resend-key'
```

### ConfigMap 커스터마이징

```yaml
# configmap.yaml의 주요 설정
data:
    # 프론트엔드 URL (실제 도메인으로 변경)
    FRONTEND_URL: 'https://your-domain.com'

    # CORS 설정
    CORS_ORIGIN: 'https://your-domain.com'

    # 데이터베이스 연결 정보
    DB_HOST: 'postgres-service'
    DB_PORT: '5432'
    DB_NAME: 'skald'
    DB_USER: 'postgres'

    # RabbitMQ 연결 정보
    RABBITMQ_HOST: 'rabbitmq-service'
    RABBITMQ_PORT: '5672'
    RABBITMQ_USER: 'skald'
    RABBITMQ_VHOST: '/'

    # 마이크로서비스 URL
    EMBEDDING_SERVICE_URL: 'http://embedding-service:8000'
    DOCLING_SERVICE_URL: 'http://docling-service:5001'
```

### 필수 환경변수 목록

| 카테고리     | 변수명                 | 설명                           | 필수여부 |
| ------------ | ---------------------- | ------------------------------ | -------- |
| 애플리케이션 | `SECRET_KEY`           | 애플리케이션 보안 키           | 필수     |
| 애플리케이션 | `JWT_SECRET`           | JWT 토큰 서명 키               | 필수     |
| 데이터베이스 | `DATABASE_URL`         | PostgreSQL 연결 URL            | 필수     |
| 데이터베이스 | `DB_PASSWORD`          | PostgreSQL 비밀번호            | 필수     |
| 메시지큐     | `RABBITMQ_PASSWORD`    | RabbitMQ 비밀번호              | 필수     |
| AI 서비스    | `OPENAI_API_KEY`       | OpenAI API 키                  | 필수     |
| OAuth        | `GOOGLE_CLIENT_ID`     | Google OAuth 클라이언트 ID     | 선택     |
| OAuth        | `GOOGLE_CLIENT_SECRET` | Google OAuth 클라이언트 시크릿 | 선택     |

---

## 6. NGINX Ingress Controller 설치

### Helm을 사용한 설치

```bash
# 1. Helm 리포지토리 추가
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm repo update

# 2. Ingress Controller 설치
helm install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx \
  --create-namespace \
  --values ingress-nginx-values.yaml

# 3. 설치 확인
kubectl get pods -n ingress-nginx
kubectl get svc -n ingress-nginx
```

### ingress-nginx-values.yaml 사용법

제공된 `ingress-nginx-values.yaml` 파일은 온프레미스 환경에 최적화된 설정입니다:

```yaml
# 주요 설정 항목
controller:
    replicaCount: 2 # 고가용성을 위해 2개 이상 권장
    service:
        type: LoadBalancer # MetalLB 설치 시 사용
        # type: NodePort     # LoadBalancer unavailable 시
    resources:
        requests:
            cpu: 500m
            memory: 512Mi
        limits:
            cpu: 1000m
            memory: 1Gi
```

### TLS/SSL 인증서 설정

#### 자체 서명 인증서 (테스트용)

```bash
# 인증서 생성
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout tls.key -out tls.crt \
  -subj "/CN=your-domain.com"

# Kubernetes Secret 생성
kubectl create secret tls skald-tls-secret \
  --namespace skald \
  --key=tls.key \
  --cert=tls.crt
```

#### Let's Encrypt 인증서 (프로덕션용)

```bash
# 1. cert-manager 설치
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.13.0/cert-manager.yaml

# 2. ClusterIssuer 생성
cat > cluster-issuer.yaml << 'EOF'
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: admin@your-domain.com
    privateKeySecretRef:
      name: letsencrypt-prod
    solvers:
    - http01:
        ingress:
          class: nginx
EOF

kubectl apply -f cluster-issuer.yaml

# 3. ingress.yaml에 cert-manager 어노테이션 추가
# cert-manager.io/cluster-issuer: "letsencrypt-prod"
```

---

## 7. 배포 확인

### 모든 Pod 상태 확인

```bash
# 전체 Pod 상태 확인
kubectl get pods -n skald

# 상세 정보 확인
kubectl describe pods -n skald

# 특정 컴포넌트만 확인
kubectl get pods -n skald -l app=skald
```

### 서비스 엔드포인트 확인

```bash
# 모든 서비스 확인
kubectl get svc -n skald

# 서비스 엔드포인트 확인
kubectl get endpoints -n skald

# Ingress 확인
kubectl get ingress -n skald
kubectl describe ingress skald-ingress -n skald
```

### 로그 확인 방법

```bash
# 특정 Pod 로그 확인
kubectl logs -f deployment/api-server -n skald
kubectl logs -f deployment/ui -n skald
kubectl logs -f postgres-0 -n skald

# 여러 Pod 로그 동시 확인
kubectl logs -f -l component=api -n skald
kubectl logs -f -l component=ui -n skald

# 이전 로그 확인 (Pod 재시작 후)
kubectl logs -p deployment/api-server -n skald
```

### 헬스체크 확인

```bash
# Pod 상세 정보에서 헬스체크 상태 확인
kubectl describe pod <pod-name> -n skald

# 특정 서비스 헬스체크
kubectl exec -it deployment/api-server -n skald -- curl http://localhost:8000/api/health
kubectl exec -it deployment/ui -n skald -- curl http://localhost:8080/health
```

---

## 8. 접속 및 테스트

### 애플리케이션 접속 URL

```bash
# Ingress 외부 IP 확인
kubectl get svc -n ingress-nginx

# 또는 LoadBalancer IP 확인
kubectl get ingress skald-ingress -n skald -o wide

# 접속 URL
# 메인 애플리케이션: https://your-domain.com
# API 엔드포인트: https://your-domain.com/api
# RabbitMQ Management는 기본 ingress에 노출되지 않음 (port-forward 사용)
```

### API 엔드포인트 테스트

```bash
# 헬스체크 엔드포인트
curl https://your-domain.com/api/health

# 인증이 필요한 엔드포인트 테스트 예시
curl -H "Authorization: Bearer <your-token>" \
     https://your-domain.com/api/user/profile
```

### RabbitMQ Management UI 접속

```bash
# Port-forward를 통한 접속 (테스트용)
kubectl port-forward -n skald svc/rabbitmq-service 15672:15672

# 브라우저에서 접속
# URL: http://localhost:15672
# 사용자명: skald (configmap.yaml에서 설정)
# 비밀번호: secret.yaml에서 설정한 값
```

---

## 9. 유지보수

### 업데이트 및 롤백 방법

#### 이미지 업데이트

```bash
# 새 이미지 태그 설정
export IMAGE_TAG=v1.1.0

# Deployment 업데이트
kubectl set image deployment/api-server \
  api-server=<REGISTRY_URL>/backend:${IMAGE_TAG} -n skald

kubectl set image deployment/ui \
  ui=<REGISTRY_URL>/ui:${IMAGE_TAG} -n skald

# 롤아웃 상태 확인
kubectl rollout status deployment/api-server -n skald
kubectl rollout status deployment/ui -n skald
```

#### 롤백

```bash
# 이전 버전으로 롤백
kubectl rollout undo deployment/api-server -n skald

# 특정 리비전으로 롤백
kubectl rollout undo deployment/api-server --to-revision=2 -n skald

# 롤아웃 히스토리 확인
kubectl rollout history deployment/api-server -n skald
```

### 백업 및 복구

#### PostgreSQL 백업

```bash
# 백업 생성
kubectl exec -it postgres-0 -n skald -- \
  pg_dump -U postgres -d skald2 > skald-backup-$(date +%Y%m%d).sql

# 복원
kubectl exec -i postgres-0 -n skald -- \
  psql -U postgres -d skald2 < skald-backup-20231201.sql
```

#### PVC 백업

```bash
# PVC 스냅샷 생성 (클라우드 환경)
kubectl create snapshot postgres-snapshot \
  --source=skald/postgres-data \
  --namespace=skald

# 온프레미스 환경에서는 파일 시스템 백업 사용
kubectl exec -it postgres-0 -n skald -- tar czf /tmp/backup.tar.gz /var/lib/postgresql/data
```

### 스케일링 방법

#### 수평 스케일링

```bash
# 레플리카 수 조정
kubectl scale deployment api-server --replicas=3 -n skald
kubectl scale deployment ui --replicas=3 -n skald

# HPA (Horizontal Pod Autoscaler) 설정
kubectl autoscale deployment api-server \
  --cpu-percent=70 \
  --min=2 \
  --max=10 \
  -n skald
```

#### 수직 스케일링

```bash
# 리소스 요청/제한 조정
kubectl patch deployment api-server -n skald -p '
{
  "spec": {
    "template": {
      "spec": {
        "containers": [{
          "name": "api-server",
          "resources": {
            "requests": {
              "memory": "1Gi",
              "cpu": "500m"
            },
            "limits": {
              "memory": "2Gi",
              "cpu": "2000m"
            }
          }
        }]
      }
    }
  }
}'
```

### 모니터링 권장사항

#### Prometheus + Grafana

```bash
# Prometheus Operator 설치
kubectl create namespace monitoring
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm install prometheus prometheus-community/kube-prometheus-stack \
  --namespace monitoring

# ServiceMonitor 생성 (예시)
cat > api-service-monitor.yaml << 'EOF'
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: api-server-metrics
  namespace: skald
spec:
  selector:
    matchLabels:
      app: skald
      component: api
  endpoints:
  - port: http
    path: /metrics
EOF
```

#### 로그 수집

```bash
# Fluent Bit 설치
helm repo add fluent https://fluent.github.io/helm-charts
helm install fluent-bit fluent/fluent-bit \
  --namespace logging \
  --create-namespace
```

---

## 10. 트러블슈팅

### 일반적인 문제 및 해결 방법

#### Pod 시작 실패

```bash
# Pod 상태 확인
kubectl get pods -n skald -o wide

# Pod 상세 정보 확인
kubectl describe pod <pod-name> -n skald

# Pod 로그 확인
kubectl logs <pod-name> -n skald

# Pod 이벤트 확인
kubectl get events -n skald --sort-by=.metadata.creationTimestamp
```

#### 이미지 풀 실패

```bash
# 이미지 풀 에러 확인
kubectl describe pod <pod-name> -n skald | grep -A 10 "Events:"

# 이미지 존재 확인
docker pull <image-name>

# 이미지 태그 확인
docker images | grep skald

# 프라이빗 레지스트리 접속 확인
kubectl get secret registry-secret -n skald -o yaml
```

#### 네트워크 연결 문제

```bash
# 서비스 엔드포인트 확인
kubectl get endpoints -n skald

# PostgreSQL readiness 확인
kubectl exec -it postgres-0 -n skald -- \
  pg_isready -U postgres -d skald2

# DNS 확인
kubectl exec -it deployment/api-server -n skald -- \
  nslookup postgres-service.skald.svc.cluster.local
```

### 로그 확인 명령어

```bash
# 실시간 로그 확인
kubectl logs -f deployment/api-server -n skald

# 여러 컨테이너 로그 확인
kubectl logs -f deployment/api-server -c api-server -n skald

# 이전 로그 확인
kubectl logs -p deployment/api-server -n skald

# 특정 시간대 로그 확인
kubectl logs --since=1h deployment/api-server -n skald
```

### Pod 재시작 방법

```bash
# Pod 재시작
kubectl rollout restart deployment/api-server -n skald

# 특정 Pod 삭제 (새 Pod 생성)
kubectl delete pod <pod-name> -n skald

# 강제 재시작
kubectl delete pod <pod-name> -n skald --force --grace-period=0
```

### 네트워크 문제 디버깅

```bash
# Pod 네트워크 정보 확인
kubectl exec -it deployment/api-server -n skald -- ip addr

# 포트 연결 확인
kubectl exec -it deployment/api-server -n skald -- \
  netstat -tlnp

# 외부 연결 테스트
kubectl exec -it deployment/api-server -n skald -- \
  curl -v https://google.com

# API 헬스체크 재확인
kubectl exec -it deployment/api-server -n skald -- \
  curl http://localhost:8000/api/health
```

---

## 11. 참고 자료

### 파일 목록 및 설명

| 파일명                              | 설명                          | 용도                      |
| ----------------------------------- | ----------------------------- | ------------------------- |
| `namespace.yaml`                    | Skald 네임스페이스 정의       | 리소스 격리               |
| `configmap.yaml`                    | 비민감 환경변수 설정          | 애플리케이션 설정         |
| `secret.yaml.example`               | Secret 설정 예제              | 보안 정보 설정            |
| `postgres-deployment.yaml`          | PostgreSQL StatefulSet        | 데이터베이스              |
| `postgres-service.yaml`             | PostgreSQL 서비스             | 데이터베이스 접속         |
| `rabbitmq-deployment.yaml`          | RabbitMQ StatefulSet          | 메시지 큐                 |
| `rabbitmq-service.yaml`             | RabbitMQ 서비스               | 메시지 큐 접속            |
| `api-deployment.yaml`               | API 서버 Deployment           | 백엔드 API                |
| `api-service.yaml`                  | API 서비스                    | API 접속                  |
| `memo-processing-deployment.yaml`   | 메모 처리 서버                | 백그라운드 처리           |
| `worker-deployment.yaml`            | Skald Worker Deployment       | Jira/Docs 수집            |
| `worker-service.yaml`               | Skald Worker 서비스           | Worker 접속               |
| `../worker/k8s/configmap.yaml`      | Worker ConfigMap 원본         | `deploy.sh` fallback 입력 |
| `../worker/k8s/secret.yaml`         | Worker Secret 원본            | `deploy.sh` fallback 입력 |
| `worker-serviceaccount.yaml`        | Worker ServiceAccount         | Worker 권한               |
| `embedding-service-deployment.yaml` | 임베딩 서비스                 | AI 임베딩                 |
| `embedding-service-service.yaml`    | 임베딩 서비스                 | 임베딩 접속               |
| `docling-deployment.yaml`           | 문서 처리 서비스              | 문서 처리                 |
| `docling-service.yaml`              | 문서 처리 서비스              | 문서 처리 접속            |
| `ui-deployment.yaml`                | 프론트엔드 UI Deployment      | 웹 인터페이스             |
| `ui-service.yaml`                   | 프론트엔드 UI 서비스          | 웹 접속                   |
| `ui-nginx-configmap.yaml`           | UI Nginx 설정 ConfigMap       | API 프록시 설정           |
| `ingress.yaml`                      | Ingress 리소스                | 외부 트래픽 라우팅        |
| `ingress-nginx-values.yaml`         | NGINX Ingress Controller 설정 | Ingress Controller        |
| `init-scripts-configmap.yaml`       | PostgreSQL 초기화 스크립트    | 데이터베이스 초기화       |
| `api-url-architecture-design.md`    | API URL 아키텍처 설계 문서    | 기술 문서                 |

### Kubernetes 공식 문서 링크

- [Kubernetes 공식 문서](https://kubernetes.io/docs/)
- [kubectl 명령어 참조](https://kubernetes.io/docs/reference/generated/kubectl/kubectl-commands)
- [Deployment 가이드](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/)
- [Service 가이드](https://kubernetes.io/docs/concepts/services-networking/service/)
- [Ingress 가이드](https://kubernetes.io/docs/concepts/services-networking/ingress/)
- [ConfigMap 가이드](https://kubernetes.io/docs/concepts/configuration/configmap/)
- [Secret 가이드](https://kubernetes.io/docs/concepts/configuration/secret/)
- [PersistentVolume 가이드](https://kubernetes.io/docs/concepts/storage/persistent-volumes/)

## 12. 검증 기준

### 운영 검증 개요

현재 운영 검증은 별도 일회성 보고서가 아니라 아래 기준으로 수행합니다.

1. **YAML / Shell 문법 검증**
    - `kubectl apply --dry-run=client -f <manifest>`
    - `bash -n k8s/deploy.sh`

2. **실배포 검증**
    - `cd k8s && ./deploy.sh -y`
    - rollout 및 readiness 확인

3. **서비스 연결 검증**
    - `api-service`, `rabbitmq-service`, `skald-worker`, `ui-service` endpoint 확인
    - 필요 시 애플리케이션 로그(`kubectl logs`)로 후속 검증

4. **문서 정합성 검증**
    - 본 README, `k8s/AGENTS.md`, `worker/k8s/README.md`, `worker/k8s/AGENTS.md`를 기준으로 유지
    - 모든 서비스의 매핑 상태 확인 완료
    - 환경변수, 포트, 네트워크 설정 검증 완료

5. **GitHub Actions 워크플로우** ⚠️
    - 일부 워크플로우에서 네임스페이스 불일치 문제 발견
    - 이미지 태그 업데이트 로직 개선 필요

6. **배포 스크립트** ✅
    - 쉘 문법 검증 통과
    - 실행 권한 확인 완료 (0755)

7. **설정 일관성** ⚠️
    - 이미지 태그 패턴 일부 불일치
    - 환경변수 참조 방식 통일 필요

8. **보안 검증** ✅
    - Secret/ConfigMap 적절히 사용됨
    - RBAC 기본 설정 확인됨
    - NetworkPolicy 추가 권장

### 권장 조치사항

#### 즉시 적용 필요

1. GitHub Actions 워크플로우 네임스페이스 일치
2. 이미지 태그 패턴 통일
3. Ingress 설정 최적화

#### 단기 개선사항

1. RBAC 강화 (서비스별 ServiceAccount 추가)
2. NetworkPolicy 도입
3. 모니터링 강화

### 검증 도구 사용법

```bash
# YAML 문법 검증
kubectl apply --dry-run=client -f k8s/

# 배포 테스트
./k8s/deploy.sh --help

# 서비스 상태 확인
kubectl get pods,svc,ingress -n skald
```

---

### 관련 도구 링크

- [Helm 공식 문서](https://helm.sh/docs/)
- [NGINX Ingress Controller](https://kubernetes.github.io/ingress-nginx/)
- [cert-manager](https://cert-manager.io/docs/)
- [Prometheus](https://prometheus.io/docs/)
- [Grafana](https://grafana.com/docs/)
- [MetalLB](https://metallb.universe.tf/)
- [Local Path Provisioner](https://github.com/rancher/local-path-provisioner)

## Hermes Discord Gateway 운영 계약

### 범위와 런타임

Hermes는 Skald가 빌드하는 Kubernetes 이미지로 운영하며 프로세스 argv는 정확히 `hermes gateway run`입니다. 별도 플래그나 Skald 호환 래퍼를 추가하지 않습니다. Discord ingress, 세션, 메시지 전달, 멘션/스레드/첨부 정책은 Hermes native Discord adapter와 native policy가 정본입니다.

이번 전환은 **functional-spec-only**입니다. 이미지에 고정된 `sparrow-function-spec`만 사용하며, 기존 standalone bot의 general RAG, product filter, reference/citation, preview/progress, streaming/partial-response 동작을 Hermes에서 재현하지 않습니다. 해당 코드는 soak 기간 동안 rollback 용도로 유지하며 삭제하지 않습니다.

readiness는 매니페스트에 정의된 단일 프로세스 probe 범위만 의미합니다. Skald 정책 동등성, MCP 의미 검증, Discord API 세션 단독 소유를 결합한 compound readiness라고 해석하거나 주장하지 않습니다.

### 이미지 발행과 배포 순서

1. 변경을 `commit`합니다.
2. 원격 저장소에 `push`합니다.
3. `.github/workflows/build-hermes-gateway.yml` GitHub Actions가 offline test, 이미지 build, vulnerability/secret scan, SPDX SBOM 생성을 완료하고 `ghcr.io/jc01rho/hermes-gateway:<commit-sha>`를 push했는지 확인합니다. 워크플로우는 `latest`를 발행하지 않습니다.
4. Actions 요약에 기록된 digest를 사용해 `HERMES_IMAGE=ghcr.io/jc01rho/hermes-gateway@sha256:<64hex>`를 설정합니다. `HERMES_IMAGE`는 legacy `IMAGE_TAG`와 독립된 전용 값이며 tag-only 값은 허용하지 않습니다.
5. `kubectl auth whoami -o json`의 실제 username 또는 group 중 운영자 전용 RBAC에 연결된 값을 `HERMES_DEPLOY_IDENTITY=user:<username>` 또는 `group:<group>`으로 설정합니다. `hermes-deploy-operator-rbac.yaml`의 기본 binding은 `hermes-deploy-operators` group을 사용하며 ServiceAccount impersonation을 사용하지 않습니다. 스크립트는 실제 ambient identity 일치와 모든 required `kubectl auth can-i` grant를 확인한 뒤, Lease create/delete, owner index 또는 snapshot 삭제, ConfigMap/Secret/Deployment/Pod delete-collection, RBAC bind/escalate/impersonate, wildcard resource/verb grant 중 하나라도 실제 credentials에 있으면 mutation 전에 실패합니다. Deployment patch는 scale 전환에 필요해 허용하지만 Lease CAS는 replace/update만 사용하므로 Lease patch는 허용하지 않으며, 각 Kubernetes 명령 전에 identity를 다시 확인합니다.
6. 전환 목적에 맞게 `HERMES_DEPLOY_MODE=cutover`, `upgrade`, 또는 `rollback`을 설정하고 `./deploy.sh -y`를 실행합니다. 빈 값은 durable active-owner record에 따라 기존 owner lane만 확인/유지합니다. Smoke 단계에서는 배포 출력의 stderr에 정확한 correlation probe가 표시됩니다. `operator_user_ids`에 등록된 운영자가 cutover 중 그 문자열을 변경 없이 대상 Discord 채널에 직접 게시해야 하며, orchestration은 그 운영자 메시지를 확인한 뒤 parent 채널과 auto-thread에서 owner bot 응답을 제한 시간 동안 읽기 전용으로 확인합니다. Bot token으로 probe를 게시하지 않습니다.

Hermes ConfigMap은 `/var/lib/hermes/config.yaml`로 mount됩니다. Secret 값은 로컬 ignored Secret manifest 또는 운영 Secret 관리 경로로 주입하며 문서나 GitHub Actions 입력에 값을 기록하지 않습니다. 확인된 runtime Secret key는 `DISCORD_BOT_TOKEN`, `OPENAI_API_KEY`, `SKALD_API_KEY`, `SKALD_PROJECT_ID`이고, `SKALD_BASE_URL`은 비민감 ConfigMap 값입니다.

### operation lock과 복구

`skald-discord-deploy-operation` Lease는 bootstrap에서 미리 생성하는 **배포 작업 mutex**입니다. expiry, renewal, 자동 takeover가 없으며 runtime readiness나 Discord session fencing이 아닙니다. durable active-owner index와 immutable snapshots가 전환/rollback 권한의 정본이고, Pod 또는 Deployment 존재 여부는 owner 판정 근거가 아닙니다.

비어 있지 않은 Lease holder는 나이나 workload 상태만으로 해제하지 않습니다. Kubernetes write, readback, 또는 release 결과가 모호하면 deploy는 즉시 `RECOVERY_REQUIRED`로 fail closed하고 holder를 유지하며 자동 mutation과 자동 rollback을 중단합니다. 별도 privileged recovery는 originating process/request가 재개되거나 지연 도착할 수 없다는 증거, 유효한 owner/snapshot 검증, lock 하 reconciliation과 correlated smoke, redacted audit를 갖춘 뒤 exact-resourceVersion CAS clear와 empty-holder readback을 수행해야 합니다.
`hermes-deploy-operator-rbac.yaml`은 장식용 ServiceAccount를 만들지 않습니다. 명시된 사용자/group identity에 직접 bind되는 namespace Role이며, Kubernetes가 `create`에 `resourceNames`를 적용하지 않는 한계 때문에 first-cutover Deployment와 content-addressed snapshot ConfigMap create/get만 resource 범위입니다. 나머지 mutation/read 권한은 transition에서 사용하는 exact resource name으로 제한됩니다. Role은 workload scale용 named Deployment patch를 유지하고 operation Lease에는 exact-name get/update만 부여하며 create/delete/patch, authority 삭제, delete-collection, RBAC privilege delegation, impersonation, wildcard grant를 부여하지 않습니다.

### cutover, rollback, soak

- **Cutover:** legacy authority와 health/smoke를 확인하고 snapshot/index를 기록한 뒤 legacy를 중지하고 Hermes를 시작합니다. stop 이후의 결론적인 실패는 retained legacy snapshot을 복원하고 smoke합니다. 결과가 모호하면 자동 복원이 아니라 `RECOVERY_REQUIRED`입니다.
- **Upgrade:** 현재 Hermes owner와 이전 immutable Hermes snapshot이 필요합니다. 결론적인 실패 시 그 exact snapshot으로 복원합니다.
- **Rollback:** Hermes owner에서 retained legacy를 복원/smoke한 뒤 durable owner를 legacy로 게시합니다. 이미 legacy owner이면 검증만 수행하는 idempotent 경로입니다.
- **Soak:** Hermes 운영 지표와 native Discord 동작을 관찰하는 동안 legacy image, manifests, compatible config/Secret contract, snapshot을 rollback-only로 보존합니다. legacy 삭제/decommission은 별도 승인 전에는 금지됩니다.

동일 production Discord token으로 Hermes와 legacy bot을 동시에 실행하지 않습니다.

### 명시적으로 수용된 잔여 위험

아래 항목은 이번 변경으로 해결되었다고 주장하지 않으며, 이 migration에서 의도적으로 수용한 잔여 위험입니다.

- 정확한 `hermes gateway run`은 multi-platform gateway process로 동작합니다.
- Hermes native Discord policy가 정본이며 legacy Skald policy parity를 보장하지 않습니다.
- compound authorization/readiness proof와 Discord API session-exclusivity proof가 없습니다.
- native attachment와 message-delivery 동작은 legacy bot과 다를 수 있습니다.
- `sparrow-function-spec`의 현재 credential 처리, TLS bypass/default, updater/install 동작은 변경하지 않습니다.
- Calico, NetworkPolicy, proxy, firewall, DNS, 일반 cluster egress를 변경하거나 강화하지 않습니다.
- 모호하거나 abandoned deployment operation은 감사된 수동 recovery가 끝날 때까지 무기한 배포를 잠글 수 있습니다.

이 목록은 remediation 완료 목록이 아닙니다. 별도 승인된 후속 작업만 해당 위험을 변경할 수 있습니다.

---

## 부록: 빠른 시작 스크립트

전체 배포를 자동화하는 스크립트는 `deploy.sh` 파일을 참고하세요.

```bash
# 배포 스크립트 실행 (선택적)
chmod +x deploy.sh
./deploy.sh
```

이 가이드가 Skald 애플리케이션의 Kubernetes 배포에 도움이 되기를 바랍니다. 문제가 발생할 경우 트러블슈팅 섹션을 참고하거나 Kubernetes 공식 문서를 확인하세요.
