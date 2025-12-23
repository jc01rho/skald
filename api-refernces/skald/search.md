# Skald Search API

## 개요

Search API는 벡터 유사도 검색을 제공합니다. 저장된 메모의 청크를 대상으로 시맨틱 검색을 수행합니다.

## 엔드포인트

```
POST /api/v1/search
```

## 요청 형식

```json
{
    "query": "quarterly goals",
    "limit": 10,
    "filters": [
        {
            "field": "source",
            "operator": "eq",
            "value": "notion",
            "filter_type": "native_field"
        },
        {
            "field": "level",
            "operator": "eq",
            "value": "beginner",
            "filter_type": "custom_metadata"
        },
        {
            "field": "tags",
            "operator": "in",
            "value": ["meeting", "q1"],
            "filter_type": "native_field"
        }
    ]
}
```

## 요청 필드

### 필수 필드

| 필드 | 타입 | 설명 |
|------|-----|------|
| `query` | string | 검색 쿼리 문자열 |

### 선택 필드

| 필드 | 타입 | 기본값 | 설명 |
|------|-----|-------|------|
| `limit` | integer | 10 | 반환할 최대 결과 수 (1-50) |
| `project_id` | UUID | - | 토큰 인증 사용 시 필수 |
| `filters` | array | [] | 필터 객체 배열 ([Filters](./filters.md) 참조) |

## 응답 형식

### 성공 응답 (200)

```json
{
    "results": [
        {
            "memo_title": "Meeting Notes",
            "memo_uuid": "memo-uuid",
            "chunk_uuid": "chunk-uuid",
            "chunk_content": "Full content of the chunk...",
            "memo_summary": "Discussion about Q1 goals",
            "distance": 0.234
        }
    ]
}
```

### 응답 필드 설명

| 필드 | 타입 | 설명 |
|------|-----|------|
| `memo_title` | string | 메모 제목 |
| `memo_uuid` | string | 메모 UUID |
| `chunk_uuid` | string | 청크 UUID |
| `chunk_content` | string | 매칭된 청크 내용 |
| `memo_summary` | string | 메모 요약 |
| `distance` | float | 벡터 유사도 거리 (**낮을수록 더 유사**) |

> **중요**: `distance`는 코사인 거리입니다. 값이 낮을수록 쿼리와 더 유사합니다.

## 에러 응답

```json
// 400 Bad Request
{"error": "Query is required"}
{"error": "Limit must be less than or equal to 50"}
{"error": "Invalid filter: <specific error message>"}

// 422 Unprocessable Entity
{"error": "Search method is required and must be one of: title_contains, title_startswith, chunk_vector_search"}
```

## Python 예시

### 기본 검색

```python
import requests

def search_similar_issues(query: str, limit: int = 15):
    """Skald Search API를 사용한 유사도 검색"""
    headers = {
        "Authorization": f"Bearer {SKALD_API_KEY}",
        "Content-Type": "application/json"
    }
    
    payload = {
        "query": query,
        "limit": min(limit, 50)
    }
    
    response = requests.post(
        f"{SKALD_BASE_URL}/api/v1/search",
        headers=headers,
        json=payload,
        timeout=60
    )
    
    response.raise_for_status()
    return response.json()
```

### 필터를 사용한 검색

```python
def search_jira_issues(query: str, limit: int = 10):
    """Jira 소스만 검색"""
    headers = {
        "Authorization": f"Bearer {SKALD_API_KEY}",
        "Content-Type": "application/json"
    }
    
    payload = {
        "query": query,
        "limit": limit,
        "filters": [
            {
                "field": "source",
                "operator": "eq",
                "value": "jira",
                "filter_type": "native_field"
            }
        ]
    }
    
    response = requests.post(
        f"{SKALD_BASE_URL}/api/v1/search",
        headers=headers,
        json=payload
    )
    
    return response.json()
```

### 태그 기반 검색

```python
def search_by_tags(query: str, tags: list):
    """특정 태그가 있는 메모만 검색"""
    payload = {
        "query": query,
        "limit": 20,
        "filters": [
            {
                "field": "tags",
                "operator": "in",
                "value": tags,
                "filter_type": "native_field"
            }
        ]
    }
    
    # ... 요청 수행
```

## 유사도 점수 해석

`distance` 값을 유사도 백분율로 변환하는 방법:

```python
def distance_to_similarity(distance: float) -> float:
    """
    코사인 거리를 유사도 백분율로 변환
    
    코사인 거리 범위: 0 ~ 2
    - 0: 완전히 동일
    - 2: 완전히 반대
    """
    similarity_percentage = max(0, (2 - distance) / 2 * 100)
    return similarity_percentage
```

## 검색 결과 필터링

검색 결과를 추가로 필터링하는 예시:

```python
def find_similar_with_threshold(query: str, threshold: float = 0.5):
    """유사도 임계값을 적용한 검색"""
    results = search_similar_issues(query, limit=50)
    
    filtered = []
    for result in results.get("results", []):
        if result["distance"] <= threshold:
            filtered.append(result)
    
    return filtered
```

## 모범 사례

1. **적절한 limit 설정**: 필요한 만큼만 요청하여 성능 최적화
2. **필터 활용**: `source` 필터로 특정 소스만 검색
3. **임계값 적용**: `distance` 기반으로 저품질 결과 필터링
4. **타임아웃 설정**: 네트워크 지연을 고려한 적절한 타임아웃
