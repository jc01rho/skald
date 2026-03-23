# Embedding Service

FastAPI microservice for embeddings, reranking, tokenization, and OpenAI-compatible helper endpoints.

## Features

- **Embedding generation** via `/embed` and OpenAI-compatible `/v1/embeddings`
- **Document reranking** via `/rerank`
- **Korean-aware tokenization** via `/tokenize`
- **OpenAI-compatible chat passthrough** via `/v1/chat/completions`
- **Operational endpoints** for health and runtime configuration inspection

## Running the Service

### Local process

`backend/src/settings.ts` defaults `EMBEDDING_SERVICE_URL` to `http://localhost:8001`, so the simplest local setup is to run the service on port `8001`.

```bash
cd embedding-service
uv sync --no-install-project
uv run uvicorn main:app --host 0.0.0.0 --port 8001
```

### Docker

The container listens on port `8000`. Map it to `8001` on the host if you want to match the backend's local default.

```bash
cd embedding-service
docker build -t embedding-service .
docker run -p 8001:8000 embedding-service
```

### Kubernetes

The Kubernetes deployment and service use port `8000` internally:

- `k8s/embedding-service-deployment.yaml`
- `k8s/embedding-service-service.yaml`

## Configuration

Common environment variables:

| Variable                 | Description                                                 | Default                                                                  |
| ------------------------ | ----------------------------------------------------------- | ------------------------------------------------------------------------ |
| `EMBEDDING_PROVIDER`     | Embedding backend (`external`, `local`, `ollama`, `gemini`) | `external`                                                               |
| `EMBEDDING_MODEL`        | Embedding model name                                        | `BAAI/bge-m3`                                                            |
| `RERANK_PROVIDER`        | Reranker backend                                            | `ollama`                                                                 |
| `RERANK_MODEL`           | Reranker model name                                         | `xitao/bge-reranker-v2-m3:latest`                                        |
| `TARGET_DIMENSION`       | Output embedding dimension                                  | `768` in code, overridden to `2048` in the current Kubernetes deployment |
| `QUERY_LANGUAGE`         | Query language optimization hint                            | `ko`                                                                     |
| `EXTERNAL_EMBEDDING_URL` | External embedding endpoint                                 | `http://localhost:8889/embeddings`                                       |
| `LOCAL_LLM_BASE_URL`     | Base URL used for local/Ollama-style fallback               | `http://localhost:11434`                                                 |
| `CLI_PROXY_API_KEY`      | CLI Proxy auth key                                          | empty                                                                    |
| `CLI_PROXY_BASE_URL`     | CLI Proxy base URL                                          | empty                                                                    |
| `CLI_PROXY_MODELS`       | Comma-separated CLI Proxy fallback models                   | empty                                                                    |
| `LOG_LEVEL`              | Python logging level                                        | `DEBUG`                                                                  |

## API Endpoints

The main FastAPI app in `main.py` exposes:

| Endpoint               | Method | Purpose                                                 |
| ---------------------- | ------ | ------------------------------------------------------- |
| `/health`              | GET    | Service health and active provider info                 |
| `/embed`               | POST   | Native embedding API                                    |
| `/v1/embeddings`       | POST   | OpenAI-compatible embeddings API                        |
| `/rerank`              | POST   | Rerank documents against a query                        |
| `/tokenize`            | POST   | Korean-aware tokenization utility                       |
| `/api-keys/validate`   | POST   | Deprecated validation endpoint; currently returns `410` |
| `/info`                | GET    | Runtime feature/config summary                          |
| `/api-keys/status`     | GET    | Provider/key status summary                             |
| `/v1/chat/completions` | POST   | OpenAI-compatible chat completion endpoint              |

> Note: `semantic_chunker.py` defines a separate FastAPI app with `/semantic-chunk`, but it is not mounted into `main.py`.

## API Documentation

If you run the service locally on port `8001`:

- Swagger UI: `http://localhost:8001/docs`
- ReDoc: `http://localhost:8001/redoc`
