# Skald Chat API

## 개요

Chat API는 RAG(Retrieval-Augmented Generation) 기반 대화형 인터페이스를 제공합니다. 저장된 메모를 컨텍스트로 활용하여 질문에 답변합니다.

## 엔드포인트

```
POST /api/v1/chat
```

## 요청 형식

```json
{
    "query": "What were the main points discussed in the Q1 meeting?",
    "stream": false,
    "system_prompt": "You are a helpful assistant that can answer questions about the memo.",
    "filters": [
        {
            "field": "source",
            "operator": "eq",
            "value": "meeting-notes",
            "filter_type": "native_field"
        },
        {
            "field": "tags",
            "operator": "in",
            "value": ["q1", "meeting"],
            "filter_type": "native_field"
        }
    ]
}
```

## 요청 필드

### 필수 필드

| 필드 | 타입 | 설명 |
|------|-----|------|
| `query` | string | 질문 내용 |

### 선택 필드

| 필드 | 타입 | 기본값 | 설명 |
|------|-----|-------|------|
| `project_id` | UUID | - | 토큰 인증 사용 시 필수 |
| `stream` | boolean | false | 스트리밍 응답 활성화 |
| `system_prompt` | string | - | 채팅 에이전트 동작 가이드 |
| `filters` | array | [] | 검색 컨텍스트 필터 ([Filters](./filters.md) 참조) |

## 응답 형식

### 비스트리밍 응답 (200)

```json
{
    "ok": true,
    "response": "The main points discussed in the Q1 meeting were:\n1. Revenue targets \n2. Hiring plans \n3. Product roadmap",
    "intermediate_steps": []
}
```

### 스트리밍 응답 (stream: true)

```
Content-Type: text/event-stream

: ping
data: {"type": "token", "content": "The"}
data: {"type": "token", "content": " main"}
data: {"type": "token", "content": " points"}
...
data: {"type": "done"}
```

### 스트리밍 이벤트 타입

| 타입 | 설명 |
|-----|------|
| `token` | 응답 토큰 |
| `done` | 스트리밍 완료 |

## 에러 응답

```json
// 400 Bad Request
{"error": "Query is required"}
{"error": "Filters must be a list"}
{"error": "Invalid filter: <specific error message>"}

// 500 Internal Server Error
{"error": "Agent error: <error details>"}
```

## Python 예시

### 기본 채팅

```python
import requests

def chat_with_skald(query: str, system_prompt: str = None):
    """Skald Chat API를 사용한 RAG 기반 질의"""
    headers = {
        "Authorization": f"Bearer {SKALD_API_KEY}",
        "Content-Type": "application/json"
    }
    
    payload = {
        "query": query,
        "stream": False
    }
    
    if system_prompt:
        payload["system_prompt"] = system_prompt
    
    response = requests.post(
        f"{SKALD_BASE_URL}/api/v1/chat",
        headers=headers,
        json=payload,
        timeout=120  # LLM 응답 대기를 위해 긴 타임아웃
    )
    
    response.raise_for_status()
    return response.json()


# 사용 예시
result = chat_with_skald(
    query="SPARROW-1234 이슈와 관련된 다른 이슈들을 설명해주세요.",
    system_prompt="당신은 Jira 이슈 분석 전문가입니다. 한국어로 답변해주세요."
)
print(result["response"])
```

### 필터를 사용한 채팅

```python
def chat_about_jira_issues(query: str, issue_type: str = None):
    """특정 이슈 타입에 대해서만 질문"""
    filters = [
        {
            "field": "source",
            "operator": "eq",
            "value": "jira",
            "filter_type": "native_field"
        }
    ]
    
    if issue_type:
        filters.append({
            "field": "issueType",
            "operator": "eq",
            "value": issue_type,
            "filter_type": "custom_metadata"
        })
    
    headers = {
        "Authorization": f"Bearer {SKALD_API_KEY}",
        "Content-Type": "application/json"
    }
    
    payload = {
        "query": query,
        "stream": False,
        "filters": filters
    }
    
    response = requests.post(
        f"{SKALD_BASE_URL}/api/v1/chat",
        headers=headers,
        json=payload
    )
    
    return response.json()
```

### 스트리밍 채팅

```python
def chat_streaming(query: str):
    """스트리밍 응답으로 채팅"""
    headers = {
        "Authorization": f"Bearer {SKALD_API_KEY}",
        "Content-Type": "application/json"
    }
    
    payload = {
        "query": query,
        "stream": True
    }
    
    response = requests.post(
        f"{SKALD_BASE_URL}/api/v1/chat",
        headers=headers,
        json=payload,
        stream=True
    )
    
    for line in response.iter_lines():
        if line:
            line = line.decode('utf-8')
            if line.startswith('data: '):
                data = json.loads(line[6:])
                if data["type"] == "token":
                    print(data["content"], end="", flush=True)
                elif data["type"] == "done":
                    print()  # 줄바꿈
                    break
```

## 필터 활용 사례

### 특정 소스만 검색

```python
filters = [
    {
        "field": "source",
        "operator": "eq",
        "value": "jira",
        "filter_type": "native_field"
    }
]
```

### 특정 태그 포함

```python
filters = [
    {
        "field": "tags",
        "operator": "in",
        "value": ["인시던트", "SAST"],
        "filter_type": "native_field"
    }
]
```

### 커스텀 메타데이터로 필터

```python
filters = [
    {
        "field": "assignee",
        "operator": "eq",
        "value": "홍길동",
        "filter_type": "custom_metadata"
    }
]
```

## 모범 사례

1. **시스템 프롬프트 활용**: 응답 스타일과 언어를 일관되게 유지
2. **필터로 범위 제한**: 관련성 높은 컨텍스트만 사용하도록 필터 적용
3. **적절한 타임아웃**: LLM 응답 시간을 고려하여 충분한 타임아웃 설정 (60-120초)
4. **스트리밍 활용**: 긴 응답의 경우 스트리밍으로 UX 개선
