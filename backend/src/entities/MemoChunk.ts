import { DeferMode, Entity, ManyToOne, PrimaryKey, Property } from '@mikro-orm/core'
import { Memo } from '@/entities/Memo'
import { Project } from '@/entities/Project'
import { MemoParentChunk } from '@/entities/MemoParentChunk'

@Entity({ tableName: 'skald_memochunk' })
export class MemoChunk {
    @PrimaryKey({ type: 'uuid' })
    uuid!: string

    @Property({ type: 'text' })
    chunk_content!: string

    @Property()
    chunk_index!: number

    // 512-dim embedding (the only embedding). The legacy `embedding` vector(2048) column is no longer mapped.
    @Property({ columnType: 'vector(512)', nullable: true, ignoreSchemaChanges: ['type'] })
    embedding_v2?: unknown

    @Property({ type: 'uuid' })
    memo_uuid!: string

    @Property({ type: 'uuid' })
    project_uuid!: string

    @Property({ type: 'uuid', nullable: true })
    parent_chunk_uuid?: string

    @ManyToOne({
        entity: () => Memo,
        fieldName: 'memo_id',
        deferMode: DeferMode.INITIALLY_DEFERRED,
        index: 'skald_memochunk_memo_id_0faad25b',
    })
    memo!: Memo

    @ManyToOne({
        entity: () => Project,
        fieldName: 'project_id',
        deferMode: DeferMode.INITIALLY_DEFERRED,
        index: 'skald_memochunk_project_id_6ec66677',
    })
    project!: Project

    @ManyToOne({
        entity: () => MemoParentChunk,
        fieldName: 'parent_chunk_id',
        deferMode: DeferMode.INITIALLY_DEFERRED,
        nullable: true,
        index: 'skald_memochunk_parent_chunk_id',
    })
    parent_chunk?: MemoParentChunk
}
