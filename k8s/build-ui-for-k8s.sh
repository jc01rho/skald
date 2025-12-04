#!/bin/bash

# K8s용 UI 이미지 빌드 스크립트
# 이 스크립트는 VITE_API_HOST를 빈 문자열로 설정하여 UI를 빌드합니다.

set -e

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

# 설정
IMAGE_NAME="${IMAGE_NAME:-ghcr.io/jc01rho/skald-ui}"
IMAGE_TAG="${IMAGE_TAG:-k8s-proxy}"
PUSH_IMAGE="${PUSH_IMAGE:-false}"

echo "========================================="
echo "    K8s용 UI 이미지 빌드"
echo "========================================="
echo ""
log_info "이미지: $IMAGE_NAME:$IMAGE_TAG"
log_info "푸시: $PUSH_IMAGE"
echo ""

# 프로젝트 루트 확인
if [ ! -f "ui.Dockerfile" ]; then
    log_error "ui.Dockerfile을 찾을 수 없습니다."
    log_error "프로젝트 루트 디렉토리에서 실행하세요."
    exit 1
fi

# Docker 확인
if ! command -v docker &> /dev/null; then
    log_error "Docker가 설치되어 있지 않습니다."
    exit 1
fi

# 빌드 시작
log_info "UI 이미지 빌드 시작..."
log_warning "VITE_API_HOST='/api'로 빌드하여 Nginx 프록시 경로 사용"

if docker build \
  --build-arg VITE_API_HOST="/api" \
  --build-arg VITE_IS_SELF_HOSTED_DEPLOY="true" \
  --file ui.Dockerfile \
  --tag "$IMAGE_NAME:$IMAGE_TAG" \
  --progress=plain \
  .; then
    log_success "UI 이미지 빌드 완료: $IMAGE_NAME:$IMAGE_TAG"
else
    log_error "UI 이미지 빌드 실패"
    exit 1
fi

# 이미지 푸시
if [ "$PUSH_IMAGE" = "true" ]; then
    log_info "이미지를 레지스트리에 푸시 중..."
    
    if docker push "$IMAGE_NAME:$IMAGE_TAG"; then
        log_success "이미지 푸시 완료"
    else
        log_error "이미지 푸시 실패"
        exit 1
    fi
else
    log_info "이미지 푸시를 건너뜁니다. (PUSH_IMAGE=true로 설정하여 푸시)"
fi

echo ""
log_success "빌드 완료!"
echo ""
log_info "다음 단계:"
echo "  1. k8s/ui-deployment.yaml의 이미지 태그를 '$IMAGE_TAG'로 변경"
echo "  2. kubectl apply -f k8s/ui-nginx-configmap.yaml"
echo "  3. kubectl apply -f k8s/ui-deployment.yaml"
echo "  4. kubectl rollout restart deployment/ui -n skald"
echo ""
log_info "또는 다음 명령으로 자동 배포:"
echo "  cd k8s && ./deploy.sh"
echo ""
