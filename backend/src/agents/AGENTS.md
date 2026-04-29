# BACKEND AGENTS

**Generated:** 2026-04-29
**Domain:** RAG/LLM Orchestration (Score 12)

## OVERVIEW

Agent code performs query understanding, retrieval strategy selection, preview answer generation, and full RAG answer synthesis.

## WHERE TO LOOK

| Flow | Location | Notes |
| --- | --- | --- |
| Full chat graph | `chatAgent/ragGraph.ts` | LangGraph retrieval/rerank/context/answer pipeline |
| Preview answer | `chatAgent/previewAgent.ts` | fast first response before full RAG completes |
| Chat prompts | `chatAgent/prompts.ts` | retrieved evidence + user-provided evidence contracts |
| Query routing | `adaptiveRagRouter.ts`, `queryUnderstandingAgent.ts` | complexity/intent/identifier understanding |
| Memo enrichment | `memoSummaryAgent.ts`, `memoTagsAgent.ts` | summaries and tag extraction for memo processing |
| LLM judging | `llmJudgeAgent.ts` | expected-vs-actual answer evaluation |

## CONVENTIONS

- Prompt contracts prefer partial answers when any related evidence exists.
- Low-confidence handling is mode-based guidance, not blanket abstention.
- Exact literal anchors (error codes/release versions) must suppress generic refusal and preserve child-chunk evidence.
- Lightweight query decomposition keeps the original query and adds supplemental variants only.
- Preview staging should be fast and conservative; final RAG remains authoritative.
- User-provided evidence is context, not retrieval citation.

## ANTI-PATTERNS

- Do not bypass `LLMService` for model calls.
- Do not replace child chunks with parent chunks when that hides exact answer snippets.
- Do not treat wiki as a primary Discord search index; Discord uses wiki as second-stage context.
- Do not introduce nonzero-temperature variance into deterministic routing/classification paths unless explicitly justified.
