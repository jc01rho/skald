# Skald Kubernetes 배포 가이드

이 문서는 Skald 애플리케이션을 온프레미스 Kubernetes 클러스터에 배포하는 방법을 안내합니다.

## 검증 상태

✅ **전체 검증 완료**: 2025-12-02
📋 **상세 검증 보고서**: [VALIDATION_REPORT.md](VALIDATION_REPORT.md) 참조

### 주요 검증 결과
- ✅ YAML 문법 검증 통과 (수정된 파일: ingress.yaml, ingress-nginx-values.yaml)
- ✅ Docker Compose ↔ Kubernetes 매핑 검증 완료
- ⚠️ GitHub Actions 워크플로우 일부 문제 발견 (네임스페이스 불일치)
- ✅ 배포 스크립트 문법 및 권한 검증 통과
- ⚠️ 설정 일관성 부분 개선 필요
- ✅ 보안 설정 기본 검증 통과

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
docker build -t skald-backend:latest .

# 태그 지정 (레지스트리에 푸시할 경우)
docker tag skald-backend:latest <REGISTRY_URL>/skald-backend:latest

# 레지스트리에 푸시
docker push <REGISTRY_URL>/skald-backend:latest
```

### Frontend UI 이미지 빌드

Frontend용 Dockerfile이 없으므로 생성해야 합니다:

```bash
# frontend/Dockerfile 생성
cat > frontend/Dockerfile << 'EOF'
# Build stage
FROM node:18-alpine AS builder

WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install pnpm and dependencies
RUN npm install -g pnpm
RUN pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Build application
RUN pnpm build

# Production stage
FROM nginx:alpine

# Copy built files
COPY --from=builder /app/dist /usr/share/nginx/html

# Copy nginx configuration
COPY nginx.conf /etc/nginx/nginx.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
EOF

# 이미지 빌드
cd frontend
docker build -t skald-frontend:latest .

# 태그 지정 및 푸시
docker tag skald-frontend:latest <REGISTRY_URL>/skald-frontend:latest
docker push <REGISTRY_URL>/skald-frontend:latest
```

### Embedding Service 이미지 빌드

```bash
# Embedding Service 디렉토리로 이동
cd embedding-service

# 이미지 빌드
docker build -t skald-embedding-service:latest .

# 태그 지정 및 푸시
docker tag skald-embedding-service:latest <REGISTRY_URL>/skald-embedding-service:latest
docker push <REGISTRY_URL>/skald-embedding-service:latest
```

### 이미지 태그 관리

```bash
# 버전 태그 지정
VERSION=v1.0.0

# 모든 이미지에 동일한 버전 태그 적용
docker tag skald-backend:latest <REGISTRY_URL>/skald-backend:${VERSION}
docker tag skald-frontend:latest <REGISTRY_URL>/skald-frontend:${VERSION}
docker tag skald-embedding-service:latest <REGISTRY_URL>/skald-embedding-service:${VERSION}

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
# secret.yaml 파일의 모든 플레이스홀더 값을 실제 값으로 교체
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

```bash
# PostgreSQL PVC 생성
kubectl apply -f postgres-pvc.yaml

# RabbitMQ PVC 생성
kubectl apply -f rabbitmq-pvc.yaml

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
kubectl wait --for=condition=ready pod -l component=api -n skald --timeout=300s
kubectl wait --for=condition=ready pod -l component=memo-processing -n skald --timeout=300s
```

### Step 6: AI 서비스 배포

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
  SECRET_KEY: "your-base64-encoded-secret-key"
  JWT_SECRET: "your-base64-encoded-jwt-secret"
  
  # 데이터베이스
  DATABASE_URL: "postgresql://user:pass@host:port/dbname"
  DB_PASSWORD: "your-base64-encoded-db-password"
  POSTGRES_PASSWORD: "your-base64-encoded-postgres-password"
  
  # RabbitMQ
  RABBITMQ_PASSWORD: "your-base64-encoded-rabbitmq-password"
  RABBITMQ_DEFAULT_PASS: "your-base64-encoded-rabbitmq-default-pass"
  
  # AI 서비스 API 키
  OPENAI_API_KEY: "your-base64-encoded-openai-key"
  VOYAGE_API_KEY: "your-base64-encoded-voyage-key"
  ANTHROPIC_API_KEY: "your-base64-encoded-anthropic-key"
  
  # OAuth
  GOOGLE_CLIENT_ID: "your-base64-encoded-google-client-id"
  GOOGLE_CLIENT_SECRET: "your-base64-encoded-google-client-secret"
  
  # 결제
  STRIPE_SECRET_KEY: "your-base64-encoded-stripe-key"
  STRIPE_WEBHOOK_SECRET: "your-base64-encoded-stripe-webhook-secret"
  
  # 이메일
  RESEND_API_KEY: "your-base64-encoded-resend-key"
```

### ConfigMap 커스터마이징

```yaml
# configmap.yaml의 주요 설정
data:
  # 프론트엔드 URL (실제 도메인으로 변경)
  FRONTEND_URL: "https://your-domain.com"
  
  # CORS 설정
  CORS_ORIGIN: "https://your-domain.com"
  
  # 데이터베이스 연결 정보
  DB_HOST: "postgres-service"
  DB_PORT: "5432"
  DB_NAME: "skald"
  DB_USER: "skald_user"
  
  # RabbitMQ 연결 정보
  RABBITMQ_HOST: "rabbitmq-service"
  RABBITMQ_PORT: "5672"
  RABBITMQ_USER: "skald_user"
  RABBITMQ_VHOST: "/skald"
  
  # 마이크로서비스 URL
  EMBEDDING_SERVICE_URL: "http://embedding-service:8000"
  DOCLING_SERVICE_URL: "http://docling-service:5001"
```

### 필수 환경변수 목록

| 카테고리 | 변수명 | 설명 | 필수여부 |
|---------|--------|------|---------|
| 애플리케이션 | `SECRET_KEY` | 애플리케이션 보안 키 | 필수 |
| 애플리케이션 | `JWT_SECRET` | JWT 토큰 서명 키 | 필수 |
| 데이터베이스 | `DATABASE_URL` | PostgreSQL 연결 URL | 필수 |
| 데이터베이스 | `DB_PASSWORD` | PostgreSQL 비밀번호 | 필수 |
| 메시지큐 | `RABBITMQ_PASSWORD` | RabbitMQ 비밀번호 | 필수 |
| AI 서비스 | `OPENAI_API_KEY` | OpenAI API 키 | 필수 |
| OAuth | `GOOGLE_CLIENT_ID` | Google OAuth 클라이언트 ID | 선택 |
| OAuth | `GOOGLE_CLIENT_SECRET` | Google OAuth 클라이언트 시크릿 | 선택 |

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
  replicaCount: 2  # 고가용성을 위해 2개 이상 권장
  service:
    type: LoadBalancer  # MetalLB 설치 시 사용
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
kubectl logs -f deployment/postgres -n skald

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
kubectl exec -it deployment/api-server -n skald -- curl http://localhost:8000/health
kubectl exec -it deployment/ui -n skald -- curl http://localhost:80/
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
# RabbitMQ Management: https://your-domain.com/rabbitmq
```

### API 엔드포인트 테스트

```bash
# 헬스체크 엔드포인트
curl https://your-domain.com/api/health

# API 버전 확인
curl https://your-domain.com/api/version

# 인증이 필요한 엔드포인트 테스트
curl -H "Authorization: Bearer <your-token>" \
     https://your-domain.com/api/user/profile
```

### RabbitMQ Management UI 접속

```bash
# Port-forward를 통한 접속 (테스트용)
kubectl port-forward -n skald svc/rabbitmq-service 15672:15672

# 브라우저에서 접속
# URL: http://localhost:15672
# 사용자명: skald_user (configmap.yaml에서 설정)
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
  api-server=<REGISTRY_URL>/skald-backend:${IMAGE_TAG} -n skald

kubectl set image deployment/ui \
  ui=<REGISTRY_URL>/skald-frontend:${IMAGE_TAG} -n skald

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
kubectl exec -it deployment/postgres -n skald -- \
  pg_dump -U skald_user -d skald > skald-backup-$(date +%Y%m%d).sql

# 복원
kubectl exec -i deployment/postgres -n skald -- \
  psql -U skald_user -d skald < skald-backup-20231201.sql
```

#### PVC 백업

```bash
# PVC 스냅샷 생성 (클라우드 환경)
kubectl create snapshot postgres-snapshot \
  --source=skald/postgres-data \
  --namespace=skald

# 온프레미스 환경에서는 파일 시스템 백업 사용
kubectl exec -it deployment/postgres -n skald -- tar czf /tmp/backup.tar.gz /var/lib/postgresql/data
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

# Pod 간 연결 테스트
kubectl exec -it deployment/api-server -n skald -- \
  curl http://postgres-service:5432

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

# 서비스 디스커버리 테스트
kubectl exec -it deployment/api-server -n skald -- \
  wget -qO- http://postgres-service:5432
```

---

## 11. 참고 자료

### 파일 목록 및 설명

| 파일명 | 설명 | 용도 |
|--------|------|------|
| `namespace.yaml` | Skald 네임스페이스 정의 | 리소스 격리 |
| `configmap.yaml` | 비민감 환경변수 설정 | 애플리케이션 설정 |
| `secret.yaml.example` | Secret 설정 예제 | 보안 정보 설정 |
| `postgres-deployment.yaml` | PostgreSQL StatefulSet | 데이터베이스 |
| `postgres-service.yaml` | PostgreSQL 서비스 | 데이터베이스 접속 |
| `postgres-pvc.yaml` | PostgreSQL 영구 볼륨 | 데이터 영속성 |
| `rabbitmq-deployment.yaml` | RabbitMQ StatefulSet | 메시지 큐 |
| `rabbitmq-service.yaml` | RabbitMQ 서비스 | 메시지 큐 접속 |
| `rabbitmq-pvc.yaml` | RabbitMQ 영구 볼륨 | 큐 데이터 영속성 |
| `api-deployment.yaml` | API 서버 Deployment | 백엔드 API |
| `api-service.yaml` | API 서비스 | API 접속 |
| `memo-processing-deployment.yaml` | 메모 처리 서버 | 백그라운드 처리 |
| `embedding-service-deployment.yaml` | 임베딩 서비스 | AI 임베딩 |
| `embedding-service-service.yaml` | 임베딩 서비스 | 임베딩 접속 |
| `docling-deployment.yaml` | 문서 처리 서비스 | 문서 처리 |
| `docling-service.yaml` | 문서 처리 서비스 | 문서 처리 접속 |
| `ui-deployment.yaml` | 프론트엔드 UI Deployment | 웹 인터페이스 |
| `ui-service.yaml` | 프론트엔드 UI 서비스 | 웹 접속 |
| `ingress.yaml` | Ingress 리소스 | 외부 트래픽 라우팅 |
| `ingress-nginx-values.yaml` | NGINX Ingress Controller 설정 | Ingress Controller |
| `init-scripts-configmap.yaml` | PostgreSQL 초기화 스크립트 | 데이터베이스 초기화 |

### Kubernetes 공식 문서 링크

- [Kubernetes 공식 문서](https://kubernetes.io/docs/)
- [kubectl 명령어 참조](https://kubernetes.io/docs/reference/generated/kubectl/kubectl-commands)
- [Deployment 가이드](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/)
- [Service 가이드](https://kubernetes.io/docs/concepts/services-networking/service/)
- [Ingress 가이드](https://kubernetes.io/docs/concepts/services-networking/ingress/)
- [ConfigMap 가이드](https://kubernetes.io/docs/concepts/configuration/configmap/)
- [Secret 가이드](https://kubernetes.io/docs/concepts/configuration/secret/)
- [PersistentVolume 가이드](https://kubernetes.io/docs/concepts/storage/persistent-volumes/)
## 12. 검증 보고서

### 검증 개요

전체 Kubernetes 설정 및 배포 자동화 시스템에 대한 종합적인 검증이 완료되었습니다. 상세한 검증 결과는 [VALIDATION_REPORT.md](VALIDATION_REPORT.md)를 참고하세요.

### 검증 항목

1. **YAML 문법 검증** ✅
   - 모든 K8s 매니페스트 파일의 문법 검증 완료
   - 수정된 파일: ingress.yaml, ingress-nginx-values.yaml

2. **Docker Compose ↔ Kubernetes 매핑** ✅
   - 모든 서비스의 매핑 상태 확인 완료
   - 환경변수, 포트, 네트워크 설정 검증 완료

3. **GitHub Actions 워크플로우** ⚠️
   - 일부 워크플로우에서 네임스페이스 불일치 문제 발견
   - 이미지 태그 업데이트 로직 개선 필요

4. **배포 스크립트** ✅
   - 쉘 문법 검증 통과
   - 실행 권한 확인 완료 (0755)

5. **설정 일관성** ⚠️
   - 이미지 태그 패턴 일부 불일치
   - 환경변수 참조 방식 통일 필요

6. **보안 검증** ✅
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

---

## 부록: 빠른 시작 스크립트

전체 배포를 자동화하는 스크립트는 `deploy.sh` 파일을 참고하세요.

```bash
# 배포 스크립트 실행 (선택적)
chmod +x deploy.sh
./deploy.sh
```

이 가이드가 Skald 애플리케이션의 Kubernetes 배포에 도움이 되기를 바랍니다. 문제가 발생할 경우 트러블슈팅 섹션을 참고하거나 Kubernetes 공식 문서를 확인하세요.