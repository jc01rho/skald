# Embedding Service ConfigMap 키 불일치 수정 보고서

**날짜**: 2026-03-04  
**이슈**: embedding-service pod가 `CreateContainerConfigError`로 시작 실패  
**근본 원인**: ConfigMap에 필수 키 누락

---

## 1. 문제 분석

### 실제 에러 메시지

```
couldn't find key RERANK_PROVIDER in ConfigMap skald/skald-config
```

### 초기 보고된 문제

- 사용자 보고: `EMBEDDING_SERVICE_PROVIDER` 키 누락
- **실제 문제**: `EMBEDDING_SERVICE_PROVIDER`는 코드베이스에 존재하지 않음
- **정규 키**: `EMBEDDING_PROVIDER` (56개 참조, 14개 파일)

---

## 2. 전체 저장소 검색 결과

### EMBEDDING_SERVICE_PROVIDER

- **검색 결과**: 0건
- **결론**: 존재하지 않는 키 (오해)

### EMBEDDING_PROVIDER

- **검색 결과**: 56건 (14개 파일)
- **역할**: 임베딩 제공자 선택 (openai/voyage/internal/local)

**주요 참조 위치**:

| 파일                                    | 라인    | 역할                          |
| --------------------------------------- | ------- | ----------------------------- |
| `embedding-service/main.py`             | 43-44   | **CONSUMER** - 환경변수 읽기  |
| `backend/src/settings.ts`               | 188     | **CONSUMER** - 환경변수 읽기  |
| `k8s/embedding-service-deployment.yaml` | 66-70   | **CONSUMER** - ConfigMap 참조 |
| `k8s/api-deployment.yaml`               | 256-260 | **CONSUMER** - ConfigMap 참조 |
| `k8s/memo-processing-deployment.yaml`   | 207-211 | **CONSUMER** - ConfigMap 참조 |
| `k8s/configmap.yaml`                    | 42      | **PRODUCER** - 값 정의        |
| `k8s/deploy.sh`                         | 105     | **PRODUCER** - 값 정의        |

---

## 3. 발견된 누락 키

ConfigMap에서 누락되었지만 deployment에서 참조하는 키들:

| 키                       | 참조 위치                                 | optional | 기본값 | 상태            |
| ------------------------ | ----------------------------------------- | -------- | ------ | --------------- |
| `RERANK_PROVIDER`        | embedding-service-deployment.yaml:81-85   | ❌ false | ollama | **누락** ❌     |
| `LOG_LEVEL`              | embedding-service-deployment.yaml:104-108 | ❌ false | info   | **누락** ❌     |
| `QUERY_LANGUAGE`         | embedding-service-deployment.yaml:97-102  | ✅ true  | ko     | 누락 (optional) |
| `EXTERNAL_EMBEDDING_URL` | embedding-service-deployment.yaml:87-92   | ✅ true  | -      | 누락 (optional) |

---

## 4. 적용된 수정

### 4.1. k8s/configmap.yaml

**추가된 라인 (56-74)**:

```yaml
# Local Embedding Configuration
LOCAL_EMBEDDING_MODEL: 'all-MiniLM-L6-v2'
LOCAL_RERANK_MODEL: 'cross-encoder/ms-marco-MiniLM-L-6-v2'
TARGET_DIMENSION: '2048'

# Reranking Configuration
RERANK_PROVIDER: 'ollama'

# Logging Configuration
LOG_LEVEL: 'info'

# Query Language (optional)
QUERY_LANGUAGE: 'ko'

# External Embedding URL (optional)
EXTERNAL_EMBEDDING_URL: 'http://192.168.150.37:8889/embeddings'

# Internal Rerank URL (optional)
INTERNAL_RERANK_URL: 'http://192.168.150.37:8889/v1/rerank'
```

### 4.2. k8s/deploy.sh

**추가된 라인 (125-143)**:

```bash
  # Local Embedding Configuration (optional)
  LOCAL_EMBEDDING_MODEL: "${LOCAL_EMBEDDING_MODEL:-all-MiniLM-L6-v2}"
  LOCAL_RERANK_MODEL: "${LOCAL_RERANK_MODEL:-cross-encoder/ms-marco-MiniLM-L-6-v2}"
  TARGET_DIMENSION: "2048"

  # Reranking Configuration
  RERANK_PROVIDER: "${RERANK_PROVIDER:-ollama}"

  # Logging Configuration
  LOG_LEVEL: "${LOG_LEVEL:-info}"

  # Query Language (optional)
  QUERY_LANGUAGE: "${QUERY_LANGUAGE:-ko}"

  # External Embedding URL (optional)
  EXTERNAL_EMBEDDING_URL: "${EXTERNAL_EMBEDDING_URL:-http://192.168.150.37:8889/embeddings}"

  # Internal Rerank URL (optional)
  INTERNAL_RERANK_URL: "${INTERNAL_RERANK_URL:-http://192.168.150.37:8889/v1/rerank}"
```

---

## 5. 배포 절차

### 5.1. ConfigMap 업데이트

```bash
kubectl apply -f k8s/configmap.yaml
```

### 5.2. embedding-service 재시작

```bash
kubectl rollout restart deployment/embedding-service -n skald
```

### 5.3. 상태 확인

```bash
# Pod 상태 확인
kubectl get pods -n skald -l component=embedding-service

# 로그 확인
kubectl logs -f -n skald -l component=embedding-service

# ConfigMap 확인
kubectl get configmap skald-config -n skald -o yaml | grep -E "RERANK_PROVIDER|LOG_LEVEL"
```

---

## 6. 검증 체크리스트

- [x] YAML 문법 검증 (`kubectl apply --dry-run=client`)
- [x] Shell 스크립트 문법 검증 (`bash -n`)
- [ ] ConfigMap 적용 확인
- [ ] embedding-service pod 정상 시작 확인
- [ ] 헬스체크 엔드포인트 응답 확인 (`/health`)

---

## 7. 추가 권장 사항

### 7.1. 다른 deployment 검증

다음 deployment들도 동일한 패턴으로 ConfigMap 키를 참조하므로 검증 필요:

- `api-deployment.yaml`
- `memo-processing-deployment.yaml`

### 7.2. 환경변수 일관성 검증

```bash
# 모든 deployment에서 참조하는 ConfigMap 키 추출
grep -r "configMapKeyRef" k8s/*-deployment.yaml | \
  grep -oP "key: \K[A-Z_]+" | sort -u > /tmp/required_keys.txt

# ConfigMap에 정의된 키 추출
kubectl get configmap skald-config -n skald -o yaml | \
  grep -oP "^\s+\K[A-Z_]+(?=:)" | sort -u > /tmp/defined_keys.txt

# 차이 확인
comm -23 /tmp/required_keys.txt /tmp/defined_keys.txt
```

### 7.3. CI/CD 파이프라인 개선

- ConfigMap 키 검증 단계 추가
- Deployment와 ConfigMap 간 키 일치성 자동 검증

---

## 8. 참고 자료

- **Kubernetes ConfigMap 문서**: https://kubernetes.io/docs/concepts/configuration/configmap/
- **관련 이슈**: embedding-service pod CreateContainerConfigError
- **수정 커밋**: (커밋 후 해시 추가)

---

**작성자**: Kiro AI Assistant  
**검토자**: (검토 후 추가)
