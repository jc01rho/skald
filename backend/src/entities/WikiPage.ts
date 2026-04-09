import { DeferMode, Entity, Index, ManyToOne, PrimaryKey, Property, Unique } from '@mikro-orm/core'
import { Project } from '@/entities/Project'
import { User } from '@/entities/User'

export type WikiPageType =
    | 'concept_page'
    | 'entity_page'
    | 'process_page'
    | 'faq_page'
    | 'comparison_page'
    | 'synthesis_page'
    | 'source_digest_page'
    | 'index_page'

export type WikiReviewStatus = 'draft' | 'verified' | 'needs_review'
export type WikiManagementMode = 'manual' | 'llm'

@Entity({ tableName: 'skald_wiki_page' })
@Unique({ name: 'skald_wiki_page_project_slug_key', properties: ['project', 'slug'] })
@Index({ name: 'skald_wiki_page_project_updated_idx', properties: ['project', 'updated_at'] })
export class WikiPage {
    @PrimaryKey({ type: 'uuid' })
    uuid!: string

    @Property()
    created_at!: Date

    @Property()
    updated_at!: Date

    @Property({ length: 255 })
    title!: string

    @Property({ length: 255 })
    slug!: string

    @Property({ type: 'text' })
    content!: string

    @Property({ length: 50, default: 'source_digest_page' })
    page_type!: WikiPageType

    @Property({ nullable: true, length: 255 })
    canonical?: string | null

    @Property({ default: 0.5 })
    confidence!: number

    @Property({ default: 0.5 })
    freshness!: number

    @Property({ length: 50, default: 'draft' })
    review_status!: WikiReviewStatus

    @Property({ default: 0 })
    source_coverage_score!: number

    @Property({ length: 50, default: 'manual' })
    management_mode!: WikiManagementMode

    @Property({ type: 'json' })
    metadata: Record<string, unknown> = {}

    @Property({ nullable: true, type: 'text' })
    summary?: string | null

    @Property({ default: 1 })
    revision_count!: number

    @ManyToOne({
        entity: () => Project,
        fieldName: 'project_id',
        deferMode: DeferMode.INITIALLY_DEFERRED,
        index: 'skald_wiki_page_project_id_idx',
    })
    project!: Project

    @ManyToOne({
        entity: () => User,
        fieldName: 'created_by_id',
        deferMode: DeferMode.INITIALLY_DEFERRED,
        nullable: true,
        index: 'skald_wiki_page_created_by_id_idx',
    })
    created_by?: User | null

    @ManyToOne({
        entity: () => User,
        fieldName: 'updated_by_id',
        deferMode: DeferMode.INITIALLY_DEFERRED,
        nullable: true,
        index: 'skald_wiki_page_updated_by_id_idx',
    })
    updated_by?: User | null
}
