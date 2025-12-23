# Skald Filters API

## 개요

Filters는 Search, Chat, Generate 엔드포인트에서 사용할 수 있는 고급 필터링 기능입니다.

## 지원 엔드포인트

- `POST /api/v1/search`
- `POST /api/v1/chat`
- `POST /api/v1/generate`

## 필터 구조

```json
{
    "field": "field_name",
    "operator": "operator_name",
    "value": "value or [array]",
    "filter_type": "native_field | custom_metadata"
}
```

### 필터 필드 설명

| 필드 | 타입 | 설명 |
|------|-----|------|
| `field` | string | 필터링할 필드명 |
| `operator` | string | 비교 연산자 |
| `value` | string \| array | 비교할 값 (`in`, `not_in`은 배열 필요) |
| `filter_type` | string | `native_field` 또는 `custom_metadata` |

---

## 필터 타입

### Native Fields (기본 필드)

`filter_type: "native_field"`

| 필드 | 설명 |
|------|------|
| `title` | 메모 제목 |
| `source` | 소스 시스템명 |
| `client_reference_id` | 외부 참조 ID |
| `tags` | 메모 태그 (`in` 또는 `not_in` 연산자와 배열 값 필요) |

**예시:**

```json
{
    "field": "source",
    "operator": "eq",
    "value": "jira",
    "filter_type": "native_field"
}
```

### Custom Metadata (사용자 정의 메타데이터)

`filter_type: "custom_metadata"`

메모 저장 시 `metadata` 객체에 포함된 모든 필드를 필터링할 수 있습니다.

**예시:**

```json
{
    "field": "category",
    "operator": "contains",
    "value": "tutorial",
    "filter_type": "custom_metadata"
}
```

> **참고**: `metadata.category` 형식이 아닌 `category`만 사용합니다.

---

## 연산자

### 동등 연산자 (Equality Operators)

| 연산자 | 설명 | 예시 값 |
|--------|------|---------|
| `eq` | 같음 | `"value"` |
| `ne` | 같지 않음 | `"value"` |

### 문자열 연산자 (String Operators)

| 연산자 | 설명 | 예시 값 |
|--------|------|---------|
| `contains` | 포함 | `"search"` |
| `startswith` | 시작 | `"prefix"` |
| `endswith` | 끝남 | `"suffix"` |

### 배열 연산자 (Array Operators)

| 연산자 | 설명 | 예시 값 |
|--------|------|---------|
| `in` | 배열 중 하나와 일치 | `["a", "b", "c"]` |
| `not_in` | 배열 모두와 불일치 | `["x", "y", "z"]` |

---

## 필터 조합

여러 필터를 배열로 전달하면 **AND 조건**으로 결합됩니다.

```json
{
    "query": "search query",
    "filters": [
        {
            "field": "source",
            "operator": "eq",
            "value": "jira",
            "filter_type": "native_field"
        },
        {
            "field": "issueType",
            "operator": "eq",
            "value": "인시던트",
            "filter_type": "custom_metadata"
        }
    ]
}
```

---

## 일반적인 필터 패턴

### 소스별 필터

```json
{
    "field": "source",
    "operator": "eq",
    "value": "jira",
    "filter_type": "native_field"
}
```

### 태그별 필터

```json
{
    "field": "tags",
    "operator": "in",
    "value": ["인시던트", "장애"],
    "filter_type": "native_field"
}
```

### 커스텀 메타데이터 필터

```json
{
    "field": "assignee",
    "operator": "eq",
    "value": "홍길동",
    "filter_type": "custom_metadata"
}
```

### 부분 문자열 매칭

```json
{
    "field": "title",
    "operator": "contains",
    "value": "SAST",
    "filter_type": "native_field"
}
```

### 복합 조건

```json
{
    "filters": [
        {
            "field": "source",
            "operator": "eq",
            "value": "jira",
            "filter_type": "native_field"
        },
        {
            "field": "status",
            "operator": "ne",
            "value": "완료",
            "filter_type": "custom_metadata"
        },
        {
            "field": "tags",
            "operator": "in",
            "value": ["SAST", "DAST"],
            "filter_type": "native_field"
        }
    ]
}
```

---

## 에러 응답

```json
// 400 Bad Request
{"error": "Invalid filter: field is required"}
{"error": "Invalid filter: operator is required"}
{"error": "Invalid filter: value is required"}
{"error": "Invalid filter: filter_type must be 'native_field' or 'custom_metadata'"}
{"error": "Invalid filter: tags field must use 'in' or 'not_in' operator with array value"}
```

---

## 엔드포인트별 사용법

### Search 엔드포인트

```python
payload = {
    "query": "검색어",
    "limit": 10,
    "filters": [
        {"field": "source", "operator": "eq", "value": "jira", "filter_type": "native_field"}
    ]
}

response = requests.post(f"{BASE_URL}/api/v1/search", headers=headers, json=payload)
```

### Chat 엔드포인트

```python
payload = {
    "query": "질문",
    "stream": False,
    "filters": [
        {"field": "source", "operator": "eq", "value": "jira", "filter_type": "native_field"}
    ]
}

response = requests.post(f"{BASE_URL}/api/v1/chat", headers=headers, json=payload)
```

### Generate 엔드포인트

```python
payload = {
    "prompt": "생성 프롬프트",
    "filters": [
        {"field": "tags", "operator": "in", "value": ["tutorial"], "filter_type": "native_field"}
    ]
}

response = requests.post(f"{BASE_URL}/api/v1/generate", headers=headers, json=payload)
```

---

## 모범 사례

1. **필터 타입 명시**: 항상 `filter_type`을 명시적으로 지정
2. **배열 연산자 사용**: `tags` 필드는 반드시 `in` 또는 `not_in` 연산자 사용
3. **빈 필터 배열**: `filters: []`는 필터 없음과 동일
4. **대소문자 주의**: 필드명과 값은 대소문자를 구분할 수 있음
5. **메타데이터 구조 확인**: 커스텀 메타데이터 필터 전 메모 저장 시 메타데이터 구조 확인
