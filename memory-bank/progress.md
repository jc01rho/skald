# Progress

This file tracks the project's progress using a task list format.
2025-12-02 05:19:44 - Log of updates made.

*

## Completed Tasks

*   

## Current Tasks

*   Kubernetes 설정 검증 및 보고 계획 수립

## Next Steps

*   
2025-12-03 12:49:13 - [Task Completed] Updated UI container image reference in k8s/ui-deployment.yaml from ${DOCKER_REGISTRY:-skaldlabs}/skald-frontend:${IMAGE_TAG:-latest} to ghcr.io/skaldlabs/skald-frontend:${IMAGE_TAG:-latest}
2025-12-03 13:23:17 - [Task Completed] Fixed Ingress resource validation errors by replacing placeholder variables with concrete hostnames in k8s/ingress.yaml
2025-12-03 13:38:57 - [Task Completed] Updated VITE_API_URL in k8s/ui-deployment.yaml from "https://${API_DOMAIN}" to "https://api.skald.sparrow.local" as requested.
2025-12-03 13:39:56 - [Task Completed] Restarted UI deployment in skald namespace using kubectl rollout restart deployment/ui -n skald command.