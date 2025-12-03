#!/bin/bash

# Skald Kubernetes 배포 자동화 스크립트
# 이 스크립트는 Skald 애플리케이션의 전체 배포 과정을 자동화합니다.

set -e  # 오류 발생 시 스크립트 중단

# 색상 정의
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 로그 함수
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# 설정 변수
NAMESPACE="skald"
IMAGE_TAG="${IMAGE_TAG:-latest}"
DOCKER_REGISTRY="${DOCKER_REGISTRY:-ghcr.io/skaldlabs}"
echo "DOCKER_REGISTRY : $DOCKER_REGISTRY"
SKIP_INGRESS="${SKIP_INGRESS:-false}"

# 환경 변수 파일
ENV_FILE="${ENV_FILE:-.env.prod}"

# 언디플로이 관련 변수
UNDEPLOY_MODE="false"
FORCE_UNDEPLOY="false"
KEEP_DATA="false"

# 강제 응답 관련 변수
FORCE_YES="false"

# 환경 변수 로드 함수
load_env_file() {
    if [ -f "$ENV_FILE" ]; then
        log_info "Loading environment variables from $ENV_FILE..."
        set -a
        source "$ENV_FILE"
        set +a
        log_success "Environment variables loaded from $ENV_FILE"
    else
        log_warning "Environment file $ENV_FILE not found, using defaults"
    fi
}

# ConfigMap 생성 함수 (환경 변수 기반)
generate_configmap_from_env() {
    log_info "Generating ConfigMap from environment variables..."
    
    cat > /tmp/skald-configmap.yaml << EOF
apiVersion: v1
kind: ConfigMap
metadata:
  name: skald-config
  namespace: $NAMESPACE
data:
  # Domain Configuration
  API_DOMAIN: "${API_DOMAIN:-api.skald.local}"
  UI_DOMAIN: "${UI_DOMAIN:-ui.skald.local}"
  ACME_EMAIL: "${ACME_EMAIL:-admin@skald.local}"
  
  # Database Configuration
  POSTGRES_DB: "${POSTGRES_DB:-skald2}"
  POSTGRES_USER: "${POSTGRES_USER:-postgres}"
  DB_HOST: "postgres-service"
  DB_PORT: "5432"
  
  # RabbitMQ Configuration
  RABBITMQ_HOST: "rabbitmq-service"
  RABBITMQ_PORT: "5672"
  RABBITMQ_USER: "${RABBITMQ_USER:-skald}"
  RABBITMQ_VHOST: "/"
  INTER_PROCESS_QUEUE: "rabbitmq"
  
  # Redis Configuration
  REDIS_HOST: "redis-service"
  REDIS_PORT: "6379"
  
  # Application Configuration
  IS_SELF_HOSTED_DEPLOY: "true"
  LLM_PROVIDER: "${LLM_PROVIDER:-openai}"
  EMBEDDING_PROVIDER: "${EMBEDDING_PROVIDER:-openai}"
  DOCUMENT_EXTRACTION_PROVIDER: "${DOCUMENT_EXTRACTION_PROVIDER:-docling}"
  EMBEDDING_SERVICE_URL: "http://embedding-service-service:8000"
  DOCLING_SERVICE_URL: "http://docling-service:5001"
  SECURE_SSL_REDIRECT: "false"
  EXPRESS_SERVER_PORT: "8000"
  
  # Frontend Configuration
  FRONTEND_URL: "https://${UI_DOMAIN:-ui.skald.local}"
  API_URL: "https://${API_DOMAIN:-api.skald.local}"
  
  # LangSmith Configuration (optional)
  LANGSMITH_TRACING: "${LANGSMITH_TRACING:-false}"
  LANGSMITH_ENDPOINT: "${LANGSMITH_ENDPOINT:-}"
  LANGSMITH_PROJECT: "${LANGSMITH_PROJECT:-}"
  
  # Local LLM Configuration (optional)
  LOCAL_LLM_BASE_URL: "${LOCAL_LLM_BASE_URL:-}"
  LOCAL_LLM_MODEL: "${LOCAL_LLM_MODEL:-}"
  
  # Local Embedding Configuration (optional)
  LOCAL_EMBEDDING_MODEL: "${LOCAL_EMBEDDING_MODEL:-all-MiniLM-L6-v2}"
  LOCAL_RERANK_MODEL: "${LOCAL_RERANK_MODEL:-cross-encoder/ms-marco-MiniLM-L-6-v2}"
  TARGET_DIMENSION: "2048"
EOF

    if kubectl apply -f /tmp/skald-configmap.yaml; then
        log_success "ConfigMap generated and applied successfully"
        rm -f /tmp/skald-configmap.yaml
        return 0
    else
        log_error "Failed to apply ConfigMap"
        rm -f /tmp/skald-configmap.yaml
        return 1
    fi
}

# 대기 함수
wait_for_pods() {
    local label=$1
    local timeout=${2:-300}
    log_info "Waiting for pods with label '$label' to be ready..."
    
    if kubectl wait --for=condition=ready pod -l "$label" -n "$NAMESPACE" --timeout="${timeout}s"; then
        log_success "Pods with label '$label' are ready"
        return 0
    else
        log_error "Timeout waiting for pods with label '$label'"
        return 1
    fi
}

# 서비스 상태 확인 함수
check_service_health() {
    local service_name=$1
    local namespace=${2:-$NAMESPACE}
    local timeout=${3:-60}
    
    log_info "Checking service health for $service_name..."
    
    # 서비스 존재 확인
    if ! kubectl get svc "$service_name" -n "$namespace" &>/dev/null; then
        log_error "Service $service_name not found"
        return 1
    fi
    
    # 엔드포인트 확인
    local endpoints
    endpoints=$(kubectl get endpoints "$service_name" -n "$namespace" -o jsonpath='{.subsets[*].addresses[*].ip}' 2>/dev/null)
    
    if [ -z "$endpoints" ]; then
        log_warning "Service $service_name has no ready endpoints"
        return 1
    fi
    
    log_success "Service $service_name is healthy with endpoints: $endpoints"
    return 0
}

# 롤링 업데이트 함수
rolling_update() {
    local deployment_name=$1
    local new_image=$2
    local timeout=${3:-300}
    
    log_info "Starting rolling update for $deployment_name to $new_image..."
    
    # 이미지 업데이트
    if kubectl set image deployment/"$deployment_name" "$deployment_name"="$new_image" -n "$NAMESPACE"; then
        log_success "Image updated for $deployment_name"
    else
        log_error "Failed to update image for $deployment_name"
        return 1
    fi
    
    # 롤링 업데이트 대기
    if kubectl rollout status deployment/"$deployment_name" -n "$NAMESPACE" --timeout="${timeout}s"; then
        log_success "Rolling update completed for $deployment_name"
        return 0
    else
        log_error "Rolling update failed for $deployment_name"
        return 1
    fi
}

# 롤백 함수
rollback_deployment() {
    local deployment_name=$1
    local revision=${2:-1}
    
    log_info "Rolling back $deployment_name to revision $revision..."
    
    if kubectl rollout undo deployment/"$deployment_name" -n "$NAMESPACE" --to-revision="$revision"; then
        log_success "Rollback completed for $deployment_name"
        return 0
    else
        log_error "Rollback failed for $deployment_name"
        return 1
    fi
}

# 배포 상태 확인 함수
check_deployment_status() {
    local deployment_name=$1
    local namespace=${2:-$NAMESPACE}
    
    log_info "Checking deployment status for $deployment_name..."
    
    # 배포 상태 확인
    local status
    status=$(kubectl get deployment "$deployment_name" -n "$namespace" -o jsonpath='{.status.conditions[?(@.type=="Progressing")].status}' 2>/dev/null)
    
    if [ "$status" = "True" ]; then
        local replicas
        local ready_replicas
        replicas=$(kubectl get deployment "$deployment_name" -n "$namespace" -o jsonpath='{.spec.replicas}' 2>/dev/null)
        ready_replicas=$(kubectl get deployment "$deployment_name" -n "$namespace" -o jsonpath='{.status.readyReplicas}' 2>/dev/null)
        
        log_success "Deployment $deployment_name is progressing (Ready: $ready_replicas/$replicas)"
        return 0
    else
        log_error "Deployment $deployment_name is not progressing"
        return 1
    fi
}

# 사전 체크 함수
check_prerequisites() {
    log_info "사전 요구사항 확인 중..."
    
    # kubectl 확인
    if ! command -v kubectl &> /dev/null; then
        log_error "kubectl이 설치되어 있지 않습니다. 설치 후 다시 시도하세요."
        exit 1
    fi
    
    # 클러스터 접속 확인
    if ! kubectl cluster-info &> /dev/null; then
        log_error "Kubernetes 클러스터에 접속할 수 없습니다. kubectl 설정을 확인하세요."
        exit 1
    fi
    
    # 네임스페이스 중복 확인
    if kubectl get namespace "$NAMESPACE" &> /dev/null; then
        log_warning "네임스페이스 '$NAMESPACE'가 이미 존재합니다. 기존 리소스를 덮어쓸 수 있습니다."
        if [ "$FORCE_YES" = "false" ]; then
            read -p "계속 진행하시겠습니까? (y/N): " -n 1 -r
            echo
            if [[ ! $REPLY =~ ^[Yy]$ ]]; then
                log_info "배포를 취소합니다."
                exit 0
            fi
        else
            log_info "FORCE_YES 모드 활성화 - 확인 없이 진행합니다."
        fi
    fi
    
    log_success "사전 요구사항 확인 완료"
}

# Step 1: 네임스페이스 생성
create_namespace() {
    log_info "Step 1: 네임스페이스 생성"
    
    if kubectl apply -f namespace.yaml; then
        log_success "네임스페이스 '$NAMESPACE' 생성 완료"
    else
        log_error "네임스페이스 생성 실패"
        exit 1
    fi
}

# Step 2: Traefik Ingress Controller 배포
deploy_traefik() {
    if [ "$SKIP_INGRESS" = "true" ]; then
        log_warning "Traefik 배포를 건너뜁니다 (SKIP_INGRESS=true)"
        return 0
    fi
    
    log_info "Step 2: Traefik Ingress Controller 배포"
    
    # Traefik 배포
    if kubectl apply -f traefik-deployment.yaml; then
        log_success "Traefik Ingress Controller 배포 완료"
    else
        log_error "Traefik Ingress Controller 배포 실패"
        exit 1
    fi
    
    # Traefik Pod 준비 대기 (default 네임스페이스에서 확인)
    log_info "Waiting for traefik pods to be ready..."
    if kubectl wait --for=condition=ready pod -l "app=traefik" -n "default" --timeout="600s"; then
        log_success "Traefik pods are ready"
    else
        log_error "Timeout waiting for traefik pods"
        exit 1
    fi
    
    # Traefik 서비스 확인
    log_info "Traefik 서비스 확인 중..."
    kubectl get svc traefik -n default
    
    log_success "Traefik Ingress Controller 준비 완료"
}

# Step 2: ConfigMap 및 Secret 생성
create_configs() {
    log_info "Step 2: ConfigMap 및 Secret 생성"
    
    # ConfigMap 생성
    if kubectl apply -f configmap.yaml -n "$NAMESPACE"; then
        log_success "ConfigMap 생성 완료"
    else
        log_error "ConfigMap 생성 실패"
        exit 1
    fi
    
    # 초기화 스크립트 ConfigMap 생성
    if kubectl apply -f init-scripts-configmap.yaml -n "$NAMESPACE"; then
        log_success "초기화 스크립트 ConfigMap 생성 완료"
    else
        log_error "초기화 스크립트 ConfigMap 생성 실패"
        exit 1
    fi
    
    # Secret 확인
    if [ ! -f "secret.yaml" ]; then
        log_warning "secret.yaml 파일이 없습니다. secret.yaml.example를 복사하여 설정하세요."
        log_info "cp secret.yaml.example secret.yaml"
        log_info "secret.yaml 파일의 모든 플레이스홀더 값을 실제 값으로 교체한 후 다시 실행하세요."
        exit 1
    fi
    
    # Secret 생성
    if kubectl apply -f secret.yaml -n "$NAMESPACE"; then
        log_success "Secret 생성 완료"
    else
        log_error "Secret 생성 실패"
        exit 1
    fi
}

# Step 3: PersistentVolumeClaim 생성
create_pvcs() {
    log_info "Step 3: PersistentVolumeClaim 생성 (StatefulSet에서 volumeClaimTemplates 사용으로 인해 불필요 - 생략)"
    
    # PostgreSQL PVC 생성 (StatefulSet에서 volumeClaimTemplates 사용으로 인해 제거)
    # RabbitMQ PVC 생성 (StatefulSet에서 volumeClaimTemplates 사용으로 인해 제거)
    
    # PVC 바인딩 대기 (생략)
    log_info "PVC 생성 생략됨 (StatefulSet에서 volumeClaimTemplates 사용)"
}

# Step 4: PostgreSQL, RabbitMQ 및 Redis 배포
deploy_infrastructure() {
    log_info "Step 4: PostgreSQL, RabbitMQ 및 Redis 배포"

    # PostgreSQL 배포
    if kubectl apply -f postgres-deployment.yaml -n "$NAMESPACE"; then
        log_success "PostgreSQL Deployment 생성 완료"
    else
        log_error "PostgreSQL Deployment 생성 실패"
        exit 1
    fi

    if kubectl apply -f postgres-service.yaml -n "$NAMESPACE"; then
        log_success "PostgreSQL Service 생성 완료"
    else
        log_error "PostgreSQL Service 생성 실패"
        exit 1
    fi

    # RabbitMQ 배포
    if kubectl apply -f rabbitmq-deployment.yaml -n "$NAMESPACE"; then
        log_success "RabbitMQ Deployment 생성 완료"
    else
        log_error "RabbitMQ Deployment 생성 실패"
        exit 1
    fi

    if kubectl apply -f rabbitmq-service.yaml -n "$NAMESPACE"; then
        log_success "RabbitMQ Service 생성 완료"
    else
        log_error "RabbitMQ Service 생성 실패"
        exit 1
    fi

    # Redis 배포
    if kubectl apply -f redis-deployment.yaml -n "$NAMESPACE"; then
        log_success "Redis Deployment 생성 완료"
    else
        log_error "Redis Deployment 생성 실패"
        exit 1
    fi

    if kubectl apply -f redis-service.yaml -n "$NAMESPACE"; then
        log_success "Redis Service 생성 완료"
    else
        log_error "Redis Service 생성 실패"
        exit 1
    fi

    # 인프라 Pod 준비 대기
    wait_for_pods "component=postgres" 300
    wait_for_pods "component=rabbitmq" 300
    wait_for_pods "component=redis" 300
}

# Step 5: Backend 서비스 배포
deploy_backend() {
    log_info "Step 5: Backend 서비스 배포"
    
    # 환경변수 치환을 위한 임시 파일 생성
    sed "s|\${DOCKER_REGISTRY:-skaldlabs}|$DOCKER_REGISTRY|g" api-deployment.yaml | \
    sed "s|\${IMAGE_TAG:-latest}|$IMAGE_TAG|g" > /tmp/api-deployment.yaml
    echo "API Deployment 임시 파일 생성 완료: /tmp/api-deployment.yaml"
    echo "DOCKER_REGISTRY in temp file: $(grep 'image:' /tmp/api-deployment.yaml)"
    
    # API 서비스 배포
    if kubectl apply -f /tmp/api-deployment.yaml -n "$NAMESPACE"; then
        log_success "API Deployment 생성 완료"
    else
        log_error "API Deployment 생성 실패"
        exit 1
    fi
    
    if kubectl apply -f api-service.yaml -n "$NAMESPACE"; then
        log_success "API Service 생성 완료"
    else
        log_error "API Service 생성 실패"
        exit 1
    fi
    
    # Memo Processing 서비스 배포
    sed "s|\${DOCKER_REGISTRY:-skaldlabs}|$DOCKER_REGISTRY|g" memo-processing-deployment.yaml | \
    sed "s|\${IMAGE_TAG:-latest}|$IMAGE_TAG|g" > /tmp/memo-processing-deployment.yaml
    
    if kubectl apply -f /tmp/memo-processing-deployment.yaml -n "$NAMESPACE"; then
        log_success "Memo Processing Deployment 생성 완료"
    else
        log_error "Memo Processing Deployment 생성 실패"
        exit 1
    fi
    
    # Backend Pod 준비 대기
    wait_for_pods "component=api" 300
    wait_for_pods "component=memo-processing" 300
    
    # 임시 파일 정리
    rm -f /tmp/api-deployment.yaml /tmp/memo-processing-deployment.yaml
}

# Step 6: AI 서비스 배포
deploy_ai_services() {
    log_info "Step 6: AI 서비스 배포"
    
    # Embedding Service 배포
    sed "s|\${DOCKER_REGISTRY:-skaldlabs}|$DOCKER_REGISTRY|g" embedding-service-deployment.yaml | \
    sed "s|\${IMAGE_TAG:-latest}|$IMAGE_TAG|g" > /tmp/embedding-service-deployment.yaml
    
    if kubectl apply -f /tmp/embedding-service-deployment.yaml -n "$NAMESPACE"; then
        log_success "Embedding Service Deployment 생성 완료"
    else
        log_error "Embedding Service Deployment 생성 실패"
        exit 1
    fi
    
    if kubectl apply -f embedding-service-service.yaml -n "$NAMESPACE"; then
        log_success "Embedding Service Service 생성 완료"
    else
        log_error "Embedding Service Service 생성 실패"
        exit 1
    fi
    
    # Docling Service 배포
    if kubectl apply -f docling-deployment.yaml -n "$NAMESPACE"; then
        log_success "Docling Service Deployment 생성 완료"
    else
        log_error "Docling Service Deployment 생성 실패"
        exit 1
    fi
    
    if kubectl apply -f docling-service.yaml -n "$NAMESPACE"; then
        log_success "Docling Service Service 생성 완료"
    else
        log_error "Docling Service Service 생성 실패"
        exit 1
    fi
    
    # AI 서비스 Pod 준비 대기
    wait_for_pods "component=embedding-service" 300
    wait_for_pods "component=docling-service" 300
    
    # 임시 파일 정리
    rm -f /tmp/embedding-service-deployment.yaml
}

# Step 7: Frontend UI 배포
deploy_frontend() {
    log_info "Step 7: Frontend UI 배포"
    
    # UI Nginx ConfigMap 생성 (API 프록시 설정)
    if kubectl apply -f ui-nginx-configmap.yaml -n "$NAMESPACE"; then
        log_success "UI Nginx ConfigMap 생성 완료"
    else
        log_error "UI Nginx ConfigMap 생성 실패"
        exit 1
    fi
    
    # 환경변수 치환을 위한 임시 파일 생성
    sed "s|\${DOCKER_REGISTRY:-skaldlabs}|$DOCKER_REGISTRY|g" ui-deployment.yaml | \
    sed "s|\${IMAGE_TAG:-latest}|$IMAGE_TAG|g" > /tmp/ui-deployment.yaml
    
    if kubectl apply -f /tmp/ui-deployment.yaml -n "$NAMESPACE"; then
        log_success "UI Deployment 생성 완료"
    else
        log_error "UI Deployment 생성 실패"
        exit 1
    fi
    
    if kubectl apply -f ui-service.yaml -n "$NAMESPACE"; then
        log_success "UI Service 생성 완료"
    else
        log_error "UI Service 생성 실패"
        exit 1
    fi
    
    # UI Pod 준비 대기
    wait_for_pods "component=ui" 300
    
    # 임시 파일 정리
    rm -f /tmp/ui-deployment.yaml
}

# Step 8: Ingress 설정
deploy_ingress() {
    if [ "$SKIP_INGRESS" = "true" ]; then
        log_warning "Ingress 배포를 건너뜁니다 (SKIP_INGRESS=true)"
        return 0
    fi
    
    log_info "Step 8: Ingress 설정"
    
    if kubectl apply -f ingress.yaml -n "$NAMESPACE"; then
        log_success "Ingress 생성 완료"
    else
        log_error "Ingress 생성 실패"
        exit 1
    fi
    
    # Ingress 준비 대기
    log_info "Ingress 준비 대기 중..."
    sleep 10
}

# 배포 확인
verify_deployment() {
    log_info "배포 확인 중..."
    
    # 모든 Pod 상태 확인
    log_info "모든 Pod 상태:"
    kubectl get pods -n "$NAMESPACE" -o wide
    
    # 모든 서비스 상태 확인
    log_info "모든 서비스 상태:"
    kubectl get services -n "$NAMESPACE"
    
    # PVC 상태 확인
    log_info "PVC 상태:"
    kubectl get pvc -n "$NAMESPACE"
    
    # StatefulSet 상태 확인
    log_info "StatefulSet 상태:"
    kubectl get statefulsets -n "$NAMESPACE"
    
    # Deployment 상태 확인
    log_info "Deployment 상태:"
    kubectl get deployments -n "$NAMESPACE"
    
    # IngressRoute 상태 확인 (Traefik)
    if kubectl get ingressroute -n "$NAMESPACE" &> /dev/null; then
        log_info "IngressRoute 상태:"
        kubectl get ingressroute -n "$NAMESPACE"
    fi
    
    # 서비스 상세 상태 확인
    verify_service_health
    
    # Ingress 설정 검증
    verify_ingress_configuration
    
    log_success "배포 확인 완료"
}

# 서비스 상세 상태 확인 함수
verify_service_health() {
    log_info "서비스 상세 상태 확인 중..."
    
    local services=("postgres-service" "rabbitmq-service" "redis-service" "api-service" "ui-service" "embedding-service-service" "docling-service")
    
    for service in "${services[@]}"; do
        if kubectl get svc "$service" -n "$NAMESPACE" &>/dev/null; then
            check_service_health "$service" "$NAMESPACE"
            
            # 서비스 엔드포인트 상세 정보
            local endpoints
            endpoints=$(kubectl get endpoints "$service" -n "$NAMESPACE" -o jsonpath='{.subsets[*].addresses[*].ip}' 2>/dev/null)
            if [ -n "$endpoints" ]; then
                log_success "  $service 엔드포인트: $endpoints"
            else
                log_warning "  $service 엔드포인트 없음"
            fi
        else
            log_warning "  $service 서비스를 찾을 수 없음"
        fi
    done
}

# Ingress 설정 검증 함수
verify_ingress_configuration() {
    log_info "Ingress 설정 검증 중..."
    
    # Traefik 서비스 확인
    if kubectl get svc traefik -n default &>/dev/null; then
        local traefik_ip
        traefik_ip=$(kubectl get svc traefik -n default -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null)
        if [ -n "$traefik_ip" ]; then
            log_success "Traefik LoadBalancer IP: $traefik_ip"
        else
            log_warning "Traefik LoadBalancer IP를 확인할 수 없음"
        fi
    fi
    
    # IngressRoute 확인
    if kubectl get ingressroute -n "$NAMESPACE" &>/dev/null; then
        local ingress_routes
        ingress_routes=$(kubectl get ingressroute -n "$NAMESPACE" -o jsonpath='{.items[*].metadata.name}' 2>/dev/null)
        for route in $ingress_routes; do
            log_info "IngressRoute $route 확인 중..."
            if kubectl get ingressroute "$route" -n "$NAMESPACE" -o yaml | grep -q "namespace: $NAMESPACE"; then
                log_success "  $route 네임스페이스 설정 올바름"
            else
                log_warning "  $route 네임스페이스 설정 확인 필요"
            fi
        done
    fi
    
    # 도메인 설정 확인
    if [ -n "$API_DOMAIN" ] && [ -n "$UI_DOMAIN" ]; then
        log_info "도메인 설정:"
        log_info "  API 도메인: $API_DOMAIN"
        log_info "  UI 도메인: $UI_DOMAIN"
        
        # DNS 확인 (선택적)
        if command -v dig &> /dev/null; then
            log_info "DNS 확인 중..."
            if dig +short "$API_DOMAIN" &>/dev/null; then
                log_success "  $API_DOMAIN DNS 확인 성공"
            else
                log_warning "  $API_DOMAIN DNS 확인 실패"
            fi
            
            if dig +short "$UI_DOMAIN" &>/dev/null; then
                log_success "  $UI_DOMAIN DNS 확인 성공"
            else
                log_warning "  $UI_DOMAIN DNS 확인 실패"
            fi
        fi
    fi
}

# 접속 정보 출력
print_access_info() {
    log_info "접속 정보:"
    
    # Ingress 외부 IP 확인
    if kubectl get ingress -n "$NAMESPACE" &> /dev/null; then
        INGRESS_IP=$(kubectl get ingress skald-ingress -n "$NAMESPACE" -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || echo "N/A")
        if [ "$INGRESS_IP" != "N/A" ]; then
            echo -e "  ${GREEN}애플리케이션 URL: https://skald.example.com${NC}"
            echo -e "  ${GREEN}API URL: https://skald.example.com/api${NC}"
            echo -e "  ${GREEN}Ingress IP: $INGRESS_IP${NC}"
        else
            echo -e "  ${YELLOW}Ingress IP를 확인할 수 없습니다. LoadBalancer 설정을 확인하세요.${NC}"
        fi
    fi
    
    # Port-forward 정보
    echo -e "  ${BLUE}Port-forward 명령어:${NC}"
    echo -e "    API: kubectl port-forward -n $NAMESPACE svc/api-service 8000:8000"
    echo -e "    UI: kubectl port-forward -n $NAMESPACE svc/ui-service 3000:80"
    echo -e "    RabbitMQ: kubectl port-forward -n $NAMESPACE svc/rabbitmq-service 15672:15672"
    
    # RabbitMQ Management 접속 정보
    echo -e "  ${BLUE}RabbitMQ Management:${NC}"
    echo -e "    URL: http://localhost:15672 (port-forward 후)"
    echo -e "    사용자명: $(kubectl get configmap skald-config -n $NAMESPACE -o jsonpath='{.data.RABBITMQ_USER}')"
    echo -e "    비밀번호: secret.yaml에서 설정한 값"
}

# 언디플로이 확인 메시지 표시
show_undeploy_confirmation() {
    echo
    log_warning "언디플로이(삭제) 작업을 시작합니다."
    echo -e "${YELLOW}다음 리소스가 삭제됩니다:${NC}"
    echo -e "  - Ingress"
    echo -e "  - UI Deployment/Service"
    echo -e "  - AI 서비스 Deployment/Service"
    echo -e "  - Backend 서비스 Deployment/Service"
    echo -e "  - RabbitMQ Deployment/Service"
    echo -e "  - PostgreSQL Deployment/Service"
    echo -e "  - ConfigMap 및 Secret"
    
    if [ "$KEEP_DATA" = "false" ]; then
        echo -e "  - PVC (데이터가 삭제됩니다)"
    else
        echo -e "  - PVC (데이터 유지)"
    fi
    
    echo -e "${YELLOW}계속 진행하시겠습니까?${NC}"
    echo -e "네임스페이스: ${NAMESPACE}"
    
    if [ "$FORCE_UNDEPLOY" = "false" ] && [ "$FORCE_YES" = "false" ]; then
        read -p "계속하시려면 'yes'를 입력하세요: " -r
        echo
        if [[ ! $REPLY =~ ^[yY][eE][sS]$ ]]; then
            log_info "언디플로이를 취소합니다."
            exit 0
        fi
    else
        log_info "Force 모드 활성화 - 확인 없이 진행합니다."
    fi
}

# 언디플로이: Ingress 삭제
undeploy_ingress() {
    log_info "Step 1: Ingress 삭제 중..."
    
    if kubectl delete ingress skald-ingress -n "$NAMESPACE" --ignore-not-found=true; then
        log_success "Ingress 삭제 완료"
    else
        log_error "Ingress 삭제 실패"
        return 1
    fi
}

# 언디플로이: UI 리소스 삭제
undeploy_ui() {
    log_info "Step 2: UI Deployment/Service 삭제 중..."
    
    # UI Service 삭제
    if kubectl delete service ui-service -n "$NAMESPACE" --ignore-not-found=true; then
        log_success "UI Service 삭제 완료"
    else
        log_error "UI Service 삭제 실패"
        return 1
    fi
    
    # UI Deployment 삭제
    if kubectl delete deployment ui-deployment -n "$NAMESPACE" --ignore-not-found=true; then
        log_success "UI Deployment 삭제 완료"
    else
        log_error "UI Deployment 삭제 실패"
        return 1
    fi
}

# 언디플로이: AI 서비스 리소스 삭제
undeploy_ai_services() {
    log_info "Step 3: AI 서비스 Deployment/Service 삭제 중..."
    
    # Docling Service 삭제
    if kubectl delete service docling-service -n "$NAMESPACE" --ignore-not-found=true; then
        log_success "Docling Service 삭제 완료"
    else
        log_error "Docling Service 삭제 실패"
        return 1
    fi
    
    if kubectl delete deployment docling-deployment -n "$NAMESPACE" --ignore-not-found=true; then
        log_success "Docling Deployment 삭제 완료"
    else
        log_error "Docling Deployment 삭제 실패"
        return 1
    fi
    
    # Embedding Service 삭제
    if kubectl delete service embedding-service-service -n "$NAMESPACE" --ignore-not-found=true; then
        log_success "Embedding Service Service 삭제 완료"
    else
        log_error "Embedding Service Service 삭제 실패"
        return 1
    fi
    
    if kubectl delete deployment embedding-service-deployment -n "$NAMESPACE" --ignore-not-found=true; then
        log_success "Embedding Service Deployment 삭제 완료"
    else
        log_error "Embedding Service Deployment 삭제 실패"
        return 1
    fi
}

# 언디플로이: Backend 리소스 삭제
undeploy_backend() {
    log_info "Step 4: Backend 서비스 Deployment/Service 삭제 중..."
    
    # Memo Processing Service 삭제
    if kubectl delete deployment memo-processing-deployment -n "$NAMESPACE" --ignore-not-found=true; then
        log_success "Memo Processing Deployment 삭제 완료"
    else
        log_error "Memo Processing Deployment 삭제 실패"
        return 1
    fi
    
    # API Service 삭제
    if kubectl delete service api-service -n "$NAMESPACE" --ignore-not-found=true; then
        log_success "API Service 삭제 완료"
    else
        log_error "API Service 삭제 실패"
        return 1
    fi
    
    # API Deployment 삭제
    if kubectl delete deployment api-deployment -n "$NAMESPACE" --ignore-not-found=true; then
        log_success "API Deployment 삭제 완료"
    else
        log_error "API Deployment 삭제 실패"
        return 1
    fi
}

# 언디플로이: RabbitMQ 리소스 삭제
undeploy_rabbitmq() {
    log_info "Step 5: RabbitMQ StatefulSet/Service 삭제 중..."

    # RabbitMQ Service 삭제
    if kubectl delete service rabbitmq-service -n "$NAMESPACE" --ignore-not-found=true; then
        log_success "RabbitMQ Service 삭제 완료"
    else
        log_error "RabbitMQ Service 삭제 실패"
        return 1
    fi

    # RabbitMQ StatefulSet 삭제
    if kubectl delete statefulset rabbitmq -n "$NAMESPACE" --ignore-not-found=true; then
        log_success "RabbitMQ StatefulSet 삭제 완료"
    else
        log_error "RabbitMQ StatefulSet 삭제 실패"
        return 1
    fi
}

# 언디플로이: Redis 리소스 삭제
undeploy_redis() {
    log_info "Step 6: Redis Deployment/Service 삭제 중..."

    # Redis Service 삭제
    if kubectl delete service redis-service -n "$NAMESPACE" --ignore-not-found=true; then
        log_success "Redis Service 삭제 완료"
    else
        log_error "Redis Service 삭제 실패"
        return 1
    fi

    # Redis Deployment 삭제
    if kubectl delete deployment redis -n "$NAMESPACE" --ignore-not-found=true; then
        log_success "Redis Deployment 삭제 완료"
    else
        log_error "Redis Deployment 삭제 실패"
        return 1
    fi
}

# 언디플로이: PostgreSQL 리소스 삭제
undeploy_postgres() {
    log_info "Step 7: PostgreSQL StatefulSet/Service 삭제 중..."

    # PostgreSQL Service 삭제
    if kubectl delete service postgres-service -n "$NAMESPACE" --ignore-not-found=true; then
        log_success "PostgreSQL Service 삭제 완료"
    else
        log_error "PostgreSQL Service 삭제 실패"
        return 1
    fi

    # PostgreSQL StatefulSet 삭제
    if kubectl delete statefulset postgres -n "$NAMESPACE" --ignore-not-found=true; then
        log_success "PostgreSQL StatefulSet 삭제 완료"
    else
        log_error "PostgreSQL StatefulSet 삭제 실패"
        return 1
    fi
}

# 언디플로이: ReplicaSet 삭제
undeploy_replicasets() {
    log_info "Step 7: ReplicaSet 삭제 중..."

    # Deployment 삭제 후 남아있는 ReplicaSet 정리
    if kubectl delete replicasets --all -n "$NAMESPACE" --ignore-not-found=true; then
        log_success "모든 ReplicaSet 삭제 완료"
    else
        log_error "ReplicaSet 삭제 실패"
        return 1
    fi
}

# 언디플로이: PVC 삭제
undeploy_pvcs() {
    if [ "$KEEP_DATA" = "false" ]; then
        log_info "Step 7: PVC 삭제 중..."
        
        # PostgreSQL PVC 삭제
        if kubectl delete pvc postgres-pvc -n "$NAMESPACE" --ignore-not-found=true; then
            log_success "PostgreSQL PVC 삭제 완료"
        else
            log_error "PostgreSQL PVC 삭제 실패"
            return 1
        fi
        
        # RabbitMQ PVC 삭제
        if kubectl delete pvc rabbitmq-pvc -n "$NAMESPACE" --ignore-not-found=true; then
            log_success "RabbitMQ PVC 삭제 완료"
        else
            log_error "RabbitMQ PVC 삭제 실패"
            return 1
        fi
    else
        log_info "Step 7: PVC 삭제 생략 (--keep-data 옵션으로 인해 데이터 유지)"
    fi
}

# 언디플로이: ConfigMap 및 Secret 삭제
undeploy_configs() {
    log_info "Step 8: ConfigMap 및 Secret 삭제 중..."
    
    # ConfigMap 삭제
    if kubectl delete configmap skald-config -n "$NAMESPACE" --ignore-not-found=true; then
        log_success "ConfigMap 삭제 완료"
    else
        log_error "ConfigMap 삭제 실패"
        return 1
    fi
    
    # 초기화 스크립트 ConfigMap 삭제
    if kubectl delete configmap init-scripts -n "$NAMESPACE" --ignore-not-found=true; then
        log_success "초기화 스크립트 ConfigMap 삭제 완료"
    else
        log_error "초기화 스크립트 ConfigMap 삭제 실패"
        return 1
    fi
    
    # Secret 삭제
    if kubectl delete secret skald-secret -n "$NAMESPACE" --ignore-not-found=true; then
        log_success "Secret 삭제 완료"
    else
        log_error "Secret 삭제 실패"
        return 1
    fi
}

# 언디플로이: 네임스페이스 삭제
undeploy_namespace() {
    log_info "Step 9: 네임스페이스 삭제 중..."
    
    if kubectl delete namespace "$NAMESPACE" --ignore-not-found=true; then
        log_success "네임스페이스 '$NAMESPACE' 삭제 완료"
    else
        log_error "네임스페이스 삭제 실패"
        return 1
    fi
}

# 언디플로이 함수
undeploy() {
    echo -e "${BLUE}========================================${NC}"
    echo -e "${BLUE}    Skald Kubernetes 언디플로이 스크립트${NC}"
    echo -e "${BLUE}========================================${NC}"
    echo
    
    log_info "언디플로이 설정:"
    echo " 네임스페이스: $NAMESPACE"
    echo "  데이터 유지: $KEEP_DATA"
    echo "  강제 삭제: $FORCE_UNDEPLOY"
    echo
    
    show_undeploy_confirmation
    
    # 삭제 순서: Ingress -> UI -> AI 서비스 -> Backend -> RabbitMQ -> Redis -> PostgreSQL -> ReplicaSets -> PVC -> Configs -> Namespace
    undeploy_ingress || log_warning "Ingress 삭제 중 오류 발생"
    undeploy_ui || log_warning "UI 리소스 삭제 중 오류 발생"
    undeploy_ai_services || log_warning "AI 서비스 삭제 중 오류 발생"
    undeploy_backend || log_warning "Backend 리소스 삭제 중 오류 발생"
    undeploy_rabbitmq || log_warning "RabbitMQ 리소스 삭제 중 오류 발생"
    undeploy_redis || log_warning "Redis 리소스 삭제 중 오류 발생"
    undeploy_postgres || log_warning "PostgreSQL 리소스 삭제 중 오류 발생"
    undeploy_replicasets || log_warning "ReplicaSet 삭제 중 오류 발생"
    undeploy_pvcs || log_warning "PVC 삭제 중 오류 발생"
    
    # StatefulSet에서 생성된 PVC 삭제 (volumeClaimTemplates로 생성된 PVC들)
    if [ "$KEEP_DATA" = "false" ]; then
        log_info "StatefulSet에서 생성된 PVC 삭제 중..."
        
        # PostgreSQL 관련 PVC 삭제 (레이블 기반)
        postgres_pvcs=$(kubectl get pvc -n "$NAMESPACE" -l "app.kubernetes.io/instance=postgres" -o name 2>/dev/null || echo "")
        if [ -n "$postgres_pvcs" ]; then
            log_info "PostgreSQL 관련 PVC 삭제 중..."
            echo "$postgres_pvcs" | while read -r pvc; do
                if [ -n "$pvc" ]; then
                    pvc_name=$(kubectl get "$pvc" -n "$NAMESPACE" -o jsonpath='{.metadata.name}')
                    if kubectl delete "$pvc" -n "$NAMESPACE"; then
                        log_success "PostgreSQL PVC '$pvc_name' 삭제 완료"
                    else
                        log_error "PostgreSQL PVC '$pvc_name' 삭제 실패"
                    fi
                fi
            done
        else
            log_info "PostgreSQL 관련 PVC를 찾을 수 없습니다"
        fi
        
        # RabbitMQ 관련 PVC 삭제 (레이블 기반)
        rabbitmq_pvcs=$(kubectl get pvc -n "$NAMESPACE" -l "app.kubernetes.io/instance=rabbitmq" -o name 2>/dev/null || echo "")
        if [ -n "$rabbitmq_pvcs" ]; then
            log_info "RabbitMQ 관련 PVC 삭제 중..."
            echo "$rabbitmq_pvcs" | while read -r pvc; do
                if [ -n "$pvc" ]; then
                    pvc_name=$(kubectl get "$pvc" -n "$NAMESPACE" -o jsonpath='{.metadata.name}')
                    if kubectl delete "$pvc" -n "$NAMESPACE"; then
                        log_success "RabbitMQ PVC '$pvc_name' 삭제 완료"
                    else
                        log_error "RabbitMQ PVC '$pvc_name' 삭제 실패"
                    fi
                fi
            done
        else
            log_info "RabbitMQ 관련 PVC를 찾을 수 없습니다"
        fi
        
        # 삭제 확인
        log_info "PVC 삭제 확인 중..."
        remaining_pvcs=$(kubectl get pvc -n "$NAMESPACE" -o name)
        if [ -n "$remaining_pvcs" ]; then
            log_warning "삭제되지 않은 PVC 목록:"
            echo "$remaining_pvcs" | while read -r pvc; do
                if [ -n "$pvc" ]; then
                    pvc_name=$(kubectl get "$pvc" -n "$NAMESPACE" -o jsonpath='{.metadata.name}')
                    pvc_status=$(kubectl get "$pvc" -n "$NAMESPACE" -o jsonpath='{.status.phase}')
                    echo "  - $pvc_name (상태: $pvc_status)"
                    
                    # 강제 삭제 시도
                    log_info "강제 삭제 시도: $pvc_name"
                    kubectl delete "$pvc" -n "$NAMESPACE" --force --grace-period=0 || true
                fi
            done
        else
            log_success "모든 PVC가 삭제되었습니다"
        fi
    fi
    
    # 남아있는 Pod 강제 종료
    log_info "남아있는 Pod 확인 및 강제 종료 중..."
    remaining_pods=$(kubectl get pods -n "$NAMESPACE" -o name)
    if [ -n "$remaining_pods" ]; then
        log_warning "삭제되지 않은 Pod 목록:"
        echo "$remaining_pods" | while read -r pod; do
            if [ -n "$pod" ]; then
                pod_name=$(kubectl get "$pod" -n "$NAMESPACE" -o jsonpath='{.metadata.name}')
                pod_status=$(kubectl get "$pod" -n "$NAMESPACE" -o jsonpath='{.status.phase}')
                echo "  - $pod_name (상태: $pod_status)"
                
                # 강제 삭제 시도
                log_info "강제 삭제 시도: $pod_name"
                kubectl delete "$pod" -n "$NAMESPACE" --force --grace-period=0 || true
            fi
        done
        
        # 삭제 확인
        sleep 5
        remaining_pods_after=$(kubectl get pods -n "$NAMESPACE" -o name)
        if [ -n "$remaining_pods_after" ]; then
            log_warning "여전히 삭제되지 않은 Pod이 존재합니다:"
            echo "$remaining_pods_after" | while read -r pod; do
                if [ -n "$pod" ]; then
                    pod_name=$(kubectl get "$pod" -n "$NAMESPACE" -o jsonpath='{.metadata.name}')
                    pod_status=$(kubectl get "$pod" -n "$NAMESPACE" -o jsonpath='{.status.phase}')
                    echo "  - $pod_name (상태: $pod_status)"
                fi
            done
        else
            log_success "모든 Pod이 삭제되었습니다"
        fi
    else
        log_success "남아있는 Pod이 없습니다"
    fi
    
    # ConfigMap 및 Secret 삭제
    undeploy_configs || log_warning "ConfigMap/Secret 삭제 중 오류 발생"
    
    # 남아있는 StatefulSet이 있는지 확인 및 정리
    log_info "남아있는 StatefulSet/Deployment/ReplicaSet 확인 및 정리 중..."
    remaining_deployments=$(kubectl get deployments -n "$NAMESPACE" -o name 2>/dev/null || echo "")
    remaining_statefulsets=$(kubectl get statefulsets -n "$NAMESPACE" -o name 2>/dev/null || echo "")
    remaining_replicasets=$(kubectl get replicasets -n "$NAMESPACE" -o name 2>/dev/null || echo "")

    if [ -n "$remaining_deployments" ] || [ -n "$remaining_statefulsets" ] || [ -n "$remaining_replicasets" ]; then
        log_warning "삭제되지 않은 컨트롤러 리소스 발견 - 강제 정리 시도"
        kubectl delete deployments,daemonsets,replicasets,statefulsets --all -n "$NAMESPACE" --force --grace-period=0 --ignore-not-found=true
        log_success "남아있는 컨트롤러 리소스 강제 정리 완료"
    else
        log_success "모든 컨트롤러 리소스가 정상적으로 삭제되었습니다"
    fi

    # 네임스페이스의 모든 리소스 확인 및 삭제
    log_info "네임스페이스 '$NAMESPACE'의 모든 리소스 확인 중..."
    all_resources=$(kubectl api-resources --verbs=delete --namespaced -o name | tr '\n' ',' | sed 's/,$//')
    
    if [ -n "$all_resources" ]; then
        log_warning "네임스페이스 '$NAMESPACE'에 남아있는 모든 리소스를 삭제합니다..."
        if kubectl delete $all_resources --all -n "$NAMESPACE" --ignore-not-found=true; then
            log_success "네임스페이스의 모든 리소스 삭제 완료"
        else
            log_warning "일부 리소스 삭제 중 오류 발생"
        fi
    fi
    
    # 네임스페이스 삭제
    log_warning "네임스페이스 '$NAMESPACE'를 삭제합니다. 이 작업은 되돌릴 수 없습니다."
    if [ "$FORCE_UNDEPLOY" = "false" ] && [ "$FORCE_YES" = "false" ]; then
        read -p "네임스페이스를 삭제하시겠습니까? (yes/no): " -r
        echo
        if [[ ! $REPLY =~ ^[yY][eE][sS]$ ]]; then
            log_info "네임스페이스 삭제를 취소합니다."
            log_info "네임스페이스를 수동으로 삭제하려면 다음 명령어를 사용하세요:"
            echo "  kubectl delete namespace $NAMESPACE"
            return 0
        fi
    fi
    
    undeploy_namespace || log_warning "네임스페이스 삭제 중 오류 발생"
    
    log_success "Skald 애플리케이션 언디플로이가 완료되었습니다!"
}

# 메인 함수
main() {
    if [ "$UNDEPLOY_MODE" = "true" ]; then
        undeploy
    else
        echo -e "${BLUE}========================================${NC}"
        echo -e "${BLUE}    Skald Kubernetes 배포 스크립트${NC}"
        echo -e "${BLUE}========================================${NC}"
        echo
        
        # 환경변수 출력
        log_info "배포 설정:"
        echo "  네임스페이스: $NAMESPACE"
        echo "  이미지 태그: $IMAGE_TAG"
        echo "  도커 레지스트리: $DOCKER_REGISTRY"
        echo "  Ingress 건너뛰기: $SKIP_INGRESS"
        echo
        
        # 환경 변수 로드
        load_env_file
        
        # 배포 단계 실행
        check_prerequisites
        create_namespace
        deploy_traefik
        
        # ConfigMap 및 Secret 생성 (환경 변수 기반)
        generate_configmap_from_env
        create_configs
        
        create_pvcs  # PVC 생성 함수는 호출되지만 내부 로직 생략됨
        deploy_infrastructure
        deploy_backend
        deploy_ai_services
        deploy_frontend
        deploy_ingress
        verify_deployment
        print_access_info
        
        echo
        log_success "Skald 애플리케이션 배포가 완료되었습니다!"
        echo
        log_info "문제 해결을 위해 다음 명령어를 사용하세요:"
        echo "  Pod 상태 확인: kubectl get pods -n $NAMESPACE"
        echo "  로그 확인: kubectl logs -f deployment/<deployment-name> -n $NAMESPACE"
        echo "  서비스 확인: kubectl get services -n $NAMESPACE"
        echo
        log_info "자세한 정보는 README.md를 참고하세요."
    fi
}

# 도움말 함수
show_help() {
    echo "Skald Kubernetes 배포/언디플로이 스크립트"
    echo
    echo "사용법:"
    echo " $0 [옵션]"
    echo
    echo "배포 옵션:"
    echo "  -h, --help              이 도움말을 표시합니다"
    echo " -t, --tag TAG          사용할 이미지 태그 (기본값: latest)"
    echo " -r, --registry REGISTRY 사용할 도커 레지스트리 (기본값: docker.io)"
    echo "  --skip-ingress          Ingress 배포를 건너뜁니다"
    echo "  -y, --yes               확인 프롬프트를 건너뛰고 모든 질문에 'yes'로 자동 응답합니다"
    echo
    echo "언디플로이 옵션:"
    echo "  --undeploy, --delete    언디플로이(삭제) 모드로 실행"
    echo "  --keep-data             PVC 삭제하지 않고 데이터 유지"
    echo "  --force                 확인 없이 강제 삭제"
    echo
    echo "환경변수:"
    echo "  IMAGE_TAG              이미지 태그 (기본값: latest)"
    echo "  DOCKER_REGISTRY        도커 레지스트리 (기본값: ghcr.io/skaldlabs)"
    echo "  SKIP_INGRESS           Ingress 건너뛰기 (기본값: false)"
    echo "  ENV_FILE              환경 변수 파일 경로 (기본값: .env.prod)"
    echo
    echo "예시:"
    echo "  $0                                    # 기본 설정으로 배포"
    echo " $0 -t v1.0.0                         # 특정 태그로 배포"
    echo "  $0 -r my-registry.com -t v1.0.0     # 특정 레지스트리와 태그로 배포"
    echo "  $0 --skip-ingress                     # Ingress 없이 배포"
    echo "  $0 -y                                 # 확인 없이 배포"
    echo "  $0 --yes                              # 확인 없이 배포"
    echo "  $0 --undeploy                         # 전체 삭제 (데이터 포함)"
    echo "  $0 --undeploy --keep-data             # 데이터 유지하고 삭제"
    echo "  $0 --undeploy --force                 # 확인 없이 강제 삭제"
    echo "  $0 --undeploy -y                      # 언디플로이 시 확인 없이 진행"
}

# 인자 파싱
while [[ $# -gt 0 ]]; do
    case $1 in
        -h|--help)
            show_help
            exit 0
            ;;
        -t|--tag)
            IMAGE_TAG="$2"
            shift 2
            ;;
        -r|--registry)
            DOCKER_REGISTRY="$2"
            shift 2
            ;;
        --skip-ingress)
            SKIP_INGRESS="true"
            shift
            ;;
        --undeploy|--delete)
            UNDEPLOY_MODE="true"
            shift
            ;;
        --keep-data)
            KEEP_DATA="true"
            shift
            ;;
        --force)
            FORCE_UNDEPLOY="true"
            shift
            ;;
        -y|--yes)
            FORCE_YES="true"
            shift
            ;;
        *)
            log_error "알 수 없는 옵션: $1"
            show_help
            exit 1
            ;;
    esac
done

# 스크립트 실행
main "$@"
