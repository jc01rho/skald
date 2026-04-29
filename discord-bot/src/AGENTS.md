# DISCORD BOT SOURCE

**Generated:** 2026-04-29
**Domain:** Discord Mention Integration (Score 12)

## OVERVIEW

Discord bot listens for mentions, sends Skald chat stream requests, and edits/splits Discord replies as tokens and references arrive.

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| Mention flow | `handlers/mentionHandler.ts` | query parsing, thread history, stream consumption |
| Stream editing | `discord/DiscordStreamEditor.ts` | throttled edits, split messages, final cursor removal |
| Skald client | `client/SkaldClient.ts`, `client/types.ts` | SSE parsing, `transport_error` event type |
| Tests | `*.test.ts` colocated with handler/editor | ESM import/env ordering gotchas |

## CONVENTIONS

- `SkaldClient.chatStream()` emits `transport_error` after partial token delivery instead of retrying the request.
- Mention handler records `references` SSE events before finalizing replies.
- Numeric error-code questions skip automatic product-id filtering to avoid hiding manual-submission evidence.
- `DiscordStreamEditor` throttles edits at 400ms and splits long responses across messages.
- Tests must set environment before dynamic imports; static import hoisting evaluates modules too early.

## ANTI-PATTERNS

- Do not infinite-retry after partial Discord stream output; preserve partial response and surface transport error.
- Do not lose references when finalizing a Discord reply.
- Do not assume browser/manual Discord QA is available in this environment.
- Do not hardcode Skald URLs or Discord credentials in source/tests.
