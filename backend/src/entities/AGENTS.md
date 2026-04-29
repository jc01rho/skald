# BACKEND ENTITIES

**Generated:** 2026-04-29
**Domain:** MikroORM Models (Score 11)

## OVERVIEW

Entities define PostgreSQL/pgvector persistence for users, projects, memos, retrieval artifacts, wiki materialization, billing, and evaluation.

## WHERE TO LOOK

| Domain | Entities | Notes |
| --- | --- | --- |
| User/auth | `User.ts`, `EmailVerificationCode.ts`, `PasswordResetToken.ts` | email/password/OAuth auth paths |
| Organization/billing | `OrganizationMembership*.ts`, `OrganizationSubscription.ts`, `Plan.ts`, `StripeEvent.ts`, `UsageRecord.ts` | membership, plan, Stripe event state |
| Project | `Project.ts`, `ProjectAPIKey.ts`, `ProjectSweepState.ts` | project config, public chat/wiki gates, sweep state |
| Source content | `Document.ts`, `JiraIssue.ts`, `NotionPage.ts`, `RawSourceContent.ts`, `RawSourceDocument.ts` | external source records |
| Memo core | `Memo.ts`, `MemoContent.ts`, `MemoChunk.ts`, `MemoParentChunk.ts` | approved searchable content |
| Memo workflow | `MemoSubmission.ts`, `SearchRequest.ts` | manual submission/review/search request state |
| Wiki | `WikiPage.ts`, `WikiPageRevision.ts`, `WikiClaim.ts`, `WikiClaimSourceRef.ts`, `WikiCompileRun.ts`, `WikiNode.ts`, `WikiEdge.ts`, `WikiPageLink.ts`, `WikiPageSourceLink.ts`, `WikiRefreshRequest.ts`, `WikiRule.ts`, `WikiSourceRef.ts` | DB-backed wiki materialization |
| Evaluation | `EvaluationDataset.ts`, `EvaluationDatasetQuestion.ts`, `Experiment.ts`, `ExperimentResult.ts`, `GroundTruth.ts`, `QueryResult.ts` | evaluation datasets and run outputs |

## CONVENTIONS

- Use MikroORM decorators; keep vector-capable fields compatible with pgvector migrations.
- Wiki current state is `WikiPage`; immutable history is `WikiPageRevision`.
- Release memos store metadata keys including `product_id`, `version`, and `release_date`.
- Document uploads use SHA256 in `metadata.file_hash` to skip unchanged processing.
- Manual-submission enrichment fields (`search_aliases`, `search_text`, `title_tokens`) are preview/retrieval surfaces, not separate source truth.

## ANTI-PATTERNS

- Do not add entity fields without matching migrations.
- Do not store plaintext secrets or passwords in entities; passwords are hashed.
- Do not rely on external issue keys for exact error-code lookup; code search uses `MemoContent`/`MemoChunk` text.
- Do not enqueue rechunking for unchanged memo inputs.
