import { DeferMode, Entity, Index, ManyToOne, PrimaryKey, Property, Unique } from '@mikro-orm/core'
import { Project } from '@/entities/Project'
import { WikiPageRevision } from '@/entities/WikiPageRevision'
import { RawSourceDocument } from '@/entities/RawSourceDocument'

@Entity({ tableName: 'skald_wiki_page_source_link' })
@Unique({ name: 'skald_wiki_page_source_link_unique_key', properties: ['wiki_page_revision', 'raw_source_document'] })
@Index({ name: 'skald_wiki_page_source_link_revision_idx', properties: ['wiki_page_revision'] })
@Index({ name: 'skald_wiki_page_source_link_source_idx', properties: ['raw_source_document'] })
export class WikiPageSourceLink {
    @PrimaryKey({ type: 'uuid' })
    uuid!: string

    @Property()
    created_at!: Date

    @Property({ nullable: true, type: 'json' })
    contribution_metadata?: Record<string, unknown> | null

    @ManyToOne({
        entity: () => WikiPageRevision,
        fieldName: 'wiki_page_revision_id',
        deferMode: DeferMode.INITIALLY_DEFERRED,
        index: 'skald_wiki_page_source_link_revision_id_idx',
    })
    wiki_page_revision!: WikiPageRevision

    @ManyToOne({
        entity: () => RawSourceDocument,
        fieldName: 'raw_source_document_id',
        deferMode: DeferMode.INITIALLY_DEFERRED,
        index: 'skald_wiki_page_source_link_document_id_idx',
    })
    raw_source_document!: RawSourceDocument

    @ManyToOne({
        entity: () => Project,
        fieldName: 'project_id',
        deferMode: DeferMode.INITIALLY_DEFERRED,
        index: 'skald_wiki_page_source_link_project_id_idx',
    })
    project!: Project
}
