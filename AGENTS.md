# PROJECT KNOWLEDGE BASE

**Generated:** 2026-03-03
**Commit:** 761d941
**Branch:** main

## OVERVIEW

Skald는 프로덕션 RAG 플랫폼입니다. 루트는 React/Vite 프론트엔드이고, `backend/`(TS API), `worker/`(Python 수집기), `embedding-service/`(Python 임베딩), `k8s/`(배포)로 분리된 **inverted monorepo** 구조입니다.

## STRUCTURE

```text
skald/
├── backend/                # Express + MikroORM + LangGraph
│   └── src/
│       ├── api/            # REST endpoints
│       ├── agents/         # RAG agents (chatAgent/ragGraph.ts)
│       ├── entities/       # DB models
│       ├── lib/            # shared infra utils
│       └── services/       # LLM/embedding/rerank/billing
├── frontend/
│   └── src/                # React app source (root package is frontend)
├── worker/
│   └── src/skald_worker/   # FastAPI collector worker
├── embedding-service/      # FastAPI embedding microservice
├── discord-bot/            # Discord integration
├── k8s/                    # Kubernetes manifests + deploy.sh
└── ee/                     # Enterprise-only extensions (separate license)
```

## WHERE TO LOOK

| Task             | Location                                   | Notes                              |
| ---------------- | ------------------------------------------ | ---------------------------------- |
| API 엔드포인트   | `backend/src/api/*.ts`                     | 미들웨어 배열 + zod 검증 패턴      |
| RAG 파이프라인   | `backend/src/agents/chatAgent/ragGraph.ts` | 핵심 검색/리랭크/스트리밍 플로우   |
| LLM 호출         | `backend/src/services/llmService.ts`       | 공급자 직접 호출 금지, 여기만 사용 |
| 공용 인프라 유틸 | `backend/src/lib/`                         | logger/redis/postgres/DI           |
| 프론트 상태      | `frontend/src/stores/*.ts`                 | 공유 상태는 Zustand                |
| 프론트 API 호출  | `frontend/src/lib/api.ts`                  | 컴포넌트 direct fetch/axios 금지   |
| 워커 수집기      | `worker/src/skald_worker/collectors/`      | Jira/docs ingest                   |
| 임베딩 서비스    | `embedding-service/main.py`                | 단일 서비스 진입점                 |
| 배포             | `k8s/deploy.sh`, `k8s/*.yaml`              | 단계적 배포                        |

## CODE MAP

| Symbol            | Type            | Location                                   | Role                         |
| ----------------- | --------------- | ------------------------------------------ | ---------------------------- |
| `getModeFromArgs` | function        | `backend/src/index.ts`                     | backend dual-mode 분기       |
| `DI` / `initDI`   | object/function | `backend/src/di.ts`                        | MikroORM repository DI       |
| `ragGraph`        | LangGraph flow  | `backend/src/agents/chatAgent/ragGraph.ts` | RAG 검색/리랭크 파이프라인   |
| `api`             | axios client    | `frontend/src/lib/api.ts`                  | CSRF/인증 포함 단일 API 경로 |
| `app`             | FastAPI app     | `worker/src/skald_worker/main.py`          | worker 서비스 진입점         |

## CONVENTIONS (DEVIATIONS ONLY)

- **Inverted monorepo**: 루트 `package.json`이 프론트엔드용입니다.
- **Dual backend mode**: `backend/src/index.ts`가 `--mode=express-server` / `--mode=memo-processing-server`를 처리합니다.
- **LLM provider policy**: 백엔드는 CLI Proxy API 체인 중심으로 동작하며 호출은 `LLMService`를 통해서만 수행합니다.
- **Testing policy**: backend Jest는 `maxWorkers=1` 직렬 실행입니다(DB 안전성).
- **Frontend state policy**: 공유 상태는 Zustand, `useState`는 컴포넌트 로컬 상태에만 허용됩니다.

## ANTI-PATTERNS (PROJECT-SPECIFIC)

- `frontend/src/lib/api.ts` 우회 금지 (컴포넌트에서 direct axios/fetch 금지)
- 공유 상태를 `useState`로 관리 금지 (`frontend/src/stores/` 패턴 사용)
- LLM SDK 직접 호출 금지 (`backend/src/services/llmService.ts` 경유)
- `console.log` 사용 금지 (`backend/src/lib/logger.ts` 사용)
- SSE 헤더를 async 작업 뒤에 설정 금지 (`backend/src/api/chat.ts`)
- 병렬 DB 테스트 금지 (`backend/jest.config.js`에서 직렬 실행)
- K8s secret 실파일 커밋 금지 (`k8s/secret.yaml.example` 템플릿만 추적)

## COMMANDS

```bash
# frontend (root)
pnpm dev
pnpm build

# backend
cd backend && pnpm dev:express-server
cd backend && pnpm dev:memo-processing-server
cd backend && pnpm build
cd backend && pnpm test

# worker
cd worker && uv run python -m skald_worker

# embedding-service
cd embedding-service && uv run uvicorn main:app --host 0.0.0.0 --port 8001

# k8s
cd k8s && ./deploy.sh -y
```

## NOTES

- GitHub Actions로 컨테이너 빌드 워크플로우가 존재합니다 (`.github/workflows/*`).
- `ee/`는 MIT 범위 밖의 별도 라이선스 코드입니다.
- 하위 AGENTS는 중복 설명보다 해당 도메인의 비표준 제약만 기록해야 합니다.

## LLM ENDPOINT POLICY

- 모든 모델 호출(Gemini 포함)은 **코드 하드코딩 금지**이며, 환경변수(`CLI_PROXY_API_BASE_URL`, `GEMINI_API_BASE_URL`)로만 지정합니다.
- `CLI_PROXY_API_BASE_URL`와 `GEMINI_API_BASE_URL`는 동일한 값을 사용해야 합니다.
