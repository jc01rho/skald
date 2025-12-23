# Z.ai API 엔드포인트

## 기본 API 엔드포인트

Z.ai API의 기본 엔드포인트는 다음과 같습니다:

```
https://api.z.ai/api/paas/v4/
```

## 엔드포인트 구조

Z.ai API는 RESTful 아키텍처를 따르며, 모든 API 요청은 기본 엔드포인트에 특정 리소스 경로를 추가하여 구성됩니다.

### 기본 URL 형식

```
https://api.z.ai/api/paas/v4/{resource}
```

여기서 `{resource}`는 접근하려는 특정 API 리소스로 대체됩니다.

## 주요 API 리소스

- 챗봇 대화: `/chat/completions`
- 모델 정보: `/models`
- 임베딩: `/embeddings`
- 기타 AI 서비스 관련 엔드포인트

## 버전 관리

API 엔드포인트에 포함된 `v4`는 API 버전을 나타냅니다. Z.ai는 버전 호환성을 유지하며 새로운 기능은 향후 버전에서 제공될 수 있습니다.

## 지원되는 프로토콜

- HTTPS
- HTTP/1.1 및 HTTP/2
- REST 아키텍처
- JSON 요청 및 응답 형식

## 리전 정보

현재 Z.ai API는 글로벌 엔드포인트를 제공하며, 특정 리전 설정은 필요하지 않습니다.

## API 게이트웨이

모든 API 요청은 기본 엔드포인트를 통해 라우팅되며, 인증, 속도 제한, 모니터링 등의 공통 기능이 적용됩니다.

## 관련 문서

- [인증](./authentication.md) - API 요청에 필요한 인증 방법
- [사용 예제](./call-examples.md) - 다양한 프로그래밍 언어에서의 API 호출 예제
- [플레이그라운드](./playground.md) - API 테스트를 위한 웹 인터페이스