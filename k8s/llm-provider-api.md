# LLM Provider API Specifications

This document provides detailed API specifications for all LLM providers supported by the Skald platform. Each provider section contains all necessary information for developers to implement integrations without needing to reference other code.

---

## Table of Contents

- [LLM Provider API Specifications](#llm-provider-api-specifications)
    - [Table of Contents](#table-of-contents)
    - [Primary Providers (Backend)](#primary-providers-backend)
        - [OpenAI](#openai)
        - [Anthropic](#anthropic)
        - [Groq](#groq)
        - [Gemini](#gemini)
        - [Z.ai (ChatGLM)](#zai-chatglm)
        - [Pollinations](#pollinations)
        - [Local LLM](#local-llm)
    - [Secondary/Fallback Providers (Embedding Service)](#secondaryfallback-providers-embedding-service)
    - [SiliconFlow](#siliconflow)
    - [OpenRouter](#openrouter)
        - [Mistral](#mistral)
    - [Fallback Chain (Embedding Service)](#fallback-chain-embedding-service)
    - [Common Patterns](#common-patterns)
        - [OpenAI-Compatible API Format](#openai-compatible-api-format)
        - [Streaming Response Handling (Python)](#streaming-response-handling-python)
        - [LangChain Integration](#langchain-integration)
    - [Testing Your Implementation](#testing-your-implementation)
        - [Environment Setup](#environment-setup)
        - [Test Endpoint](#test-endpoint)
        - [Health Check](#health-check)
    - [Additional Resources](#additional-resources)
    - [Contributing New Providers](#contributing-new-providers)

---

## Primary Providers (Backend)

These providers are directly supported by the main backend application (`backend/src/services/llmService.ts`).

### OpenAI

**Type**: Native LangChain Integration

**Environment Variables**:

```bash
OPENAI_API_KEY=sk-...                     # Required
LLM_PROVIDER=openai                         # Set to enable OpenAI as primary
OPENAI_MODEL=gpt-4o-mini                  # Optional, default: gpt-4o-mini
```

**Implementation Details**:

- Uses LangChain's `ChatOpenAI` class
- OpenAI-native API endpoint (no baseURL override)
- API Key authentication via Bearer token

**Default Models**:
| Purpose | Model Slug | Display Name |
|---------|------------|--------------|
| Chat | `gpt-4o-mini` | GPT-4o Mini |
| Classification | `gpt-4o-mini` | GPT-4o Mini |

**Supported Models**:

- `gpt-4o-mini`
- `gpt-5-nano`

**Request Format (LangChain abstraction)**:

```typescript
{
  messages: Array<{role: 'user' | 'assistant' | 'system', content: string}>,
  temperature: number  // default: 0
}
```

**Response Format (LangChain abstraction)**:

```typescript
{
  content: string,
  usage: {
    prompt_tokens: number,
    completion_tokens: number,
    total_tokens: number
  }
}
```

**Example Implementation**:

```typescript
import { ChatOpenAI } from '@langchain/openai'

const llm = new ChatOpenAI({
    model: 'gpt-4o-mini',
    apiKey: process.env.OPENAI_API_KEY,
    temperature: 0,
})

const response = await llm.invoke([{ role: 'user', content: 'Hello, world!' }])
```

**Error Handling**:

- Throws `Error` if `OPENAI_API_KEY` is not configured
- Standard OpenAI error responses (429, 401, etc.)

---

### Anthropic

**Type**: Native LangChain Integration

**Environment Variables**:

```bash
ANTHROPIC_API_KEY=sk-ant-...              # Required
LLM_PROVIDER=anthropic                      # Set to enable Anthropic as primary
ANTHROPIC_MODEL=claude-sonnet-4-5-20250929 # Optional, default: claude-sonnet-4-5-20250929
```

**Implementation Details**:

- Uses LangChain's `ChatAnthropic` class
- Anthropic-native API endpoint
- API Key authentication via x-api-key header

**Default Models**:
| Purpose | Model Slug | Display Name |
|---------|------------|--------------|
| Chat | `claude-sonnet-4-5-20250929` | Claude Sonnet 4.5 |
| Classification | `claude-haiku-4-5-20251001` | Claude Haiku 4.5 |

**Supported Models**:

- `claude-haiku-4-5-20251001`
- `claude-sonnet-4-5-20250929`

**Request Format (LangChain abstraction)**:

```typescript
{
  messages: Array<{role: 'user' | 'assistant' | 'system', content: string}>,
  temperature: number  // default: 0
}
```

**Response Format (LangChain abstraction)**:

```typescript
{
  content: string,
  usage: {
    prompt_tokens: number,
    completion_tokens: number,
    total_tokens: number
  }
}
```

**Example Implementation**:

```typescript
import { ChatAnthropic } from '@langchain/anthropic'

const llm = new ChatAnthropic({
    model: 'claude-sonnet-4-5-20250929',
    apiKey: process.env.ANTHROPIC_API_KEY,
    temperature: 0,
})

const response = await llm.invoke([{ role: 'user', content: 'Hello, world!' }])
```

**Error Handling**:

- Throws `Error` if `ANTHROPIC_API_KEY` is not configured
- Standard Anthropic error responses (429, 401, etc.)

---

### Groq

**Type**: OpenAI-Compatible (with optional local proxy)

**Environment Variables**:

```bash
GROQ_API_KEY=gsk_...                      # Optional (can use proxy)
LLM_PROVIDER=groq                          # Set to enable Groq as primary
GROQ_MODEL=llama-3.1-8b-instant          # Optional, default: llama-3.1-8b-instant
LOCAL_LLM_BASE_URL=http://localhost:11434   # Optional: use embedding-service as proxy
```

**Implementation Details**:

- Uses LangChain's `ChatOpenAI` with baseURL override
- OpenAI-compatible API format at Groq endpoint
- **Supports local proxy**: If `LOCAL_LLM_BASE_URL` is set, requests go through embedding-service
- Proxy handles key rotation and rate limiting

**API Endpoints**:

- **Direct**: `https://api.groq.com/openai/v1`
- **Via Proxy**: `{LOCAL_LLM_BASE_URL}/v1` (embedding-service)

**Default Models**:
| Purpose | Model Slug | Display Name | RPM | TPM |
|---------|------------|--------------|-----|-----|
| Chat | `llama-3.3-70b-versatile` | Llama 3.3 70B Versatile | 30 | 12,000 |
| Classification | `llama-3.1-8b-instant` | Llama 3.1 8B Instant | 30 | 6,000 |

**Supported Models**:
| Model Slug | Display Name | RPM | TPM |
|------------|--------------|-----|-----|
| `llama-3.1-8b-instant` | Llama 3.1 8B Instant | 30 | 6,000 |
| `llama-3.3-70b-versatile` | Llama 3.3 70B Versatile | 30 | 12,000 |
| `qwen/qwen3-32b` | Qwen 3 32B | 60 | 6,000 |
| `moonshotai/kimi-k2-instruct` | Kimi K2 Instruct | 60 | 10,000 |
| `moonshotai/kimi-k2-instruct-0905` | Kimi K2 Instruct 0905 | 60 | 10,000 |
| `openai/gpt-oss-120b` | GPT OSS 120B | 30 | 8,000 |
| `openai/gpt-oss-20b` | GPT OSS 20B | 30 | 8,000 |
| `openai/gpt-oss-safeguard-20b` | GPT OSS Safeguard 20B | 30 | 8,000 |
| `groq/compound` | Groq Compound | 30 | 70,000 |
| `groq/compound-mini` | Groq Compound Mini | 30 | 70,000 |
| `meta-llama/llama-4-scout-17b-16e-instruct` | Llama 4 Scout 17B | 30 | 30,000 |
| `meta-llama/llama-4-maverick-17b-128e-instruct` | Llama 4 Maverick 17B | 30 | 6,000 |
| `meta-llama/llama-guard-4-12b` | Llama Guard 4 12B | 30 | 15,000 |
| `meta-llama/llama-prompt-guard-2-22m` | Llama Prompt Guard 2 22M | 30 | 15,000 |
| `meta-llama/llama-prompt-guard-2-86m` | Llama Prompt Guard 2 86M | 30 | 15,000 |
| `allam-2-7b` | Allam 2 7B | 30 | 6,000 |

**Request Format (OpenAI-Compatible)**:

```json
{
    "model": "llama-3.1-8b-instant",
    "messages": [{ "role": "user", "content": "Hello, world!" }],
    "temperature": 0.7,
    "stream": false
}
```

**Response Format (OpenAI-Compatible)**:

```json
{
    "id": "chatcmpl-123",
    "object": "chat.completion",
    "created": 1699012345,
    "model": "llama-3.1-8b-instant",
    "choices": [
        {
            "index": 0,
            "message": {
                "role": "assistant",
                "content": "Hello! How can I help you today?"
            },
            "finish_reason": "stop"
        }
    ],
    "usage": {
        "prompt_tokens": 10,
        "completion_tokens": 9,
        "total_tokens": 19
    }
}
```

**Example Implementation (Direct)**:

```typescript
import { ChatOpenAI } from '@langchain/openai'

const llm = new ChatOpenAI({
    model: 'llama-3.1-8b-instant',
    apiKey: process.env.GROQ_API_KEY,
    configuration: {
        baseURL: 'https://api.groq.com/openai/v1',
    },
    temperature: 0,
})

const response = await llm.invoke([{ role: 'user', content: 'Hello, world!' }])
```

**Example Implementation (Via Proxy)**:

```typescript
import { ChatOpenAI } from '@langchain/openai'

const llm = new ChatOpenAI({
    model: 'llama-3.1-8b-instant',
    apiKey: process.env.GROQ_API_KEY || 'managed', // 'managed' if proxy handles keys
    configuration: {
        baseURL: 'http://localhost:11434/v1', // embedding-service endpoint
    },
    temperature: 0,
})

const response = await llm.invoke([{ role: 'user', content: 'Hello, world!' }])
```

**Rate Limiting (Proxy Mode)**:

- Embedding service uses `GroqKeyManager` for round-robin key rotation
- RPM-based throttling at 90% of allowed limits
- Automatic key rotation on rate limit (429) errors

**Error Handling**:

- Throws `Error` if `GROQ_API_KEY` is not set and no proxy configured
- Standard OpenAI-compatible error responses

---

### Gemini

**Type**: Native LangChain Integration

**Environment Variables**:

```bash
GEMINI_API_KEY=AIza...                     # Required
LLM_PROVIDER=gemini                         # Set to enable Gemini as primary
GEMINI_MODEL=gemini-2.5-pro               # Optional, default: gemini-2.5-pro
```

**Implementation Details**:

- Uses LangChain's `ChatGoogleGenerativeAI` class
- Google AI Studio API endpoint
- API Key authentication

**Default Models**:
| Purpose | Model Slug | Display Name |
|---------|------------|--------------|
| Chat | `gemini-2.5-pro` | Gemini 2.5 Pro |
| Classification | `gemini-2.5-flash` | Gemini 2.5 Flash |

**Supported Models**:

- `gemini-2.5-flash`
- `gemini-2.5-pro`

**Request Format (LangChain abstraction)**:

```typescript
{
  messages: Array<{role: 'user' | 'assistant' | 'system', content: string}>,
  temperature: number  // default: 0
}
```

**Response Format (LangChain abstraction)**:

```typescript
{
  content: string,
  usage: {
    prompt_tokens: number,
    completion_tokens: number,
    total_tokens: number
  }
}
```

**Example Implementation**:

```typescript
import { ChatGoogleGenerativeAI } from '@langchain/google-genai'

const llm = new ChatGoogleGenerativeAI({
    model: 'gemini-2.5-pro',
    apiKey: process.env.GEMINI_API_KEY,
    temperature: 0,
})

const response = await llm.invoke([{ role: 'user', content: 'Hello, world!' }])
```

**Error Handling**:

- Throws `Error` if `GEMINI_API_KEY` is not configured
- Standard Gemini error responses (429, 403, etc.)

---

### Z.ai (ChatGLM)

**Type**: OpenAI-Compatible

**Environment Variables**:

```bash
ZAI_API_KEY=...                             # Required
LLM_PROVIDER=zai                            # Set to enable Z.ai as primary
ZAI_MODEL=glm-4.7                          # Optional, default: glm-4.7
```

**Implementation Details**:

- Uses LangChain's `ChatOpenAI` with baseURL override
- OpenAI-compatible API format at Z.ai endpoint

**API Endpoint**:

- **Base URL**: `https://api.z.ai/api/paas/v4`
- **Chat Completions**: `https://api.z.ai/api/paas/v4/chat/completions`

**Default Models**:
| Purpose | Model Slug | Display Name |
|---------|------------|--------------|
| Chat | `glm-4.7` | GLM 4.7 |
| Classification | `glm-4.7` | GLM 4.7 |

**Supported Models**:

- `glm-4.7` (default)

**Request Format (OpenAI-Compatible)**:

```json
{
    "model": "glm-4.7",
    "messages": [{ "role": "user", "content": "Hello, world!" }],
    "temperature": 0.7,
    "stream": false
}
```

**Response Format (OpenAI-Compatible)**:

```json
{
    "id": "chatcmpl-123",
    "object": "chat.completion",
    "created": 1699012345,
    "model": "glm-4.7",
    "choices": [
        {
            "index": 0,
            "message": {
                "role": "assistant",
                "content": "Hello! How can I help you today?"
            },
            "finish_reason": "stop"
        }
    ],
    "usage": {
        "prompt_tokens": 10,
        "completion_tokens": 9,
        "total_tokens": 19
    }
}
```

**Example Implementation**:

```typescript
import { ChatOpenAI } from '@langchain/openai'

const llm = new ChatOpenAI({
    model: 'glm-4.7',
    apiKey: process.env.ZAI_API_KEY,
    configuration: {
        baseURL: 'https://api.z.ai/api/paas/v4',
    },
    temperature: 0,
})

const response = await llm.invoke([{ role: 'user', content: 'Hello, world!' }])
```

**Error Handling**:

- Throws `Error` if `ZAI_API_KEY` is not configured
- Standard OpenAI-compatible error responses

---

### Pollinations

**Type**: OpenAI-Compatible (No API Key Required)

**Environment Variables**:

```bash
POLLINATIONS_API_KEY=...                    # Optional (free tier doesn't require key)
LLM_PROVIDER=pollinations                   # Set to enable Pollinations as primary
POLLINATIONS_BASE_URL=https://gen.pollinations.ai/v1/chat/completions  # Optional
POLLINATIONS_MODEL=openai                  # Optional, default: openai
```

**Implementation Details**:

- Uses LangChain's `ChatOpenAI` with baseURL override
- OpenAI-compatible API format
- **Free tier does not require API key**
- Supports multiple model backends via API

**API Endpoint**:

- **Base URL**: `https://gen.pollinations.ai/v1/chat/completions`

**Default Models**:
| Purpose | Model Slug | Display Name |
|---------|------------|--------------|
| Chat | `openai` | OpenAI |
| Classification | `openai` | OpenAI |

**Supported Models**:

- `openai` (default)
- `claude-3-5-sonnet`
- `gemini-2.5-flash`
- `llama-3.3-70b`

**Request Format (OpenAI-Compatible)**:

```json
{
    "model": "openai",
    "messages": [{ "role": "user", "content": "Hello, world!" }],
    "temperature": 0.7,
    "stream": false,
    "modalities": ["text"]
}
```

**Response Format (OpenAI-Compatible)**:

```json
{
    "id": "chatcmpl-123",
    "object": "chat.completion",
    "created": 1699012345,
    "model": "openai",
    "choices": [
        {
            "index": 0,
            "message": {
                "role": "assistant",
                "content": "Hello! How can I help you today?"
            },
            "finish_reason": "stop"
        }
    ],
    "usage": {
        "prompt_tokens": 10,
        "completion_tokens": 9,
        "total_tokens": 19
    }
}
```

**Example Implementation**:

```typescript
import { ChatOpenAI } from '@langchain/openai'

const llm = new ChatOpenAI({
    model: 'openai',
    apiKey: 'not-needed', // Pollinations doesn't require API key
    configuration: {
        baseURL: 'https://gen.pollinations.ai/v1/chat/completions',
    },
    temperature: 0,
})

const response = await llm.invoke([{ role: 'user', content: 'Hello, world!' }])
```

**Notes**:

- Free tier has no API key requirement
- May have rate limits or queue times
- Check [Pollinations AI](https://pollinations.ai) for latest models and limits

**Error Handling**:

- Standard OpenAI-compatible error responses
- May experience delays during high demand periods

---

### Local LLM

**Type**: OpenAI-Compatible (Self-Hosted)

**Environment Variables**:

```bash
LOCAL_LLM_BASE_URL=http://localhost:11434   # Required
LLM_PROVIDER=local                          # Set to enable Local LLM as primary
LOCAL_LLM_CHAT_MODEL=llama-3.1-8b-instruct     # Optional, default: LOCAL_LLM_MODEL
LOCAL_LLM_CLASSIFICATION_MODEL=llama-3.1-8b-instruct  # Optional
LOCAL_LLM_MODEL=llama-3.1-8b-instruct     # Optional, default: llama-3.1-8b-instruct
LOCAL_LLM_API_KEY=not-needed               # Optional, default: not-needed
```

**Implementation Details**:

- Uses LangChain's `ChatOpenAI` with baseURL override
- OpenAI-compatible API format
- Works with any OpenAI-compatible local server

**Supported Local LLM Servers**:

- Ollama
- LM Studio
- vLLM
- LocalAI
- Text Generation WebUI

**Default Models**:
| Purpose | Model Slug | Display Name |
|---------|------------|--------------|
| Chat | `LOCAL_LLM_CHAT_MODEL` | Configured Model |
| Classification | `LOCAL_LLM_CLASSIFICATION_MODEL` | Configured Model |

**API Endpoint Format**:

- **Base URL**: `{LOCAL_LLM_BASE_URL}/v1`
- **Example (Ollama)**: `http://localhost:11434/v1`
- **Example (vLLM)**: `http://localhost:8000/v1`

**Request Format (OpenAI-Compatible)**:

```json
{
    "model": "llama-3.1-8b-instruct",
    "messages": [{ "role": "user", "content": "Hello, world!" }],
    "temperature": 0.7,
    "stream": false
}
```

**Response Format (OpenAI-Compatible)**:

```json
{
    "id": "chatcmpl-123",
    "object": "chat.completion",
    "created": 1699012345,
    "model": "llama-3.1-8b-instruct",
    "choices": [
        {
            "index": 0,
            "message": {
                "role": "assistant",
                "content": "Hello! How can I help you today?"
            },
            "finish_reason": "stop"
        }
    ],
    "usage": {
        "prompt_tokens": 10,
        "completion_tokens": 9,
        "total_tokens": 19
    }
}
```

**Example Implementation**:

```typescript
import { ChatOpenAI } from '@langchain/openai'

const llm = new ChatOpenAI({
    model: process.env.LOCAL_LLM_CHAT_MODEL || 'llama-3.1-8b-instruct',
    apiKey: process.env.LOCAL_LLM_API_KEY || 'not-needed',
    configuration: {
        baseURL: process.env.LOCAL_LLM_BASE_URL || 'http://localhost:11434',
    },
    temperature: 0,
})

const response = await llm.invoke([{ role: 'user', content: 'Hello, world!' }])
```

**Ollama-Specific Notes**:

- Remove `/v1` suffix for Ollama native API (not OpenAI-compatible mode)
- OpenAI-compatible mode typically runs on port 11434 with `/v1` prefix
- Ensure Ollama is running with the required model: `ollama run llama-3.1-8b-instruct`

**vLLM-Specific Notes**:

- Default port: 8000
- OpenAI-compatible API server: `python -m vllm.entrypoints.openai.api_server --model {MODEL_NAME}`

**Error Handling**:

- Throws `Error` if `LOCAL_LLM_BASE_URL` is not configured
- Connection errors if local server is not running

---

## Secondary/Fallback Providers (Embedding Service)

These providers are implemented in the Python embedding-service (`embedding-service/main.py`) to provide fallback options when primary providers fail.

### SiliconFlow

**Type**: OpenAI-Compatible

**Environment Variables**:

```bash
SILICONFLOW_API_KEY=...                    # Required
SILICONFLOW_MODEL=nex-agi/DeepSeek-V3.1-Nex-N1  # Optional, default
```

**Implementation Details**:

- OpenAI-compatible API format
- Used as Fallback 1 in embedding-service
- HTTPX client for async requests
- Streaming support

**API Endpoint**:

- **URL**: `https://api.siliconflow.com/v1/chat/completions`

**Default Models**:

- `nex-agi/DeepSeek-V3.1-Nex-N1` (default)

**Request Format**:

```json
{
    "model": "nex-agi/DeepSeek-V3.1-Nex-N1",
    "messages": [{ "role": "user", "content": "Hello, world!" }],
    "temperature": 0.7,
    "max_tokens": 4096,
    "stream": false,
    "enable_thinking": false,
    "thinking_budget": 4096,
    "min_p": 0.05,
    "top_p": 0.7,
    "top_k": 50,
    "frequency_penalty": 0.5,
    "n": 1
}
```

**Special Parameters**:

- `enable_thinking`: Enable chain-of-thought (default: false)
- `thinking_budget`: Maximum tokens for thinking (default: 4096)
- `min_p`: Nucleus sampling parameter (default: 0.05)
- JSON mode: Automatically enabled if "json" appears in any message content

**Response Format (OpenAI-Compatible)**:

```json
{
    "id": "chatcmpl-123",
    "object": "chat.completion",
    "created": 1699012345,
    "model": "nex-agi/DeepSeek-V3.1-Nex-N1",
    "choices": [
        {
            "index": 0,
            "message": {
                "role": "assistant",
                "content": "Hello! How can I help you today?"
            },
            "finish_reason": "stop"
        }
    ],
    "usage": {
        "prompt_tokens": 10,
        "completion_tokens": 9,
        "total_tokens": 19
    }
}
```

**Streaming Format (SSE)**:

```
data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1699012345,"model":"nex-agi/DeepSeek-V3.1-Nex-N1","choices":[{"index":0,"delta":{"content":"Hello!"},"finish_reason":null}]}

data: [DONE]
```

**Example Implementation (Python)**:

```python
import httpx

async def call_siliconflow(messages, temperature=0.7, max_tokens=4096, stream=False):
    url = "https://api.siliconflow.com/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {SILICONFLOW_API_KEY}",
        "Content-Type": "application/json"
    }

    payload = {
        "model": "nex-agi/DeepSeek-V3.1-Nex-N1",
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": stream,
        "enable_thinking": False,
        "thinking_budget": 4096,
        "min_p": 0.05,
        "top_p": 0.7,
        "top_k": 50,
        "frequency_penalty": 0.5,
        "n": 1
    }a

    if stream:
        async with httpx.AsyncClient(timeout=60.0) as client:
            return await client.post(url, json=payload, headers=headers)
    else:
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(url, json=payload, headers=headers)
            response.raise_for_status()
            return response.json()
```

**Fallback Chain Position**:

- **Fallback 1** (after Pollinations primary)

---

### OpenRouter

**Type**: OpenAI-Compatible

**Environment Variables**:

```bash
OPENROUTER_API_KEY=...                     # Required
OPENROUTER_MODEL=xiaomi/mimo-v2-flash:free # Optional, default
```

**Implementation Details**:

- OpenAI-compatible API format
- Used as Fallback 5 in embedding-service
- Daily usage limit: 800 calls
- HTTPX client for async requests
- Streaming support
- Requires custom headers for identification

**API Endpoint**:

- **URL**: `https://openrouter.ai/api/v1/chat/completions`

**Required Headers**:

```http
Authorization: Bearer {OPENROUTER_API_KEY}
Content-Type: application/json
HTTP-Referer: https://skald.sparrow.local
X-Title: Skald AI
```

**Default Models**:

- `xiaomi/mimo-v2-flash:free` (default)

**Request Format**:

```json
{
    "model": "xiaomi/mimo-v2-flash:free",
    "messages": [{ "role": "user", "content": "Hello, world!" }],
    "temperature": 0.7,
    "max_tokens": 4096,
    "stream": false
}
```

**Response Format (OpenAI-Compatible)**:

```json
{
    "id": "chatcmpl-123",
    "object": "chat.completion",
    "created": 1699012345,
    "model": "xiaomi/mimo-v2-flash:free",
    "choices": [
        {
            "index": 0,
            "message": {
                "role": "assistant",
                "content": "Hello! How can I help you today?"
            },
            "finish_reason": "stop"
        }
    ],
    "usage": {
        "prompt_tokens": 10,
        "completion_tokens": 9,
        "total_tokens": 19
    }
}
```

**Streaming Format (SSE)**:

```
data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1699012345,"model":"xiaomi/mimo-v2-flash:free","choices":[{"index":0,"delta":{"content":"Hello!"},"finish_reason":null}]}

data: [DONE]
```

**Example Implementation (Python)**:

```python
import httpx

async def call_openrouter(messages, temperature=0.7, max_tokens=4096, stream=False):
    url = "https://openrouter.ai/api/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {OPENROUTER_API_KEY}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://skald.sparrow.local",
        "X-Title": "Skald AI"
    }

    payload = {
        "model": "xiaomi/mimo-v2-flash:free",
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": stream
    }

    if stream:
        async with httpx.AsyncClient(timeout=60.0) as client:
            return await client.post(url, json=payload, headers=headers)
    else:
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(url, json=payload, headers=headers)
            response.raise_for_status()
            return response.json()
```

**Rate Limiting**:

- Daily limit: 800 requests
- Tracked by `DailyUsageTracker` in embedding-service
- Automatic tracking and limiting

**Fallback Chain Position**:

- **Fallback 5** (after Mistral)

---

### Mistral

**Type**: OpenAI-Compatible

**Environment Variables**:

```bash
MISTRAL_API_KEY=...                       # Required
MISTRAL_MODEL=mistral-medium-latest        # Optional, default
```

**Implementation Details**:

- OpenAI-compatible API format
- Used as Fallback 4 in embedding-service
- HTTPX client for async requests
- Streaming support

**API Endpoint**:

- **URL**: `https://api.mistral.ai/v1/chat/completions`

**Default Models**:

- `mistral-medium-latest` (default)

**Request Format**:

```json
{
    "model": "mistral-medium-latest",
    "messages": [{ "role": "user", "content": "Hello, world!" }],
    "temperature": 0.7,
    "max_tokens": 4096,
    "stream": false
}
```

**Response Format (OpenAI-Compatible)**:

```json
{
    "id": "chatcmpl-123",
    "object": "chat.completion",
    "created": 1699012345,
    "model": "mistral-medium-latest",
    "choices": [
        {
            "index": 0,
            "message": {
                "role": "assistant",
                "content": "Hello! How can I help you today?"
            },
            "finish_reason": "stop"
        }
    ],
    "usage": {
        "prompt_tokens": 10,
        "completion_tokens": 9,
        "total_tokens": 19
    }
}
```

**Streaming Format (SSE)**:

```
data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1699012345,"model":"mistral-medium-latest","choices":[{"index":0,"delta":{"content":"Hello!"},"finish_reason":null}]}

data: [DONE]
```

**Example Implementation (Python)**:

```python
import httpx

async def call_mistral(messages, temperature=0.7, max_tokens=4096, stream=False):
    url = "https://api.mistral.ai/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {MISTRAL_API_KEY}",
        "Content-Type": "application/json"
    }

    payload = {
        "model": "mistral-medium-latest",
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": stream
    }

    if stream:
        async with httpx.AsyncClient(timeout=60.0) as client:
            return await client.post(url, json=payload, headers=headers)
    else:
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(url, json=payload, headers=headers)
            response.raise_for_status()
            return response.json()
```

**Fallback Chain Position**:

- **Fallback 4** (after GitHub Models, before OpenRouter)

---

## Fallback Chain (Embedding Service)

The embedding-service implements a robust fallback chain for `/v1/chat/completions` endpoint:

1. **Primary**: Pollinations.ai (openai-fast)
2. **Fallback 1**: SiliconFlow (DeepSeek-V3)
3. **Fallback 2**: GitHub Models (DeepSeek-R1 Round-Robin)
4. **Fallback 3**: Mistral (Mistral Medium)
5. **Fallback 4**: OpenRouter (Xiaomi Mimo-V2-Flash)
6. **Fallback 5**: Groq (llama-3.3-70b/70b-versatile etc)
7. **Fallback 6**: Local LLM (ollama)

This ensures that if one provider is down or rate-limited, the system automatically switches to the next available provider.

---

## Common Patterns

### OpenAI-Compatible API Format

Most providers (Groq, Z.ai, Pollinations, SiliconFlow, OpenRouter, Mistral) follow the OpenAI API format:

**Request**:

```json
{
    "model": "model-slug",
    "messages": [
        { "role": "system", "content": "You are a helpful assistant." },
        { "role": "user", "content": "Hello, world!" }
    ],
    "temperature": 0.7,
    "max_tokens": 4096,
    "stream": false
}
```

**Response (non-streaming)**:

```json
{
    "id": "chatcmpl-123",
    "object": "chat.completion",
    "created": 1699012345,
    "model": "model-slug",
    "choices": [
        {
            "index": 0,
            "message": {
                "role": "assistant",
                "content": "Response content..."
            },
            "finish_reason": "stop"
        }
    ],
    "usage": {
        "prompt_tokens": 20,
        "completion_tokens": 15,
        "total_tokens": 35
    }
}
```

**Streaming (SSE)**:

```
data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1699012345,"model":"model-slug","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}

data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1699012345,"model":"model-slug","choices":[{"index":0,"delta":{"content":"!"},"finish_reason":null}]}

data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1699012345,"model":"model-slug","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

### Streaming Response Handling (Python)

```python
import httpx
import json

async def stream_response(response):
    async for line in response.aiter_lines():
        if not line.strip():
            continue
        if line.startswith("data: "):
            data_str = line[6:].strip()
            if data_str == "[DONE]":
                break
            try:
                chunk = json.loads(data_str)
                content = chunk.get("choices", [{}])[0].get("delta", {}).get("content", "")
                if content:
                    print(content, end="", flush=True)
            except json.JSONDecodeError:
                continue
    await response.aclose()
```

### LangChain Integration

All providers (except native OpenAI/Anthropic/Gemini) can be integrated using LangChain's `ChatOpenAI`:

```typescript
import { ChatOpenAI } from '@langchain/openai'

const llm = new ChatOpenAI({
    model: 'model-slug',
    apiKey: process.env.PROVIDER_API_KEY,
    configuration: {
        baseURL: 'https://api.provider.com/v1',
    },
    temperature: 0,
})

const response = await llm.invoke([{ role: 'user', content: 'Hello, world!' }])
```

---

## Testing Your Implementation

### Environment Setup

Create a `.env` file with your provider's configuration:

```bash
# Example: Using OpenAI
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-your-api-key-here

# Example: Using Groq with proxy
LLM_PROVIDER=groq
GROQ_API_KEY=gsk-your-api-key-here
LOCAL_LLM_BASE_URL=http://localhost:11434

# Example: Using Local LLM
LLM_PROVIDER=local
LOCAL_LLM_BASE_URL=http://localhost:11434
LOCAL_LLM_CHAT_MODEL=llama-3.1-8b-instruct
```

### Test Endpoint

Use the embedding-service's OpenAI-compatible endpoint:

```bash
curl -X POST http://localhost:8001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "llama-3.1-8b-instant",
    "messages": [
      {"role": "user", "content": "Hello, world!"}
    ],
    "temperature": 0.7,
    "stream": false
  }'
```

### Health Check

```bash
curl http://localhost:8001/health
```

Response:

```json
{
    "status": "healthy",
    "embedding_provider": "ollama",
    "rerank_provider": "local",
    "rerank_model": "xitao/bge-reranker-v2-m3:latest",
    "embedding_model": "BAAI/bge-m3",
    "query_language": "ko"
}
```

---

## Additional Resources

- **Embedding Service Code**: `embedding-service/main.py`
- **LLM Service Code**: `backend/src/services/llmService.ts`
- **Settings**: `backend/src/settings.ts`
- **Model Definitions**: `backend/src/llmModels.ts`
- **Providers Documentation**: `k8s/llm-providers.md`

---

## Contributing New Providers

When adding a new LLM provider to Skald:

1. **Backend Integration** (`backend/src/services/llmService.ts`):
    - Add provider to `SUPPORTED_LLM_PROVIDERS` in `settings.ts`
    - Implement provider logic in `LLMService.getLLM()`
    - Add default models in `llmModels.ts`
    - Add environment variables to `settings.ts`

2. **Embedding Service Integration** (`embedding-service/main.py`):
    - Add environment variable configuration
    - Implement `call_{provider}()` async function
    - Implement `stream_{provider}_response()` generator
    - Add to fallback chain in `chat_completions()` endpoint

3. **Documentation**:
    - Update `k8s/llm-providers.md` with new provider
    - Update this document with API specification
    - Add model information with rates (if applicable)

4. **Testing**:
    - Test with both streaming and non-streaming requests
    - Verify error handling (rate limits, invalid keys)
    - Test fallback chain behavior

---

**Document Version**: 1.0.0
**Last Updated**: 2025-01-07
**Skald Version**: Main Branch (commit: 830cd51)
