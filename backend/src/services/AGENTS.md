# BACKEND SERVICES

**Generated:** 2026-04-29
**Domain:** Business Services (Score 10)

## OVERVIEW

Service classes wrap provider access and domain workflows that routes/agents should not implement inline.

## WHERE TO LOOK

| Service | Location | Notes |
| --- | --- | --- |
| LLM provider access | `llmService.ts` | all provider calls and retry policy |
| Embeddings/rerank | `embeddingService.ts`, `rerankService.ts` | remote embedding-service integration |
| Wiki compiler | `wiki/wikiCompilerService.ts`, `wiki/wikiCompilePrompts.ts` | WikiPage/Revision/Claim/Node/Edge compile pipeline |
| Documents | `documentProcessingService.ts`, `doclingService.ts` | document parsing and Docling integration |
| Evaluation/billing | `evaluationService.ts`, `subscriptionService.ts`, `usageTrackingService.ts` | evaluation metrics, plans, usage accounting |

## CONVENTIONS

- `LLMService.invokeWithRetry()` is the provider boundary for backend model calls.
- Wiki compilation uses fixed prompt inputs and server-side DB context selection, not iterative answer-time traversal.
- Wiki compiler must honor both `WIKI_ENABLED` and `WIKI_COMPILE_ON_MEMO_PROCESS`.
- Service methods should accept explicit repositories/entity managers when called from async workers.

## ANTI-PATTERNS

- Do not hardcode provider URLs or model endpoint hosts.
- Do not call services from migrations.
- Do not perform long-running wiki compilation synchronously inside request handlers when queue mode is enabled.
