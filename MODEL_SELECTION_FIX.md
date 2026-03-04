# Discord Bot 모델 선택 문제 해결

**날짜**: 2026-03-04  
**문제**: Discord 봇 요청이 gpt-5.2 대신 qwen-3.5 사용

---

## 근본 원인

### 코드 경로 분석

1. **Discord Bot → Backend 요청**
    - 파일: `discord-bot/src/handlers/mentionHandler.ts:269-280`
    - 문제: `llm_provider: 'cli-proxy-api'`만 전송, 모델 미지정

2. **Backend 모델 결정 로직**
    - `backend/src/api/chat.ts:34` → rag_config 파싱
    - `backend/src/lib/ragUtils.ts:33` → llmProvider만 추출
    - `backend/src/services/llmService.ts:108-139` → getLLM() 호출
    - `backend/src/llmModels.ts:50-70` → getDefaultLLMModels() 실행

3. **환경변수 기반 모델 선택**
    - `backend/src/settings.ts:106-113`
    - `LLM_DEFAULT_CHAT_MODEL` 미설정 시 빈 문자열
    - `LLM_FALLBACK_CHAIN` 미설정 시 빈 배열

4. **Fallback 체인 동작**
    - `backend/src/services/llmService.ts:246-329` → streamWithFallback()
    - `backend/src/llmModels.ts:9-44` → SUPPORTED_LLM_MODELS 순서 사용
    - 1순위 'step' 시도 → capacity error
    - 2순위 'qwen-3.5'로 자동 fallback

### 왜 qwen-3.5가 선택되었나?

```
환경변수 미설정
  ↓
getDefaultLLMModels()가 SUPPORTED_LLM_MODELS 순서 사용
  ↓
1순위 'step' 모델 시도 → 503 capacity error
  ↓
2순위 'qwen-3.5'로 자동 fallback
```

---

## 적용된 수정사항

### 1. gpt-5.2 모델 추가

**파일**: `backend/src/llmModels.ts:9`

```typescript
export const SUPPORTED_LLM_MODELS = {
    'cli-proxy-api': {
        'gpt-5.2': { slug: 'gpt-5.2', name: 'GPT 5.2' }, // 추가됨
        step: { slug: 'step', name: 'Step' },
        'qwen-3.5': { slug: 'qwen-3.5', name: 'Qwen 3.5' },
        // ...
    },
}
```

### 2. 환경변수 예제 업데이트

**파일**: `.env.example:62-69`

```bash
# LLM Model Configuration (runtime configurable)
# Default model for chat operations
LLM_DEFAULT_CHAT_MODEL=gpt-5.2
# Default model for classification operations
LLM_DEFAULT_CLASSIFICATION_MODEL=gpt-5.2
# Fallback chain: comma-separated model slugs (first = highest priority)
# If primary model fails, system will try next model in chain
LLM_FALLBACK_CHAIN=gpt-5.2,step,qwen-3.5,gemini-2.5-pro
```

---

## 배포 방법

### 방법 1: 환경변수 설정 (권장)

**Backend 환경변수 추가**:

```bash
# .env 또는 k8s ConfigMap
LLM_DEFAULT_CHAT_MODEL=gpt-5.2
LLM_DEFAULT_CLASSIFICATION_MODEL=gpt-5.2
LLM_FALLBACK_CHAIN=gpt-5.2,step,qwen-3.5,gemini-2.5-pro
```

**적용 방법**:

- 로컬: `.env` 파일 생성/수정 후 backend 재시작
- K8s: ConfigMap 업데이트 후 pod 재시작

### 방법 2: Discord 봇에서 모델 명시 (향후 개선)

`discord-bot/src/handlers/mentionHandler.ts:273` 수정:

```typescript
rag_config: {
    llm_provider: 'cli-proxy-api',
    model: 'gpt-5.2',  // 추가 필요
    query_rewrite: { enabled: true },
    // ...
}
```

**주의**: Backend에서 `model` 필드 파싱 로직 추가 필요

---

## 검증 방법

1. **환경변수 확인**:

```bash
echo $LLM_DEFAULT_CHAT_MODEL
echo $LLM_FALLBACK_CHAIN
```

2. **Backend 로그 확인**:

```bash
# 모델 선택 로그 확인
kubectl logs -f deployment/backend | grep "Attempting to stream LLM with model"
```

3. **Discord 봇 테스트**:

- Discord에서 봇 멘션 후 질문
- Backend 로그에서 "gpt-5.2" 사용 확인

---

## 참고사항

### 모델 우선순위 변경

`backend/src/llmModels.ts`의 순서가 fallback 우선순위를 결정합니다.
환경변수 미설정 시 이 순서를 따릅니다.

### Capacity Error 처리

`backend/src/services/llmService.ts:286-291`에서 503/capacity error 감지 시 즉시 다음 모델로 fallback합니다.

### Hot Reload

`LLMService.reloadConfig()` 호출 시 환경변수 재로드 가능 (재시작 불필요).
