# PROJECT KNOWLEDGE BASE

**Generated:** 2026-02-25
**Commit:** d710f8f
**Branch:** main

## OVERVIEW

Skald: Open-source production RAG platform with plug-and-play API. TypeScript backend (Express + MikroORM + PostgreSQL + pgvector), React/Vite frontend with Zustand, Python embedding/worker services, Kubernetes deployment. CLI Proxy API as sole LLM provider.

## STRUCTURE

```
skald/                      # Root = Frontend package (inverted monorepo)
├── backend/                # TypeScript/Express API + LangGraph agents
│   └── src/
│       ├── api/            # Express route handlers (20 files)
│       ├── entities/       # MikroORM database models (26 entities)
│       ├── migrations/     # Database schema migrations (28 files)
│       ├── lib/            # Shared utilities (35 files: logger, DI, postgres, redis)
│       ├── agents/         # LangGraph RAG agents (chat, memo processing)
│       │   └── chatAgent/  # Core RAG pipeline (11-node graph)
│       ├── services/       # Business logic (LLM, embedding, rerank, Stripe)
│       ├── middleware/     # Express middleware (auth, rate limit, CSRF)
│       └── __tests__/      # Jest tests (serial, maxWorkers=1)
├── frontend/               # React/Vite UI (source in frontend/src/)
│   └── src/
│       ├── stores/         # Zustand state management (14 stores)
│       ├── components/     # React components (ui/, feature folders)
│       ├── pages/          # Route-level pages (21 files)
│       └── lib/            # Frontend utilities (api.ts, types.ts)
├── worker/                 # Python FastAPI worker (Jira/docs collectors)
│   └── src/skald_worker/   # Circuit breaker + retry patterns
├── embedding-service/      # Python FastAPI embeddings (single-file service)
├── discord-bot/            # Discord integration (separate deploy via GitHub Actions)
├── k8s/                    # Kubernetes manifests (55 files, 8 microservices)
├── ee/                     # Enterprise edition (separate license)
├── mock_data/              # Odin-docs test fixtures
└── memory-bank/            # AI context persistence files
```

## WHERE TO LOOK

| Task             | Location                                    | Notes                               |
| ---------------- | ------------------------------------------- | ----------------------------------- |
| API endpoints    | backend/src/api/\*.ts                       | Express routes, middleware arrays   |
| Database models  | backend/src/entities/\*.ts                  | MikroORM decorators, 26 entities    |
| RAG pipeline     | backend/src/agents/chatAgent/               | LangGraph StateGraph, 11 nodes      |
| LLM access       | backend/src/services/llmService.ts          | CLI Proxy API only, retry+fallback  |
| State management | frontend/src/stores/\*.ts                   | Zustand, one per domain             |
| UI components    | frontend/src/components/                    | Feature-grouped subdirs             |
| API client       | frontend/src/lib/api.ts                     | ALL requests go through here        |
| Deployment       | k8s/\*.yaml                                 | K8s manifests, 4-phase deploy order |
| Python worker    | worker/src/skald_worker/                    | Jira/docs collectors                |
| Embeddings       | embedding-service/main.py                   | FastAPI + sentence-transformers     |
| Subscription     | backend/src/services/subscriptionService.ts | Stripe billing (845 lines)          |
| Discord bot      | discord-bot/                                | Separate deploy, GitHub Actions     |

## CODE MAP

| Symbol              | Type       | Location                                    | Role                  |
| ------------------- | ---------- | ------------------------------------------- | --------------------- |
| chatAgent           | Function   | backend/src/agents/chatAgent/chatAgent.ts   | RAG entry point       |
| ragGraph            | StateGraph | backend/src/agents/chatAgent/ragGraph.ts    | 11-node LangGraph     |
| LLMService          | Class      | backend/src/services/llmService.ts          | Single LLM provider   |
| DI                  | Object     | backend/src/lib/di.ts                       | Dependency injection  |
| SubscriptionService | Class      | backend/src/services/subscriptionService.ts | Stripe webhooks       |
| HybridSearchService | Class      | backend/src/embeddings/hybridSearch.ts      | Vector + BM25 search  |
| api                 | Axios      | frontend/src/lib/api.ts                     | HTTP client with CSRF |
| useAuthStore        | Store      | frontend/src/stores/authStore.ts            | Auth state            |
| useChatStore        | Store      | frontend/src/stores/chatStore.ts            | Chat/streaming state  |
| CircuitBreaker      | Class      | worker/src/skald_worker/circuit_breaker.py  | Fault tolerance       |

## CONVENTIONS

### Backend

- **Tooling:** pnpm, tsx for runtime
- **Entry:** backend/src/index.ts (--mode=express-server | memo-processing-server)
- **ORM:** MikroORM with PostgreSQL, pgvector for embeddings
- **LLM:** CLI Proxy API only (CLI_PROXY_API_KEY) - no provider switching
- **Logging:** Pino (logger.ts) with redaction - NEVER console.log
- **Auth:** httpOnly cookies + CSRF, Google OAuth
- **Testing:** Jest, maxWorkers=1 (serial), src/\_\_tests\_\_/\*.test.ts
- **Path Alias:** @/\* → src/\* (backend tsconfig)

### Frontend

- **Tooling:** Vite, React, Zustand, Tailwind
- **State:** Zustand stores in stores/\*.ts - NO useState for shared state
- **API:** api.ts for ALL requests - NO direct axios/fetch in components
- **Routing:** File-based via pages/ structure
- **Styling:** Tailwind CSS with cn() utility from shadcn
- **Path Alias:** @/\* → frontend/src/\* (root tsconfig)

### Python Services

- **Worker:** FastAPI, Ruff linting (E, F, I, UP, B, SIM), 120 char lines
- **Embedding:** FastAPI + sentence-transformers
- **Resilience:** Circuit breaker (5 failures → 30s open), exponential backoff retry
- **Package Manager:** uv

### Code Style

- **Prettier:** 4 spaces, no semicolons, single quotes, 120 chars
- **ESLint:** Flat config (eslint.config.js), TypeScript + React, no-explicit-any disabled
- **Pre-commit:** Husky + lint-staged (prettier --write on staged files)
- **General:** Concise, simple code - avoid complex patterns

## ANTI-PATTERNS (THIS PROJECT)

- **Frontend:** NEVER useState for shared state → use Zustand stores
- **Frontend:** NEVER direct axios/fetch → use api.ts
- **Backend:** NEVER multiple components per file → one main + tiny helpers
- **Backend:** NEVER call LLM providers directly → use LLMService.getLLM(purpose)
- **Backend:** NEVER instantiate services manually → use DI container
- **Testing:** NO parallel tests → serial (maxWorkers=1) for DB safety
- **Auth:** NEVER localStorage tokens → httpOnly cookies only
- **LLM:** NO provider switching → CLI Proxy API is the only provider
- **Logging:** NEVER console.log → use logger from lib/logger.ts
- **PostHog:** NEVER scatter feature flags → use in as few places as possible
- **PostHog:** ALWAYS use enums for flag names (UPPERCASE_WITH_UNDERSCORE)
- **Streaming:** NEVER send SSE headers after async work → headers BEFORE RAG graph

## UNIQUE STYLES

### Inverted Monorepo

- Root package.json = Frontend (Vite/React)
- Backend is subdirectory with own package.json
- No workspace manager (no pnpm-workspace.yaml)

### RAG Pipeline (11-node LangGraph)

- **Flow:** history → analyzeQuery → rewrite → search → properties → rerank → validateCrag → mmr → contextReorder → fetchParentChunks → buildLLMInputs
- **Self-controlling nodes:** Each node checks ragConfig to decide execution
- **Parent-child chunking:** 512 chars for search, 2048 chars for LLM context
- **Citations:** Strict [[N]] format, references injected as final SSE chunk

### Dual Server Mode

- `--mode=express-server`: HTTP API (port 8000)
- `--mode=memo-processing-server`: RabbitMQ/SQS/Redis consumer
- Same codebase, different entry modes

### Dependency Injection

- Manual DI via backend/src/lib/di.ts, initDI() at startup
- All MikroORM repositories accessible via DI.entityName

## COMMANDS

```bash
# Backend
cd backend && pnpm dev:express-server      # API server
cd backend && pnpm dev:memo-processing-server  # Ingestion server
cd backend && pnpm build                   # Compile TypeScript
cd backend && pnpm test                    # Jest tests (serial)
cd backend && pnpm migrate:up              # Apply migrations

# Frontend (from root)
pnpm dev                         # Vite dev server
pnpm build                       # Production build

# Docker
docker-compose up                # All services locally
docker-compose --profile local up  # With local embedding service

# Worker (Python)
cd worker && uv run python -m skald_worker  # Start worker
cd worker && pytest                          # Run tests

# Embedding Service (Python)
cd embedding-service && uvicorn main:app --host 0.0.0.0 --port 8001
```

## NOTES

- **LLM Provider:** CLI Proxy API exclusively - all others removed
- **Database:** PostgreSQL + pgvector for vector search
- **Message Queue:** RabbitMQ for async memo processing (SQS, Redis also supported)
- **Path Aliases:** @/\* → frontend/src/\* (root), @/\* → src/\* (backend)
- **No CI/CD pipeline:** Manual builds/deployments, pre-commit via Husky/lint-staged
- **Streaming Critical:** Chat headers MUST be sent before RAG graph invocation to avoid 504
- **K8s Deploy Order:** Infrastructure → Core App → AI Services → Frontend/Ingress
- **Large Files:** subscriptionService.ts (845), ragGraph.ts (623), memo.ts (513) - complexity hotspots

## DEPLOYMENT POLICIES

### Discord Bot

**Build Process:**

- **ONLY via GitHub Actions** - `.github/workflows/build-discord-bot.yml`
- Triggered by: push to `main` branch with `discord-bot/**` changes, or `v*` tags
- **NEVER build locally** for production deployments
- Image: `ghcr.io/jc01rho/discord-bot:latest`

**Deployment:**

- **ONLY via `k8s/deploy.sh`** script
- Uses `discord-bot-secret.local.yaml` for sensitive data (never commit actual secrets)

**Local Development:**

```bash
cd discord-bot && pnpm install && pnpm run dev
```

### Kubernetes Deployment

**Deployment Workflow:**

1. **Commit & Push** - 코드 커밋 후 GitHub에 푸시
2. **GitHub Actions** - 자동으로 Docker 이미지 빌드 및 푸시 (Backend, Worker)
   - `.github/workflows/build-backend.yml` - Backend 이미지 빌드
   - `.github/workflows/build-worker.yml` - Worker 이미지 빌드
   - 트리거: `main` 브랜치 푸시 또는 수동 실행
3. **Wait for GH Actions** - GitHub Actions 완료 대기 (약 1-2분)
4. **Run deploy.sh** - Kubernetes 배포 실행

```bash
# 배포 스크립트 실행
cd k8s && ./deploy.sh

# 또는 환경변수로 자동 승인
cd k8s && echo "y" | ./deploy.sh
```

**Deploy Script Phases:**

1. Namespace & ConfigMap 생성
2. Secrets 생성 (`k8s/secret.yaml` 필요)
3. PostgreSQL & RabbitMQ 배포 (StatefulSet)
4. Redis 배포
5. Backend API Server 배포
6. Memo Processing Server 배포
7. AI Services (Embedding, Docling, Worker) 배포
8. Frontend UI 배포
9. Ingress 설정

**Important Files:**

- `k8s/configmap.yaml` - 비민감 환경변수
- `k8s/secret.yaml` - 민감 정보 (Git 추적 안함, `secret.yaml.example` 참조)
- `k8s/deploy.sh` - 전체 배포 자동화 스크립트

**Key Environment Variables:**

- `LOG_LEVEL` - 로깅 레벨 (info, debug, warn)
- `LLM_DEFAULT_CHAT_MODEL` - 기본 채팅 모델
- `LLM_FALLBACK_CHAIN` - 폴백 모델 체인 (쉼표 구분)
- `CLI_PROXY_API_KEY` - LLM API 키
- `GEMINI_API_KEY` - Gemini API 키 (선택)

**Deployment Verification:**

```bash
# Pod 상태 확인
kubectl get pods -n skald

# 서비스 상태 확인
kubectl get services -n skald

# 로그 확인
kubectl logs -f deployment/api-server -n skald

# LLM 호출 로그 확인 (LOG_LEVEL=info 필요)
kubectl logs -f deployment/api-server -n skald | grep -E "LLM|invoke|fallback|retry"
```

**Common Issues:**

- **503 No Capacity Error** - LLMService가 자동으로 fallback 모델로 전환
- **SQL ANY() Error** - 빈 배열 필터는 자동으로 `FALSE` 처리
- **Memo Not Found Loop** - 존재하지 않는 memo는 재시도 없이 종료
- **Deployment Label Mismatch** - `component` 라벨 확인 (deploy.sh에서 사용)
