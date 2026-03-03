# BACKEND AGENTS

**Generated:** 2026-01-12
**Domain:** Core AI/Logic (Score 15)

## OVERVIEW

LangGraph-powered RAG pipeline for chat orchestration and specialized agents for memo ingestion (summarization, tagging).

## WHERE TO LOOK

| Task            | Location                  | Notes                                                     |
| --------------- | ------------------------- | --------------------------------------------------------- |
| RAG pipeline    | chatAgent/ragGraph.ts     | Core RAG pipeline definition using `StateGraph`           |
| Chat streaming  | chatAgent/chatAgent.ts    | Streaming implementation for chat                         |
| Query rewriting | chatAgent/queryRewrite.ts | Standalone utility for context-aware query enhancement    |
| Prompts         | chatAgent/prompts.ts      | Core RAG instructions, citation rules                     |
| Memo summaries  | memoSummaryAgent.ts       | Specialized agent for generating concise memo summaries   |
| Memo tags       | memoTagsAgent.ts          | Specialized agent for extracting relevant tags from memos |
| LLM evaluation  | llmJudgeAgent.ts          | RAG evaluation agent comparing actual vs expected answers |

## CONVENTIONS

- **State Management:** Use `Annotation.Root` from `@langchain/langgraph` for state schema in graphs
- **LLM Access:** Always use `LLMService.getLLM()` with specific `purpose` ('chat', 'classification', etc.)
- **Structured Output:** Ingestion agents MUST use `withStructuredOutput` for reliable JSON extraction
- **Streaming:** Chat responses use `AsyncGenerator<StreamChunk>` to handle multi-model response normalization

## UNIQUE STYLES

- **Linear Graph Flow:** RAG pipeline follows a fixed sequence: `history` -> `rewrite` -> `search` -> `properties` -> `rerank` -> `prompt`
- **Node Self-Control:** Nodes decide whether to execute based on `ragConfig` (e.g., skipping reranking if disabled)
- **Concurrent Reranking:** The `rerank` node processes chunk batches (max 25) in parallel to stay within reranker token limits
- **Citation Protocol:** Prompt instructions enforce strict `[[N]]` citation format for source referencing
- **Reference Injection:** Appends a `references` chunk to SSE stream after final response token

## LLM ENDPOINT POLICY

- 모든 모델 호출(Gemini 포함)은 **코드 하드코딩 금지**이며, 환경변수(`CLI_PROXY_API_BASE_URL`, `GEMINI_API_BASE_URL`)로만 지정합니다.
- `CLI_PROXY_API_BASE_URL`와 `GEMINI_API_BASE_URL`는 동일한 값을 사용해야 합니다.
