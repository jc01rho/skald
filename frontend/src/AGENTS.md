# FRONTEND SOURCE DOMAIN

**Generated:** 2026-03-03
**Domain:** UI Runtime (`frontend/src`) (Score 18)

## OVERVIEW

루트 패키지가 곧 프론트엔드인 inverted 구조입니다. 이 디렉토리는 라우팅/상태/API 호출 규칙의 실제 기준점입니다.

## WHERE TO LOOK

| Task          | Location              | Notes                          |
| ------------- | --------------------- | ------------------------------ |
| API 호출 표준 | `lib/api.ts`          | 컴포넌트 직접 fetch/axios 금지 |
| 공유 상태     | `stores/*.ts`         | Zustand only                   |
| 라우팅 진입점 | `App.tsx`, `main.tsx` | Vite + React bootstrap         |
| 페이지 규칙   | `pages/*.tsx`         | 페이지는 thin, 로직 최소화     |
| 공용 타입     | `lib/types.ts`        | 도메인 타입 소스               |

## CONVENTIONS (DEVIATIONS ONLY)

- 루트 `package.json`이 프론트엔드 명령(`pnpm dev`, `pnpm build`)을 소유
- 공유 상태는 Zustand 스토어로만 관리 (`stores/`)
- 요청/CSRF/스트리밍 API 경로는 `lib/api.ts` 단일 경유
- 스타일은 Tailwind + `cn()` 조합 패턴 고정
- alias는 `@/* -> frontend/src/*` (루트 tsconfig 기준)

## ANTI-PATTERNS

- 컴포넌트에서 `axios`/`fetch` 직접 호출 금지 (`lib/api.ts` 사용)
- 공유 상태를 `useState`로 올리는 패턴 금지
- 페이지(`pages/`)에 비즈니스 로직 집적 금지
- 다중 대형 컴포넌트를 한 파일에 혼합 금지

## NOTES

- 개발 프록시: `/api/* -> http://localhost:8000`
- 채팅 스트리밍 상태는 `stores/chatStore.ts` 기준

## LLM ENDPOINT POLICY

- 모든 모델 호출(Gemini 포함)은 **코드 하드코딩 금지**이며, 환경변수(`CLI_PROXY_API_BASE_URL`, `GEMINI_API_BASE_URL`)로만 지정합니다.
- `CLI_PROXY_API_BASE_URL`와 `GEMINI_API_BASE_URL`는 동일한 값을 사용해야 합니다.
