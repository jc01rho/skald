# LLM Retry and Fallback Implementation

## Overview

Implemented comprehensive retry logic with multi-level fallback for LLM API calls. The system now gracefully handles failures by:

1. **Retrying failed requests** (3 attempts with exponential backoff)
2. **Trying alternative models** within the same provider
3. **Falling back to alternative providers** when all models fail

## Implementation Details

### 1. Retry Wrapper (`withRetry`)

- **Max Retries**: 3 attempts (configurable)
- **Backoff Strategy**: Exponential delay (1s, 2s, 3s)
- **Logging**: Warns on each failure before retry
- **Error Propagation**: Throws last error after all retries exhausted

### 2. Model-Level Fallback Chain

For `cli-proxy-api` provider, models are tried in this priority order:

```
1. deepseek-v3.2-reasoner
2. qwen3-235b
3. gemini-2.5-pro
4. gemini-2.5-flash
5. gemini-2.5-flash-lite
6. gemini-3-flash-preview
7. gemini-2.5-computer-use-preview-10-2025
8. kimi-k2-0905
9. kimi-k2
10. qwen3-max-preview
11. qwen3-coder-plus
12. qwen3-235b-a22b-thinking-2507
13. qwen3-235b-a22b-instruct
14. qwen3-max
15. qwen3-32b
16. deepseek-v3.1
17. deepseek-v3
18. deepseek-r1
19. deepseek-v3.2
20. deepseek-v3.2-chat
21. tstars2.0
22. glm-4.7
23. code
24. opus
25. free
26. free-code
27. sonnet
```

### 3. Provider-Level Fallback Chain

When all models fail, providers are tried in this order:

```
1. cli-proxy-api (current)
2. openai
3. anthropic
4. gemini
5. groq
6. pollinations
7. zai
8. local
```

## API Usage

### Using `LLMService.getLLM()` (Original Method)

Returns a single LLM instance. No retry or fallback logic applied.

```typescript
const llm = LLMService.getLLM({ temperature: 0.7 })
const result = await llm.invoke(messages) // You handle errors manually
```

### Using `LLMService.invokeWithRetry()` (New Method)

Automatically handles retries and fallbacks. Recommended for production use.

```typescript
const result = await LLMService.invokeWithRetry({
    messages: [{ role: 'user', content: 'Say hello' }],
    temperature: 0.7,
    maxRetries: 3, // Optional: override default
    retryDelayMs: 1000, // Optional: override default
    useFallbackChain: true, // Optional: enable/disable fallbacks
})
```

### Parameters

- **messages**: Array of chat messages (required)
- **temperature**: LLM temperature (default: 0)
- **maxRetries**: Number of retry attempts (default: 3)
- **retryDelayMs**: Delay between retries in ms (default: 1000)
- **useFallbackChain**: Enable fallback to next model/provider (default: true)

## Fallback Logic Flow

```
1. Try current model (retries up to 3 times)
   └─> Success? → Return result
   └─> All retries fail?
       └─> Try next model in fallback chain (retries up to 3 times)
           └─> Success? → Return result
           └─> All models fail?
               └─> Try next provider in fallback chain (retries up to 3 times)
                   └─> Success? → Return result
                   └─> All providers fail? → Throw error
```

## Logging Examples

```
Attempting to invoke LLM with provider: cli-proxy-api
Attempt 1/3 failed: Connection timeout
Retrying in 1000ms...
Attempt 2/3 failed: Connection timeout
Retrying in 2000ms...
Attempt 3/3 failed: Connection timeout

Current model failed after retries, trying model-level fallback chain...
Trying fallback model: qwen3-235b
Successfully invoked with fallback model: qwen3-235b
```

## Error Handling

All errors are logged before:

- Retrying (with attempt number)
- Trying fallback model
- Trying fallback provider
- Final failure (after all options exhausted)

## Files Modified

1. **backend/src/llmModels.ts**
    - Added 3 new models: `free`, `free-code`, `sonnet`
    - Added `MODEL_FALLBACK_CHAINS` export (model priority order per provider)
    - Added `PROVIDER_FALLBACK_CHAIN` export (provider priority order)

2. **backend/src/services/llmService.ts**
    - Added `withRetry()` helper function
    - Added `modelOverride` parameter to `GetLLMParams`
    - Added `invokeWithRetry()` method to `LLMService` class
    - Integrated retry logic with exponential backoff
    - Implemented model-level fallback (for cli-proxy-api)
    - Implemented provider-level fallback (all providers)

## Testing

To test the retry and fallback logic:

```bash
# Test with invalid model (will trigger fallbacks)
curl -X POST "http://localhost:3000/api/chat" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{"role": "user", "content": "Say hello"}],
    "provider": "cli-proxy-api"
  }'
```

Expected behavior:

1. Attempts 3 retries with current model
2. Falls through 27 models in cli-proxy-api
3. Falls through 8 providers in provider chain
4. Throws error if all options exhausted

## Backward Compatibility

The original `LLMService.getLLM()` method remains unchanged.
Existing code continues to work without modifications.
Use `invokeWithRetry()` only when you want automatic fallback behavior.
