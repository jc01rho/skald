#!/bin/bash

# GitHub Actions 워크플로우 트리거 및 모니터링 스크립트
# 이 스크립트는 K8s UI 이미지 빌드 워크플로우를 실행하고 완료를 대기합니다.

set -e

# 색상 정의
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

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

echo "========================================="
echo "    GitHub Actions 워크플로우 트리거"
echo "========================================="
echo ""

# GitHub CLI 확인
if ! command -v gh &> /dev/null; then
    log_error "GitHub CLI (gh)가 설치되어 있지 않습니다."
    log_info "설치 방법: https://cli.github.com/manual/installation"
    log_info ""
    log_info "또는 GitHub 웹 인터페이스를 사용하세요:"
    log_info "  1. https://github.com/jc01rho/skald 접속"
    log_info "  2. Actions 탭 클릭"
    log_info "  3. 'Build UI for Kubernetes' 워크플로우 선택"
    log_info "  4. 'Run workflow' 클릭"
    exit 1
fi

# GitHub 인증 확인
if ! gh auth status &> /dev/null; then
    log_error "GitHub CLI 인증이 필요합니다."
    log_info "다음 명령으로 인증하세요: gh auth login"
    exit 1
fi

# 워크플로우 트리거
log_info "GitHub Actions 워크플로우를 트리거합니다..."
log_info "워크플로우: build-ui-for-k8s.yml"
log_info "브랜치: main"
log_info "이미지 태그: k8s-latest"
echo ""

if gh workflow run build-ui-for-k8s.yml \
    --ref main \
    --field image_tag=k8s-latest; then
    log_success "워크플로우 트리거 완료"
else
    log_error "워크플로우 트리거 실패"
    exit 1
fi

echo ""
log_info "워크플로우 진행 상황을 확인합니다..."
sleep 3

# 최근 워크플로우 실행 확인
log_info "최근 워크플로우 실행 목록:"
gh run list --workflow=build-ui-for-k8s.yml --limit 5

echo ""
log_info "워크플로우 완료를 대기합니다..."
log_warning "이 작업은 5-10분 정도 소요될 수 있습니다."
echo ""

# 최근 실행 ID 가져오기
RUN_ID=$(gh run list --workflow=build-ui-for-k8s.yml --limit 1 --json databaseId --jq '.[0].databaseId')

if [ -z "$RUN_ID" ]; then
    log_error "워크플로우 실행 ID를 찾을 수 없습니다."
    log_info "GitHub 웹에서 수동으로 확인하세요: https://github.com/jc01rho/skald/actions"
    exit 1
fi

log_info "워크플로우 실행 ID: $RUN_ID"
log_info "웹에서 확인: https://github.com/jc01rho/skald/actions/runs/$RUN_ID"
echo ""

# 워크플로우 완료 대기
if gh run watch $RUN_ID; then
    log_success "워크플로우가 성공적으로 완료되었습니다!"
    echo ""
    log_info "빌드된 이미지:"
    log_success "  ghcr.io/jc01rho/skald-ui:k8s-latest"
    echo ""
    log_info "다음 단계:"
    echo "  1. cd /home/sparrow/git/skald/k8s"
    echo "  2. IMAGE_TAG=k8s-latest ./deploy.sh"
    echo ""
else
    log_error "워크플로우가 실패했습니다."
    log_info "로그 확인: gh run view $RUN_ID --log"
    exit 1
fi
