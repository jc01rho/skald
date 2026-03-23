# GitHub Actions - K8s UI 자동 빌드

## 개요

이 워크플로우는 Kubernetes 배포용 UI 이미지를 빌드합니다. 핵심 목표는 브라우저가 API를 절대 URL이 아니라 상대 경로 `/api`로 호출하도록 만드는 것입니다.

## 현재 구현 기준

### GitHub Actions 워크플로우

파일: `.github/workflows/build-ui-for-k8s.yml`

- 이미지 이름: `ghcr.io/${{ github.repository }}/ui`
- 기본 태그: `latest`
- 추가 태그: `${{ github.sha }}`
- 빌드 인자:

```yaml
build-args: |
    VITE_API_HOST=
    VITE_IS_SELF_HOSTED_DEPLOY=true
```

즉, GitHub Actions 빌드는 `VITE_API_HOST`를 빈 값으로 두고, 런타임에 `k8s/ui-nginx-configmap.yaml`의 Nginx 프록시와 `sub_filter` 조합으로 `/api` 경로를 보정합니다.

### 로컬 K8s 빌드 스크립트

파일: `k8s/build-ui-for-k8s.sh`

- 기본 이미지 이름: `ghcr.io/jc01rho/skald-ui`
- 기본 태그: `k8s-proxy`
- 로컬 스크립트는 `VITE_API_HOST="/api"`로 빌드합니다.

이 차이는 의도된 것입니다. GitHub Actions는 빈 값 + Nginx 런타임 보정, 로컬 스크립트는 `/api`를 직접 주입합니다.

## 생성되는 이미지 태그

GitHub Actions 기준:

- `ghcr.io/jc01rho/skald/ui:latest`
- `ghcr.io/jc01rho/skald/ui:<git-sha>`

현재 `k8s/ui-deployment.yaml`은 `ghcr.io/jc01rho/skald/ui:latest`를 사용합니다.

## 사용 방법

### 자동 빌드

`main` 브랜치에 다음 경로 변경이 푸시되면 자동으로 실행됩니다.

- `frontend/**`
- `ui.Dockerfile`
- `vite.config.ts`
- `package.json`
- `pnpm-lock.yaml`

### 수동 실행

GitHub Actions 페이지에서 **Build UI for Kubernetes** 워크플로우를 선택한 뒤, 필요하면 `image_tag` 입력값을 넘겨 실행합니다.

### 로컬 빌드

```bash
cd /home/jc01rho/git/skald
./k8s/build-ui-for-k8s.sh

# 또는 태그를 직접 지정
IMAGE_TAG=k8s-local ./k8s/build-ui-for-k8s.sh
```

## 검증

### 1. GitHub Actions Summary 확인

- 빌드된 이미지 태그
- 빌드 인자
- localhost 문자열 검증 결과

### 2. 이미지 pull 테스트

```bash
docker pull ghcr.io/jc01rho/skald/ui:latest
```

### 3. K8s 배포 후 확인

```bash
kubectl exec -it deployment/ui -n skald -- \
  find /usr/share/nginx/html -name "*.js" -exec grep -l "localhost" {} \;
```

결과가 없거나, 의도한 치환 대상만 남아 있으면 정상입니다.

### 4. 브라우저 테스트

1. UI 도메인에 접속
2. 개발자 도구 → Network 탭 열기
3. API 요청이 `/api/...`로 나가는지 확인
4. `localhost:8080`, `localhost:3000`, `localhost:8000`으로 직접 호출되지 않는지 확인

## 트러블슈팅

### 여전히 localhost로 요청하는 경우

```bash
# 1. 현재 배포 이미지 확인
kubectl get deployment ui -n skald -o jsonpath='{.spec.template.spec.containers[0].image}'

# 2. Nginx ConfigMap 확인
kubectl get configmap ui-nginx-config -n skald -o yaml

# 3. UI 재시작
kubectl rollout restart deployment/ui -n skald
```

### `/api` 요청이 404인 경우

```bash
# Nginx 설정 확인
kubectl exec -it deployment/ui -n skald -- cat /etc/nginx/nginx.conf

# UI Pod의 health 확인
kubectl exec -it deployment/ui -n skald -- curl http://localhost:8080/health
```

## 관련 파일

- `.github/workflows/build-ui-for-k8s.yml` - K8s UI 빌드 워크플로우
- `k8s/ui-nginx-configmap.yaml` - Nginx 프록시 설정
- `k8s/ui-deployment.yaml` - UI Deployment 정의
- `k8s/build-ui-for-k8s.sh` - 로컬 빌드 스크립트
