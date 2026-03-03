# EMBEDDING-SERVICE DOMAIN

**Generated:** 2026-03-03
**Domain:** FastAPI 임베딩 마이크로서비스 (Score 12)

## OVERVIEW

`embedding-service`는 단일 진입점(`main.py`) 중심의 경량 Python 서비스입니다. 임베딩/리랭크/청킹 로직이 한 서비스에 집중되어 있습니다.

## WHERE TO LOOK

| Task          | Location              | Notes                         |
| ------------- | --------------------- | ----------------------------- |
| 서비스 진입점 | `main.py`             | FastAPI app + endpoint wiring |
| 청킹 로직     | `semantic_chunker.py` | 의미 기반 분할                |
| 의존성/런타임 | `pyproject.toml`      | Python 3.11+, uv              |
| 컨테이너      | `Dockerfile`          | k8s 배포 이미지               |

## CONVENTIONS (DEVIATIONS ONLY)

- 일반 FastAPI 계층(`routers/`, `services/`) 대신 단일 파일 중심 구조
- 런타임/의존성 관리는 `uv` + `pyproject.toml` 기준
- 포트/헬스체크 계약은 k8s 매니페스트와 함께 유지

## ANTI-PATTERNS

- 임베딩 서비스에 상태 저장(DB/Redis) 결합 금지
- 인증/인가 로직 추가 금지(상위 backend에서 처리)
- 임베딩 파이프라인 우회한 임의 endpoint 추가 금지

## NOTES

- 복잡도 핫스팟은 `main.py` 단일 파일 집중
- 변경 시 `k8s/embedding-service-*.yaml`과 동기 검증 필요

## LLM ENDPOINT POLICY

- 모든 모델 호출(Gemini 포함)은 **코드 하드코딩 금지**이며, 환경변수(`CLI_PROXY_API_BASE_URL`, `GEMINI_API_BASE_URL`)로만 지정합니다.
- `CLI_PROXY_API_BASE_URL`와 `GEMINI_API_BASE_URL`는 동일한 값을 사용해야 합니다.
