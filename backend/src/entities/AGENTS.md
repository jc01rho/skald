# DATABASE ENTITIES

**Generated:** 2026-01-12
**Domain:** Data Layer (Score 15)

## OVERVIEW

MikroORM entity definitions for PostgreSQL with pgvector support.

## WHERE TO LOOK

| Entity            | File                 | Purpose                                        |
| ----------------- | -------------------- | ---------------------------------------------- |
| Memo              | Memo.ts              | Core RAG data with metadata, processing status |
| MemoChunk         | MemoChunk.ts         | Vector-searchable chunks                       |
| MemoContent       | MemoContent.ts       | Original content storage                       |
| MemoSummary       | MemoSummary.ts       | AI-generated summaries                         |
| MemoTag           | MemoTag.ts           | Memo metadata tags                             |
| Chat              | Chat.ts              | Chat sessions                                  |
| ChatMessage       | ChatMessage.ts       | Chat history                                   |
| Project           | Project.ts           | User projects                                  |
| Organization      | Organization.ts      | Multi-tenant orgs                              |
| EvaluationDataset | EvaluationDataset.ts | Q&A datasets                                   |
| Experiment        | Experiment.ts        | RAG A/B tests                                  |

## CONVENTIONS

**Entity Structure**

```typescript
@Entity({ tableName: 'skald_entity' })
export class Entity {
    @PrimaryKey({ type: 'uuid' })
    uuid!: string

    @Property()
    created_at!: Date

    @ManyToOne({ entity: () => Related, fieldName: 'field_id' })
    related!: Related
}
```

**Indexing**

```typescript
@Index({ name: 'index_name', properties: ['project', 'status'] })
@Index({ expression: 'CREATE INDEX name USING gin (column)' })
```

**Relationships**

- `@ManyToOne` with `DeferMode.INITIALLY_DEFERRED`
- Foreign keys via `fieldName` parameter

**JSON Fields**

- `@Property({ type: 'json' })` for metadata

**Processing Status Enum**

`type ProcessingStatus = 'received' | 'processing' | 'processed' | 'error'`

## ANTI-PATTERNS

- NEVER mix entity logic with business logic (use services/agents)
- NEVER create indexes without names for troubleshooting
- NEVER use complex joins in entity files (use queries/)

## LLM ENDPOINT POLICY

- 모든 모델 호출(Gemini 포함)은 **코드 하드코딩 금지**이며, 환경변수(`CLI_PROXY_API_BASE_URL`, `GEMINI_API_BASE_URL`)로만 지정합니다.
- `CLI_PROXY_API_BASE_URL`와 `GEMINI_API_BASE_URL`는 동일한 값을 사용해야 합니다.
