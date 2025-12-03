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