# Skald Memos API

## 개요

Memos API는 문서(메모)의 CRUD 작업을 제공합니다. 메모는 자동으로 청크로 분할되고 벡터 임베딩이 생성되어 검색 가능해집니다.

## 엔드포인트 요약

| 메서드 | 엔드포인트 | 설명 |
|--------|-----------|------|
| `POST` | `/api/v1/memo` | 새 메모 생성 |
| `GET` | `/api/v1/memo/{id}` | 메모 조회 |
| `PATCH` | `/api/v1/memo/{id}` | 메모 업데이트 |
| `DELETE` | `/api/v1/memo/{id}` | 메모 삭제 |

---

## POST /api/v1/memo

새로운 메모를 생성합니다.

### 요청 형식

```json
{
    "title": "Meeting Notes",
    "content": "Full content of the memo...",
    "metadata": {
        "type": "notes",
        "author": "John Doe"
    },
    "reference_id": "external-id-123",
    "tags": ["meeting", "q1"],
    "source": "notion",
    "expiration_date": "2024-12-31T23:59:59Z"
}
```

### 필수 필드

| 필드 | 타입 | 설명 |
|------|-----|------|
| `title` | string | 메모 제목 (최대 255자) |
| `content` | string | 메모 본문 내용 |

### 선택 필드

| 필드 | 타입 | 설명 |
|------|-----|------|
| `metadata` | object | 사용자 정의 JSON 메타데이터 |
| `reference_id` | string | 외부 시스템 참조 ID (최대 255자) |
| `tags` | array[string] | 분류용 태그 목록 |
| `source` | string | 소스 시스템명 (최대 255자) |
| `expiration_date` | datetime | 메모 만료 일시 |

### 성공 응답 (200)

```json
{
    "ok": true
}
```

### Python 예시

```python
import requests

headers = {
    "Authorization": f"Bearer {SKALD_API_KEY}",
    "Content-Type": "application/json"
}

payload = {
    "title": "SPARROW-1234 이슈 요약",
    "content": "이슈 상세 내용...",
    "metadata": {
        "issueType": "인시던트",
        "reporter": "홍길동",
        "assignee": "김철수"
    },
    "reference_id": "SPARROW-1234",
    "tags": ["인시던트", "SAST"],
    "source": "jira"
}

response = requests.post(
    f"{SKALD_BASE_URL}/api/v1/memo",
    headers=headers,
    json=payload
)
```

---

## GET /api/v1/memo/{id}

메모를 조회합니다.

### URL 파라미터

| 파라미터 | 타입 | 설명 |
|---------|-----|------|
| `id` | string | 메모 UUID 또는 reference_id |

### 쿼리 파라미터

| 파라미터 | 타입 | 기본값 | 설명 |
|---------|-----|-------|------|
| `id_type` | string | `memo_uuid` | `memo_uuid` 또는 `reference_id` |

### 요청 예시

```
# UUID로 조회
GET /api/v1/memo/550e8400-e29b-41d4-a716-446655440000

# reference_id로 조회
GET /api/v1/memo/SPARROW-1234?id_type=reference_id
```

### 성공 응답 (200)

```json
{
    "uuid": "memo-uuid",
    "created_at": "2024-01-15T10:30:00Z",
    "updated_at": "2024-01-15T10:30:00Z",
    "title": "Meeting Notes",
    "content": "Full content of the memo...",
    "summary": "Discussion about Q1 goals",
    "content_length": 1234,
    "metadata": {
        "type": "notes"
    },
    "client_reference_id": "external-id-123",
    "source": "notion",
    "type": "document",
    "expiration_date": "2024-12-31T23:59:59Z",
    "archived": false,
    "pending": false,
    "tags": [
        {
            "uuid": "tag-uuid",
            "tag": "meeting"
        }
    ],
    "chunks": [
        {
            "uuid": "chunk-uuid",
            "chunk_content": "First chunk content...",
            "chunk_index": 0
        }
    ]
}
```

### 에러 응답

```json
// 400 Bad Request
{"error": "id_type must be either 'memo_uuid' or 'reference_id'"}

// 404 Not Found
{"error": "Memo not found"}
```

---

## PATCH /api/v1/memo/{id}

기존 메모를 업데이트합니다.

### URL 및 쿼리 파라미터

- `id`: 메모 UUID 또는 reference_id
- `id_type`: `memo_uuid` (기본값) 또는 `reference_id`

### 요청 형식

```json
{
    "title": "Updated Title",
    "metadata": {
        "type": "updated"
    },
    "client_reference_id": "new-ref-id",
    "source": "updated-source",
    "expiration_date": "2025-12-31T23:59:59Z",
    "content": "Updated content..."
}
```

### 업데이트 가능한 필드

| 필드 | 타입 | 설명 |
|------|-----|------|
| `title` | string | 메모 제목 업데이트 |
| `metadata` | object | 사용자 정의 메타데이터 업데이트 |
| `client_reference_id` | string | 외부 참조 ID 업데이트 |
| `source` | string | 소스 시스템명 업데이트 |
| `expiration_date` | datetime | 만료 일시 업데이트 |
| `content` | string | 본문 내용 업데이트 (**재처리 트리거**) |

> **중요**: `content`를 업데이트하면 메모가 자동으로 재처리됩니다 (요약, 태그, 청크가 재생성됨).

### 성공 응답 (200)

```json
{
    "ok": true
}
```

### 에러 응답

```json
// 400 Bad Request
{"error": "id_type must be either 'memo_uuid' or 'reference_id'"}

// 403 Forbidden
{"error": "Resource does not belong to the project"}
{"error": "Access denied"}

// 404 Not Found
{"error": "Memo not found"}
```

---

## DELETE /api/v1/memo/{id}

메모를 삭제합니다.

### URL 및 쿼리 파라미터

- `id`: 메모 UUID 또는 reference_id
- `id_type`: `memo_uuid` (기본값) 또는 `reference_id`

### 요청 예시

```
# UUID로 삭제
DELETE /api/v1/memo/550e8400-e29b-41d4-a716-446655440000

# reference_id로 삭제
DELETE /api/v1/memo/SPARROW-1234?id_type=reference_id
```

### 성공 응답

```
204 No Content
```

### 에러 응답

```json
// 400 Bad Request
{"error": "id_type must be either 'memo_uuid' or 'reference_id'"}

// 403 Forbidden
{"error": "Resource does not belong to the project"}
{"error": "Access denied"}

// 404 Not Found
{"error": "Memo not found"}
```

---

## 사용 패턴: Upsert (생성 또는 업데이트)

`reference_id`를 사용하면 외부 시스템 ID 기반으로 메모를 관리할 수 있습니다.

```python
def create_or_update_memo(issue_key: str, title: str, content: str, metadata: dict):
    """reference_id를 사용한 upsert 패턴"""
    headers = {
        "Authorization": f"Bearer {SKALD_API_KEY}",
        "Content-Type": "application/json"
    }
    
    # 먼저 기존 메모 존재 여부 확인
    get_url = f"{SKALD_BASE_URL}/api/v1/memo/{issue_key}?id_type=reference_id"
    response = requests.get(get_url, headers=headers)
    memo_exists = response.status_code == 200
    
    payload = {
        "title": title,
        "content": content,
        "metadata": metadata,
        "reference_id": issue_key,
        "source": "jira"
    }
    
    if memo_exists:
        # 업데이트
        patch_url = f"{SKALD_BASE_URL}/api/v1/memo/{issue_key}?id_type=reference_id"
        return requests.patch(patch_url, headers=headers, json=payload)
    else:
        # 생성
        post_url = f"{SKALD_BASE_URL}/api/v1/memo"
        return requests.post(post_url, headers=headers, json=payload)
```
