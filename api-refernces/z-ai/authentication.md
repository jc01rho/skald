# Z.ai API 인증

## 개요

Z.ai API를 사용하려면 모든 요청에 유효한 인증 정보가 필요합니다. Z.ai는 API 키 기반의 인증 시스템을 사용합니다.

## API 키 발급

API 키는 Z.ai 플랫폼에서 발급받을 수 있습니다:

1. Z.ai 계정에 로그인
2. 개발자 대시보드 또는 API 설정 페이지로 이동
3. 새 API 키 생성
4. 생성된 API 키를 안전하게 저장

## 인증 방법

### Bearer 토큰 인증

Z.ai API는 Bearer 토큰 인증을 사용합니다. 모든 API 요청에 다음 헤더를 포함해야 합니다:

```
Authorization: Bearer YOUR_API_KEY
```

### 요청 헤더 예시

```http
GET /api/paas/v4/models HTTP/1.1
Host: api.z.ai
Authorization: Bearer z-ai-api-key-xxxxxxxxxxxxx
Content-Type: application/json
```

## API 키 보안

API 키는 중요한 자산이며 다음 보안 관행을 따라야 합니다:

- API 키를 코드에 직접 하드코딩하지 마세요
- 환경 변수나 보안 저장소를 사용하여 API 키를 관리하세요
- API 키를 버전 관리 시스템이나 공개 저장소에 커밋하지 마세요
- 주기적으로 API 키를 순환하세요

## 인증 오류

인증에 실패하면 다음과 같은 오류 응답을 받을 수 있습니다:

### 401 Unauthorized

API 키가 유효하지 않거나, 만료되었거나, 제공되지 않은 경우 발생합니다.

```json
{
  "error": {
    "message": "Invalid API key",
    "type": "authentication_error"
  }
}
```

### 403 Forbidden

API 키가 해당 리소스에 접근할 권한이 없는 경우 발생합니다.

```json
{
  "error": {
    "message": "Insufficient permissions",
    "type": "permission_error"
  }
}
```

## SDK를 통한 인증

Z.ai SDK를 사용하면 인증 과정이 단순화됩니다. SDK 초기화 시 API 키를 설정하면 됩니다:

### Python SDK 예시

```python
from zai import ZAI

client = ZAI(api_key="your-api-key")
```

### JavaScript SDK 예시

```javascript
import { ZAI } from 'zai';

const client = new ZAI({ apiKey: 'your-api-key' });
```

### Java SDK 예시

```java
import com.zai.client.ZAIClient;
import com.zai.client.okhttp.ZAIOkHttpClient;

ZAIClient client = ZAIOkHttpClient.builder()
    .apiKey("your-api-key")
    .build();
```

## 관련 문서

- [API 엔드포인트](./api-endpoint.md) - 기본 API 엔드포인트 정보
- [사용 예제](./call-examples.md) - 다양한 언어에서의 인증 포함 API 호출 예제
- [플레이그라운드](./playground.md) - 웹 인터페이스에서의 인증 테스트