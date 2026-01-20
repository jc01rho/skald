# LLM Providers Configuration

This document lists all Large Language Model (LLM) providers configured and implemented in the Skald platform.

## Overview

Skald uses a hybrid approach for LLM handling:
1.  **Direct Backend Support**: The Node.js backend directly integrates with major providers.
2.  **Fallback/Proxy Support**: The Python Embedding Service acts as a robust proxy with fallback strategies for additional providers.

## Supported Providers

### 1. Primary Providers (Backend)
These providers are directly supported by the main application logic (`backend/src/services/llmService.ts`).

| Provider | Env Variable | Status | Implementation |
|----------|--------------|--------|----------------|
| **OpenAI** | `OPENAI_API_KEY` | Configured | `ChatOpenAI` (LangChain) |
| **Anthropic** | `ANTHROPIC_API_KEY` | Configured | `ChatAnthropic` (LangChain) |
| **Groq** | `GROQ_API_KEY` | Configured | `ChatOpenAI` (OpenAI Compatible) |
| **Gemini** | `GEMINI_API_KEY` | Configured | `ChatGoogleGenerativeAI` |
| **Z.ai** | `ZAI_API_KEY` | Configured | `ChatOpenAI` (OpenAI Compatible) |
| **Pollinations** | `POLLINATIONS_API_KEY` | Configured | `ChatOpenAI` (OpenAI Compatible) |
| **Local LLM** | `LOCAL_LLM_BASE_URL` | Optional | `ChatOpenAI` (OpenAI Compatible) |

### 2. Secondary/Fallback Providers (Embedding Service)
These providers are implemented in the Python service (`embedding-service`) to provide redundancy and fallback options when primary providers fail or for specific specialized tasks.

| Provider | Env Variable | Status | Role |
|----------|--------------|--------|------|
| **Mistral** | `MISTRAL_API_KEY` | Configured | Fallback Provider |
| **SiliconFlow** | `SILICONFLOW_API_KEY` | Configured | High-performance Fallback |
| **OpenRouter** | `OPENROUTER_API_KEY` | Configured | Fallback with Rate Limiting |

### 3. Embedding Providers

| Provider | Env Variable | Status | Notes |
|----------|--------------|--------|-------|
| **Voyage AI** | `VOYAGE_API_KEY` | Configured | High-quality embeddings & reranking |
| **OpenAI** | `OPENAI_API_KEY` | Configured | Standard embeddings |

## Configuration in Kubernetes

All API keys are managed via the `skald-secrets` Secret in the `skald` namespace.

### Viewing Current Configuration
```bash
# View all configured secrets (decoded)
kubectl get secret skald-secrets -n skald -o go-template='{{range $k,$v := .data}}{{printf "%s: " $k}}{{if not $v}}{{$v}}{{else}}{{$v | base64decode}}{{end}}{{"\n"}}{{end}}'
```

### Updating Keys
To update keys, edit the `k8s/secret.yaml` file (using `stringData` for plain text) and apply:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: skald-secrets
  namespace: skald
type: Opaque
stringData:
  OPENAI_API_KEY: "sk-..."
  ANTHROPIC_API_KEY: "sk-ant-..."
  # ... other keys
```

```bash
kubectl apply -f k8s/secret.yaml
# Restart pods to pick up changes
kubectl rollout restart deployment api -n skald
kubectl rollout restart deployment embedding-service -n skald
```

## Fallback Logic
The system implements a robust fallback chain in the Embedding Service to ensure reliability:
1.  **Primary**: Pollinations / Configured Primary
2.  **Fallback 1**: SiliconFlow (DeepSeek-V3)
3.  **Fallback 2**: GitHub Models (DeepSeek-R1 Round-Robin)
4.  **Fallback 3**: Mistral (Mistral Medium)
5.  **Fallback 4**: OpenRouter (Various models)
6.  **Fallback 5**: Groq (Multi-model chain)
7.  **Fallback 6**: Local LLM (Ollama)

This ensures that if one provider is down or rate-limited, the system automatically switches to the next available provider.
