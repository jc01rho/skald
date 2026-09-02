# RAG 질의 도메인 별칭 관리 구조 제안

**작성일:** 2026-09-02
**배경 커밋:** `3c09365` (feat: add checker alias to issue detection rule term in query normalization)

## 1. 배경

Discord 봇을 포함한 Skald RAG 질의 계층에서 도메인 용어 별칭(예: `체커` → `이슈검출규칙`, `매트릭` → `metric`)을
영구 지식으로 반영하는 작업이 반복될 것으로 예상됨.

현재는 `backend/src/lib/queryNormalization.ts`에 별칭 1개당 다음을 코드로 하드코딩하고 있음:

1. 정규식 상수 (`CHECKER_ALIAS_PATTERN`, `METRIC_ALIAS_PATTERN` 등)
2. `expandTechnicalQueryVariants()` 내부의 `if` 조건 분기 및 전용 variants 로직
3. 전용 유닛 테스트 (`backend/src/__tests__/queryNormalization.test.ts`)

## 2. 현재 구조의 한계

| 항목              | 내용                                                                                                                                                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 용어 추가 비용    | 용어 1개마다 코드 수정 → 테스트 → 빌드 → 배포 전 과정 필요. 도메인 용어는 비개발자/현업 요청으로 자주 늘어나는 경향이 있어 흐름에 부합하지 않음                                                           |
| variant 폭발 비용 | 예: `enterprise + 에러코드` 조건이 쿼리당 11개 이상의 검색 variant 생성. `vectorSearchNode`에서 variant마다 임베딩 1회 + 하이브리드 검색 1회 발생. `uniqueQueries` 중복 제거는 있으나 변형 개수 상한 없음 |
| 전역 적용         | 별칭이 코드에 박혀 모든 프로젝트에 동일 적용됨. Skald는 멀티프로젝트 구조이므로 프로젝트별 용어가 갈리는 순간 이 방식은 사용 불가                                                                         |

**판단:** 별칭이 2~3개 수준이면 현상 유지로 충분. "많이" 발생 예정이라면 데이터 주도 구조로 전환 필요.

## 3. 제안: 단계별 전환

### 1단계 — 데이터 주도 별칭 테이블 (권장, 지금)

- 별칭 정의를 데이터로 분리: `{ alias 패턴 → 표준 용어 (+ 옵션 variants) }` 배열 또는 설정 파일
- `normalizeTechnicalAliases()`는 테이블 순회만 수행
- variant 생성 규칙을 표준어 기반 제네릭 패턴(옵션/종류/목록 등)으로 통일
- 변형 검색 상한(예: 쿼리당 최대 N개 variant) 도입으로 임베딩/검색 비용 통제
- 효과: 용어 추가가 데이터 수정으로 끝남. 동작은 기존과 동일 (원본 쿼리 보존 + 정규화 variant 추가)

### 2단계 — DB 테이블 + 프로젝트 스코프 (필요시)

- 트리거: 용어가 코드 배포 없이 자주 추가되거나 프로젝트별로 갈리기 시작할 때
- 구성: DB 별칭 테이블(프로젝트 스코프) + Redis 캐시(TTL) + 조회 API
- 기반 인프라(Redis, admin API 패턴)가 이미 있어 도입 부담이 크지 않음

### 참고 — LLM 프롬프트 기반 대안

- `queryUnderstandingAgent` / query rewrite 프롬프트에 용어집을 주입해 LLM이 문맥에 맞게 치환
- 장점: 문맥 의존적 별칭(오탈자, 문장 내 변형)에 유연
- 단점: 비결정적, 지연 비용 추가. 결정적 라우팅 경로 선호 프로젝트 컨벤션(`backend/src/agents/AGENTS.md`)과 충돌
- 결론: 알려진 용어는 결정적 치환(정규화 계층)이 우세. LLM 기반은 보조 수단으로만 검토

## 4. 권장 방침

1. 지금은 **1단계**(설정 테이블화 + variant 상한)만 적용
2. 용어가 프로젝트별로 갈리기 시작하면 **2단계**로 확장

## 5. 관련 파일

| 파일                                               | 역할                                                         |
| -------------------------------------------------- | ------------------------------------------------------------ |
| `backend/src/lib/queryNormalization.ts`            | 별칭 정규화 + 질의 variant 확장 (현재 하드코딩)              |
| `backend/src/agents/chatAgent/ragGraph.ts`         | `vectorSearchNode`에서 variant별 임베딩/하이브리드 검색 수행 |
| `backend/src/agents/chatAgent/queryRewrite.ts`     | LLM rewrite 결과에도 동일 확장 적용                          |
| `backend/src/__tests__/queryNormalization.test.ts` | 별칭/variant 유닛 테스트                                     |
