# backend/src/agents/

## OVERVIEW

LangGraph-powered RAG pipeline for chat orchestration and specialized agents for memo ingestion (summarization, tagging).

## WHERE TO LOOK

- `chatAgent/ragGraph.ts`: Core RAG pipeline definition using `StateGraph`. Nodes: history retrieval, query rewriting, vector search, memo properties lookup, reranking, and prompt building.
- `chatAgent/chatAgent.ts`: Streaming implementation for chat using `LLMService` and LangChain.
- `chatAgent/queryRewrite.ts`: Standalone utility for context-aware query enhancement using `QUERY_REWRITE_PROMPT`.
- `chatAgent/prompts.ts`: Core RAG instructions, including citation rules (`[[1]]` format) and rejection policies.
- `memoSummaryAgent.ts`: Specialized agent for generating concise memo summaries with structured output.
- `memoTagsAgent.ts`: Specialized agent for extracting relevant tags from memos, with existing tag reuse logic.
- `llmJudgeAgent.ts`: RAG evaluation agent comparing actual answers against expected ones for scoring (0-10).

## CONVENTIONS

- **State Management**: Use `Annotation.Root` from `@langchain/langgraph` for state schema in graphs.
- **LLM Access**: Always use `LLMService.getLLM()` with specific `purpose` ('chat', 'classification', etc.) to ensure correct model selection.
- **Structured Output**: Ingestion agents MUST use `withStructuredOutput` for reliable JSON extraction.
- **Streaming**: Chat responses use `AsyncGenerator<StreamChunk>` to handle multi-model response normalization (e.g., Anthropic vs OpenAI formats).

## UNIQUE STYLES

- **Linear Graph Flow**: RAG pipeline follows a fixed sequence: `history` -> `rewrite` -> `search` -> `properties` -> `rerank` -> `prompt`.
- **Node Self-Control**: Nodes decide whether to execute based on `ragConfig` (e.g., skipping reranking if disabled) to keep the graph topology static and predictable.
- **Concurrent Reranking**: The `rerank` node processes chunk batches (max 25) in parallel to stay within reranker token limits while maximizing throughput.
- **Citation Protocol**: Prompt instructions enforce strict `[[N]]` citation format for source referencing, which is then parsed by the frontend.
- **Reference Injection**: Appends a `references` chunk to the SSE stream after the final response token, mapping citation numbers to memo metadata.
