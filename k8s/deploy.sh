#!/bin/bash

# Skald Kubernetes 배포 자동화 스크립트
# 이 스크립트는 Skald 애플리케이션의 전체 배포 과정을 자동화합니다.

set -e  # 오류 발생 시 스크립트 중단

# Reserved Hermes deployment inputs are caller-only. Capture their values before
# defaults or ENV_FILE data can alter them; the dotenv loader exports only the
# explicit non-secret application-setting allowlist.
readonly HERMES_IMAGE_CALLER_VALUE="${HERMES_IMAGE-}"
readonly HERMES_CI_RECEIPT_FILE_CALLER_VALUE="${HERMES_CI_RECEIPT_FILE-}"
readonly HERMES_PROVENANCE_BUNDLE_CALLER_VALUE="${HERMES_PROVENANCE_BUNDLE-}"
readonly HERMES_DEPLOY_MODE_CALLER_VALUE="${HERMES_DEPLOY_MODE-}"
readonly HERMES_DEPLOY_IDENTITY_CALLER_VALUE="${HERMES_DEPLOY_IDENTITY-}"
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
HERMES_PREVERIFIED_FILE=""
HERMES_PREVERIFIED_SHA256=""



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
UI_IMAGE_TAG="${UI_IMAGE_TAG:-$IMAGE_TAG}"
DOCKER_REGISTRY="${DOCKER_REGISTRY:-ghcr.io/jc01rho}"
HERMES_IMAGE="${HERMES_IMAGE:-}"
HERMES_DEPLOY_MODE="${HERMES_DEPLOY_MODE:-}"
HERMES_DEPLOY_IDENTITY="${HERMES_DEPLOY_IDENTITY:-}"
HERMES_CI_RECEIPT_FILE="${HERMES_CI_RECEIPT_FILE:-}"
HERMES_PROVENANCE_BUNDLE="${HERMES_PROVENANCE_BUNDLE:-}"

RETENTION_ACTIVE="${RETENTION_ACTIVE:-true}"

SKIP_INGRESS="${SKIP_INGRESS:-false}"

# 환경 변수 파일
ENV_FILE="${ENV_FILE:-.env.prod}"

# 언디플로이 관련 변수
UNDEPLOY_MODE="false"
FORCE_UNDEPLOY="false"
KEEP_DATA="true"

# 강제 응답 관련 변수
FORCE_YES="false"
cleanup_hermes_preverified() {
    if [ -n "$HERMES_PREVERIFIED_FILE" ]; then
        rm -f -- "$HERMES_PREVERIFIED_FILE"
        HERMES_PREVERIFIED_FILE=""
    fi
}
trap cleanup_hermes_preverified EXIT HUP INT TERM


# ENV_FILE is a strict data-only dotenv file with an explicit application-setting
# allowlist. Parse the complete file before exporting anything so rejected input
# cannot partially affect deploy.
load_env_file() {
    if [ -f "$ENV_FILE" ]; then
        log_info "Loading environment variables from $ENV_FILE..."

        local parsed_file parse_status key value
        parsed_file="$(mktemp "${TMPDIR:-/tmp}/skald-env.XXXXXX")" || {
            log_error "Unable to create temporary ENV_FILE parse output"
            return 64
        }
        chmod 0600 "$parsed_file" || {
            rm -f -- "$parsed_file"
            return 64
        }

        if python3 - "$ENV_FILE" > "$parsed_file" <<'PY'
import re
import sys

path = sys.argv[1]
identifier = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\Z")
allowed_keys = {
    "POSTGRES_DB",
    "POSTGRES_USER",
    "RABBITMQ_USER",
    "UI_DOMAIN",
    "API_DOMAIN",
    "LLM_PROVIDER",
    "CLI_PROXY_API_BASE_URL",
    "LLM_DEFAULT_CHAT_MODEL",
    "LLM_DEFAULT_CLASSIFICATION_MODEL",
    "LLM_FALLBACK_CHAIN",
    "EMBEDDING_PROVIDER",
    "DOCUMENT_EXTRACTION_PROVIDER",
    "EMBEDDING_SERVICE_URL",
    "LOCAL_EMBEDDING_MODEL",
    "LOCAL_RERANK_MODEL",
    "RERANK_PROVIDER",
    "QUERY_LANGUAGE",
    "EXTERNAL_EMBEDDING_URL",
    "INTERNAL_RERANK_URL",
    "LOG_LEVEL",
}
unsafe_unquoted = re.compile(r"[;|&`<>(){}\\]")
seen = set()

def fail(line_number, message):
    print(f"ENV_FILE line {line_number}: {message}", file=sys.stderr)
    raise SystemExit(64)

try:
    with open(path, "rb") as env_file:
        raw = env_file.read()
except OSError as error:
    print(f"Unable to read ENV_FILE: {error}", file=sys.stderr)
    raise SystemExit(64)

if b"\0" in raw:
    print("ENV_FILE contains a NUL byte", file=sys.stderr)
    raise SystemExit(64)
try:
    text = raw.decode("utf-8")
except UnicodeDecodeError:
    print("ENV_FILE must be valid UTF-8", file=sys.stderr)
    raise SystemExit(64)

for line_number, physical_line in enumerate(text.splitlines(), 1):
    line = physical_line.strip()
    if not line or line.startswith("#"):
        continue
    if line.startswith("export"):
        match = re.match(r"export[ \t]+", line)
        if match:
            line = line[match.end():]
    if "=" not in line:
        fail(line_number, "expected KEY=VALUE")
    key_text, value_text = line.split("=", 1)
    key = key_text.strip()
    if not identifier.fullmatch(key):
        fail(line_number, "invalid variable identifier")
    if key in seen:
        fail(line_number, f"duplicate variable {key}")
    seen.add(key)
    if key not in allowed_keys:
        fail(line_number, f"{key} is not an allowed ENV_FILE setting")

    value_text = value_text.strip()
    if value_text[:1] in ("'", '"'):
        quote = value_text[0]
        if len(value_text) < 2 or value_text[-1] != quote:
            fail(line_number, "malformed quoted value")
        value = value_text[1:-1]
        if quote in value:
            fail(line_number, "quoted value must use one whole matching quote pair")
    else:
        if "#" in value_text or unsafe_unquoted.search(value_text) or "$" in value_text:
            fail(line_number, "unsafe syntax in unquoted value")
        value = value_text
    if "\r" in value or "\n" in value:
        fail(line_number, "multiline values are not supported")
    sys.stdout.buffer.write(key.encode("utf-8") + b"\0" + value.encode("utf-8") + b"\0")
PY
        then
            parse_status=0
        else
            parse_status=$?
        fi
        if [ "$parse_status" -ne 0 ]; then
            rm -f -- "$parsed_file"
            log_error "ENV_FILE must be a data-only dotenv file"
            return 64
        fi

        while IFS= read -r -d '' key && IFS= read -r -d '' value; do
            printf -v "$key" '%s' "$value"
            export "$key"
        done < "$parsed_file"
        rm -f -- "$parsed_file"
        log_success "Environment variables loaded from $ENV_FILE"
    else
        log_warning "Environment file $ENV_FILE not found, using defaults"
    fi

    HERMES_IMAGE="$HERMES_IMAGE_CALLER_VALUE"
    HERMES_CI_RECEIPT_FILE="$HERMES_CI_RECEIPT_FILE_CALLER_VALUE"
    HERMES_PROVENANCE_BUNDLE="$HERMES_PROVENANCE_BUNDLE_CALLER_VALUE"
    HERMES_DEPLOY_MODE="$HERMES_DEPLOY_MODE_CALLER_VALUE"
    HERMES_DEPLOY_IDENTITY="$HERMES_DEPLOY_IDENTITY_CALLER_VALUE"
    HERMES_PREVERIFIED_FILE=""
    HERMES_PREVERIFIED_SHA256=""
    readonly HERMES_IMAGE HERMES_CI_RECEIPT_FILE HERMES_PROVENANCE_BUNDLE HERMES_DEPLOY_MODE HERMES_DEPLOY_IDENTITY
}

validate_hermes_caller_inputs() {
    if [ -n "$HERMES_PROVENANCE_BUNDLE" ]; then
        log_error "HERMES_PROVENANCE_BUNDLE is unsupported; the CI receipt is the only approved provenance protocol"
        return 64
    fi

    if [ "$UNDEPLOY_MODE" = "true" ]; then
        if [ -z "$HERMES_DEPLOY_IDENTITY" ] || [[ ! "$HERMES_DEPLOY_IDENTITY" =~ ^(user|group):[^[:space:]]+$ ]]; then
            log_error "retained undeploy requires caller HERMES_DEPLOY_IDENTITY=user:<name> or group:<name>"
            return 64
        fi
        return 0
    fi

    case "$HERMES_DEPLOY_MODE" in
        "")
            if [ -n "$HERMES_DEPLOY_IDENTITY" ]; then
                log_error "HERMES_DEPLOY_IDENTITY is not accepted for ordinary deployment"
                return 64
            fi
            if { [ -n "$HERMES_IMAGE" ] && [ -z "$HERMES_CI_RECEIPT_FILE" ]; } || { [ -z "$HERMES_IMAGE" ] && [ -n "$HERMES_CI_RECEIPT_FILE" ]; }; then
                log_error "ordinary Hermes candidate requires both HERMES_IMAGE and HERMES_CI_RECEIPT_FILE, or neither"
                return 64
            fi
            ;;
        cutover|upgrade)
            if [ -z "$HERMES_DEPLOY_IDENTITY" ] || [[ ! "$HERMES_DEPLOY_IDENTITY" =~ ^(user|group):[^[:space:]]+$ ]]; then
                log_error "explicit Hermes deployment requires caller HERMES_DEPLOY_IDENTITY=user:<name> or group:<name>"
                return 64
            fi
            if [ -z "$HERMES_IMAGE" ] || [ -z "$HERMES_CI_RECEIPT_FILE" ]; then
                log_error "$HERMES_DEPLOY_MODE requires both HERMES_IMAGE and HERMES_CI_RECEIPT_FILE"
                return 64
            fi
            ;;
        rollback)
            if [ -z "$HERMES_DEPLOY_IDENTITY" ] || [[ ! "$HERMES_DEPLOY_IDENTITY" =~ ^(user|group):[^[:space:]]+$ ]]; then
                log_error "explicit Hermes deployment requires caller HERMES_DEPLOY_IDENTITY=user:<name> or group:<name>"
                return 64
            fi
            if [ -n "$HERMES_IMAGE" ] || [ -n "$HERMES_CI_RECEIPT_FILE" ]; then
                log_error "rollback rejects HERMES_IMAGE and HERMES_CI_RECEIPT_FILE"
                return 64
            fi
            ;;
        *)
            log_error "HERMES_DEPLOY_MODE must be unset, cutover, upgrade, or rollback"
            return 64
            ;;
    esac
}


resolve_hermes_inputs() {
    load_env_file || return $?
    validate_hermes_caller_inputs || return $?

    if [ -n "$HERMES_IMAGE" ] && [ -z "$HERMES_DEPLOY_MODE" ]; then
        local prior_umask
        prior_umask="$(umask)"
        umask 077
        HERMES_PREVERIFIED_FILE="$(mktemp "${TMPDIR:-/tmp}/hermes-preverified.XXXXXX")" || {
            umask "$prior_umask"
            log_error "Unable to create secure Hermes verification handoff"
            return 1
        }
        umask "$prior_umask"
        chmod 0600 "$HERMES_PREVERIFIED_FILE" || return 1
        local preverified_envelope
        if ! preverified_envelope="$(python3 "$SCRIPT_DIR/hermes/deploy_state.py" verify-candidate)"; then
            log_error "Hermes candidate verification failed before Kubernetes access"
            return 1
        fi
        printf '%s\n' "$preverified_envelope" > "$HERMES_PREVERIFIED_FILE" || return 1
        HERMES_PREVERIFIED_SHA256="$(printf '%s\n' "$preverified_envelope" | python3 -c 'import hashlib,sys; print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())')" || return 1
        readonly HERMES_PREVERIFIED_SHA256
    elif ! python3 "$SCRIPT_DIR/hermes/deploy_state.py" verify-candidate >/dev/null; then
        log_error "Hermes candidate verification failed before Kubernetes access"
        return 1
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
  # Database Configuration
  DB_NAME: "${POSTGRES_DB:-skald2}"
  DB_USER: "${POSTGRES_USER:-postgres}"
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
  NODE_ENV: "production"
  IS_DEVELOPMENT: "false"
  IS_SELF_HOSTED_DEPLOY: "true"
  ENABLE_SECURITY_SETTINGS: "true"
  EMAIL_VERIFICATION_ENABLED: "false"
  LLM_PROVIDER: "${LLM_PROVIDER:-cli-proxy-api}"
  CLI_PROXY_API_BASE_URL: "${CLI_PROXY_API_BASE_URL:-}"
  LLM_DEFAULT_CHAT_MODEL: "${LLM_DEFAULT_CHAT_MODEL:-parrot}"
  LLM_DEFAULT_CLASSIFICATION_MODEL: "${LLM_DEFAULT_CLASSIFICATION_MODEL:-parrot}"
  LLM_FALLBACK_CHAIN: "${LLM_FALLBACK_CHAIN:-parrot}"
  EMBEDDING_PROVIDER: "${EMBEDDING_PROVIDER:-external}"
  DOCUMENT_EXTRACTION_PROVIDER: "${DOCUMENT_EXTRACTION_PROVIDER:-docling}"
  EMBEDDING_SERVICE_URL: "${EMBEDDING_SERVICE_URL:-http://embedding-service:8000}"
  DOCLING_SERVICE_URL: "http://docling-service:5001"
  
  # Frontend Configuration
  FRONTEND_URL: "https://${UI_DOMAIN:-ui.skald.local}"
  CORS_ALLOWED_ORIGINS: "https://${UI_DOMAIN:-ui.skald.local},https://${API_DOMAIN:-api.skald.local}"
  
  # Local Embedding Configuration (optional)
  LOCAL_EMBEDDING_MODEL: "${LOCAL_EMBEDDING_MODEL:-all-MiniLM-L6-v2}"
  LOCAL_RERANK_MODEL: "${LOCAL_RERANK_MODEL:-cross-encoder/ms-marco-MiniLM-L-6-v2}"
  
  # Reranking Configuration
  RERANK_PROVIDER: "${RERANK_PROVIDER:-ollama}"
  
  # Logging Configuration
  LOG_LEVEL: "${LOG_LEVEL:-info}"
  
  # Query Language (optional)
  QUERY_LANGUAGE: "${QUERY_LANGUAGE:-ko}"
  
  # External Embedding URL (optional)
  EXTERNAL_EMBEDDING_URL: "${EXTERNAL_EMBEDDING_URL:-http://192.168.150.37:8889/embeddings}"
  
  # Internal Rerank URL (optional)
  INTERNAL_RERANK_URL: "${INTERNAL_RERANK_URL:-http://192.168.150.37:8889/v1/rerank}"
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
    local timeout=${2:-600}
    log_info "Waiting for pods with label '$label' to be ready (timeout: ${timeout}s)..."
    
    # 현재 파드 상태 표시
    log_info "Current pod status for label '$label':"
    kubectl get pods -l "$label" -n "$NAMESPACE" --no-headers 2>/dev/null || echo "  No pods found yet"
    
    # 모든 파드가 ready 상태가 될 때까지 대기
    local start_time=$(date +%s)
    while true; do
        local current_time=$(date +%s)
        local elapsed=$((current_time - start_time))
        
        if [ $elapsed -ge $timeout ]; then
            log_error "Timeout waiting for pods with label '$label' (${elapsed}s elapsed)"
            kubectl get pods -l "$label" -n "$NAMESPACE" -o wide
            return 1
        fi
        
        # 파드 상태 확인 - 모든 파드가 Running이고 Ready 상태인지 체크
        local pod_status
        pod_status=$(kubectl get pods -l "$label" -n "$NAMESPACE" -o jsonpath='{range .items[*]}{.status.phase}{" "}{.status.containerStatuses[0].ready}{"\n"}{end}' 2>/dev/null)
        
        if [ -z "$pod_status" ]; then
            log_info "No pods found with label '$label', waiting..."
            sleep 2
            continue
        fi
        
        local all_ready=true
        local total_pods=0
        local ready_pods=0
        local active_pods=0
        
        while IFS= read -r line; do
            if [ -n "$line" ]; then
                local phase=$(echo "$line" | awk '{print $1}')
                local ready=$(echo "$line" | awk '{print $2}')

                if [ "$phase" = "Succeeded" ] || [ "$phase" = "Failed" ]; then
                    continue
                fi

                total_pods=$((total_pods + 1))
                active_pods=$((active_pods + 1))
                
                if [ "$phase" = "Running" ] && [ "$ready" = "true" ]; then
                    ready_pods=$((ready_pods + 1))
                else
                    all_ready=false
                fi
            fi
        done <<< "$pod_status"
        
        if [ $active_pods -eq 0 ]; then
            log_info "No active pods found with label '$label', waiting..."
            sleep 2
            continue
        fi

        if [ $all_ready = true ] && [ $active_pods -gt 0 ]; then
            log_success "All $active_pods active pods with label '$label' are ready (${elapsed}s elapsed)"
            return 0
        fi
        
        log_info "Waiting for pods... ($ready_pods/$active_pods active pods ready, ${elapsed}s elapsed)"
        sleep 5
    done
}

# 서비스 상태 확인 함수
check_service_health() {
    local service_name=$1
    local namespace=${2:-$NAMESPACE}
    local timeout=${3:-120}
    
    log_info "Checking service health for $service_name (timeout: ${timeout}s)..."
    
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
    local timeout=${3:-600}
    
    log_info "Starting rolling update for $deployment_name to $new_image (timeout: ${timeout}s)..."
    
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
# Step 2: Traefik Ingress Controller 배포 (Cluster에 이미 Nginx/Envoy가 있으므로 생략)
deploy_traefik() {
    log_info "Step 2: Traefik Ingress Controller 배포 (생략)"
    log_info "Cluster에 이미 Ingress Controller(Nginx/Envoy)가 존재하므로 Traefik을 배포하지 않습니다."
    return 0
}

# Step 2: ConfigMap 및 Secret 생성
create_configs() {
    log_info "Step 2: ConfigMap 및 Secret 생성"
    
    # ConfigMap 생성 (로컬 파일 우선)
    if [ -f "configmap.local.yaml" ]; then
        log_info "configmap.local.yaml 사용"
        if kubectl apply -f configmap.local.yaml -n "$NAMESPACE"; then
            log_success "ConfigMap 생성 완료 (local)"
        else
            log_error "ConfigMap 생성 실패"
            exit 1
        fi
    elif [ -f "configmap.yaml" ]; then
        log_info "configmap.yaml 사용"
        if kubectl apply -f configmap.yaml -n "$NAMESPACE"; then
            log_success "ConfigMap 생성 완료"
        else
            log_error "ConfigMap 생성 실패"
            exit 1
        fi
    else
        log_error "ConfigMap 파일이 없습니다 (configmap.local.yaml 또는 configmap.yaml)"
        exit 1
    fi
    
    # 초기화 스크립트 ConfigMap 생성
    if kubectl apply -f init-scripts-configmap.yaml -n "$NAMESPACE"; then
        log_success "초기화 스크립트 ConfigMap 생성 완료"
    else
        log_error "초기화 스크립트 ConfigMap 생성 실패"
        exit 1
    fi
    
    # Embedding Service Source ConfigMap 생성 (Hotfix code injection)
    if kubectl create configmap embedding-service-source --from-file=main.py=../embedding-service/main.py -n "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -; then
        log_success "Embedding Service Source ConfigMap 생성 완료"
    else
        log_warning "Embedding Service Source ConfigMap 생성 실패 (소스 파일 경로 확인 필요)"
    fi
    
    # Secret 생성 (로컬 파일 우선)
    if [ -f "secret.local.yaml" ]; then
        log_info "secret.local.yaml 사용"
        if kubectl apply -f secret.local.yaml -n "$NAMESPACE"; then
            log_success "Secret 생성 완료 (local)"
        else
            log_error "Secret 생성 실패"
            exit 1
        fi
    elif [ -f "secret.yaml" ]; then
        log_info "secret.yaml 사용"
        if kubectl apply -f secret.yaml -n "$NAMESPACE"; then
            log_success "Secret 생성 완료"
        else
            log_error "Secret 생성 실패"
            exit 1
        fi
    else
        log_warning "secret 파일이 없습니다. secret.local.yaml 또는 secret.yaml.example 기반 secret.yaml을 준비하세요."
        log_info "cp secret.yaml.example secret.local.yaml"
        log_info "secret.local.yaml 또는 secret.yaml의 모든 플레이스홀더 값을 실제 값으로 교체한 후 다시 실행하세요."
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
    # 이미지 태그 치환 (IMAGE_TAG 변수 사용)
    sed "s|\${IMAGE_TAG:-latest}|$IMAGE_TAG|g" api-deployment.yaml > /tmp/api-deployment.yaml
    echo "API Deployment 임시 파일 생성 완료: /tmp/api-deployment.yaml"
    echo "IMAGE tag used: $IMAGE_TAG"
    echo "Image in temp file: $(grep 'ghcr.io/jc01rho/skald/backend:' /tmp/api-deployment.yaml)"
    
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
    # 이미지 태그 치환 (IMAGE_TAG 변수 사용)
    sed "s|\${IMAGE_TAG:-latest}|$IMAGE_TAG|g" memo-processing-deployment.yaml > /tmp/memo-processing-deployment.yaml
    echo "Memo Processing Deployment 임시 파일 생성 완료: /tmp/memo-processing-deployment.yaml"
    echo "Image in temp file: $(grep 'ghcr.io/jc01rho/skald/backend:' /tmp/memo-processing-deployment.yaml)"

    if kubectl apply -f /tmp/memo-processing-deployment.yaml -n "$NAMESPACE"; then
        log_success "Memo Processing Deployment 생성 완료"
    else
        log_error "Memo Processing Deployment 생성 실패"
        exit 1
    fi
    
    # Wiki Processing 서비스 배포
    sed "s|\${IMAGE_TAG:-latest}|$IMAGE_TAG|g" wiki-processing-deployment.yaml > /tmp/wiki-processing-deployment.yaml
    echo "Wiki Processing Deployment 임시 파일 생성 완료: /tmp/wiki-processing-deployment.yaml"
    echo "Image in temp file: $(grep 'ghcr.io/jc01rho/skald/backend:' /tmp/wiki-processing-deployment.yaml)"

    if kubectl apply -f /tmp/wiki-processing-deployment.yaml -n "$NAMESPACE"; then
        log_success "Wiki Processing Deployment 생성 완료"
    else
        log_error "Wiki Processing Deployment 생성 실패"
        exit 1
    fi
    
    # 강제 롤아웃 리스타트 (latest 태그 갱신을 위해)
    # 이미지가 변경되지 않았더라도(latest), 파드를 재시작하여 새 이미지를 pull하도록 함
    log_info "Deployments 롤아웃 리스타트 실행..."
    kubectl rollout restart deployment/api-server -n "$NAMESPACE"
    kubectl rollout restart deployment/memo-processing-server -n "$NAMESPACE"
    kubectl rollout restart deployment/wiki-processing-server -n "$NAMESPACE"
    
    # 롤아웃 완료 대기
    log_info "롤아웃 완료 대기 중..."
    kubectl rollout status deployment/api-server -n "$NAMESPACE"
    kubectl rollout status deployment/memo-processing-server -n "$NAMESPACE"
    kubectl rollout status deployment/wiki-processing-server -n "$NAMESPACE"
    
    # 파드가 안정화될 때까지 잠시 대기
    log_info "파드 안정화 대기 중..."
    sleep 5
    
    # Backend Pod 준비 대기
    wait_for_pods "component=api" 1800
    wait_for_pods "component=memo-processing" 300
    wait_for_pods "component=wiki-processing" 300
    
    # 임시 파일 정리
    rm -f /tmp/api-deployment.yaml /tmp/memo-processing-deployment.yaml /tmp/wiki-processing-deployment.yaml
}

# Step 6: AI 서비스 배포
deploy_ai_services() {
    log_info "Step 6: AI 서비스 배포"

    # 이미지 태그 치환
    sed "s|\${IMAGE_TAG:-latest}|$IMAGE_TAG|g" embedding-service-deployment.yaml > /tmp/embedding-service-deployment.yaml
    echo "Embedding Service Deployment 임시 파일 생성 완료: /tmp/embedding-service-deployment.yaml"
    
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

    # 강제 롤아웃 리스타트 (latest 태그/실행 중 이미지 갱신 반영을 위해)
    # 이미지 태그 문자열이 동일하더라도 파드를 재시작하여 최신 이미지를 pull 하도록 함
    log_info "AI 서비스 Deployment 롤아웃 리스타트 실행..."
    kubectl rollout restart deployment/embedding-service -n "$NAMESPACE"
    kubectl rollout restart deployment/docling-service -n "$NAMESPACE"

    # 롤아웃 완료 대기
    log_info "AI 서비스 롤아웃 완료 대기 중..."
    kubectl rollout status deployment/embedding-service -n "$NAMESPACE"
    kubectl rollout status deployment/docling-service -n "$NAMESPACE"

    # 파드가 안정화될 때까지 잠시 대기
    log_info "AI 서비스 파드 안정화 대기 중..."
    sleep 5
    
    # AI 서비스 Pod 준비 대기
    wait_for_pods "component=embedding-service" 1800
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
    
    # 이미지 태그 치환
    sed "s|\${IMAGE_TAG:-latest}|$UI_IMAGE_TAG|g" ui-deployment.yaml > /tmp/ui-deployment.yaml
    echo "UI Deployment 임시 파일 생성 완료: /tmp/ui-deployment.yaml"
    echo "Image in temp file: $(grep 'ghcr.io/jc01rho/skald/ui:' /tmp/ui-deployment.yaml)"
    
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

    # 강제 롤아웃 리스타트 (latest 태그 갱신을 위해)
    # 이미지 태그 문자열이 동일하더라도 파드를 재시작하여 최신 이미지를 pull 하도록 함
    log_info "UI Deployment 롤아웃 리스타트 실행..."
    kubectl rollout restart deployment/ui -n "$NAMESPACE"

    # 롤아웃 완료 대기
    log_info "UI 롤아웃 완료 대기 중..."
    kubectl rollout status deployment/ui -n "$NAMESPACE"

    # 파드가 안정화될 때까지 잠시 대기
    log_info "UI 파드 안정화 대기 중..."
    sleep 5
    
    # UI Pod 준비 대기
    wait_for_pods "component=ui" 300
    
    # 임시 파일 정리
    rm -f /tmp/ui-deployment.yaml
}

# Step 7.5: Worker 배포
deploy_worker() {
    log_info "Step 7.5: Skald Worker 배포"

    # Worker ConfigMap 생성 (로컬 파일 우선)
    if [ -f "worker-configmap.local.yaml" ]; then
        log_info "worker-configmap.local.yaml 사용"
        if kubectl apply -f worker-configmap.local.yaml -n "$NAMESPACE"; then
            log_success "Worker ConfigMap 생성 완료 (local)"
        else
            log_error "Worker ConfigMap 생성 실패"
            exit 1
        fi
    elif [ -f "worker-configmap.yaml" ]; then
        log_info "worker-configmap.yaml 사용"
        if kubectl apply -f worker-configmap.yaml -n "$NAMESPACE"; then
            log_success "Worker ConfigMap 생성 완료"
        else
            log_error "Worker ConfigMap 생성 실패"
            exit 1
        fi
    elif [ -f "../worker/k8s/configmap.local.yaml" ]; then
        log_info "../worker/k8s/configmap.local.yaml 사용"
        if kubectl apply -f ../worker/k8s/configmap.local.yaml -n "$NAMESPACE"; then
            log_success "Worker ConfigMap 생성 완료 (worker/k8s)"
        else
            log_error "Worker ConfigMap 생성 실패"
            exit 1
        fi
    else
        log_error "Worker ConfigMap 파일이 없습니다 (worker-configmap.local.yaml, worker-configmap.yaml 또는 ../worker/k8s/configmap.local.yaml)"
        exit 1
    fi

    # Worker Secret 생성 (로컬 파일 우선)
    if [ -f "worker-secret.local.yaml" ]; then
        log_info "worker-secret.local.yaml 사용"
        if kubectl apply -f worker-secret.local.yaml -n "$NAMESPACE"; then
            log_success "Worker Secret 생성 완료 (local)"
        else
            log_error "Worker Secret 생성 실패"
            exit 1
        fi
    elif [ -f "worker-secret.yaml" ]; then
        log_info "worker-secret.yaml 사용"
        if kubectl apply -f worker-secret.yaml -n "$NAMESPACE"; then
            log_success "Worker Secret 생성 완료"
        else
            log_error "Worker Secret 생성 실패"
            exit 1
        fi
    elif [ -f "../worker/k8s/secret.local.yaml" ]; then
        log_info "../worker/k8s/secret.local.yaml 사용"
        if kubectl apply -f ../worker/k8s/secret.local.yaml -n "$NAMESPACE"; then
            log_success "Worker Secret 생성 완료 (worker/k8s)"
        else
            log_error "Worker Secret 생성 실패"
            exit 1
        fi
    else
        log_warning "Worker Secret 파일이 없습니다 (worker-secret.local.yaml, worker-secret.yaml 또는 ../worker/k8s/secret.local.yaml)"
        log_warning "Worker가 제대로 작동하지 않을 수 있습니다."
    fi

    # 이미지 태그 치환
    sed "s|\${IMAGE_TAG:-latest}|$IMAGE_TAG|g" worker-deployment.yaml > /tmp/worker-deployment.yaml
    echo "Worker Deployment 임시 파일 생성 완료: /tmp/worker-deployment.yaml"
    echo "Image in temp file: $(grep 'ghcr.io/jc01rho/skald-worker-v2:' /tmp/worker-deployment.yaml)"

    if kubectl apply -f /tmp/worker-deployment.yaml -n "$NAMESPACE"; then
        log_success "Worker Deployment 생성 완료"
    else
        log_error "Worker Deployment 생성 실패"
        exit 1
    fi

    if kubectl apply -f worker-service.yaml -n "$NAMESPACE"; then
        log_success "Worker Service 생성 완료"
    else
        log_error "Worker Service 생성 실패"
        exit 1
    fi

    if kubectl apply -f worker-serviceaccount.yaml -n "$NAMESPACE"; then
        log_success "Worker ServiceAccount 생성 완료"
    else
        log_error "Worker ServiceAccount 생성 실패"
        exit 1
    fi

    # 강제 롤아웃 리스타트 (latest 태그 갱신을 위해)
    # 이미지가 변경되지 않았더라도(latest), 파드를 재시작하여 새 이미지를 pull하도록 함
    log_info "Worker Deployment 롤아웃 리스타트 실행..."
    kubectl rollout restart deployment/skald-worker -n "$NAMESPACE"
    
    # 롤아웃 완료 대기
    log_info "Worker 롤아웃 완료 대기 중..."
    kubectl rollout status deployment/skald-worker -n "$NAMESPACE"
    
    # 파드가 안정화될 때까지 잠시 대기
    log_info "Worker 파드 안정화 대기 중..."
    sleep 5
    
    # Worker Pod 준비 대기
    wait_for_pods "component=worker" 300

    # 임시 파일 정리
    rm -f /tmp/worker-deployment.yaml
}

# Step 7.6: Discord Bot 배포
# Hermes/legacy Discord owner dispatch. Durable owner state is authoritative;
# workload existence is never used to choose an owner.
deploy_discord_owner() {
    local state_command=(python3 "$SCRIPT_DIR/hermes/deploy_state.py" dispatch --mode "$HERMES_DEPLOY_MODE")
    local result
    if [ -z "$HERMES_DEPLOY_MODE" ] && [ -n "$HERMES_IMAGE" ]; then
        state_command+=(--preverified-file "$HERMES_PREVERIFIED_FILE" --preverified-sha256 "$HERMES_PREVERIFIED_SHA256")
    fi

    if [ -n "$HERMES_DEPLOY_MODE" ]; then
        if ! result=$("${state_command[@]}"); then
            log_error "Discord owner orchestration failed; see sanitized hermes_deploy diagnostics"
            return 1
        fi
    else
        if ! result=$("${state_command[@]}"); then
            log_error "Discord owner orchestration failed; see sanitized hermes_deploy diagnostics"
            return 1
        fi
    fi

    case "$result" in
        ordinary-legacy-noop)
            log_info "discord_owner=legacy action=noop ordinary_deploy=true"
            ;;
        hermes-noop)
            log_info "discord_owner=hermes action=noop ordinary_deploy=true"
            ;;
        hermes-reconciled)
            log_success "Hermes ordinary image reconciliation completed"
            ;;
        managed)
            log_success "Hermes Discord owner transition completed"
            ;;
        *)
            log_error "Invalid Discord owner dispatch result"
            return 1
            ;;
    esac
}


deploy_discord_bot() {
    log_info "Step 7.6: Discord Bot 배포"

    # Discord Bot ConfigMap 생성
    if [ -f "discord-bot-configmap.local.yaml" ]; then
        log_info "discord-bot-configmap.local.yaml 사용"
        if kubectl apply -f discord-bot-configmap.local.yaml -n "$NAMESPACE"; then
            log_success "Discord Bot ConfigMap 생성 완료 (local)"
        else
            log_error "Discord Bot ConfigMap 생성 실패"
            exit 1
        fi
    elif [ -f "discord-bot-configmap.yaml" ]; then
        if kubectl apply -f discord-bot-configmap.yaml -n "$NAMESPACE"; then
            log_success "Discord Bot ConfigMap 생성 완료"
        else
            log_error "Discord Bot ConfigMap 생성 실패"
            exit 1
        fi
    fi

    # Discord Bot Secret 생성 (로컬 파일 우선)
    if [ -f "discord-bot-secret.local.yaml" ]; then
        log_info "discord-bot-secret.local.yaml 사용"
        if kubectl apply -f discord-bot-secret.local.yaml -n "$NAMESPACE"; then
            log_success "Discord Bot Secret 생성 완료 (local)"
        else
            log_error "Discord Bot Secret 생성 실패"
            exit 1
        fi
    elif [ -f "discord-bot-secret.yaml" ]; then
        log_info "discord-bot-secret.yaml 사용"
        if kubectl apply -f discord-bot-secret.yaml -n "$NAMESPACE"; then
            log_success "Discord Bot Secret 생성 완료"
        else
            log_error "Discord Bot Secret 생성 실패"
            exit 1
        fi
    else
        log_warning "Discord Bot Secret 파일이 없습니다 (discord-bot-secret.local.yaml 또는 discord-bot-secret.yaml)"
        log_warning "Discord Bot이 제대로 작동하지 않을 수 있습니다."
    fi

    # 이미지 태그 치환
    sed "s|\${IMAGE_TAG:-latest}|$IMAGE_TAG|g" discord-bot-deployment.yaml > /tmp/discord-bot-deployment.yaml
    echo "Discord Bot Deployment 임시 파일 생성 완료: /tmp/discord-bot-deployment.yaml"

    if kubectl apply -f /tmp/discord-bot-deployment.yaml -n "$NAMESPACE"; then
        log_success "Discord Bot Deployment 생성 완료"
    else
        log_error "Discord Bot Deployment 생성 실패"
        exit 1
    fi

    if kubectl apply -f discord-bot-service.yaml -n "$NAMESPACE"; then
        log_success "Discord Bot Service 생성 완료"
    else
        log_error "Discord Bot Service 생성 실패"
        exit 1
    fi

    # 강제 롤아웃 리스타트 (latest 태그 갱신을 위해)
    # 이미지가 변경되지 않았더라도(latest), 파드를 재시작하여 새 이미지를 pull하도록 함
    log_info "Discord Bot Deployment 롤아웃 리스타트 실행..."
    kubectl rollout restart deployment/discord-bot -n "$NAMESPACE"

    # 롤아웃 완료 대기
    log_info "Discord Bot 롤아웃 완료 대기 중..."
    kubectl rollout status deployment/discord-bot -n "$NAMESPACE"

    # 파드가 안정화될 때까지 잠시 대기
    log_info "Discord Bot 파드 안정화 대기 중..."
    sleep 5

    # Discord Bot Pod 준비 대기
    wait_for_pods "component=discord-bot" 300

    # 임시 파일 정리
    rm -f /tmp/discord-bot-deployment.yaml
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
    
    # IngressRoute 상태 확인 (Traefik) - 생략
    # if kubectl get ingressroute -n "$NAMESPACE" &> /dev/null; then
    #     log_info "IngressRoute 상태:"
    #     kubectl get ingressroute -n "$NAMESPACE"
    # fi
    
    # 서비스 상세 상태 확인
    verify_service_health
    
    # Ingress 설정 검증
    verify_ingress_configuration
    
    log_success "배포 확인 완료"
}

# 서비스 상세 상태 확인 함수
verify_service_health() {
    log_info "서비스 상세 상태 확인 중..."
    
    local services=("postgres-service" "rabbitmq-service" "redis-service" "api-service" "ui-service" "embedding-service" "docling-service" "skald-worker")
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
    
    # Ingress 리소스 확인
    if kubectl get ingress skald-ingress -n "$NAMESPACE" &>/dev/null; then
        local ingress_ip
        ingress_ip=$(kubectl get ingress skald-ingress -n "$NAMESPACE" -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null)
        if [ -n "$ingress_ip" ]; then
            log_success "Ingress IP 할당됨: $ingress_ip"
        else
            log_warning "Ingress IP가 아직 할당되지 않았습니다. 잠시 후 다시 확인하세요."
        fi
    else
        log_error "Ingress 리소스를 찾을 수 없습니다."
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
    echo -e "  - Discord Bot Deployment/Service"
    echo -e "  - Backend 서비스 Deployment/Service"
    echo -e "  - RabbitMQ Deployment/Service"
    echo -e "  - PostgreSQL Deployment/Service"
    echo -e "  - ConfigMap 및 Secret"
    
    if [ "$KEEP_DATA" = "false" ]; then
        echo -e "  - 네임스페이스 (PVC 포함 모든 데이터 삭제)"
    else
        echo -e "  - 네임스페이스 선택 스킵 (데이터 유지)"
    fi
    
    echo -e "${YELLOW}계속 진행하시겠습니까?${NC}"
    echo -e "네임스페이스: ${NAMESPACE}"
    echo -e "데이터 유지: ${KEEP_DATA}"
    
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

# 언디플로이: Worker 리소스 삭제
undeploy_worker() {
    log_info "Step 2.5: Worker Deployment/Service 삭제 중..."

    # Worker Service 삭제
    if kubectl delete service skald-worker -n "$NAMESPACE" --ignore-not-found=true; then
        log_success "Worker Service 삭제 완료"
    else
        log_error "Worker Service 삭제 실패"
        return 1
    fi

    # Worker Deployment 삭제
    if kubectl delete deployment skald-worker -n "$NAMESPACE" --ignore-not-found=true; then
        log_success "Worker Deployment 삭제 완료"
    else
        log_error "Worker Deployment 삭제 실패"
        return 1
    fi

    # Worker ServiceAccount 삭제
    if kubectl delete serviceaccount skald-worker -n "$NAMESPACE" --ignore-not-found=true; then
        log_success "Worker ServiceAccount 삭제 완료"
    else
        log_error "Worker ServiceAccount 삭제 실패"
        return 1
    fi
}

# 언디플로이: Discord Bot 리소스 삭제
undeploy_discord_bot() {
    log_info "Step 2.6: Discord Bot Deployment/Service 삭제 중..."

    # Discord Bot Service 삭제
    if kubectl delete service discord-bot-service -n "$NAMESPACE" --ignore-not-found=true; then
        log_success "Discord Bot Service 삭제 완료"
    else
        log_error "Discord Bot Service 삭제 실패"
        return 1
    fi

    # Discord Bot Deployment 삭제
    if kubectl delete deployment discord-bot -n "$NAMESPACE" --ignore-not-found=true; then
        log_success "Discord Bot Deployment 삭제 완료"
    else
        log_error "Discord Bot Deployment 삭제 실패"
        return 1
    fi

    # Discord Bot ConfigMap 삭제
    if kubectl delete configmap discord-bot-config -n "$NAMESPACE" --ignore-not-found=true; then
        log_success "Discord Bot ConfigMap 삭제 완료"
    else
        log_error "Discord Bot ConfigMap 삭제 실패"
        return 1
    fi

    # Discord Bot Secret 삭제
    if kubectl delete secret discord-bot-secrets -n "$NAMESPACE" --ignore-not-found=true; then
        log_success "Discord Bot Secret 삭제 완료"
    else
        log_error "Discord Bot Secret 삭제 실패"
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
    if kubectl delete service embedding-service -n "$NAMESPACE" --ignore-not-found=true; then
        log_success "Embedding Service 삭제 완료"
    else
        log_error "Embedding Service 삭제 실패"
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
    
    # Wiki Processing Deployment 삭제
    if kubectl delete deployment wiki-processing-server -n "$NAMESPACE" --ignore-not-found=true; then
        log_success "Wiki Processing Deployment 삭제 완료"
    else
        log_error "Wiki Processing Deployment 삭제 실패"
        return 1
    fi
    
    # Memo Processing Service 삭제
    if kubectl delete deployment memo-processing-server -n "$NAMESPACE" --ignore-not-found=true; then
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
    if kubectl delete deployment api-server -n "$NAMESPACE" --ignore-not-found=true; then
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

# 언디플로이: retention-safe non-Discord ConfigMap 및 Secret 삭제
undeploy_non_discord_configs() {
    log_info "Step 8: non-Discord ConfigMap 및 Secret 삭제 중..."

    if kubectl delete configmap skald-config -n "$NAMESPACE" --ignore-not-found=true; then
        log_success "Skald ConfigMap 삭제 완료"
    else
        log_error "Skald ConfigMap 삭제 실패"
        return 1
    fi

    if kubectl delete configmap init-scripts -n "$NAMESPACE" --ignore-not-found=true; then
        log_success "초기화 스크립트 ConfigMap 삭제 완료"
    else
        log_error "초기화 스크립트 ConfigMap 삭제 실패"
        return 1
    fi

    if kubectl delete secret skald-secret -n "$NAMESPACE" --ignore-not-found=true; then
        log_success "Skald Secret 삭제 완료"
    else
        log_error "Skald Secret 삭제 실패"
        return 1
    fi
}
# 언디플로이: Traefik 삭제
undeploy_traefik() {
    log_info "Step 0: Traefik Ingress Controller 삭제 중..."
    
    # Traefik Deployment 삭제
    if kubectl delete deployment traefik -n default --ignore-not-found=true; then
        log_success "Traefik Deployment 삭제 완료"
    else
        log_error "Traefik Deployment 삭제 실패"
    fi

    # Traefik Service 삭제
    if kubectl delete service traefik -n default --ignore-not-found=true; then
        log_success "Traefik Service 삭제 완료"
    else
        log_error "Traefik Service 삭제 실패"
    fi

    # Traefik ServiceAccount 삭제
    if kubectl delete serviceaccount traefik-ingress-controller -n default --ignore-not-found=true; then
        log_success "Traefik ServiceAccount 삭제 완료"
    fi

    # Traefik ClusterRole & Binding 삭제
    kubectl delete clusterrole traefik-ingress-controller --ignore-not-found=true
    kubectl delete clusterrolebinding traefik-ingress-controller --ignore-not-found=true
    
    # Traefik PVC 삭제
    if [ "$KEEP_DATA" = "false" ]; then
         if kubectl delete pvc traefik-certs-pvc -n default --ignore-not-found=true; then
            log_success "Traefik PVC 삭제 완료"
         fi
    fi
}

# 언디플로이 함수
# Retention-safe undeploy uses only the explicit non-Discord cleanup calls below.
# Both Discord owner lanes, their Secrets, ConfigMaps, workloads and Services,
# the durable owner index, immutable snapshots, operation Lease, RBAC, and the
# namespace are outside this allowlist and remain untouched.
undeploy_retained() {
    log_info "Discord owner retention is active; preserving rollback authority"
    if NAMESPACE="$NAMESPACE" HERMES_DEPLOY_IDENTITY="$HERMES_DEPLOY_IDENTITY" python3 hermes/deploy_state.py retained-undeploy; then
        :
    else
        local state_result=$?
        log_error "Retained undeploy state transition failed; no cleanup was attempted"
        return "$state_result"
    fi

    undeploy_traefik || log_warning "Traefik 삭제 중 오류 발생"
    undeploy_ingress || log_warning "Ingress 삭제 중 오류 발생"
    undeploy_ui || log_warning "UI 리소스 삭제 중 오류 발생"
    undeploy_ai_services || log_warning "AI 서비스 삭제 중 오류 발생"
    undeploy_worker || log_warning "Worker 리소스 삭제 중 오류 발생"
    undeploy_backend || log_warning "Backend 리소스 삭제 중 오류 발생"
    undeploy_rabbitmq || log_warning "RabbitMQ 리소스 삭제 중 오류 발생"
    undeploy_redis || log_warning "Redis 리소스 삭제 중 오류 발생"
    undeploy_postgres || log_warning "PostgreSQL 리소스 삭제 중 오류 발생"
    undeploy_pvcs || log_warning "PVC 삭제 중 오류 발생"
    undeploy_non_discord_configs || log_warning "Non-Discord ConfigMap/Secret 삭제 중 오류 발생"

    log_success "Skald 애플리케이션 언디플로이가 완료되었습니다 (Discord retention active)"
}

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
    if [ "$RETENTION_ACTIVE" != "true" ]; then
        log_error "Discord owner decommission requires a separately approved operation; ordinary undeploy is retention-only"
        return 1
    fi
    undeploy_retained
}

# 메인 함수
main() {
    resolve_hermes_inputs || return $?

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
        echo "  UI 이미지 태그: $UI_IMAGE_TAG"
        if [ -n "$HERMES_IMAGE" ]; then
            echo "  Hermes image: $HERMES_IMAGE"
        fi
        echo "  Hermes mode: ${HERMES_DEPLOY_MODE:-ordinary-owner-dispatch}"
        echo "  도커 레지스트리: $DOCKER_REGISTRY"
        echo "  Ingress 건너뛰기: $SKIP_INGRESS"
        echo

        
        # 배포 단계 실행
        check_prerequisites
        create_namespace
        deploy_traefik
        
        # ConfigMap 및 Secret 생성
        create_configs
        
        # 로컬/정적 ConfigMap 파일이 없을 때만 환경 변수 기반 ConfigMap 생성
        if [ -f "configmap.local.yaml" ] || [ -f "configmap.yaml" ]; then
            log_info "ConfigMap 파일이 이미 적용되었으므로 환경 변수 기반 ConfigMap 덮어쓰기를 건너뜁니다."
        else
            generate_configmap_from_env
        fi
        
        create_pvcs  # PVC 생성 함수는 호출되지만 내부 로직 생략됨
        deploy_infrastructure
        deploy_backend
        deploy_ai_services
        deploy_worker
        deploy_discord_owner
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
    echo "  --keep-data             PVC 삭제하지 않고 데이터 유지 (기본값)"
    echo "  --purge-data            PVC 포함 모든 데이터 삭제"
    echo "  --force                 확인 없이 강제 삭제"
    echo
    echo "환경변수:"
    echo "  IMAGE_TAG              공통 이미지 태그 (기본값: latest)"
    echo "  UI_IMAGE_TAG           UI 전용 이미지 태그 (기본값: IMAGE_TAG 값)"
    echo "  HERMES_IMAGE           caller-only immutable image subject; paired with receipt in ordinary mode"
    echo "  HERMES_CI_RECEIPT_FILE caller-only canonical GitHub Actions receipt path"
    echo "  HERMES_PROVENANCE_BUNDLE unsupported; nonempty values are rejected"
    echo "  HERMES_DEPLOY_MODE     caller-only: unset, cutover, upgrade, or rollback"
    echo "  HERMES_DEPLOY_IDENTITY caller-only restricted identity; explicit modes only"
    echo "  RETENTION_ACTIVE      preserve Discord rollback authority on undeploy (default: true)"
    echo "  DOCKER_REGISTRY        도커 레지스트리 (기본값: ghcr.io/skaldlabs)"
    echo "  SKIP_INGRESS           Ingress 건너뛰기 (기본값: false)"
    echo "  ENV_FILE              strict data-only dotenv path; no shell expansion (default: .env.prod)"
    echo
    echo "예시:"
    echo "  $0                                    # 기본 설정으로 배포"
    echo " $0 -t v1.0.0                         # 특정 태그로 배포"
    echo "  $0 -r my-registry.com -t v1.0.0     # 특정 레지스트리와 태그로 배포"
    echo "  $0 --skip-ingress                     # Ingress 없이 배포"
    echo "  $0 -y                                 # 확인 없이 배포"
    echo "  $0 --yes                              # 확인 없이 배포"
    echo "  $0 --undeploy                         # 데이터 유지하고 삭제 (기본값)"
    echo "  $0 --undeploy --purge-data            # 데이터 포함 전체 삭제"
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
        --purge-data)
            KEEP_DATA="false"
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
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    main "$@"
fi
