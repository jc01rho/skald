import { DeferMode, Entity, Index, ManyToOne, PrimaryKey, Property } from '@mikro-orm/core'
import { Memo } from '@/entities/Memo'
import { MemoChunk } from '@/entities/MemoChunk'
import { MemoSummary } from '@/entities/MemoSummary'
import { Project } from '@/entities/Project'
import { RawSourceDocument } from '@/entities/RawSourceDocument'

export type WikiSourceKind = 'memo' | 'memo_chunk' | 'memo_summary' | 'raw_source'

@Entity({ tableName: 'skald_wiki_source_ref' })
@Index({ name: 'skald_wiki_source_ref_project_kind_idx', properties: ['project', 'source_kind'] })
export class WikiSourceRef {
    @PrimaryKey({ type: 'uuid' })
    uuid!: string

    @Property()
    created_at!: Date

    @Property({ length: 50 })
    source_kind!: WikiSourceKind

    @Property({ nullable: true, type: 'text' })
    locator_text?: string | null

    @Property({ nullable: true, type: 'text' })
    excerpt?: string | null

    @ManyToOne({
        entity: () => Memo,
        fieldName: 'memo_id',
        deferMode: DeferMode.INITIALLY_DEFERRED,
        nullable: true,
        index: 'skald_wiki_source_ref_memo_id_idx',
    })
    memo?: Memo | null

    @ManyToOne({
        entity: () => MemoChunk,
        fieldName: 'memo_chunk_id',
        deferMode: DeferMode.INITIALLY_DEFERRED,
        nullable: true,
        index: 'skald_wiki_source_ref_chunk_id_idx',
    })
    memo_chunk?: MemoChunk | null

    @ManyToOne({
        entity: () => MemoSummary,
        fieldName: 'memo_summary_id',
        deferMode: DeferMode.INITIALLY_DEFERRED,
        nullable: true,
        index: 'skald_wiki_source_ref_summary_id_idx',
    })
    memo_summary?: MemoSummary | null

    @ManyToOne({
        entity: () => RawSourceDocument,
        fieldName: 'raw_source_document_id',
        deferMode: DeferMode.INITIALLY_DEFERRED,
        nullable: true,
        index: 'skald_wiki_source_ref_raw_source_document_id_idx',
    })
    raw_source_document?: RawSourceDocument | null

    @ManyToOne({
        entity: () => Project,
        fieldName: 'project_id',
        deferMode: DeferMode.INITIALLY_DEFERRED,
        index: 'skald_wiki_source_ref_project_id_idx',
    })
    project!: Project
}
