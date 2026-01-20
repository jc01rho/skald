# PROJECT KNOWLEDGE BASE

**Generated:** 2026-01-12
**Commit:** 06b2d84
**Branch:** main

## OVERVIEW

Skald: Open-source production RAG platform with plug-and-play API. TypeScript backend (Express + MikroORM + PostgreSQL), React/Vite frontend with Zustand, Python embedding/worker services, Kubernetes deployment. CLI Proxy API as sole LLM provider.

## STRUCTURE

```
skald/
├── backend/          # TypeScript/Express API + LangGraph agents
│   └── src/
│       ├── api/          # Express route handlers
│       ├── entities/     # MikroORM database models
│       ├── migrations/   # Database schema migrations
│       ├── lib/          # Shared utilities (logger, DI, postgres, redis)
│       ├── agents/       # LangGraph RAG agents (chat, memo processing)
│       ├── services/     # Business logic (LLM, embedding, rerank)
│       └── __tests__/    # Jest tests (co-located)
├── frontend/         # React/Vite UI
│   └── src/
│       ├── stores/       # Zustand state management
│       ├── components/   # React components (ui/, feature folders)
│       ├── pages/        # Route-level pages
│       └── lib/          # Frontend utilities (api.ts)
├── worker/           # Python FastAPI worker (Jira/docs collectors)
│   └── src/skald_worker/
├── embedding-service/ # Python FastAPI embeddings (sentence-transformers)
├── k8s/              # Kubernetes deployment manifests (41 files)
└── ee/               # Enterprise edition (separate license)
```

## WHERE TO LOOK

| Task             | Location                           | Notes                             |
| ---------------- | ---------------------------------- | --------------------------------- |
| API endpoints    | backend/src/api/\*.ts              | Express routes, middleware arrays |
| Database models  | backend/src/entities/\*.ts         | MikroORM decorators               |
| RAG pipeline     | backend/src/agents/chatAgent/      | LangGraph StateGraph              |
| LLM access       | backend/src/services/llmService.ts | CLI Proxy API only                |
| State management | frontend/src/stores/\*.ts          | Zustand, one per domain           |
| UI components    | frontend/src/components/           | Feature-grouped subdirs           |
| API client       | frontend/src/lib/api.ts            | ALL requests go through here      |
| Deployment       | k8s/\*.yaml                        | K8s manifests for all services    |
| Python worker    | worker/src/skald_worker/           | Jira/docs collectors              |
| Embeddings       | embedding-service/main.py          | FastAPI + sentence-transformers   |

## CODE MAP

| Symbol       | Type       | Location                                  | Role                  |
| ------------ | ---------- | ----------------------------------------- | --------------------- |
| chatAgent    | Function   | backend/src/agents/chatAgent/chatAgent.ts | RAG entry point       |
| ragGraph     | StateGraph | backend/src/agents/chatAgent/ragGraph.ts  | LangGraph pipeline    |
| LLMService   | Class      | backend/src/services/llmService.ts        | Single LLM provider   |
| DI           | Object     | backend/src/lib/di.ts                     | Dependency injection  |
| api          | Axios      | frontend/src/lib/api.ts                   | HTTP client with CSRF |
| useAuthStore | Store      | frontend/src/stores/authStore.ts          | Auth state            |
| useChatStore | Store      | frontend/src/stores/chatStore.ts          | Chat/streaming state  |

## CONVENTIONS

### Backend

- **Tooling:** pnpm, tsx for runtime
- **Entry:** backend/src/index.ts (--mode=express-server | memo-processing-server)
- **ORM:** MikroORM with PostgreSQL, pgvector for embeddings
- **LLM:** CLI Proxy API only (CLI_PROXY_API_KEY) - no provider switching
- **Logging:** Pino (logger.ts) with redaction - NEVER console.log
- **Auth:** httpOnly cookies + CSRF, Google OAuth
- **Testing:** Jest, maxWorkers=1 (serial), src/**tests**/\*.test.ts

### Frontend

- **Tooling:** Vite, React, Zustand, Tailwind
- **State:** Zustand stores in stores/\*.ts - NO useState for shared state
- **API:** api.ts for ALL requests - NO direct axios/fetch in components
- **Routing:** File-based via pages/ structure
- **Styling:** Tailwind CSS with cn() utility from shadcn

### Python Services

- **Worker:** FastAPI, Ruff linting (E, F, I, UP, B, SIM), 120 char lines
- **Embedding:** FastAPI + sentence-transformers

### Code Style

- **Prettier:** 4 spaces, no semicolons, single quotes, 120 chars
- **ESLint:** Flat config, TypeScript + React, no-explicit-any disabled
- **General:** Concise, simple code - avoid complex patterns

## ANTI-PATTERNS (THIS PROJECT)

- **Frontend:** NEVER useState for shared state → use Zustand stores
- **Frontend:** NEVER direct axios/fetch → use api.ts
- **Backend:** NEVER multiple components per file → one main + tiny helpers
- **Testing:** NO parallel tests → serial (maxWorkers=1) for DB safety
- **Auth:** NEVER localStorage tokens → httpOnly cookies only
- **LLM:** NO provider switching → CLI Proxy API is the only provider
- **Logging:** NEVER console.log → use logger from lib/logger.ts
- **PostHog:** NEVER scatter feature flags → use in as few places as possible
- **PostHog:** ALWAYS use enums for flag names (UPPERCASE_WITH_UNDERSCORE)

## UNIQUE STYLES

### RAG Pipeline

- **LangGraph:** Linear flow: history → rewrite → search → properties → rerank → prompt
- **Streaming:** SSE for chat (text/event-stream), headers sent BEFORE graph invocation
- **Citations:** Strict [[N]] format, references chunk appended after response

### Dual Server Mode

- Express server (API) + memo-processing-server (async ingestion via RabbitMQ)

### Dependency Injection

- Manual DI via backend/src/lib/di.ts, initDI() at startup

## COMMANDS

```bash
# Backend
pnpm dev:express-server          # API server
pnpm dev:memo-processing-server  # Ingestion server
pnpm build                       # Compile TypeScript
pnpm test                        # Jest tests (serial)
pnpm migrate:up                  # Apply migrations

# Frontend
pnpm dev                         # Vite dev server
pnpm build                       # Production build

# Docker
docker-compose up                # All services locally

# Worker (Python)
uv run python -m skald_worker    # Start worker
pytest                           # Run tests
```

## NOTES

- **LLM Provider:** CLI Proxy API exclusively - all others removed
- **Database:** PostgreSQL + pgvector for vector search
- **Message Queue:** RabbitMQ for async memo processing
- **Path Aliases:** @/\* differs between root tsconfig (frontend) and backend/tsconfig.json
- **No CI/CD:** Manual builds/deployments, pre-commit via Husky/lint-staged
- **Streaming Critical:** Chat headers MUST be sent before RAG graph invocation to avoid 504
