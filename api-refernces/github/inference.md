# GitHub Models Inference API

GitHub Models Inference API는 GitHub에서 제공하는 다양한 AI 모델을 사용하여 추론 작업을 수행할 수 있도록 해주는 REST API입니다. 이 API를 통해 개발자는 OpenAI, Meta, Google 등이 개발한 최신 LLM(대형 언어 모델)에 액세스할 수 있습니다.

## 개요

GitHub Models Inference API는 다음과 같은 주요 기능을 제공합니다:

- 다양한 사전 학습된 언어 모델에 대한 통일된 액세스 인터페이스
- 텍스트 생성, 요약, 번역 등 자연어 처리 작업
- 코드 생성, 분석 및 완성 기능
- 스트리밍 및 비동기 처리 지원
- 사용량 기반의 유연한 요금제

## 인증

API 사용을 위해서는 GitHub Personal Access Token(PAT)이 필요합니다. 토큰은 다음 권한을 포함해야 합니다:

- `models:inference` - 모델 추론 실행 권한

### 인증 방식

요청 헤더에 다음과 같이 인증 정보를 포함시켜야 합니다:

```http
Authorization: Bearer YOUR_GITHUB_TOKEN
Content-Type: application/json
X-GitHub-Api-Version: 2022-11-28
```

## 기본 URL

모든 API 요청은 다음 기본 URL을 사용합니다:

```
https://api.github.com
```

## 엔드포인트

### POST /models/{model}/infer

지정된 모델을 사용하여 추론을 수행합니다.

#### 경로 매개변수

- `model` (필수): 사용할 모델의 식별자
  - `gpt-4` - OpenAI GPT-4
  - `gpt-4-turbo` - OpenAI GPT-4 Turbo
  - `gpt-3.5-turbo` - OpenAI GPT-3.5 Turbo
  - `codellama-13b` - Meta CodeLlama 13B
  - `mistral-7b` - Mistral AI 7B
  - `llama-2-70b-chat` - Meta Llama 2 70B Chat

#### 요청 헤더

```http
Authorization: Bearer YOUR_GITHUB_TOKEN
Content-Type: application/json
X-GitHub-Api-Version: 2022-11-28
```

#### 요청 본문

```json
{
  "inputs": "추론에 사용할 입력 텍스트 또는 메시지 배열",
  "parameters": {
    "temperature": 0.7,
    "max_tokens": 1000,
    "top_p": 0.9,
    "frequency_penalty": 0,
    "presence_penalty": 0,
    "stop": ["\n", "Human:", "AI:"],
    "stream": false
  },
  "model": "gpt-4",
  "n": 1
}
```

#### 요청 매개변수 상세

- `inputs` (필수): 모델에 전달할 입력 데이터
  - 문자열: 단일 프롬프트
  - 배열: 대화형 메시지 형식 (채팅 모델용)
  
- `parameters` (선택): 모델 동작을 제어하는 매개변수
  - `temperature` (0-2): 출력의 무작위성 제어 (기본값: 1)
  - `max_tokens` (1-4096): 생성할 최대 토큰 수 (기본값: 256)
  - `top_p` (0-1): 토큰 선택을 위한 누적 확률 임계값 (기본값: 1)
  - `frequency_penalty` (-2-2): 빈번한 단어에 대한 페널티 (기본값: 0)
  - `presence_penalty` (-2-2): 이미 등장한 단어에 대한 페널티 (기본값: 0)
  - `stop` (문자열 또는 배열): 생성을 중단할 시퀀스
  - `stream` (불리언): 스트리밍 응답 여부 (기본값: false)

- `model` (선택): 모델 식별자 (경로 매개변수로 지정된 경우 생략 가능)
- `n` (정수): 생성할 응답 수 (기본값: 1)

#### 응답

##### 비스트리밍 응답 (stream: false)

```json
{
  "object": "text_completion",
  "model": "gpt-4",
  "choices": [
    {
      "index": 0,
      "text": "모델이 생성한 결과 텍스트",
      "logprobs": null,
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 10,
    "completion_tokens": 20,
    "total_tokens": 30
  },
  "created": 1677652288
}
```

##### 채팅 모델 응답

```json
{
  "id": "chatcmpl-abc123",
  "object": "chat.completion",
  "created": 1677652288,
  "model": "gpt-4",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "모델이 생성한 응답 내용"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 10,
    "completion_tokens": 20,
    "total_tokens": 30
  }
}
```

##### 스트리밍 응답 (stream: true)

```http
data: {"id": "cmpl-abc123", "object": "text_completion", "created": 1677652288, "choices": [{"index": 0, "text": "생성된", "logprobs": null, "finish_reason": null}]}

data: {"id": "cmpl-abc123", "object": "text_completion", "created": 1677652288, "choices": [{"index": 0, "text": " 텍스트", "logprobs": null, "finish_reason": null}]}

data: {"id": "cmpl-abc123", "object": "text_completion", "created": 1677652288, "choices": [{"index": 0, "text": " 조각", "logprobs": null, "finish_reason": "stop"}]}

data: [DONE]
```

## 지원 모델

### 텍스트 생성 모델

| 모델 | 제공업체 | 설명 | 최대 컨텍스트 |
|------|----------|------|--------------|
| `gpt-4` | OpenAI | 고급 자연어 생성 및 이해 모델 | 8,192 토큰 |
| `gpt-4-turbo` | OpenAI | 향상된 GPT-4, 더 빠른 응답 속도 | 128,000 토큰 |
| `gpt-3.5-turbo` | OpenAI | 비용 효율적인 언어 모델 | 16,384 토큰 |
| `llama-2-70b-chat` | Meta | 대화 최적화된 Llama 2 모델 | 4,096 토큰 |
| `mistral-7b` | Mistral AI | 경량 고성능 언어 모델 | 8,192 토큰 |

### 코드 전문 모델

| 모델 | 제공업체 | 설명 | 최대 컨텍스트 |
|------|----------|------|--------------|
| `codellama-13b` | Meta | 코드 생성 및 분석 특화 모델 | 16,384 토큰 |
| `gpt-4` | OpenAI | 코드 생성 및 이해 능력 포함 | 8,192 토큰 |

## 사용 예제

### 기본 텍스트 생성

```bash
curl -X POST \
  https://api.github.com/models/gpt-4/infer \
  -H 'Authorization: Bearer YOUR_GITHUB_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'X-GitHub-Api-Version: 2022-11-28' \
  -d '{
    "inputs": "오늘 날씨가 좋네요. 이에 대한 시를 지어주세요.",
    "parameters": {
      "temperature": 0.8,
      "max_tokens": 150
    }
  }'
```

### 채팅 형식 요청

```bash
curl -X POST \
  https://api.github.com/models/gpt-4-turbo/infer \
  -H 'Authorization: Bearer YOUR_GITHUB_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'X-GitHub-Api-Version: 2022-11-28' \
  -d '{
    "inputs": [
      {
        "role": "system",
        "content": "당신은 친절한 AI 비서입니다."
      },
      {
        "role": "user",
        "content": "JavaScript에서 배열을 정렬하는 방법을 알려주세요."
      }
    ],
    "parameters": {
      "temperature": 0.3,
      "max_tokens": 500
    }
  }'
```

### 코드 생성 요청

```bash
curl -X POST \
  https://api.github.com/models/codellama-13b/infer \
  -H 'Authorization: Bearer YOUR_GITHUB_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'X-GitHub-Api-Version: 2022-11-28' \
  -d '{
    "inputs": "# Python으로 퀵 정렬(quick sort) 알고리즘 구현\n\ndef quick_sort(arr):",
    "parameters": {
      "temperature": 0.2,
      "max_tokens": 200,
      "stop": ["\ndef ", "\nclass ", "\n#"]
    }
  }'
```

### 스트리밍 응답 요청

```bash
curl -X POST \
  https://api.github.com/models/gpt-3.5-turbo/infer \
  -H 'Authorization: Bearer YOUR_GITHUB_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'X-GitHub-Api-Version: 2022-11-28' \
  -d '{
    "inputs": "인공지능의 미래에 대한 긴 에세이를 작성해주세요.",
    "parameters": {
      "temperature": 0.7,
      "max_tokens": 1000,
      "stream": true
    }
  }'
```

### Python 예제

```python
import requests
import json

def call_github_model(model, inputs, parameters=None):
    """GitHub Models API 호출 함수"""
    url = f"https://api.github.com/models/{model}/infer"
    headers = {
        "Authorization": "Bearer YOUR_GITHUB_TOKEN",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28"
    }
    
    payload = {
        "inputs": inputs,
        "parameters": parameters or {}
    }
    
    response = requests.post(url, headers=headers, json=payload)
    response.raise_for_status()
    return response.json()

# 사용 예시
result = call_github_model(
    model="gpt-4",
    inputs="파이썬으로 피보나치 수열을 계산하는 함수를 작성해주세요.",
    parameters={
        "temperature": 0.3,
        "max_tokens": 300
    }
)

print(result["choices"][0]["text"])
```

### Node.js 예제

```javascript
const https = require('https');

function callGitHubModel(model, inputs, parameters = {}) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify({
            inputs: inputs,
            parameters: parameters
        });

        const options = {
            hostname: 'api.github.com',
            path: `/models/${model}/infer`,
            method: 'POST',
            headers: {
                'Authorization': 'Bearer YOUR_GITHUB_TOKEN',
                'Content-Type': 'application/json',
                'X-GitHub-Api-Version': '2022-11-28',
                'Content-Length': data.length
            }
        };

        const req = https.request(options, (res) => {
            let responseData = '';
            res.on('data', (chunk) => {
                responseData += chunk;
            });
            res.on('end', () => {
                try {
                    const parsedData = JSON.parse(responseData);
                    resolve(parsedData);
                } catch (error) {
                    reject(error);
                }
            });
        });

        req.on('error', (error) => {
            reject(error);
        });

        req.write(data);
        req.end();
    });
}

// 사용 예시
callGitHubModel(
    'gpt-4',
    'Node.js에서 파일을 비동기적으로 읽는 방법을 설명해주세요.',
    { temperature: 0.5, max_tokens: 400 }
)
.then(response => {
    console.log(response.choices[0].text);
})
.catch(error => {
    console.error('Error:', error);
});
```

## 응답 코드

| 상태 코드 | 설명 |
|-----------|------|
| `200` | 요청 성공 |
| `400` | 잘못된 요청 (입력 데이터 형식 오류, 매개변수 오류 등) |
| `401` | 인증 실패 (유효하지 않은 토큰) |
| `403` | 권한 없음 (필요한 권한 없음) |
| `404` | 요청한 모델을 찾을 수 없음 |
| `422` | 처리할 수 없는 엔티티 (유효성 검증 실패) |
| `429` | 요청 제한 초과 (Rate limit exceeded) |
| `500` | 서버 내부 오류 |
| `503` | 서비스를 사용할 수 없음 |

## 제한 사항

### 요청 제한

- 각 요청은 최대 1MB 크기의 입력 데이터를 허용합니다.
- 동시 요청 수는 계정 유형에 따라 제한됩니다.
- 일일/월간 토큰 사용량 한계가 적용됩니다.

### 모델별 제한

- `max_tokens` 매개변수는 모델별 최대 컨텍스트 길이를 초과할 수 없습니다.
- 일부 모델은 특정 매개변수를 지원하지 않을 수 있습니다.
- 무료 사용자는 일부 고성능 모델에 대한 접근이 제한될 수 있습니다.

## 오류 처리

API 응답에서 오류가 발생한 경우, 다음과 같은 형식으로 오류 정보가 제공됩니다:

```json
{
  "error": {
    "code": "invalid_request_error",
    "message": "The request is invalid.",
    "type": "invalid_request_error",
    "param": "inputs",
    "details": "The inputs field is required and cannot be empty."
  }
}
```

### 일반적인 오류 유형

- `invalid_request_error`: 요청 형식이 잘못됨
- `authentication_error`: 인증 실패
- `permission_error`: 권한 부족
- `not_found_error`: 요청한 리소스를 찾을 수 없음
- `rate_limit_error`: 요청 한도 초과
- `api_error`: API 서버 오류

## 요금 정책

GitHub Models Inference API는 사용량에 따라 요금이 부과됩니다:

- 토큰 기반 과금: 입력 및 출력 토큰 수에 따라 비용 청구
- 모델별 요금 차등: 고성능 모델은 더 높은 요금 적용
- 무료 사용 한도: 매월 일정량의 무료 토큰 제공

자세한 요금 정책은 [GitHub Models 요금 페이지](https://github.com/pricing)를 참조하세요.

## 모범 사례

### 성능 최적화

1. **적절한 모델 선택**: 작업에 적합한 가장 비용 효율적인 모델 사용
2. **토큰 최적화**: 불필요한 입력 텍스트 제거로 비용 절감
3. **캐싱 전략**: 동일한 요청에 대한 응답 캐싱
4. **배치 처리**: 여러 작업을 하나의 요청으로 결합

### 보안 고려사항

1. **토큰 관리**: API 토큰을 코드에 직접 하드코딩하지 않기
2. **입력 검증**: 사용자 입력 데이터 검증 및 정제
3. **오류 처리**: 민감 정보가 오류 메시지에 노출되지 않도록 주의

### 신뢰성 향상

1. **재시도 로직**: 일시적인 오류에 대한 지수 백오프 재시도 구현
2. **폴백 전략**: 주요 모델을 사용할 수 없을 때 대체 모델 사용
3. **모니터링**: API 응답 시간 및 오류율 모니터링

## 추가 정보

- [GitHub Models 공식 문서](https://docs.github.com/ko/rest/models)
- [GitHub Models API 레퍼런스](https://docs.github.com/ko/rest/models/inference)
- [GitHub 개발자 포럼](https://github.com/community/developers)
- [GitHub Models 예제 저장소](https://github.com/github/models-examples)

## 변경 로그

### 2024-03-15
- `gpt-4-turbo` 모델 추가
- 스트리밍 응답 형식 개선
- 요금 정책 업데이트

### 2024-01-20
- `mistral-7b` 모델 지원 추가
- API 버전 2022-11-28 표준화
- 오류 응답 형식 개선

### 2023-11-10
- 초기 API 릴리스
- 기본 텍스트 생성 및 채팅 기능 지원