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