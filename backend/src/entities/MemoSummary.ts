import { DeferMode, Entity, ManyToOne, PrimaryKey, Property } from '@mikro-orm/core'
import { Memo } from '@/entities/Memo'
import { Project } from '@/entities/Project'

@Entity({ tableName: 'skald_memosummary' })
export class MemoSummary {
    @PrimaryKey({ type: 'uuid' })
    uuid!: string

    @Property({ type: 'text' })
    summary!: string

    @Property({ columnType: 'vector(2048)', ignoreSchemaChanges: ['type'] })
    embedding!: unknown

    // v2 embedding (512-dim). NULL until dual-write or backfillEmbeddingV2 fills it.
    @Property({ columnType: 'vector(512)', nullable: true, ignoreSchemaChanges: ['type'] })
    embedding_v2?: unknown

    @ManyToOne({
        entity: () => Memo,
        fieldName: 'memo_id',
        deferMode: DeferMode.INITIALLY_DEFERRED,
        index: 'skald_memosummary_memo_id_43ac3024',
    })
    memo!: Memo

    @ManyToOne({
        entity: () => Project,
        fieldName: 'project_id',
        deferMode: DeferMode.INITIALLY_DEFERRED,
        index: 'skald_memosummary_project_id_95cfb327',
    })
    project!: Project
}
