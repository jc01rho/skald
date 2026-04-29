# BACKEND MIGRATIONS

**Generated:** 2026-04-29
**Domain:** MikroORM Schema Changes (Score 10)

## OVERVIEW

Migrations preserve PostgreSQL schema for auth, billing, memos, vectors, and wiki materialization.

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| Migration files | `Migration*.ts` | chronological schema evolution |
| Entity source | `../entities/` | field definitions must match migrations |
| pgvector fields | memo/vector migrations | keep extension/index compatibility |
| Wiki tables | wiki-related migrations | current pages, revisions, claims, graph, refresh queue |

## CONVENTIONS

- Entity changes require a migration in the same work unit.
- Prefer additive, reversible-safe changes for production data.
- Keep defaults/backfills explicit when adding non-nullable fields.
- Treat vector indexes and wiki materialization tables as production data paths.

## ANTI-PATTERNS

- Do not call application services or `LLMService` from migrations.
- Do not drop production data/PVC-backed assumptions casually.
- Do not add secrets or environment-specific values into migrations.
