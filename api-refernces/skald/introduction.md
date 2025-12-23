# Skald API Introduction

## 개요

Skald는 문서 저장, 벡터 검색, RAG 기반 채팅 기능을 제공하는 API 서비스입니다.

## Base URL

```
https://api.skald.sparrow.local
```

> **참고**: 기본 Skald 클라우드 서비스는 `https://api.useskald.com`을 사용하지만, 이 프로젝트에서는 self-hosted 인스턴스를 사용합니다.

## 인증 (Authentication)

모든 API 요청에는 Bearer 토큰 인증이 필요합니다.

### 헤더 형식

```
Authorization: Bearer sk_proj_xxxxxxxxx
```

### API 키 획득

API 키는 Skald 플랫폼에서 발급받을 수 있습니다.

### Python 예시

```python
import requests

headers = {
    "Authorization": f"Bearer {SKALD_API_KEY}",
    "Content-Type": "application/json"
}

response = requests.get(
    "https://api.skald.sparrow.local/api/v1/memo/example-id",
    headers=headers
)
```

## 응답 코드 (Response Codes)

| 상태 코드 | 설명 |
|----------|------|
| `200 OK` | 요청 성공 |
| `201 Created` | 리소스 생성 성공 |
| `204 No Content` | 삭제 성공 (본문 없음) |
| `400 Bad Request` | 잘못된 요청 형식 |
| `401 Unauthorized` | 인증 실패 |
| `403 Forbidden` | 접근 권한 없음 |
| `404 Not Found` | 리소스를 찾을 수 없음 |
| `422 Unprocessable Entity` | 유효성 검사 실패 |
| `500 Internal Server Error` | 서버 내부 오류 |

## 공통 에러 응답 형식

```json
{
    "error": "에러 메시지 설명"
}
```

## 성공 응답 형식

대부분의 POST/PATCH 요청에 대한 성공 응답:

```json
{
    "ok": true
}
```
