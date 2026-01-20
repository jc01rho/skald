import { DeferMode, Entity, ManyToOne, PrimaryKey, Property } from '@mikro-orm/core'
import { Memo } from '@/entities/Memo'
import { Project } from '@/entities/Project'

/**
 * Parent chunk for parent-child chunking strategy.
 *
 * Parent chunks are larger (2048 chars) and store context for LLM responses.
 * They do NOT have embeddings - only child chunks are searchable.
 *
 * Retrieval flow:
 * 1. Search child chunks (MemoChunk) via vector similarity
 * 2. Fetch parent chunk for matched children
 * 3. Use parent chunk content as LLM context
 */
@Entity({ tableName: 'skald_memoparentchunk' })
export class MemoParentChunk {
    @PrimaryKey({ type: 'uuid' })
    uuid!: string

    @Property({ type: 'text' })
    chunk_content!: string

    @Property()
    chunk_index!: number

    @Property({ type: 'uuid' })
    memo_uuid!: string

    @Property({ type: 'uuid' })
    project_uuid!: string

    @ManyToOne({
        entity: () => Memo,
        fieldName: 'memo_id',
        deferMode: DeferMode.INITIALLY_DEFERRED,
        index: 'skald_memoparentchunk_memo_id',
    })
    memo!: Memo

    @ManyToOne({
        entity: () => Project,
        fieldName: 'project_id',
        deferMode: DeferMode.INITIALLY_DEFERRED,
        index: 'skald_memoparentchunk_project_id',
    })
    project!: Project
}
