# SiliconFlow API Usage Guide

SiliconFlow provides a high-performance LLM inference service with an OpenAI-compatible API.

## API Endpoint
*   **Base URL**: `https://api.siliconflow.com/v1`
*   **Authentication**: Bearer Token (obtained from [SiliconFlow Account](https://cloud.siliconflow.com/account/ak))

## Basic Usage (Python)

SiliconFlow's API is fully compatible with the OpenAI SDK.

### Configuration
```python
from openai import OpenAI

client = OpenAI(
    api_key="YOUR_SILICONFLOW_API_KEY",
    base_url="https://api.siliconflow.com/v1"
)
```

### 1. Text Generation (Chat Completion)
```python
response = client.chat.completions.create(
    model="deepseek-ai/DeepSeek-V3",
    messages=[
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": "Explain quantum entanglement in simple terms."}
    ],
    temperature=0.7,
    max_tokens=1024,
    stream=True
)

for chunk in response:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="", flush=True)
```

### 2. Vision (Image Analysis)
Using multimodal models like `deepseek-ai/deepseek-vl2`.
```python
response = client.chat.completions.create(
    model="deepseek-ai/deepseek-vl2",
    messages=[
        {
            "role": "user",
            "content": [
                {
                    "type": "image_url",
                    "image_url": {"url": "https://example.com/image.png"}
                },
                {
                    "type": "text", 
                    "text": "Identify the objects in this image."
                }
            ]
        }
    ],
    max_tokens=512
)
print(response.choices[0].message.content)
```

### 3. JSON Mode
```python
response = client.chat.completions.create(
    model="deepseek-ai/DeepSeek-V2.5",
    messages=[
        {"role": "system", "content": "You are a helpful assistant designed to output JSON."},
        {"role": "user", "content": "List the three largest cities in the world by population in 2024 as a JSON list."}
    ],
    response_format={"type": "json_object"}
)
print(response.choices[0].message.content)
```

## Model Selection
SiliconFlow supports a wide range of open-source models including:
*   **DeepSeek series**: `DeepSeek-V3`, `DeepSeek-R1`, `DeepSeek-V2.5`, etc.
*   **Llama series**: `Llama-3-70B`, `Llama-3.1-405B`, etc.
*   **Qwen series**: `Qwen2.5-72B`, etc.

Check the [SiliconFlow Models List](https://cloud.siliconflow.com/models) for the latest available models.

## Core Parameters
*   `temperature`: Creativity control (0.0 to 2.0).
*   `top_p`: Nucleus sampling.
*   `max_tokens`: Maximum output length.
*   `response_format`: Use `{"type": "json_object"}` for structured output.
*   `stop`: Custom stop sequences.
