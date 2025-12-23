# Z.ai API 사용 예제

## 개요

이 문서는 다양한 프로그래밍 언어에서 Z.ai API를 사용하는 방법을 보여주는 예제를 포함합니다. 모든 예제는 적절한 인증이 필요합니다.

## 기본 설정

모든 예제에서 다음 기본 설정을 사용합니다:

- API 엔드포인트: `https://api.z.ai/api/paas/v4/`
- 인증: Bearer 토큰 (API 키 필요)
- 모델: `glm-4.7` (기본값)

## Python 예제

### 기본 챗봇 호출

```python
import requests
import json

# API 설정
API_KEY = "your-Z.AI-api-key"
BASE_URL = "https://api.z.ai/api/paas/v4/"
HEADERS = {
    "Authorization": f"Bearer {API_KEY}",
    "Content-Type": "application/json"
}

# 챗봇 완성 요청
def chat_completion():
    url = f"{BASE_URL}chat/completions"
    data = {
        "model": "glm-4.7",
        "messages": [
            {"role": "system", "content": "You are a helpful AI assistant."},
            {"role": "user", "content": "Hello, please introduce yourself."}
        ],
        "max_tokens": 1000,
        "temperature": 0.7
    }
    
    response = requests.post(url, headers=HEADERS, json=data)
    return response.json()

# 요청 실행
if __name__ == "__main__":
    result = chat_completion()
    print(json.dumps(result, indent=2))
```

### Z.ai SDK 사용

```python
from zai import ZAI

# 클라이언트 초기화
client = ZAI(api_key="your-Z.AI-api-key")

# 챗봇 완성 요청
response = client.chat.completions.create(
    model="glm-4.7",
    messages=[
        {"role": "system", "content": "You are a helpful AI assistant."},
        {"role": "user", "content": "Hello, please introduce yourself."}
    ],
    max_tokens=1000,
    temperature=0.7
)

print(response.choices[0].message.content)
```

## JavaScript 예제

### Node.js (fetch)

```javascript
const API_KEY = "your-Z.AI-api-key";
const BASE_URL = "https://api.z.ai/api/paas/v4/";

async function chatCompletion() {
    const response = await fetch(`${BASE_URL}chat/completions`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: "glm-4.7",
            messages: [
                { role: "system", content: "You are a helpful AI assistant." },
                { role: "user", content: "Hello, please introduce yourself." }
            ],
            max_tokens: 1000,
            temperature: 0.7
        })
    });
    
    const data = await response.json();
    console.log(data);
}

chatCompletion();
```

### Z.ai SDK 사용

```javascript
import { ZAI } from 'zai';

// 클라이언트 초기화
const client = new ZAI({ apiKey: 'your-Z.AI-api-key' });

// 챗봇 완성 요청
async function getChatResponse() {
    try {
        const response = await client.chat.completions.create({
            model: "glm-4.7",
            messages: [
                { role: "system", content: "You are a helpful AI assistant." },
                { role: "user", content: "Hello, please introduce yourself." }
            ],
            max_tokens: 1000,
            temperature: 0.7
        });
        
        console.log(response.choices[0].message.content);
    } catch (error) {
        console.error('Error:', error);
    }
}

getChatResponse();
```

## Java 예제

### 기본 HTTP 클라이언트

```java
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpRequest.BodyPublishers;
import java.time.Duration;
import com.fasterxml.jackson.databind.ObjectMapper;

public class ZAIExample {
    private static final String API_KEY = "your-Z.AI-api-key";
    private static final String BASE_URL = "https://api.z.ai/api/paas/v4/";
    
    public static void main(String[] args) throws Exception {
        HttpClient client = HttpClient.newHttpClient();
        ObjectMapper mapper = new ObjectMapper();
        
        // 요청 본문 구성
        String requestBody = mapper.writeValueAsString(Map.of(
            "model", "glm-4.7",
            "messages", List.of(
                Map.of("role", "system", "content", "You are a helpful AI assistant."),
                Map.of("role", "user", "content", "Hello, please introduce yourself.")
            ),
            "max_tokens", 1000,
            "temperature", 0.7
        ));
        
        // HTTP 요청 생성
        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(BASE_URL + "chat/completions"))
                .header("Authorization", "Bearer " + API_KEY)
                .header("Content-Type", "application/json")
                .POST(BodyPublishers.ofString(requestBody))
                .timeout(Duration.ofSeconds(30))
                .build();
        
        // 요청 전송 및 응답 처리
        HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());
        System.out.println(response.body());
    }
}
```

### Z.ai SDK 사용

```java
import com.zai.client.ZAIClient;
import com.zai.client.okhttp.ZAIOkHttpClient;
import com.zai.models.chat.completions.ChatCompletion;
import com.zai.models.chat.completions.ChatCompletionCreateParams;

public class ZAISDKExample {
    public static void main(String[] args) {
        // 클라이언트 초기화
        ZAIClient client = ZAIOkHttpClient.builder()
                .apiKey("your-Z.AI-api-key")
                .baseUrl("https://api.z.ai/api/paas/v4/")
                .build();
        
        // 챗봇 완성 요청 매개변수 구성
        ChatCompletionCreateParams params = ChatCompletionCreateParams.builder()
                .addSystemMessage("You are a helpful AI assistant.")
                .addUserMessage("Hello, please introduce yourself.")
                .model("glm-4.7")
                .maxTokens(1000)
                .temperature(0.7)
                .build();
        
        // 요청 전송 및 응답 처리
        ChatCompletion chatCompletion = client.chat().completions().create(params);
        Object response = chatCompletion.choices().get(0).message().content();
        
        System.out.println(response);
    }
}
```

## cURL 예제

```bash
curl -X POST "https://api.z.ai/api/paas/v4/chat/completions" \
-H "Authorization: Bearer your-Z.AI-api-key" \
-H "Content-Type: application/json" \
-d '{
    "model": "glm-4.7",
    "messages": [
        {"role": "system", "content": "You are a helpful AI assistant."},
        {"role": "user", "content": "Hello, please introduce yourself."}
    ],
    "max_tokens": 1000,
    "temperature": 0.7
}'
```

## 응답 처리 예제

모든 예제에서 API 응답은 다음과 같은 구조를 가집니다:

```json
{
    "id": "chatcmpl-xxxxxxxx",
    "object": "chat.completion",
    "created": 1677652288,
    "model": "glm-4.7",
    "choices": [
        {
            "index": 0,
            "message": {
                "role": "assistant",
                "content": "Hello! I'm an AI assistant powered by Z.ai. I'm here to help you with any questions or tasks you might have."
            },
            "finish_reason": "stop"
        }
    ],
    "usage": {
        "prompt_tokens": 56,
        "completion_tokens": 17,
        "total_tokens": 73
    }
}
```

## 오류 처리

API 요청이 실패할 경우 다음과 같은 오류 응답을 받을 수 있습니다:

```python
# Python 오류 처리 예제
response = requests.post(url, headers=HEADERS, json=data)

if response.status_code != 200:
    error_data = response.json()
    print(f"Error: {error_data.get('error', {}).get('message', 'Unknown error')}")
    print(f"Status code: {response.status_code}")
else:
    result = response.json()
    print(result.choices[0].message.content)
```

## 관련 문서

- [API 엔드포인트](./api-endpoint.md) - 기본 API 엔드포인트 정보
- [인증](./authentication.md) - API 인증 방법
- [플레이그라운드](./playground.md) - 웹 기반 API 테스트 도구