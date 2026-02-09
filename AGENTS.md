# PROJECT KNOWLEDGE BASE

**Generated:** 2026-02-09
**Commit:** a7df64b
**Branch:** main

## OVERVIEW

Skald: Open-source production RAG platform with plug-and-play API. TypeScript backend (Express + MikroORM + PostgreSQL), React/Vite frontend with Zustand, Python embedding/worker services, Kubernetes deployment. CLI Proxy API as sole LLM provider.

## STRUCTURE

```
skald/                      # Root = Frontend package (inverted monorepo)
├── backend/                # TypeScript/Express API + LangGraph agents
│   └── src/
│       ├── api/            # Express route handlers (20 files)
│       ├── entities/       # MikroORM database models (26 files)
│       ├── migrations/     # Database schema migrations (28 files)
│       ├── lib/            # Shared utilities (30 files: logger, DI, postgres, redis)
│       ├── agents/         # LangGraph RAG agents (chat, memo processing)
│       │   └── chatAgent/  # Core RAG pipeline (11-node graph)
│       ├── services/       # Business logic (LLM, embedding, rerank, Stripe)
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
├── k8s/                    # Kubernetes manifests (50 files, 8 microservices)
└── ee/                     # Enterprise edition (separate license)
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

### Frontend

- **Tooling:** Vite, React, Zustand, Tailwind
- **State:** Zustand stores in stores/\*.ts - NO useState for shared state
- **API:** api.ts for ALL requests - NO direct axios/fetch in components
- **Routing:** File-based via pages/ structure
- **Styling:** Tailwind CSS with cn() utility from shadcn

### Python Services

- **Worker:** FastAPI, Ruff linting (E, F, I, UP, B, SIM), 120 char lines
- **Embedding:** FastAPI + sentence-transformers
- **Resilience:** Circuit breaker (5 failures → 30s open), exponential backoff retry

### Code Style

- **Prettier:** 4 spaces, no semicolons, single quotes, 120 chars
- **ESLint:** Flat config, TypeScript + React, no-explicit-any disabled
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
- **No CI/CD:** Manual builds/deployments, pre-commit via Husky/lint-staged
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

**Deployment Process:**

- **ONLY via `k8s/deploy.sh`** script
- Configures ConfigMap, Secret, Deployment, Service automatically
- Uses `discord-bot-secret.local.yaml` for sensitive data (never commit actual secrets)

**Local Development:**

```bash
cd discord-bot
pnpm install
pnpm run dev  # Local testing only
```

**Production Deployment:**

```bash
cd k8s
./deploy.sh  # This is the ONLY way to deploy Discord Bot to production
```
