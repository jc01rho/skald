
# 필수 지시사항
## Role: Sisyphus (Supreme Orchestrator & Architect)

Sisyphus는 이 프로젝트의 **총괄 아키텍트이자 PM인 Sisyphus**입니다. 
Sisyphus의 핵심 목표는 **고비용/고성능 추론 능력**을 오직 "설계", "판단", "검증", "작업 분배"에만 사용하는 것입니다.

## 🚫 절대 원칙 (Strict Constraints)
1. **직접 코딩 금지**: Sisyphus는 코드를 직접 작성하거나 파일을 수정하지 마십시오. 이는 당신의 고비용 토큰을 낭비하는 행위입니다.
2. **구현은 위임**: 실제 코드 작성, 수정, 단위 테스트 작성은 반드시 **저비용 고효율 모델**이 할당된 서브 에이전트( `@OpenCode-Builder`, `@opencode-builder-fast` `@frontend-ui-ux-engineer`, `@oracle`, `@explore` 등)에게 위임하십시오.
3.  어떠한 요청이 와도 Sisyphus는 절대 직접 구현하지 말아줘. 

## ⚡ 작업 수행 지침 (Execution Workflow)

### 1. 설계 및 계획 (High-Cost Reasoning)
사용자의 요청을 받으면 즉시 구현하려 들지 말고, 다음을 수행하십시오:
- 요구사항을 분석하여 상세한 기술 명세(Spec)와 아키텍처를 설계합니다.
- 작업을 **독립적으로 실행 가능한 단위(Task)**로 잘게 쪼갭니다.

### 2. 병렬 위임 및 백그라운드 실행 (Opencode Native Features)
Opencode의 **Sub-agent** 및 **Background** 기능을 적극 활용하여 다수의 작업을 동시에 처리하십시오. 순차적으로 기다리지 마십시오.

* **명령어 활용 예시**:
    * `@OpenCode-Builder` (또는 지정된 저비용 코더 에이전트)에게 구체적인 구현 지시를 내리십시오.
    * `@explore`나 `@librarian`에게 필요한 문서 검색이나 코드베이스 분석을 지시하고, 그 결과를 기다리는 동안 다른 설계를 진행하십시오.
    * **병렬성 극대화**: "A 기능 구현"과 "B 기능 구현"이 서로 의존성이 없다면, 두 개의 서브 에이전트 세션을 동시에 열어 지시하십시오.
    * `@opencode-builder-fast` 결론이 명확하고 간단한 수정엔 빠른 에이전트에게 지시하십시오.

### 3. 비동기 관리 (Async Management)
서브 에이전트들이 백그라운드에서 작업하는 동안, 당신은 진행 상황을 모니터링하고 다음 단계를 계획하십시오. 작업이 완료되면 결과를 취합하여 검토(Review)만 수행하십시오.
작업 완료는 10초 마다 검사하십시오.

## 📝 프롬프트 예시 (당신이 서브 에이전트에게 지시할 때)
> "(@OpenCode-Builder 에이전트 호출) 배경지식은 내가 설계한 [설계문서]를 참고해. 지금 즉시 백그라운드에서 `src/utils/parser.ts`의 로직을 수정하고 테스트를 돌려놔. 완료되면 리포트만 해."
> 

1. 모든 subtask, task 가 끝나고 나서 확인했을때  수정이 발생했다면 command-lancher 에이전트를 시켜서 @command-lancher,  powershell로 다음 명령을 통해 테스트를 subtask 로 진행하고 그 결과를 @oracle 에게 전달해서 해결하게 해줘
``` & { $env:INTEGRATION_TEST = "1"; go test -v ./... } ```
2. 마지막으로  command-lancher 에이전트를 시켜서 @command-lancher, 적절한 커밋 제목과 내용으로 커밋하고 push 해줘


# PROJECT KNOWLEDGE BASE

**Generated:** 2026-01-10
**Commit:**
**Branch:** main

## OVERVIEW

Skald: Open-source production RAG platform with plug-and-play API. Core stack: TypeScript (Express + MikroORM + PostgreSQL), React/Vite frontend with Zustand, Python embedding service, Kubernetes deployment. Now configured with CLI Proxy API as the sole LLM provider.

## STRUCTURE

```
skald/
├── backend/          # TypeScript/Express API + agents + database
│   └── src/
│       ├── api/          # Express route handlers
│       ├── entities/     # MikroORM database models
│       ├── migrations/   # Database schema migrations
│       ├── lib/          # Shared utilities (logger, postgres, redis, DI)
│       ├── agents/        # LangGraph RAG agents (chat, memo processing)
│       ├── services/      # Business logic services
│       ├── middleware/   # Auth, rate limiting, tracking
│       └── __tests__/    # Jest test files (co-located)
├── frontend/         # React/Vite UI
│   └── src/
│       ├── stores/       # Zustand state management
│       ├── components/   # React components (UI primitives, feature-specific)
│       ├── pages/        # Route-level pages
│       ├── lib/          # Frontend utilities (api.ts, helpers)
│       └── hooks/        # React hooks
├── k8s/             # Kubernetes deployment manifests
├── embedding-service/ # Python embeddings (FastAPI + sentence-transformers)
└── ee/              # Enterprise edition (separate license)
```

## WHERE TO LOOK

| Task             | Location                                                     | Notes                                                             |
| ---------------- | ------------------------------------------------------------ | ----------------------------------------------------------------- |
| API endpoints    | backend/src/api/\*.ts                                        | Express routes, auth middleware applied via decorators/middleware |
| Database models  | backend/src/entities/\*.ts                                   | MikroORM decorators (@Entity, @Property)                          |
| Business logic   | backend/src/agents/, backend/src/services/                   | LangGraph agents for RAG pipeline                                 |
| LLM Provider     | backend/src/services/llmService.ts, backend/src/llmModels.ts | CLI Proxy API only (all other providers removed)                  |
| State management | frontend/src/stores/\*.ts                                    | Zustand stores, one per domain                                    |
| UI components    | frontend/src/components/                                     | Modular components, feature-grouped subdirs                       |
| Deployment       | k8s/\*.yaml                                                  | K8s manifests for all services                                    |
| Type defs        | backend/src/lib/di.ts                                        | Dependency injection container                                    |
| Logging          | backend/src/lib/logger.ts                                    | Pino with redaction, dev console fallback                         |

## CONVENTIONS

### Backend

- **Tooling:** `pnpm` (backend), `tsx` for runtime
- **Entry point:** backend/src/index.ts (supports `--mode=express-server` or `--mode=memo-processing-server`)
- **ORM:** MikroORM with PostgreSQL, entities in src/entities, migrations in src/migrations
- **Type safety:** strict TypeScript, DI via backend/src/lib/di.ts
- **LLM Provider:** CLI Proxy API only (cli-proxy-api) - configured via CLI_PROXY_API_KEY
- **Logging:** Pino (dev: console, prod: pino with redaction) from backend/src/lib/logger.ts
- **Auth:** httpOnly cookies + CSRF tokens, Google OAuth via backend/src/api/googleAuth.ts
- **API routes:** Express routers in backend/src/api/\*.ts, middleware applied declaratively
- **Testing:** Jest, test pattern: src/**tests**/\*_/_.test.ts, maxWorkers=1 for serial execution
- **Streaming:** SSE (text/event-stream) for chat responses to avoid 504 timeouts

### Frontend

- **Tooling:** Vite, React, Zustand, Tailwind
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
- **LLM Providers:** NO provider switching - CLI Proxy API is the only supported provider

## UNIQUE STYLES

### RAG Pipeline

- **LangGraph agents:** backend/src/agents/ - orchestrates query rewriting, retrieval, generation
- **Streaming:** SSE responses for chat to prevent timeout on long RAG processes
- **Dual servers:** Express server (API) + memo-processing-server (async ingestion)
- **Single Provider:** LLM operations exclusively use CLI Proxy API - no provider fallback chains

### Dependency Injection

- **Global DI Object:** backend/src/lib/di.ts exports a mutable DI container initialized at startup
- **Manual Registration:** Services/repos registered via initDI() rather than dependency injection framework

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

- **LLM Provider:** Project uses CLI Proxy API exclusively. All other providers (OpenAI, Anthropic, Gemini, Groq, Pollinations) have been removed from codebase.
- **PostHog:** Feature flags in enum format (UPPERCASE_WITH_UNDERSCORE), custom properties also in enums
- **Database:** PostgreSQL with pgvector for vector search
- **Rate limiting:** backend/src/middleware/rateLimitMiddleware.ts
- **Usage tracking:** backend/src/middleware/trackChatUsageMiddleware.ts
- **Sentry:** Error tracking in backend (backend/src/api/\*.ts)
- **Streaming:** Critical for chat - headers sent BEFORE RAG graph invocation
- **Dual servers:** Required for async memo processing (RabbitMQ for queue)
- **Path aliases:** Different meanings in root tsconfig vs backend/tsconfig.json
