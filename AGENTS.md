# PROJECT KNOWLEDGE BASE

**Generated:** 2025-01-04
**Commit:** 830cd51
**Branch:** main

## OVERVIEW

Skald: Open-source production RAG platform with plug-and-play API. Core stack: TypeScript (Express + MikroORM + PostgreSQL), React/Vite frontend with Zustand, Python embedding service, Kubernetes deployment.

## STRUCTURE

```
skald/
├── backend/          # TypeScript/Express API + agents + database
│   └── src/
│       ├── api/          # Express route handlers
│       ├── entities/     # MikroORM database models
│       ├── migrations/   # Database schema migrations
│       ├── lib/          # Shared utilities (logger, postgres, redis)
│       ├── agents/        # LangGraph RAG agents (chat, memo processing)
│       ├── services/      # Business logic services
│       └── middleware/   # Auth, rate limiting, tracking
├── frontend/         # React/Vite UI
│   └── src/
│       ├── stores/       # Zustand state management
│       ├── components/   # React components (UI, feature-specific)
│       ├── pages/        # Route-level pages
│       ├── lib/          # Frontend utilities (api.ts, helpers)
│       └── hooks/        # React hooks
├── k8s/             # Kubernetes deployment manifests
├── embedding-service/ # Python embeddings (FastAPI + sentence-transformers)
└── ee/              # Enterprise edition (separate license)
```

## WHERE TO LOOK

| Task             | Location                                   | Notes                                                             |
| ---------------- | ------------------------------------------ | ----------------------------------------------------------------- |
| API endpoints    | backend/src/api/\*.ts                      | Express routes, auth middleware applied via decorators/middleware |
| Database models  | backend/src/entities/\*.ts                 | MikroORM decorators (@Entity, @Property)                          |
| Business logic   | backend/src/agents/, backend/src/services/ | LangGraph agents for RAG pipeline                                 |
| State management | frontend/src/stores/\*.ts                  | Zustand stores, one per domain                                    |
| UI components    | frontend/src/components/                   | Modular components, feature-grouped subdirs                       |
| Deployment       | k8s/\*.yaml                                | K8s manifests for all services                                    |
| Type defs        | backend/src/lib/di.ts                      | Dependency injection container                                    |
| Logging          | backend/src/lib/logger.ts                  | Pino with redaction, dev console fallback                         |

## CONVENTIONS

### Backend

- **Tooling:** `pnpm` (backend), `tsx` for runtime
- **Entry point:** backend/src/index.ts (supports `--mode=express-server` or `--mode=memo-processing-server`)
- **ORM:** MikroORM with PostgreSQL, entities in src/entities, migrations in src/migrations
- **Type safety:** strict TypeScript, DI via backend/src/lib/di.ts
- **Logging:** Pino (dev: console, prod: pino with redaction) from backend/src/lib/logger.ts
- **Auth:** httpOnly cookies + CSRF tokens, Google OAuth via backend/src/api/googleAuth.ts
- **API routes:** Express routers in backend/src/api/\*.ts, middleware applied declaratively
- **Testing:** Jest, test pattern: src/**tests**/\*_/_.test.ts, maxWorkers=1 for serial execution
- **Streaming:** SSE (text/event-stream) for chat responses to avoid 504 timeouts

### Frontend

- **Tooling:** Vite, React, Zustand, Tailwind (implicit from project structure)
- **State:** Zustand stores in frontend/src/stores/\*.ts - NO useState unless component-specific
- **API:** frontend/src/lib/api.ts for ALL requests - Axios with credentials, CSRF handling
- **Routing:** File-based routing (implied from pages/ structure)
- **Components:** Modular, feature-specific - NO multiple components per file
- **Streaming:** fetch API with SSE for chat, abort controller support

### Code Style

- **Prettier:** 4 spaces, no semicolons, single quotes, 120 char width
- **General:** Concise, simple code - avoid complex patterns
- **Imports:** Path aliases: `@/*` maps to `./frontend/src/*` (root tsconfig) and `@/*` maps to `./backend/src/*` (backend tsconfig)

## ANTI-PATTERNS (THIS PROJECT)

- **Frontend:** NEVER use useState for shared state - use Zustand stores
- **Backend:** NEVER create multiple components per file - one main component + tiny helpers only
- **Frontend:** ALWAYS use api.ts for requests - NO direct axios/fetch in components
- **Testing:** NO parallel test execution - serial tests (maxWorkers=1) to avoid DB conflicts
- **Auth:** NEVER store tokens in localStorage - httpOnly cookies only

## UNIQUE STYLES

### RAG Pipeline

- **LangGraph agents:** backend/src/agents/ - orchestrates query rewriting, retrieval, generation
- **Streaming:** SSE responses for chat to prevent timeout on long RAG processes
- **Dual servers:** Express server (API) + memo-processing-server (async ingestion)

### Multi-language

- Backend: TypeScript
- Embedding service: Python (FastAPI, sentence-transformers)
- Deployment: Kubernetes manifests in k8s/

## COMMANDS

### Backend

```bash
pnpm dev:express-server          # Start API server
pnpm dev:memo-processing-server # Start ingestion server
pnpm build                      # Compile TypeScript
pnpm test                       # Run Jest tests
pnpm migrate:up                # Apply DB migrations
pnpm fixtures:load              # Load test data
```

### Frontend

```bash
# (Vite commands from package.json structure)
pnpm dev                        # Start Vite dev server
pnpm build                       # Build for production
```

### Docker

```bash
docker-compose up                # Start all services (API + DB + Redis + embedding)
```

## NOTES

- **PostHog:** Feature flags in enum format (UPPERCASE_WITH_UNDERSCORE), custom properties also in enums
- **Database:** PostgreSQL with pgvector for vector search
- **Rate limiting:** backend/src/middleware/rateLimitMiddleware.ts
- **Usage tracking:** backend/src/middleware/trackChatUsageMiddleware.ts
- **Sentry:** Error tracking in backend (backend/src/api/\*.ts)
- **Streaming:** Critical for chat - headers sent BEFORE RAG graph invocation
- **Dual servers:** Required for async memo processing (RabbitMQ for queue)
- **Path aliases:** Different meanings in root tsconfig vs backend/tsconfig.json
