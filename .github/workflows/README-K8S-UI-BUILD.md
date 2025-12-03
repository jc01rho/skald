# GitHub Actions - K8s UI 자동 빌드

## 개요

이 워크플로우는 Kubernetes 배포에 최적화된 UI 이미지를 자동으로 빌드합니다.

## 핵심 차이점

### 일반 UI vs K8s UI

| 항목 | 일반 UI | K8s UI |
|------|---------|---------|
| 빌드 인자 | `VITE_API_HOST=http://localhost:3000` | `VITE_API_HOST=""` |
| API 호출 방식 | 절대 경로 (`http://localhost:3000/api`) | 상대 경로 (`/api`) |
| 이미지 태그 | `latest` | `k8s-latest`, `k8s-{sha}` |
| Nginx 프록시 | 불필요 | 필수 (`/api` → `api-service:8080`) |

## 워크플로우 파일

### 1. `build-ui-for-k8s.yml` (신규)

**목적**: K8s 전용 UI 이미지 빌드

**트리거**:
- Frontend 코드 변경 시 (`frontend/**`, `ui.Dockerfile` 등)
- 수동 실행 (workflow_dispatch)

**빌드 인자**:
```yaml
build-args: |
  VITE_API_HOST=
  VITE_IS_SELF_HOSTED_DEPLOY=true
```

**생성되는 이미지 태그**:
- `ghcr.io/jc01rho/skald-ui:k8s-latest` (메인)
- `ghcr.io/jc01rho/skald-ui:k8s-{git-sha}` (추적용)

### 2. `deploy-to-k8s.yml` (수정됨)

**변경 사항**:
1. UI 이미지 태그를 `k8s-latest`로 고정
2. `ui-nginx-configmap.yaml` 배포 단계 추가

## 사용 방법

### 자동 빌드

프론트엔드 코드를 main 브랜치에 푸시하면 자동으로 빌드됩니다:

```bash
git add frontend/
git commit -m "Update frontend"
git push origin main
```

### 수동 빌드

GitHub Actions 페이지에서:
1. "Build UI for Kubernetes" 워크플로우 선택
2. "Run workflow" 클릭
3. 원하는 이미지 태그 입력 (기본값: `k8s-latest`)
4. "Run workflow" 실행

### 로컬 빌드

긴급한 경우 로컬에서도 빌드 가능:

```bash
cd /home/sparrow/git/skald
./k8s/build-ui-for-k8s.sh

# 또는
docker build \
  --build-arg VITE_API_HOST="" \
  --file ui.Dockerfile \
  --tag ghcr.io/jc01rho/skald-ui:k8s-local \
  .
```

## 검증

### 1. GitHub Actions에서 확인

워크플로우 실행 후 Summary 페이지에서:
- 빌드된 이미지 태그 확인
- 빌드 인자 확인

### 2. 이미지 pull 테스트

```bash
docker pull ghcr.io/jc01rho/skald-ui:k8s-latest
```

### 3. K8s 배포 후 확인

```bash
# Pod에서 빌드된 코드 확인
kubectl exec -it deployment/ui -n skald -- \
  find /usr/share/nginx/html -name "*.js" -exec grep -l "localhost:8080" {} \;

# 결과가 없으면 성공 (상대 경로 사용 중)
```

### 4. 브라우저 테스트

1. https://ui.skald.sparrow.local 접속
2. 개발자 도구 → Network 탭
3. API 요청이 `/api/...`로 발생하는지 확인
4. `localhost:8080` 요청이 **없어야** 함

## 트러블슈팅

### 이미지 빌드 실패

**증상**: GitHub Actions 워크플로우 실패

**해결**:
1. 워크플로우 로그 확인
2. `ui.Dockerfile` 문법 오류 확인
3. `package.json` 의존성 확인

### 여전히 localhost:8080으로 요청

**증상**: 브라우저에서 `localhost:8080` 요청 발생

**원인**: 
- 잘못된 이미지 태그 사용
- 이미지가 캐시되어 재빌드되지 않음

**해결**:
```bash
# 1. 이미지 태그 확인
kubectl get deployment ui -n skald -o jsonpath='{.spec.template.spec.containers[0].image}'

# 예상 출력: ghcr.io/jc01rho/skald-ui:k8s-latest

# 2. Pod 재시작
kubectl rollout restart deployment/ui -n skald

# 3. 이미지 강제 재pull
kubectl delete pod -l component=ui -n skald
```

### Nginx 프록시가 작동하지 않음

**증상**: `/api` 요청이 404

**확인**:
```bash
# Nginx ConfigMap 확인
kubectl get configmap ui-nginx-config -n skald -o yaml

# Nginx 설정 확인
kubectl exec -it deployment/ui -n skald -- cat /etc/nginx/nginx.conf
```

## 관련 파일

- `.github/workflows/build-ui-for-k8s.yml` - K8s UI 빌드 워크플로우
- `.github/workflows/deploy-to-k8s.yml` - K8s 배포 워크플로우
- `k8s/ui-nginx-configmap.yaml` - Nginx 프록시 설정
- `k8s/ui-deployment.yaml` - UI Deployment 정의
- `k8s/build-ui-for-k8s.sh` - 로컬 빌드 스크립트

## 참고

- [Vite Environment Variables](https://vitejs.dev/guide/env-and-mode.html)
- [Docker Build Arguments](https://docs.docker.com/engine/reference/commandline/build/#set-build-time-variables---build-arg)
- [GitHub Actions - docker/build-push-action](https://github.com/docker/build-push-action)
