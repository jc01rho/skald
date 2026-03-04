# Groq 제거 종합 리포트

**생성일**: 2026-03-04  
**목적**: Kubernetes secret key `GROQ_API_KEYS` 누락으로 인한 배포/런타임 오류 해결  
**범위**: 전체 레포지토리의 Groq 관련 코드/설정 참조 완전 제거

---

## 📊 요약 통계

| 분류       | 파일 수 | 총 참조 라인 수 | 우선순위  |
| ---------- | ------- | --------------- | --------- |
| **CODE**   | 8       | ~1,500+         | 🔴 HIGH   |
| **CONFIG** | 5       | 15              | 🔴 HIGH   |
| **DOCS**   | 4       | 30+             | 🟡 MEDIUM |
| **TEST**   | 1       | 1               | 🟢 LOW    |

**총 영향 파일**: 18개  
**핵심 제거 대상**: `embedding-service/main.py` (1,500+ 라인 영향)

---

## 🎯 제거 우선순위 및 실행 계획

### Phase 1: 🔴 CRITICAL (배포 차단 해결)

#### 1.1 Kubernetes 배포 설정

```yaml
# k8s/embedding-service-deployment.yaml
Lines 64-68: GROQ_API_KEYS secretKeyRef 제거
Lines 157-162: GROQ_RPM_LIMIT configMapKeyRef 제거

# k8s/api-deployment.yaml
Lines 303-308: GROQ_API_KEY secretKeyRef 제거 (optional: true)

# k8s/memo-processing-deployment.yaml
Lines 242-247: GROQ_API_KEY secretKeyRef 제거 (optional: true)

# k8s/secret.yaml
Lines 46-47: GROQ_API_KEY 항목 제거
Line 73: 주석에서 'groq' 제거
```

#### 1.2 Python 임베딩 서비스 (핵심)

```python
# embedding-service/main.py
Line 10: from groq import Groq, AsyncGroq 제거
Lines 52-53: GROQ_API_KEYS 환경변수 파싱 제거
Lines 96-156: class GroqKeyManager 전체 제거
Lines 237-244: _get_groq_rpm_limit() 함수 제거
Lines 253-317: class SimpleRPMThrottler 제거
Lines 365-375: groq_key_manager 초기화 로직 제거
Lines 1263-1312: /api-keys/validate 엔드포인트 제거
Lines 1346-1361: /api-keys/status 엔드포인트 제거
Line 1370: rpm_throttler 초기화 제거
Lines 1374-1407: GROQ_MODEL_FALLBACKS 딕셔너리 제거
Lines 1580-1627: _stream_groq_response() 함수 제거
Lines 2052-2209: Groq 폴백 로직 제거 (chat_completions 함수 내)
Lines 2213-2248: /groq/status, /groq/health 엔드포인트 제거

# embedding-service/pyproject.toml
Line 13: "groq>=0.13.0" 의존성 제거
```

### Phase 2: 🟡 MEDIUM (타입 안전성 및 호환성)

#### 2.1 백엔드 TypeScript

```typescript
// backend/src/memoProcessingServer/processMemo.ts
Line 82: 배열에서 'groq' 제거
// 변경 전: ['openai', 'anthropic', 'gemini', 'local', 'groq']
// 변경 후: ['openai', 'anthropic', 'gemini', 'local']

// backend/src/__tests__/jest.setup.ts
Line 6: Groq 테스트 설정 제거
// { provider: 'groq', label: 'Groq', model: 'llama-3.1-8b-instant' }
```

#### 2.2 프론트엔드 TypeScript

```typescript
// frontend/src/stores/projectStore.ts
Line 10: 타입에서 'groq' 제거
// 변경 전: 'openai' | 'anthropic' | 'local' | 'groq' | 'gemini'
// 변경 후: 'openai' | 'anthropic' | 'local' | 'gemini'

// frontend/src/components/Project/ChatUiConfig.tsx
Line 14: 동일한 타입 수정

// ee/src/api/publicChat.ts
Line 124: 동일한 타입 수정
```

#### 2.3 Docker Compose

```yaml
# docker-compose.selfhosted.yml
Lines 81, 137: GROQ_API_KEY 환경변수 제거
```

#### 2.4 환경변수 예제

```bash
# .env.example
Line 42: 주석에서 'groq' 제거
Lines 57-59: Groq 섹션 전체 제거
```

### Phase 3: 🟢 LOW (문서 및 참조)

#### 3.1 문서 업데이트

```markdown
# docs/LLM_PROVIDER_FALLBACK_CHAIN.md

Lines 231, 234, 243, 245, 250-296, 359, 382, 429, 474, 482, 521-522, 544, 68
→ Groq 관련 섹션 및 다이어그램 제거/수정

# k8s/llm-provider-api.md

Lines 14, 185-228, 227-228, 280, 282, 297, 309, 315, 1080, 1091, 1202-1204
→ Groq 설정 가이드 제거

# k8s/DOCKER-COMPOSE-PARITY.md

Lines 55-70, 137, 199
→ Groq API 키 추가 관련 내용 제거

# RETRY_FALLBACK_IMPLEMENTATION.md

Line 63: provider 목록에서 'groq' 제거
```

#### 3.2 워커 참조 코드

```python
# worker/reference/similar_issue_rag.py
Line 31: "llm_provider": "groq" 예제 제거 또는 주석 처리
```

---

## 📋 파일별 상세 맵

### 🔴 CODE PATH (실제 실행 코드)

#### `embedding-service/main.py` (Python) - **핵심 제거 대상**

| 라인 범위 | 내용                                      | 타입           |
| --------- | ----------------------------------------- | -------------- |
| 10        | `from groq import Groq, AsyncGroq`        | import         |
| 52-53     | `GROQ_API_KEYS_STR`, `GROQ_API_KEYS` 파싱 | 환경변수       |
| 96-156    | `class GroqKeyManager`                    | 클래스 정의    |
| 237-244   | `_get_groq_rpm_limit()`                   | 함수           |
| 253-317   | `class SimpleRPMThrottler`                | 클래스 정의    |
| 365-375   | `groq_key_manager` 초기화                 | 전역 변수      |
| 1263-1312 | `/api-keys/validate`                      | API 엔드포인트 |
| 1346-1361 | `/api-keys/status`                        | API 엔드포인트 |
| 1370      | `rpm_throttler` 초기화                    | 전역 변수      |
| 1374-1407 | `GROQ_MODEL_FALLBACKS`                    | 딕셔너리       |
| 1580-1627 | `_stream_groq_response()`                 | 함수           |
| 2052-2209 | Groq 폴백 로직                            | 함수 내부 로직 |
| 2213-2248 | `/groq/status`, `/groq/health`            | API 엔드포인트 |

#### `backend/src/memoProcessingServer/processMemo.ts` (TypeScript)

| 라인 | 내용                            | 타입   |
| ---- | ------------------------------- | ------ |
| 82   | LLM_PROVIDER 배열에 'groq' 포함 | 조건문 |

#### `backend/src/__tests__/jest.setup.ts` (TypeScript)

| 라인 | 내용                  | 타입          |
| ---- | --------------------- | ------------- |
| 6    | Groq 테스트 설정 객체 | 테스트 데이터 |

#### `frontend/src/stores/projectStore.ts` (TypeScript)

| 라인 | 내용                           | 타입      |
| ---- | ------------------------------ | --------- |
| 10   | llmProvider 타입 정의에 'groq' | 타입 정의 |

#### `frontend/src/components/Project/ChatUiConfig.tsx` (TypeScript)

| 라인 | 내용                           | 타입      |
| ---- | ------------------------------ | --------- |
| 14   | llmProvider 타입 정의에 'groq' | 타입 정의 |

#### `ee/src/api/publicChat.ts` (TypeScript)

| 라인 | 내용                           | 타입      |
| ---- | ------------------------------ | --------- |
| 124  | llmProvider 타입 정의에 'groq' | 타입 정의 |

#### `worker/reference/similar_issue_rag.py` (Python)

| 라인 | 내용                     | 타입      |
| ---- | ------------------------ | --------- |
| 31   | `"llm_provider": "groq"` | 참조 예제 |

#### `backend/dist/*` (JavaScript - 빌드 결과물)

- `backend/dist/__tests__/jest.setup.js:7`
- `backend/dist/memoProcessingServer/processMemo.js:59`

---

### ⚙️ CONFIG (환경변수 및 배포 설정)

#### `k8s/embedding-service-deployment.yaml`

| 라인 범위 | 내용                             | 타입     |
| --------- | -------------------------------- | -------- |
| 64-68     | `GROQ_API_KEYS` secretKeyRef     | 환경변수 |
| 157-162   | `GROQ_RPM_LIMIT` configMapKeyRef | 환경변수 |

#### `k8s/secret.yaml`

| 라인  | 내용                             | 타입          |
| ----- | -------------------------------- | ------------- |
| 46-47 | `GROQ_API_KEY` base64 값 및 주석 | Secret 데이터 |
| 73    | LLM_PROVIDER 주석에 'groq' 언급  | 주석          |

#### `k8s/api-deployment.yaml`

| 라인 범위 | 내용                                   | 타입     |
| --------- | -------------------------------------- | -------- |
| 303-308   | `GROQ_API_KEY` secretKeyRef (optional) | 환경변수 |

#### `k8s/memo-processing-deployment.yaml`

| 라인 범위 | 내용                                   | 타입     |
| --------- | -------------------------------------- | -------- |
| 242-247   | `GROQ_API_KEY` secretKeyRef (optional) | 환경변수 |

#### `docker-compose.selfhosted.yml`

| 라인    | 내용                             | 타입     |
| ------- | -------------------------------- | -------- |
| 81, 137 | `GROQ_API_KEY=${GROQ_API_KEY:-}` | 환경변수 |

#### `.env.example`

| 라인  | 내용                                 | 타입          |
| ----- | ------------------------------------ | ------------- |
| 42    | provider 목록 주석에 'groq'          | 주석          |
| 57-59 | Groq 섹션 (GROQ_API_KEY, GROQ_MODEL) | 환경변수 예제 |

#### `embedding-service/pyproject.toml`

| 라인 | 내용             | 타입          |
| ---- | ---------------- | ------------- |
| 13   | `"groq>=0.13.0"` | Python 의존성 |

---

### 📚 DOCS (문서 및 가이드)

#### `docs/LLM_PROVIDER_FALLBACK_CHAIN.md`

| 라인                    | 내용                             | 타입       |
| ----------------------- | -------------------------------- | ---------- |
| 68                      | 다이어그램에 Groq 표시           | 다이어그램 |
| 231, 234, 243, 245      | Groq 폴백 체인 설명              | 설명       |
| 250-296                 | "6. Groq (Fallback 5)" 전체 섹션 | 섹션       |
| 359, 382, 429, 474, 482 | Groq 관련 설명                   | 설명       |
| 521-522                 | Groq 환경변수 예제               | 예제       |
| 544                     | Groq 복잡도 언급                 | 설명       |

#### `k8s/llm-provider-api.md`

| 라인          | 내용               | 타입   |
| ------------- | ------------------ | ------ |
| 14            | 목차에 Groq        | 목차   |
| 185-228       | Groq 섹션 전체     | 섹션   |
| 227-228       | Groq 모델 테이블   | 테이블 |
| 280, 282, 297 | Groq 코드 예제     | 코드   |
| 309, 315      | Groq 설명          | 설명   |
| 1080, 1091    | Groq 폴백 언급     | 설명   |
| 1202-1204     | Groq 환경변수 예제 | 예제   |

#### `k8s/DOCKER-COMPOSE-PARITY.md`

| 라인     | 내용                  | 타입       |
| -------- | --------------------- | ---------- |
| 55-70    | Groq API 키 추가 이슈 | 이슈 설명  |
| 137, 199 | Groq 환경변수 언급    | 체크리스트 |

#### `RETRY_FALLBACK_IMPLEMENTATION.md`

| 라인 | 내용                   | 타입 |
| ---- | ---------------------- | ---- |
| 63   | provider 목록에 'groq' | 목록 |

---

### 🧪 TEST (테스트 코드)

#### `backend/src/__tests__/jest.setup.ts`

| 라인 | 내용                                                                 | 타입          |
| ---- | -------------------------------------------------------------------- | ------------- |
| 6    | `{ provider: 'groq', label: 'Groq', model: 'llama-3.1-8b-instant' }` | 테스트 데이터 |

---

## 🔧 제거 작업 체크리스트

### Phase 1: Kubernetes 배포 수정 (배포 차단 해결)

- [ ] `k8s/embedding-service-deployment.yaml` - GROQ_API_KEYS, GROQ_RPM_LIMIT 제거
- [ ] `k8s/api-deployment.yaml` - GROQ_API_KEY 제거
- [ ] `k8s/memo-processing-deployment.yaml` - GROQ_API_KEY 제거
- [ ] `k8s/secret.yaml` - GROQ_API_KEY 항목 제거

### Phase 2: 코어 서비스 수정

- [ ] `embedding-service/main.py` - Groq 관련 코드 전체 제거 (1,500+ 라인)
- [ ] `embedding-service/pyproject.toml` - groq 의존성 제거
- [ ] `backend/src/memoProcessingServer/processMemo.ts` - 'groq' 제거
- [ ] `backend/src/__tests__/jest.setup.ts` - Groq 테스트 설정 제거

### Phase 3: 프론트엔드 타입 수정

- [ ] `frontend/src/stores/projectStore.ts` - 타입에서 'groq' 제거
- [ ] `frontend/src/components/Project/ChatUiConfig.tsx` - 타입에서 'groq' 제거
- [ ] `ee/src/api/publicChat.ts` - 타입에서 'groq' 제거

### Phase 4: 설정 파일 정리

- [ ] `docker-compose.selfhosted.yml` - GROQ_API_KEY 제거
- [ ] `.env.example` - Groq 섹션 제거

### Phase 5: 문서 업데이트

- [ ] `docs/LLM_PROVIDER_FALLBACK_CHAIN.md` - Groq 섹션 제거
- [ ] `k8s/llm-provider-api.md` - Groq 가이드 제거
- [ ] `k8s/DOCKER-COMPOSE-PARITY.md` - Groq 관련 내용 제거
- [ ] `RETRY_FALLBACK_IMPLEMENTATION.md` - 'groq' 제거
- [ ] `worker/reference/similar_issue_rag.py` - 예제 수정

### Phase 6: 빌드 및 검증

- [ ] `backend/dist/` 재빌드 (TypeScript 변경사항 반영)
- [ ] `pnpm-lock.yaml` 업데이트 (groq 패키지 제거 확인)
- [ ] Kubernetes 배포 테스트
- [ ] 임베딩 서비스 헬스체크 확인

---

## ⚠️ 주의사항

### 1. 임베딩 서비스 폴백 체인 재설계 필요

`embedding-service/main.py`의 `chat_completions` 함수에서 Groq는 **Fallback 7**로 사용되고 있습니다. 제거 후 폴백 체인을 다음과 같이 재구성해야 합니다:

**현재 체인**:

1. SiliconFlow
2. CLI Proxy
3. OpenRouter
4. Groq ← **제거 대상**
5. Local LLM

**제거 후 체인**:

1. SiliconFlow
2. CLI Proxy
3. OpenRouter
4. Local LLM (직접 폴백)

### 2. RPM 스로틀링 로직 영향

`SimpleRPMThrottler` 클래스는 Groq 전용으로 설계되었습니다. 제거 시 다른 provider에 대한 rate limiting이 필요한지 검토해야 합니다.

### 3. API 엔드포인트 제거 영향

다음 엔드포인트가 제거됩니다:

- `GET /groq/status`
- `GET /groq/health`
- `POST /api-keys/validate`
- `GET /api-keys/status`

외부에서 이 엔드포인트를 호출하는 클라이언트가 있는지 확인 필요합니다.

### 4. 타입 안전성

프론트엔드와 백엔드의 `llmProvider` 타입에서 'groq'를 제거하면, 기존에 'groq'로 설정된 프로젝트가 있을 경우 마이그레이션이 필요할 수 있습니다.

---

## 🚀 실행 순서 권장사항

1. **Phase 1 먼저 실행** → Kubernetes 배포 차단 즉시 해결
2. **Phase 2 실행** → 코어 서비스 안정화
3. **Phase 3-5 순차 실행** → 타입 안전성 및 문서 정리
4. **Phase 6 검증** → 전체 시스템 테스트

---

## 📝 완료 후 확인사항

- [ ] Kubernetes 배포 성공 (embedding-service pod 정상 기동)
- [ ] `/health` 엔드포인트 응답 정상
- [ ] 임베딩 생성 API 정상 동작
- [ ] 채팅 API 정상 동작 (폴백 체인 검증)
- [ ] 프론트엔드 빌드 오류 없음
- [ ] 백엔드 테스트 통과
- [ ] TypeScript 타입 체크 통과

---

**생성 완료**: 2026-03-04 03:13:52 KST  
**다음 단계**: Phase 1 Kubernetes 설정 수정부터 시작
