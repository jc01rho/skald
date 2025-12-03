# Active Context

  This file tracks the project's current status, including recent changes, current goals, and open questions.
  2025-12-02 05:19:23 - Log of updates made.

*

## Current Focus

*   

## Recent Changes

*   

## Open Questions/Issues

*   
2025-12-03 12:49:08 - [UI Container Registry Update] Updated k8s/ui-deployment.yaml to use GitHub Container Registry (ghcr.io) for the UI container image instead of the previous DOCKER_REGISTRY variable.
2025-12-03 13:38:52 - [API URL Configuration] Modified VITE_API_URL in k8s/ui-deployment.yaml to use a hardcoded API endpoint "https://api.skald.sparrow.local" instead of the variable reference "https://${API_DOMAIN}".
2025-12-03 13:39:44 - [UI Deployment Restart] Successfully restarted the UI deployment in skald namespace using kubectl rollout restart deployment/ui -n skald command.
2025-12-03 13:57:11 - [Kubernetes Deployment Analysis] Analyzed docling, embedding-service, api, and memo-processing deployments to identify potential causes for automatic revival after undeploy.
[2025-12-03 06:01:00] - [API URL 동적 설정 아키텍처 설계 완료]
## 현재 작업
Kubernetes 환경에서 UI가 API 서버에 동적으로 접근할 수 있는 아키텍처 설계 완료

## 주요 변경사항
1. ConfigMap에 INTERNAL_API_URL(http://api-service:8080) 추가
2. UI Deployment에서 VITE_API_URL을 ConfigMap 값으로 동적 설정
3. 프론트엔드 코드에서 환경 변수 사용 방식 수정
4. Kubernetes 서비스 디스커버리 원칙 적용

## 다음 단계
- k8s/configmap.yaml 파일 수정
- k8s/ui-deployment.yaml 파일 수정
- frontend/src/lib/api.ts 파일 수정
- 테스트 및 검증