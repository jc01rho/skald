import { DeferMode, Entity, Index, ManyToOne, PrimaryKey, Property, Unique } from '@mikro-orm/core'
import { Project } from '@/entities/Project'
import { User } from '@/entities/User'
import { WikiPage } from '@/entities/WikiPage'

@Entity({ tableName: 'skald_wiki_page_revision' })
@Unique({ name: 'skald_wiki_page_revision_page_version_key', properties: ['wiki_page', 'version'] })
@Index({ name: 'skald_wiki_page_revision_page_version_idx', properties: ['wiki_page', 'version'] })
@Index({ name: 'skald_wiki_page_revision_project_created_idx', properties: ['project', 'created_at'] })
export class WikiPageRevision {
    @PrimaryKey({ type: 'uuid' })
    uuid!: string

    @Property()
    created_at!: Date

    @Property()
    version!: number

    @Property({ length: 255 })
    title!: string

    @Property({ length: 255 })
    slug!: string

    @Property({ type: 'text' })
    content!: string

    @Property({ nullable: true, length: 50 })
    page_type?: string | null

    @Property({ nullable: true, length: 255 })
    canonical?: string | null

    @Property({ nullable: true })
    confidence?: number | null

    @Property({ nullable: true })
    freshness?: number | null

    @Property({ nullable: true, length: 50 })
    review_status?: string | null

    @Property({ nullable: true })
    source_coverage_score?: number | null

    @Property({ nullable: true, length: 50 })
    management_mode?: string | null

    @Property({ type: 'json' })
    metadata: Record<string, unknown> = {}

    @Property({ nullable: true, type: 'text' })
    summary?: string | null

    @Property({ nullable: true, type: 'text' })
    change_note?: string | null

    @ManyToOne({
        entity: () => WikiPage,
        fieldName: 'wiki_page_id',
        deferMode: DeferMode.INITIALLY_DEFERRED,
        index: 'skald_wiki_page_revision_page_id_idx',
    })
    wiki_page!: WikiPage

    @ManyToOne({
        entity: () => Project,
        fieldName: 'project_id',
        deferMode: DeferMode.INITIALLY_DEFERRED,
        index: 'skald_wiki_page_revision_project_id_idx',
    })
    project!: Project

    @ManyToOne({
        entity: () => User,
        fieldName: 'created_by_id',
        deferMode: DeferMode.INITIALLY_DEFERRED,
        nullable: true,
        index: 'skald_wiki_page_revision_created_by_id_idx',
    })
    created_by?: User | null
}
