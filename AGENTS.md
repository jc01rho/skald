# PROJECT KNOWLEDGE BASE

**Generated:** 2026-04-29
**Commit:** a4d360b
**Branch:** main

## OVERVIEW

작업이 끝나면 빌드가 가능한지 빌드 테스트를 하고, 성공했다면 커밋하고 푸쉬해줘.

`lsp_diagnostics`에서 `filePath`와 `directory`는 상호 배타적입니다. 하나만 제공하거나 둘 다 생략하세요.

DevCenter 보고에 적절한 task를 찾지 못했을 경우, PROJECT-147의 적절한 Story 아래에 task를 생성하고 진행 상황을 등록해도 됩니다. DevCenter 보고는 평일에만 가능하며, 평일이 아니거나 목요일 14시-24시 사이라면 `.opencode/devcenter-pending`에 Markdown으로 지연 기록 후 다음 허용 시간대 실행에서 보고하고 삭제하세요.

배포 순서: `commit` → `push` → GitHub Actions build 확인 → `k8s/deploy.sh -y`.

Skald는 프로덕션 RAG 플랫폼입니다. 루트는 React/Vite 프론트엔드이고, `backend/`(TS API), `worker/`(Python 수집기), `embedding-service/`(Python 임베딩/리랭크), `discord-bot/`(Discord 통합), `k8s/`(배포)로 분리된 **inverted monorepo** 구조입니다.

## STRUCTURE

```text
skald/
├── backend/                # Express + MikroORM + LangGraph/RAG
├── frontend/src/           # React app source; root package.json owns frontend commands
├── worker/                 # FastAPI collector worker + worker k8s source manifests
├── embedding-service/      # FastAPI embeddings/reranking/chat proxy microservice
├── discord-bot/            # Discord mention integration runtime
├── k8s/                    # Kubernetes manifests + deploy.sh orchestration
├── api-refernces/          # API lookup docs only; not production source
├── rag-reference/          # external/research reference material; do not copy blindly
└── ee/                     # Enterprise-only extensions (separate license)
```

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| Frontend API client | `frontend/src/lib/api.ts` | CSRF/auth/SSE 포함 단일 HTTP 경로 |
| Frontend routing/pages | `frontend/src/routes.tsx`, `frontend/src/pages/` | pages are thin route entry points |
| Frontend shared state | `frontend/src/stores/*.ts` | Zustand only for shared state |
| Backend route handlers | `backend/src/api/*.ts` | middleware array + zod validation |
| Chat/RAG graph | `backend/src/agents/chatAgent/ragGraph.ts` | retrieval, rerank, low-confidence guidance, wiki traversal |
| Preview response | `backend/src/agents/chatAgent/previewAgent.ts` | fast first answer before full RAG |
| Query routing/understanding | `backend/src/agents/adaptiveRagRouter.ts`, `backend/src/agents/queryUnderstandingAgent.ts` | lightweight routing/classification |
| LLM access | `backend/src/services/llmService.ts` | provider calls must go through here |
| Wiki compiler | `backend/src/services/wiki/` | DB-backed wiki materialization |
| Public wiki API/UI | `backend/src/api/publicWiki.ts`, `backend/src/api/wiki.ts`, `frontend/src/pages/PublicWikiGraphPage.tsx` | shared/public wiki readers |
| Async memo processing | `backend/src/memoProcessingServer/` | memo agents + queue consumers |
| Backend entities | `backend/src/entities/` | MikroORM models and pgvector-backed data |
| Backend infra utilities | `backend/src/lib/` | logger, DB/Redis, retrieval utilities, queue clients |
| Worker collectors | `worker/src/skald_worker/collectors/` | Jira/docs/Notion/release/userdata ingest |
| Worker runtime config | `worker/src/skald_worker/config.py` | pydantic-settings env source |
| Embedding/rerank API | `embedding-service/main.py` | single-file FastAPI service hotspot |
| Discord mention flow | `discord-bot/src/handlers/mentionHandler.ts` | query → Skald stream → Discord edit flow |
| Deployment | `k8s/deploy.sh`, `k8s/*.yaml` | staged apply, rollout/readiness checks |
| Worker deploy config | `worker/k8s/*.yaml`, `k8s/worker-*.yaml` | config/secret source lives under `worker/k8s/` |

## CODE MAP

| Symbol | Type | Location | Role |
| --- | --- | --- | --- |
| `getModeFromArgs` | function | `backend/src/index.ts` | backend `express-server` / `memo-processing-server` / `wiki-processing-server` 분기 |
| `DI` / `initDI` | object/function | `backend/src/di.ts` | MikroORM repository/service DI |
| `ragGraph` | LangGraph flow | `backend/src/agents/chatAgent/ragGraph.ts` | RAG 검색/리랭크/프롬프트/위키 traversal |
| `previewAgent` | agent | `backend/src/agents/chatAgent/previewAgent.ts` | 스트리밍 전 1차 답변 생성 |
| `adaptiveRagRouter` | router | `backend/src/agents/adaptiveRagRouter.ts` | 질의 복잡도/전략 라우팅 |
| `queryUnderstandingAgent` | agent | `backend/src/agents/queryUnderstandingAgent.ts` | query intent/identifier 이해 |
| `WikiCompilerService` | service | `backend/src/services/wiki/wikiCompilerService.ts` | WikiPage/Revision/Claim/Node/Edge materialization |
| `api` | axios client | `frontend/src/lib/api.ts` | CSRF/인증/스트리밍 포함 단일 API 경로 |
| `chatStore` / `publicChatStore` | Zustand stores | `frontend/src/stores/` | chat SSE state and preview promotion |
| `app` | FastAPI app | `worker/src/skald_worker/main.py` | collector worker service entry point |
| `DiscordStreamEditor` | class | `discord-bot/src/discord/DiscordStreamEditor.ts` | throttled Discord streaming edits |

## CONVENTIONS (DEVIATIONS ONLY)

- **Inverted monorepo**: root `package.json` is the frontend package; backend/discord-bot/worker/embedding-service have separate manifests.
- **Backend modes**: `backend/src/index.ts` accepts `--mode=express-server`, `--mode=memo-processing-server`, `--mode=wiki-processing-server`.
- **LLM endpoint policy**: no hardcoded model endpoint URLs. `CLI_PROXY_API_BASE_URL` and `GEMINI_API_BASE_URL` are env-driven and must use the same value.
- **LLM provider policy**: backend provider calls go through `LLMService`; direct SDK calls elsewhere are forbidden.
- **Backend test policy**: Jest uses serial execution (`maxWorkers=1`) because DB tests share PostgreSQL state.
- **Frontend state policy**: shared state lives in Zustand stores; `useState` is only for local UI state.
- **K8s worker ownership**: root `k8s/` owns worker runtime Deployment/Service/SA; worker ConfigMap/Secret source manifests live in `worker/k8s/` and are consumed by deploy fallback.
- **RabbitMQ self-host defaults**: user `skald`, password `skald`, vhost `/` for new-node bootstrap only; existing PVCs can preserve old broker users.
- **Reference folders**: `api-refernces/` and `rag-reference/` are lookup/research material, not production implementation patterns.

## ANTI-PATTERNS (PROJECT-SPECIFIC)

- `frontend/src/lib/api.ts` 우회 금지: components/stores에서 raw `fetch`/`axios` 직접 사용 금지.
- 공유 상태를 `useState`로 관리 금지; `frontend/src/stores/` 패턴 사용.
- LLM SDK 직접 호출 금지; `backend/src/services/llmService.ts` 경유.
- `console.log` 사용 금지; `backend/src/lib/logger.ts` 사용.
- SSE 헤더를 async 작업 뒤에 설정 금지; `backend/src/api/chat.ts`에서 먼저 flush.
- 병렬 DB 테스트 금지; backend Jest 직렬 실행 유지.
- K8s Secret 실파일 커밋 금지; 추적 템플릿은 placeholder만 유지.
- Kubernetes mutable image tag 배포 시 `kubectl apply`만으로 새 Pod가 보장된다고 가정 금지; rollout 또는 불변 태그 필요.
- PostgreSQL PVC는 credential repair/undeploy 중 기본 보존; 운영 데이터 삭제 금지.
- `rag-reference/` 코드를 명시적 요청 없이 production source로 복사 금지.

## COMMANDS

```bash
# frontend (root)
pnpm dev
pnpm build
pnpm lint

# backend
cd backend && pnpm dev:express-server
cd backend && pnpm dev:memo-processing-server
cd backend && pnpm build
cd backend && pnpm test

# worker
cd worker && uv run python -m skald_worker.main
cd worker && uv run pytest
cd worker && uv run ruff check .

# embedding-service
cd embedding-service && uv run uvicorn main:app --host 0.0.0.0 --port 8001

# discord-bot
cd discord-bot && pnpm build

# k8s
cd k8s && ./deploy.sh -y
```

## NOTES

- GitHub Actions container build workflows live in `.github/workflows/`.
- `ee/` is outside the MIT core scope.
- Child AGENTS.md files must document only domain-specific deviations and must not repeat global policies from this root file.
- Live worker secrets must stay in ignored local manifests or Kubernetes Secret, never tracked templates.
- Root `.gitignore` ignores `.env` and `.env.*` while allowing `.env.example` and `.env.prod.example`.
- `k8s/deploy.sh` needs the root app secret file `k8s/secret.yaml`; `k8s/worker-secret.local.yaml` does not satisfy that check.
