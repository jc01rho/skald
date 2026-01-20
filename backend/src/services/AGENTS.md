# BACKEND SERVICES

**Generated:** 2026-01-12
**Domain:** Business Logic Layer (Score 12)

## OVERVIEW

Service layer abstracting external integrations and business logic: LLM access, embeddings, reranking, document processing.

## WHERE TO LOOK

| Service      | File                         | Purpose                                 |
| ------------ | ---------------------------- | --------------------------------------- |
| LLM          | llmService.ts                | CLI Proxy API access (ONLY provider)    |
| Embedding    | embeddingService.ts          | Vector generation via embedding-service |
| Rerank       | rerankService.ts             | Chunk reranking for RAG                 |
| Document     | documentProcessingService.ts | Doc parsing orchestration               |
| Docling      | doclingService.ts            | Docling service client                  |
| Evaluation   | evaluationService.ts         | RAG evaluation metrics                  |
| Subscription | subscriptionService.ts       | Stripe billing integration              |
| Usage        | usageTrackingService.ts      | Token/request tracking                  |

## CONVENTIONS

- **LLM Access:** ALWAYS use `LLMService.getLLM(purpose)` with specific purpose ('chat', 'classification', etc.)
- **Singleton Pattern:** Services instantiated once, accessed via DI container
- **Error Handling:** Wrap external calls in try/catch, log via logger.ts
- **Async:** All external calls return Promises

## ANTI-PATTERNS

- NEVER call LLM providers directly - use LLMService
- NEVER instantiate services manually - use DI
- NEVER skip error handling for external calls
