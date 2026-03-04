# Discord Bot "An error occurred" 실패 추적 분석

**생성일**: 2026-03-04  
**대상 에러**: Discord 한국어 쿼리 시 `❌ Error: An error occurred` 반환  
**분석 범위**: discord-bot → backend → embedding-service 전체 체인

---

## 🎯 핵심 문제점

**프로덕션 환경에서 모든 예외가 "An error occurred"로 마스킹되어 실제 원인 파악 불가**

---

## 📊 End-to-End 에러 전파 경로

### 1단계: Backend API - 에러 발생 및 마스킹

**파일**: `backend/src/api/chat.ts`  
**함수**: `_generateStreamingResponse`

#### 🔴 Critical Line: 436

```typescript
const errorMsg = IS_DEVELOPMENT && error instanceof Error ? `${error.message}\n${error.stack}` : 'An error occurred' // ← 프로덕션에서 모든 에러 마스킹
```

**문제**:

- `IS_DEVELOPMENT=false` (프로덕션)에서 에러 타입/메시지 완전 손실
- 로그는 line 431-434에 기록되지만 사용자에게는 전달 안 됨

#### SSE 스트림 전송: Line 437-438

```typescript
const errorData = JSON.stringify({ type: 'error', content: errorMsg })
res.write(`data: ${errorData}\n\n`)
```

---

### 2단계: Discord Bot - 에러 수신

**파일**: `discord-bot/src/handlers/mentionHandler.ts`

#### Line 296-298: SSE 이벤트 처리

```typescript
case 'error':
    await editor.showError(event.content)  // ← 'An error occurred' 받음
    return
```

---

### 3단계: Discord 메시지 표시

**파일**: `discord-bot/src/discord/DiscordStreamEditor.ts`

#### Line 184: 최종 사용자 메시지

```typescript
const errorMessage = `❌ Error: ${error.slice(0, 1800)}`
// 출력: "❌ Error: An error occurred"
```

---

## 🔍 Upstream 에러 원인 후보

### A. Backend RAG Graph 실행 실패

**파일**: `backend/src/api/chat.ts`  
**Line**: 395-402

```typescript
const ragResultState = await ragGraph.invoke({
    query,
    project,
    chatId,
    filters,
    clientSystemPrompt,
    ragConfig,
})
```

**가능한 실패 지점**:

1. Vector search 타임아웃
2. Reranking 서비스 응답 없음
3. LLM 호출 실패 (capacity/rate limit)
4. Embedding 생성 실패

---

### B. Embedding Service 에러 (가장 의심)

**파일**: `embedding-service/main.py`

#### 🔴 High Priority 에러 포인트

| Line        | 함수                     | 에러 타입     | HTTP Status | 설명                                 |
| ----------- | ------------------------ | ------------- | ----------- | ------------------------------------ |
| **406-411** | `get_ollama_embedding`   | HTTPException | 502         | Ollama API 연결 실패                 |
| **461-469** | `get_external_embedding` | HTTPException | 502         | External embedding API 에러          |
| **528**     | `get_gemini_embedding`   | HTTPException | 503         | Gemini cooldown (dimension error 후) |
| **560-566** | `get_gemini_embedding`   | HTTPException | 503         | Gemini dimension mismatch            |
| **589-591** | `get_gemini_embedding`   | HTTPException | 429         | Gemini rate limit 전체 키 소진       |
| **1052**    | `rerank`                 | HTTPException | 500         | Reranking 실패                       |

#### 상세 에러 시나리오

**1. Ollama Embedding 실패 (Line 406-411)**

```python
except httpx.HTTPStatusError as e:
    logger.error(f"Ollama API error: {e.response.status_code} - {e.response.text}")
    raise HTTPException(status_code=502, detail=f"Ollama API error: {str(e)}")
```

- **원인**: Ollama 서비스 다운/응답 없음
- **전파**: Backend → 502 에러 → "An error occurred"

**2. Gemini Cooldown (Line 528)**

```python
if is_cooldown:
    error_msg = f"Embedding service in cooldown due to dimension error. Retry after {remaining_minutes:.1f} minutes."
    raise HTTPException(status_code=503, detail=error_msg)
```

- **원인**: 이전 dimension error로 1시간 cooldown 활성화
- **전파**: Backend → 503 에러 → "An error occurred"

**3. Reranking 실패 (Line 1052)**

```python
except Exception as e:
    logger.error(f"Rerank failed after {total_time:.6f}s: {str(e)}")
    raise HTTPException(status_code=500, detail=f"Reranking failed: {str(e)}")
```

- **원인**: CrossEncoder/Ollama rerank 타임아웃
- **전파**: Backend → 500 에러 → "An error occurred"

---

### C. Backend Service Layer 에러

**파일**: `backend/src/services/embeddingService.ts`

#### Line 52: Internal Embedding 에러

```typescript
throw new Error(`Internal embedding service error: ${response.status} - ${errorText}`)
```

**파일**: `backend/src/services/rerankService.ts`

#### Line 51: Internal Rerank 에러

```typescript
throw new Error(`Internal rerank service error: ${response.status} - ${errorText}`)
```

**파일**: `backend/src/services/llmService.ts`

#### Line 328: LLM Fallback Chain 소진

```typescript
throw new Error(`All LLM models failed for streaming. Last error: ${lastError?.message}`)
```

---

## 🛠️ HTTP 상태 코드 매핑

| HTTP Status | 발생 위치         | 의미                          | Backend 처리                |
| ----------- | ----------------- | ----------------------------- | --------------------------- |
| **502**     | embedding-service | Ollama/External API 연결 실패 | catch → "An error occurred" |
| **503**     | embedding-service | Gemini cooldown/서비스 불가   | catch → "An error occurred" |
| **429**     | embedding-service | Gemini rate limit 전체 소진   | catch → "An error occurred" |
| **500**     | embedding-service | Reranking 일반 실패           | catch → "An error occurred" |
| **504**     | backend           | Embedding/Rerank 타임아웃     | catch → "An error occurred" |

---

## 📋 즉시 패치 방안

### Option 1: 에러 메시지 개선 (권장)

**파일**: `backend/src/api/chat.ts:436`

```typescript
// 변경 전
const errorMsg = IS_DEVELOPMENT && error instanceof Error ? `${error.message}\n${error.stack}` : 'An error occurred'

// 변경 후
const errorMsg =
    IS_DEVELOPMENT && error instanceof Error
        ? `${error.message}\n${error.stack}`
        : error instanceof Error
          ? `처리 중 오류: ${error.message.slice(0, 100)}`
          : 'An error occurred'
```

**효과**: 프로덕션에서도 에러 메시지 일부 노출

---

### Option 2: Embedding Service 에러 타입 구분

**파일**: `embedding-service/main.py:1052`

```python
# 현재
raise HTTPException(status_code=500, detail=f"Reranking failed: {str(e)}")

# 개선
if "timeout" in str(e).lower():
    raise HTTPException(status_code=504, detail="Reranking timeout")
elif "connection" in str(e).lower():
    raise HTTPException(status_code=503, detail="Reranking service unavailable")
else:
    raise HTTPException(status_code=500, detail=f"Reranking failed: {str(e)[:100]}")
```

---

### Option 3: Backend 에러 핸들링 강화

**파일**: `backend/src/api/chat.ts:429-438`

```typescript
} catch (error) {
    Sentry.captureException(error)
    logger.error(
        { err: error, llmProvider: parsedRagConfig?.llmProvider, errorMessage: (error as Error)?.message },
        'Streaming chat agent error'
    )

    // 에러 타입별 사용자 친화적 메시지
    let userMessage = 'An error occurred'
    if (error instanceof Error) {
        if (error.message.includes('timeout')) {
            userMessage = '요청 처리 시간이 초과되었습니다. 잠시 후 다시 시도해주세요.'
        } else if (error.message.includes('503') || error.message.includes('unavailable')) {
            userMessage = '일시적으로 서비스를 사용할 수 없습니다. 잠시 후 다시 시도해주세요.'
        } else if (error.message.includes('429') || error.message.includes('rate limit')) {
            userMessage = 'API 사용량 한도에 도달했습니다. 잠시 후 다시 시도해주세요.'
        } else if (!IS_DEVELOPMENT) {
            userMessage = `처리 중 오류: ${error.message.slice(0, 80)}`
        }
    }

    const errorData = JSON.stringify({ type: 'error', content: userMessage })
    res.write(`data: ${errorData}\n\n`)
}
```

---

## 🎯 디버깅 체크리스트

```bash
# 1. Backend 로그 확인 (실제 에러 메시지)
kubectl logs -n skald deployment/backend --tail=100 | grep -i "streaming chat agent error"

# 2. Embedding service 로그 확인
kubectl logs -n skald deployment/embedding-service --tail=100 | grep -E "(error|failed|timeout)"

# 3. Embedding service 헬스체크
kubectl exec -n skald deployment/backend -- curl http://embedding-service:8889/health

# 4. Rerank service 헬스체크
kubectl exec -n skald deployment/backend -- curl http://embedding-service:8889/rerank -X POST \
  -H "Content-Type: application/json" \
  -d '{"query":"test","documents":["doc1"]}'

# 5. 한국어 쿼리 직접 테스트
kubectl exec -n skald deployment/backend -- curl http://localhost:3000/api/v1/chat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"query":"배포 플랫폼","stream":true}'
```

---

## 📌 최종 의심 파일 + 라인 요약

| 우선순위   | 파일                                       | 라인    | 역할                | 조치                |
| ---------- | ------------------------------------------ | ------- | ------------------- | ------------------- |
| ⭐⭐⭐⭐⭐ | `backend/src/api/chat.ts`                  | 436     | 에러 메시지 마스킹  | **즉시 수정 필요**  |
| ⭐⭐⭐⭐   | `backend/src/api/chat.ts`                  | 395-402 | RAG graph 호출      | 로그 확인           |
| ⭐⭐⭐⭐   | `embedding-service/main.py`                | 1052    | Reranking 실패      | 에러 타입 구분 추가 |
| ⭐⭐⭐⭐   | `embedding-service/main.py`                | 528     | Gemini cooldown     | 상태 확인           |
| ⭐⭐⭐     | `embedding-service/main.py`                | 589-591 | Gemini rate limit   | API 키 상태 확인    |
| ⭐⭐⭐     | `backend/src/services/embeddingService.ts` | 52      | Embedding 에러 전파 | 로그 확인           |
| ⭐⭐⭐     | `backend/src/services/rerankService.ts`    | 51      | Rerank 에러 전파    | 로그 확인           |

---

## 🚀 권장 조치 순서

1. **즉시**: `backend/src/api/chat.ts:436` 수정하여 에러 메시지 노출
2. **단기**: Backend 로그 확인하여 실제 에러 원인 파악
3. **중기**: Embedding service 에러 타입별 구분 개선
4. **장기**: 전체 에러 핸들링 표준화 및 모니터링 강화

---

## 📝 참고사항

- 모든 에러는 Sentry에 캡처되므로 Sentry 대시보드 확인 권장
- Backend logger는 structured logging 사용 (JSON 형식)
- Embedding service는 Python logging 사용 (text 형식)
- K8s 환경에서는 `kubectl logs` 명령으로 실시간 로그 확인 가능
