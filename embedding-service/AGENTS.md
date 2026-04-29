# EMBEDDING SERVICE

**Generated:** 2026-04-29
**Domain:** Python Embedding/Rerank API (Score 10)

## OVERVIEW

Single-file FastAPI microservice for embeddings, reranking, and chat proxy support used by backend retrieval flows.

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| API app | `main.py` | endpoints, model clients, request/response models |
| Chunking | `semantic_chunker.py` | semantic chunk splitting helpers |
| Python project | `pyproject.toml`, `uv.lock` | dependencies and runtime environment |
| Container | `Dockerfile` | service image build |

## CONVENTIONS

- Run locally with `uv run uvicorn main:app --host 0.0.0.0 --port 8001`.
- Keep request/response schemas explicit; backend depends on stable embedding/rerank shapes.
- Provider base URLs and keys must be environment-driven.
- This service is intentionally compact; split modules only when endpoint/model count justifies it.

## ANTI-PATTERNS

- Do not hardcode provider API keys, model endpoint URLs, or cluster-only hosts.
- Do not change embedding vector dimensions without coordinating backend entity/migration/index assumptions.
- Do not add heavyweight startup downloads without documenting container cold-start impact.
