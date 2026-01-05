# LLM Provider Fallback Chain Documentation

## Overview

The embedding service implements a multi-layer fallback system to ensure high availability of LLM responses. Each provider is tried sequentially, and if a provider fails or is exhausted, the system automatically falls back to the next provider in the chain.

## Fallback Chain (Priority Order)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        CHAT REQUEST START                          │
└─────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
                    ┌────────────────────────┐
                    │  Check for explicit  │
                    │  provider request?   │
                    └─────────┬──────────┘
                              │ Yes        │ No
                              ▼           ▼
                    ┌─────────────┐   ┌─────────────────┐
                    │  Try Z.ai   │   │ Start fallback  │
                    │  (if requested)   │     chain          │
                    └──────┬──────┘   └────┬────────────┘
                           │                 │
                           │                 ▼
                           │         ┌─────────────────────┐
                           │         │  1. Pollinations.ai │ ◄──── PRIMARY
                           │         │  Model: "openai"    │
                           │         │  Error: 24h cooldown│
                           │         └─────────┬───────────┘
                           │                   │ Fail/Cooldown
                           │                   ▼
                           │         ┌─────────────────────┐
                           │         │ 2. SiliconFlow     │ ◄──── FALLBACK 1
                           │         │ Model: DeepSeek-V3   │
                           │         └─────────┬───────────┘
                           │                   │ Fail
                           │                   ▼
                           │         ┌─────────────────────┐
                           │         │ 3. MovementLabs    │ ◄──── FALLBACK 2
                           │         │ Model: hawk-max      │
                           │         └─────────┬───────────┘
                           │                   │ Fail
                           │                   ▼
                           │         ┌─────────────────────┐
                           │         │4. GitHub Models    │ ◄──── FALLBACK 3
                           │         │ Round-robin list:   │
                           │         │ • DeepSeek-R1       │
                           │         │ • grok-3-mini       │
                           │         │ • grok-3           │
                           │         │ • DeepSeek-V3-0324  │
                           │         │ • gpt-4o-mini       │
                           │         │ • o4-mini           │
                           │         └─────────┬───────────┘
                           │                   │ All models fail
                           │                   ▼
                           │         ┌─────────────────────┐
                           │         │ 5. Mistral         │ ◄──── FALLBACK 4
                           │         │ Model: mistral-medium │
                           │         └─────────┬───────────┘
                           │                   │ Fail
                           │                   ▼
                           │         ┌─────────────────────┐
                           │         │6. OpenRouter       │ ◄──── FALLBACK 5
                           │         │ Model: mimo-v2-flash │
                           │         │ Limit: 800/day      │
                           │         └─────────┬───────────┘
                           │                   │ Fail/Over limit
                           │                   ▼
                           │         ┌─────────────────────┐
                           │         │ 7. Groq            │ ◄──── FALLBACK 6
                           │         │ Multi-model chain:  │
                           │         │ + RPM throttling     │
                           │         │ + Key rotation      │
                           │         └─────────┬───────────┘
                           │                   │ All fail
                           │                   ▼
                           │         ┌─────────────────────┐
                           │         │8. Local LLM        │ ◄──── FINAL FALLBACK
                           │         │ Ollama endpoints    │
                           │         └─────────┬───────────┘
                           │                   │ Fail
                           ▼                   ▼
                    ┌──────────────────────────────────────┐
                    │  503 Service Unavailable          │
                    │  All providers failed              │
                    └──────────────────────────────────────┘
```

## Detailed Provider Behaviors

### 1. Pollinations.ai (Primary)

**Model:** `openai` (configurable via `POLLINATIONS_MODEL`)
**Endpoint:** `https://gen.pollinations.ai/v1/chat/completions`
**Cooldown:** 24 hours on error

**Flow:**

- Checks if in 24-hour cooldown (activates on any error)
- If not in cooldown and API key present → try request
- On error (any exception or non-200 status):
    - Activate 24-hour cooldown
    - Move to SiliconFlow

**Example Scenario:**

```
Request → Pollinations (openai model)
  ├─ Success → Return response
  └─ Error (e.g., 500 Internal Server Error)
      ├─ Activate 24h cooldown
      └─ Try SiliconFlow → [continues down chain]
```

---

### 2. SiliconFlow (Fallback 1)

**Model:** `nex-agi/DeepSeek-V3.1-Nex-N1` (configurable)
**Endpoint:** `https://api.siliconflow.com/v1/chat/completions`

**Flow:**

- If API key present → try request
- On error → log and continue to MovementLabs (no retry)

**Example Scenario:**

```
Pollinations failed → SiliconFlow
  ├─ Success → Return response
  └─ Error (e.g., timeout)
      └─ Try MovementLabs → [continues down chain]
```

---

### 3. MovementLabs (Fallback 2)

**Model:** `hawk-max` (configurable)
**Endpoint:** `https://api.movementlabs.ai/v1/chat/completions`

**Flow:**

- If API key present → try request
- On error → log and continue to GitHub Models (no retry)

**Example Scenario:**

```
SiliconFlow failed → MovementLabs
  ├─ Success → Return response
  └─ Error (e.g., 401 Unauthorized)
      └─ Try GitHub Models → [continues down chain]
```

---

### 4. GitHub Models (Fallback 3)

**Models (Round-robin):**

```
deepseek/DeepSeek-R1
xai/grok-3-mini
xai/grok-3
deepseek/DeepSeek-V3-0324
openai/gpt-4o-mini
openai/o4-mini
```

**Endpoint:** `https://models.github.ai/inference/chat/completions`

**Flow:**

- Round-robin manager tracks current model
- Tries all models in the list starting from current position
- For each model:
    - If success → return response and don't rotate
    - If 429/403/quota error → rotate to next model and continue
    - If other error → try next model in list
- If all models exhausted → move to Mistral

**Example Scenario:**

```
MovementLabs failed → GitHub Models
  ├─ Try deepseek/DeepSeek-R1
  │   ├─ 429 Rate Limit → Rotate to xai/grok-3-mini
  │   ├─ Success → Return response (don't rotate)
  │   └─ Error → Try xai/grok-3
  └─ All 6 models tried and failed
      └─ Try Mistral → [continues down chain]
```

**Round-Robin State Management:**

```python
github_model_manager = RoundRobinManager(GITHUB_MODELS)

# Before each request:
current_model = github_model_manager.get_current()  # e.g., "deepseek/DeepSeek-R1"

# On rate limit/quota:
github_model_manager.rotate()  # Moves to next: "xai/grok-3-mini"

# On success:
# Don't rotate, same model will be tried next time
```

---

### 5. Mistral (Fallback 4)

**Model:** `mistral-medium-latest` (configurable)
**Endpoint:** `https://api.mistral.ai/v1/chat/completions`

**Flow:**

- If API key present → try request
- On error → log and continue to OpenRouter (no retry)

**Example Scenario:**

```
GitHub Models all failed → Mistral
  ├─ Success → Return response
  └─ Error (e.g., 402 Payment Required)
      └─ Try OpenRouter → [continues down chain]
```

---

### 6. OpenRouter (Fallback 5)

**Model:** `xiaomi/mimo-v2-flash:free` (configurable)
**Endpoint:** `https://openrouter.ai/api/v1/chat/completions`
**Daily Limit:** 800 requests per day

**Flow:**

- Check usage tracker (resets daily)
- If limit reached → skip to Groq
- If under limit → try request
    - On success → increment usage counter
    - On error → log and continue to Groq

**Example Scenario:**

```
Mistral failed → OpenRouter
  ├─ Check daily usage: 780/800
  ├─ Under limit → Try request
  │   ├─ Success → Usage: 781/800, Return response
  │   └─ Error → Try Groq
  └─ Check daily usage: 800/800
      └─ Limit reached → Try Groq
```

---

### 7. Groq (Fallback 6) - COMPLEX CHAIN

**Base Endpoint:** `https://api.groq.com/openai/v1/chat/completions`
**Features:**

- Multi-model fallback chains
- Multiple API keys with round-robin
- RPM-based throttling (90% of limit)

#### Model Fallback Chains

**High Intelligence Chain (requested: `llama-3.3-70b-versatile`)**

```
1. llama-3.3-70b-versatile        (30 RPM, 1000 RPD)
2. qwen/qwen3-32b                 (60 RPM, 1000 RPD)
3. moonshotai/kimi-k2-instruct     (60 RPM, 1000 RPD)
4. openai/gpt-oss-120b            (30 RPM, 1000 RPD)
5. groq/compound                  (30 RPM, 250 RPD)
6. llama-3.1-8b-instant          (30 RPM, 14400 RPD)
7. moonshotai/kimi-k2-instruct-0905 (60 RPM, 1000 RPD)
8. meta-llama/llama-4-scout-17b-16e-instruct
9. meta-llama/llama-4-maverick-17b-128e-instruct
10. openai/gpt-oss-20b
11. openai/gpt-oss-safeguard-20b
12. allam-2-7b
13. groq/compound-mini
```

**Fast/Classification Chain (requested: `llama-3.1-8b-instant`)**

```
1. openai/gpt-oss-120b
2. groq/compound
3. llama-3.1-8b-instant
4. moonshotai/kimi-k2-instruct-0905
5. meta-llama/llama-4-scout-17b-16e-instruct
6. meta-llama/llama-4-maverick-17b-128e-instruct
7. openai/gpt-oss-20b
8. openai/gpt-oss-safeguard-20b
9. allam-2-7b
10. groq/compound-mini
11. meta-llama/llama-guard-4-12b
12. meta-llama/llama-prompt-guard-2-22m
```

#### Groq Detailed Flow

```
┌─────────────────────────────────────────────────────────────┐
│           Groq Fallback Chain (Fallback 6)             │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
              ┌───────────────────────┐
              │ Check API keys exist  │
              └──────────┬────────────┘
                         │ No
                         ▼           Yes
              ┌─────────────┐    ┌─────────────────┐
              │ Skip to     │    │ For each model │
              │ Local LLM   │    │ in chain:     │
              └─────────────┘    └────────┬────────┘
                                     │
                                     ▼
                          ┌──────────────────────┐
                          │ RPM Throttle Check   │
                          │ 90% of limit       │
                          └────────┬────────────┘
                                   │
                          ┌────────┴────────┐
                          │                 │
                     Wait (if           No wait
                     over limit)         │
                          │                 │
                          └────────┬────────┘
                                   │
                                   ▼
                          ┌──────────────────────┐
                          │ Get current key      │
                          │ (round-robin)       │
                          └────────┬────────────┘
                                   │
                                   ▼
                          ┌──────────────────────┐
                          │ Try model with key   │
                          └────────┬────────────┘
                                   │
              ┌──────────────────────┼──────────────────────┐
              │                      │                      │
         Success                413 Payload          429 Rate Limit/
                              Too Large            Quota/Other Error
              │                      │                      │
              │                      ▼                      │
              │              ┌─────────────┐                │
              │              │ Skip to     │                │
              │              │ Local LLM   │                │
              │              └─────────────┘                │
              │                                             │
              │                                             ▼
              │                                     ┌─────────────────┐
              │                                     │ Rotate key     │
              └────────────────────────────────────────→ │ & next model   │
                                                    └─────────────────┘
```

**Example Scenario:**

```
OpenRouter failed → Groq
  ├─ Key Manager: 5 keys available, using key #1
  ├─ Requested model: llama-3.3-70b-versatile
  ├─ Try llama-3.3-70b-versatile with key #1
  │   ├─ Success → Return response
  │   └─ 429 Rate Limit
  │       ├─ Rotate to key #2
  │       ├─ Try again with key #2
  │       ├─ Still 429
  │       └─ Rotate to key #3
  │           └─ All 5 keys rate-limited
  │               └─ Try next model: qwen/qwen3-32b
  ├─ Try qwen/qwen3-32b with key #1
  │   ├─ Success → Return response
  │   └─ 413 Payload Too Large
  │       └─ Skip to Local LLM
  └─ All models exhausted
      └─ Try Local LLM
```

**Key Rotation Behavior:**

```python
groq_key_manager = GroqKeyManager(api_keys=[key1, key2, key3, ...])

# Initial state: key_index = 0 (key1)
get_current_key() → (key1, 0)
rotate_key() → key_index = 1 (key2)
rotate_key() → key_index = 2 (key3)
rotate_key() → key_index = 3 (key1, wraps around)
```

**RPM Throttling Example:**

```
Model: llama-3.3-70b-versatile
RPM Limit: 30
Effective Limit: 27 (90%)

10:00:00 - Request 1 (wait: 0s)   # 1/27 in last 60s
10:00:02 - Request 2 (wait: 0s)   # 2/27
10:00:04 - Request 3 (wait: 0s)   # 3/27
...
10:00:52 - Request 27 (wait: 0s)  # 27/27 (at limit)
10:00:54 - Request 28 (wait: 6s)  # Oldest (10:00:00) expired, wait until 10:01:00
10:01:00 - Request 28 (wait: 0s)  # Continue
```

---

### 8. Local LLM (Final Fallback)

**Models:**

```
ollama-kanana: cookieshake/kanana-1.5-8b-instruct-2505:Q4_K_M
```

**Endpoint:** `http://192.168.30.169:11434/api/chat` (Ollama API)

**Flow:**

- Randomly select from available local LLM endpoints
- Try request
- On success → return response
- On error → 503 Service Unavailable

**Example Scenario:**

```
Groq all failed → Local LLM
  ├─ Select: ollama-kanana (http://192.168.30.169:11434)
  ├─ Try Ollama API
  ├─ Success → Return response
  └─ Error (endpoint offline)
      └─ Return 503: All providers failed
```

---

## Complete Flow Example

### Scenario: All providers progressively fail

```
User Request: "Explain quantum computing"

1. Pollinations (openai)
   - 503 Service Unavailable
   - Activate 24h cooldown
   - ↓

2. SiliconFlow (DeepSeek-V3)
   - Timeout after 30s
   - ↓

3. MovementLabs (hawk-max)
   - 401 Unauthorized
   - ↓

4. GitHub Models
   - Try deepseek/DeepSeek-R1 → 429 Rate Limit
   - Rotate → xai/grok-3-mini → 429 Rate Limit
   - Rotate → xai/grok-3 → 429 Rate Limit
   - Rotate → deepseek/DeepSeek-V3-0324 → 429 Rate Limit
   - Rotate → openai/gpt-4o-mini → 429 Rate Limit
   - Rotate → openai/o4-mini → 429 Rate Limit
   - All models quota exhausted
   - ↓

5. Mistral (mistral-medium)
   - 402 Payment Required (credits exhausted)
   - ↓

6. OpenRouter (mimo-v2-flash:free)
   - Check usage: 800/800
   - Daily limit reached
   - ↓

7. Groq (llama-3.3-70b-versatile chain)
   - Try llama-3.3-70b-versatile with key #1 → 429
   - Rotate → key #2 → 429
   - Rotate → key #3 → 429
   - All keys rate-limited
   - Try qwen/qwen3-32b with key #1 → 429
   - Try moonshotai/kimi-k2-instruct → 429
   - Try openai/gpt-oss-120b → 429
   - Try groq/compound → 429
   - All models exhausted
   - ↓

8. Local LLM (ollama-kanana)
   - Try http://192.168.30.169:11434
   - Success!
   - Return response

Result: User gets response from local Ollama instance
```

---

## Configuration

### Environment Variables

```bash
# Pollinations (Primary)
POLLINATIONS_API_KEY=your_key
POLLINATIONS_MODEL=openai

# SiliconFlow (Fallback 1)
SILICONFLOW_API_KEY=your_key
SILICONFLOW_MODEL=nex-agi/DeepSeek-V3.1-Nex-N1

# MovementLabs (Fallback 2)
MOVEMENTLABS_API_KEY=your_key
MOVEMENTLABS_MODEL=hawk-max

# GitHub Models (Fallback 3)
GITHUB_TOKEN=ghp_xxxx
GITHUB_MODELS=deepseek/DeepSeek-R1,xai/grok-3-mini,xai/grok-3,deepseek/DeepSeek-V3-0324,openai/gpt-4o-mini,openai/o4-mini

# Mistral (Fallback 4)
MISTRAL_API_KEY=your_key
MISTRAL_MODEL=mistral-medium-latest

# OpenRouter (Fallback 5)
OPENROUTER_API_KEY=your_key
OPENROUTER_MODEL=xiaomi/mimo-v2-flash:free

# Groq (Fallback 6)
GROQ_API_KEYS=key1,key2,key3,key4,key5

# Local LLM (Fallback 7)
# No env vars needed, configured in code:
# LOCAL_LLM_ENDPOINTS = [
#   {
#     "name": "ollama-kanana",
#     "url": "http://192.168.30.169:11434",
#     "type": "ollama",
#     "model": "cookieshake/kanana-1.5-8b-instruct-2505:Q4_K_M"
#   }
# ]
```

---

## Summary

1. **Sequential Fallback**: Providers tried in fixed order, no skipping
2. **Pollinations Cooldown**: 24-hour cooldown on any error prevents cascade
3. **GitHub Round-Robin**: Rotates through 6 models on quota/rate-limit
4. **OpenRouter Daily Limit**: 800 requests/day resets automatically
5. **Groq Complexity**: Multi-level fallback (model → key → next model)
6. **Final Fallback**: Local LLM is last resort
7. **All Fail**: Returns 503 Service Unavailable

This architecture ensures maximum availability while respecting rate limits and quotas across all providers.
