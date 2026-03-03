# DISCORD-BOT SOURCE DOMAIN

**Generated:** 2026-03-03
**Domain:** Discord 연동 레이어 (`discord-bot/src`) (Score 10)

## OVERVIEW

Discord mention 이벤트를 Skald API와 연결하는 별도 런타임입니다. 본체 앱과 배포 파이프라인이 분리되어 있습니다.

## WHERE TO LOOK

| Task           | Location                         | Notes                    |
| -------------- | -------------------------------- | ------------------------ |
| 런타임 진입점  | `index.ts`                       | Discord client lifecycle |
| 멘션 처리      | `handlers/mentionHandler.ts`     | 질의→응답 흐름           |
| Skald API 통신 | `client/SkaldClient.ts`          | 백엔드 연동 클라이언트   |
| 스트리밍 편집  | `discord/DiscordStreamEditor.ts` | 메시지 업데이트 정책     |
| 명령어         | `commands/*.ts`                  | `/help`, `/config`       |

## CONVENTIONS (DEVIATIONS ONLY)

- Discord bot 이미지는 메인 앱과 분리된 워크플로우로 빌드
- 배포는 k8s 스크립트와 GHCR 이미지 태그 흐름을 따름
- 길드별 설정/응답 포맷 정책은 핸들러 계층에서 일관 처리

## ANTI-PATTERNS

- 프로덕션 이미지 로컬 빌드/푸시 금지 (GitHub Actions 경유)
- 토큰/민감값 하드코딩 금지 (`.env`, secret 사용)
- 스트리밍 중 동기 블로킹 로직 금지

## NOTES

- `discord-bot/**` 변경은 전용 워크플로우 트리거 대상
- 레이트리밋 민감 구간은 `DiscordStreamEditor`에서 처리

## LLM ENDPOINT POLICY

- 모든 모델 호출(Gemini 포함)은 **코드 하드코딩 금지**이며, 환경변수(`CLI_PROXY_API_BASE_URL`, `GEMINI_API_BASE_URL`)로만 지정합니다.
- `CLI_PROXY_API_BASE_URL`와 `GEMINI_API_BASE_URL`는 동일한 값을 사용해야 합니다.
