# Decision Log

This file records architectural and implementation decisions using a list format.
2025-12-02 05:19:38 - Log of updates made.

*

## Decision

*

## Rationale 

*

## Implementation Details

*
2025-12-03 12:49:02 - [Container Registry Migration] Changed UI container image from ${DOCKER_REGISTRY:-skaldlabs}/skald-frontend:${IMAGE_TAG:-latest} to ghcr.io/skaldlabs/skald-frontend:${IMAGE_TAG:-latest} to point to GitHub Container Registry where the UI image will be published by GitHub Actions.
2025-12-03 13:23:11 - [Ingress Hostname Fix] Replaced placeholder variables ${UI_DOMAIN} and ${API_DOMAIN} in k8s/ingress.yaml with concrete hostnames ui.skald.local and api.skald.local to resolve validation errors when applying with kubectl.
2025-12-03 13:38:45 - [API URL Configuration] Updated VITE_API_URL in k8s/ui-deployment.yaml from "https://${API_DOMAIN}" to "https://api.skald.sparrow.local" to use a hardcoded API endpoint instead of a variable reference.
[2025-12-03 06:01:00] - [API URL 동적 설정 아키텍처 결정]
## 결정
UI가 API 서버의 주소를 동적으로 설정할 수 있는 아키텍처 설계 완료

## 근거
현재 시스템에서 UI가 API 서버에 연결할 때 `http://localhost:8080`을 하드코딩하여 사용하고 있어 Kubernetes 환경에서 문제 발생

## 구현 내용
1. ConfigMap에 INTERNAL_API_URL 추가 (http://api-service:8080)
2. UI Deployment에서 VITE_API_URL을 ConfigMap 값으로 동적 설정
3. 프론트엔드 코드에서 환경 변수를 올바르게 사용하도록 수정
4. Kubernetes 서비스 디스커버리 원칙에 따라 내부 통신 구현

## 관련 파일
- k8s/api-url-architecture-design.md: 상세 설계 문서
- k8s/configmap.yaml: INTERNAL_API_URL 추가 필요
- k8s/ui-deployment.yaml: 환경 변수 설정 수정 필요
- frontend/src/lib/api.ts: 환경 변수 사용 방식 수정 필요