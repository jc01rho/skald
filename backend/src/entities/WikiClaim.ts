import { DeferMode, Entity, Index, ManyToOne, PrimaryKey, Property } from '@mikro-orm/core'
import { Project } from '@/entities/Project'
import { WikiNode } from '@/entities/WikiNode'
import { WikiPage } from '@/entities/WikiPage'

export type WikiClaimType = 'fact' | 'summary' | 'faq' | 'relationship' | 'policy' | 'process_step'
export type WikiContradictionStatus = 'compatible' | 'supersedes' | 'contradicts' | 'uncertain'

@Entity({ tableName: 'skald_wiki_claim' })
@Index({ name: 'skald_wiki_claim_project_type_idx', properties: ['project', 'claim_type'] })
@Index({ name: 'skald_wiki_claim_page_idx', properties: ['page'] })
export class WikiClaim {
    @PrimaryKey({ type: 'uuid' })
    uuid!: string

    @Property()
    created_at!: Date

    @Property()
    updated_at!: Date

    @Property({ type: 'text' })
    claim_text!: string

    @Property({ length: 50 })
    claim_type!: WikiClaimType

    @Property({ default: 0.5 })
    confidence!: number

    @Property({ default: 0.5 })
    freshness!: number

    @Property({ length: 50, default: 'compatible' })
    contradiction_status!: WikiContradictionStatus

    @ManyToOne({
        entity: () => WikiPage,
        fieldName: 'page_id',
        deferMode: DeferMode.INITIALLY_DEFERRED,
        index: 'skald_wiki_claim_page_id_idx',
    })
    page!: WikiPage

    @ManyToOne({
        entity: () => WikiNode,
        fieldName: 'node_id',
        deferMode: DeferMode.INITIALLY_DEFERRED,
        nullable: true,
        index: 'skald_wiki_claim_node_id_idx',
    })
    node?: WikiNode | null

    @ManyToOne({
        entity: () => Project,
        fieldName: 'project_id',
        deferMode: DeferMode.INITIALLY_DEFERRED,
        index: 'skald_wiki_claim_project_id_idx',
    })
    project!: Project
}
