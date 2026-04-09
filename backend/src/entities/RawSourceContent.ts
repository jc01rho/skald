import { DeferMode, Entity, Index, ManyToOne, PrimaryKey, Property, Unique } from '@mikro-orm/core'
import { Project } from '@/entities/Project'
import { RawSourceDocument } from '@/entities/RawSourceDocument'

@Entity({ tableName: 'skald_raw_source_content' })
@Index({ name: 'skald_raw_source_content_document_idx', properties: ['raw_source_document', 'created_at'] })
@Unique({
    name: 'skald_raw_source_content_document_hash_key',
    properties: ['raw_source_document', 'content_hash'],
})
export class RawSourceContent {
    @PrimaryKey({ type: 'uuid' })
    uuid!: string

    @Property()
    created_at!: Date

    @Property({ type: 'text' })
    content!: string

    @Property({ nullable: true })
    content_hash?: string | null

    @Property({ nullable: true })
    content_length?: number | null

    @Property({ nullable: true, type: 'json' })
    extraction_metadata?: Record<string, unknown> | null

    @ManyToOne({
        entity: () => RawSourceDocument,
        fieldName: 'raw_source_document_id',
        deferMode: DeferMode.INITIALLY_DEFERRED,
        index: 'skald_raw_source_content_document_id_idx',
    })
    raw_source_document!: RawSourceDocument

    @ManyToOne({
        entity: () => Project,
        fieldName: 'project_id',
        deferMode: DeferMode.INITIALLY_DEFERRED,
        index: 'skald_raw_source_content_project_id_idx',
    })
    project!: Project
}
