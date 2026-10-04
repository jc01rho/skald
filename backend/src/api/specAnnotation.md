# SpecAnnotation API 입력 가이드 — AI 자동화 추가사항 (AUTOMATION_HINT)

작성일: 2026-10-04
대상 API: `backend/src/api/specAnnotation.ts` (마운트: `/v1/spec-annotations`, `backend/src/expressServer.ts`)
관련 엔티티: `skald_spec_annotation` (MikroORM `SpecAnnotation`)

## 1. 개요

`AUTOMATION_HINT`는 AI 자동화(자동 스펙 변환, 자동 태그/요약 생성 등) 시 참고해야 할 추가 사항을 기록하는 필드입니다.

- `kind`는 `ADDITIONAL_NOTE`(추가 참고사항)와 `AUTOMATION_HINT`(자동화 변환 시 참고사항) 두 가지입니다.
- `body`는 필수이며 최대 20,000자입니다.
- `condition`, `effect`, `applies_to`는 선택적이며 자동화 시점/동작/대상을 명시할 때 사용합니다.

## 2. 엔티티 필드 정의

| 필드                        | 유형         | 제약                                     | 설명 (AI 자동화 관점)                        |
| --------------------------- | ------------ | ---------------------------------------- | -------------------------------------------- |
| `uuid`                      | UUID         | PK                                       | 수정/보관/확인 시 사용                       |
| `kind`                      | enum         | `ADDITIONAL_NOTE` \| `AUTOMATION_HINT`   | AI 자동화 참고사항은 `AUTOMATION_HINT`       |
| `body`                      | text         | 필수, max 20,000                         | 자동화 시 참고할 핵심 내용                   |
| `condition`                 | text?        | 선택, max 2,000                          | 이 참고사항이 적용되는 조건                  |
| `effect`                    | text?        | 선택, max 2,000                          | 조건 충족 시 자동화가 취할 동작              |
| `applies_to`                | text?        | 선택, max 2,000                          | 적용 대상 필드/구간 (예: `title`, `summary`) |
| `status`                    | enum         | `ACTIVE` \| `NEEDS_REVIEW` \| `ARCHIVED` | 기본 `ACTIVE`                                |
| `anchor_revision_id`        | UUID?        | 선택                                     | 작성 기준이 된 수집 리비전                   |
| `anchor_content_hash`       | string(128)? | 선택                                     | 소스 변경 감지용 해시                        |
| `created_by` / `updated_by` | string(254)? | 서버 자동 기록                           | 이메일 또는 `project-api-key`                |
| `version`                   | int          | 기본 1                                   | 낙관적 잠금용, 모든 쓰기 요청에 필수         |

## 3. API 입력 스키마 (Zod 기준)

### 생성 — `POST /api/v1/spec-annotations`

```json
{
    "memo_uuid": "<캐노니컬 스펙 메모 UUID>",
    "kind": "AUTOMATION_HINT",
    "body": "필수, 1~20,000자",
    "condition": "선택, 최대 2,000자",
    "effect": "선택, 최대 2,000자",
    "applies_to": "선택, 최대 2,000자"
}
```

- 필수: `memo_uuid`, `kind`, `body`
- 선택: `condition`, `effect`, `applies_to` — 빈 문자열은 `null`로 정규화됨
- `memo_uuid`는 UUID 형식이어야 하며, 해당 메모가 캐노니컬 스펙 메모가 아니면 404 `NOT_A_SPEC_MEMO`

### 수정 — `PATCH /api/v1/spec-annotations/:id`

- `kind`/`body`/`condition`/`effect`/`applies_to` 중 원하는 필드만 부분 전송 가능 (`Fields.partial()`)
- `version` 필수 (정수, 1 이상)

```json
{ "version": 3, "effect": "자동 태그 생성 시 'functions-default'만 적용" }
```

### 상태 변경 — `POST /api/v1/spec-annotations/:id/archive`, `/:id/confirm`

- 둘 다 `version` 필수:

```json
{ "version": 3 }
```

## 4. AI 자동화 추가사항 입력 예시

### 예시 1: 자동 스펙 변환 시 처리 규칙

```json
{
    "memo_uuid": "0f0e3c7a-....",
    "kind": "AUTOMATION_HINT",
    "body": "이 스펙은 functions 테크그룹 설정값이므로 자동 변환 시 '기본값 유지'로 처리. 수동 변경 시 만료 일자를 명시할 것.",
    "condition": "소스가 functions이고 content_length > 300일 때",
    "effect": "자동 태그 생성 시 'functions-default'만 적용, 기타 태그는 수동 검토 후 추가",
    "applies_to": "tags, summary"
}
```

### 예시 2: 자동 요약 생성 시 제약

```json
{
    "memo_uuid": "0f0e3c7a-....",
    "kind": "AUTOMATION_HINT",
    "body": "내부 보안 정책 관련 메모이므로 자동 요약은 최소한으로 제한.",
    "condition": null,
    "effect": "summary 생성 시 길이 120자로 제한하고 민감 키워드 필터 적용",
    "applies_to": "summary"
}
```

## 5. API URL 및 처리 흐름

| 메서드 | 경로                                        | 설명                             |
| ------ | ------------------------------------------- | -------------------------------- |
| GET    | `/api/v1/spec-annotations?memo_uuid=<uuid>` | 해당 메모의 애노테이션 목록 조회 |
| POST   | `/api/v1/spec-annotations`                  | 생성                             |
| PATCH  | `/api/v1/spec-annotations/:id`              | 수정 (`version` 필수)            |
| POST   | `/api/v1/spec-annotations/:id/archive`      | 보관 (`version` 필수)            |
| POST   | `/api/v1/spec-annotations/:id/confirm`      | 확인/활성화 (`version` 필수)     |

처리 흐름:

1. `memo_uuid`로 대상 메모 확인 → 캐노니컬 스펙 메모여야 함 (아니면 404 `NOT_A_SPEC_MEMO`)
2. `kind`, `body` 필수 검증 (`zod`)
3. `condition`/`effect`/`applies_to`의 빈 문자열은 `null`로 정규화
4. `version` 불일치 시 409 `VERSION_CONFLICT` (낙관적 잠금)
5. 보관(ARCHIVED)된 애노테이션은 수정/confirm 불가 (409 `ANNOTATION_ARCHIVED`)

## 6. 오류 응답 예시

```json
// 400 — 필수 필드 누락/검증 실패
{ "error": "Request validation failed: body: body is required", "code": "INVALID_REQUEST" }

// 409 — version 불일치 (낙관적 잠금)
{ "error": "Annotation was modified by someone else; reload and retry", "code": "VERSION_CONFLICT" }

// 404 — 애노테이션 ID 없음
{ "error": "Annotation not found", "code": "ANNOTATION_NOT_FOUND" }

// 404 — 대상 메모가 캐노니컬 스펙 메모가 아님
{ "error": "Memo is not a canonical spec memo", "code": "NOT_A_SPEC_MEMO" }

// 409 — 보관된 애노테이션 수정/confirm 시도
{ "error": "Archived annotations cannot be edited", "code": "ANNOTATION_ARCHIVED" }
```

## 7. 사전 조건과 주의사항

- 애노테이션은 캐노니컬 스펙 메모에만 달 수 있습니다.
- 애노테이션은 수집 리비전 밖에 저장되므로 SPMS 재동기화로 덮어써지지 않습니다. 대신 소스 내용이 바뀌면 `anchor_content_hash` 비교로 `NEEDS_REVIEW` 플래그가 걸릴 수 있습니다.
- `version`은 모든 쓰기 요청(PATCH, archive, confirm)에 필수이며, 항상 마지막으로 읽은 값을 그대로 보내야 합니다.
- `created_by`/`updated_by`는 클라이언트가 보내는 값이 아니라 서버가 인증 주체(로그인 사용자 이메일 또는 `project-api-key`)에서 자동 기록합니다.

## 8. 참고: 프론트 패널

`SpecAnnotationsPanel` (`frontend/src/components/Memos/SpecAnnotationsPanel.tsx`)에서 동일 필드를 UI로 입력할 수 있으며, `AUTOMATION_HINT`는 UI 라벨이 "자동화 변환 시 참고사항"입니다. `NEEDS_REVIEW` 상태는 `confirm`으로 `ACTIVE`로 되돌릴 수 있습니다.
