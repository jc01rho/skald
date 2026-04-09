import { DeferMode, Entity, Index, ManyToOne, PrimaryKey, Property, Unique } from '@mikro-orm/core'
import { Project } from '@/entities/Project'

export type WikiNodeType = 'concept' | 'entity' | 'process' | 'topic' | 'policy' | 'artifact' | 'metric' | 'event'

@Entity({ tableName: 'skald_wiki_node' })
@Unique({ name: 'skald_wiki_node_project_type_canonical_key', properties: ['project', 'node_type', 'canonical_name'] })
@Index({ name: 'skald_wiki_node_project_type_idx', properties: ['project', 'node_type'] })
export class WikiNode {
    @PrimaryKey({ type: 'uuid' })
    uuid!: string

    @Property()
    created_at!: Date

    @Property()
    updated_at!: Date

    @Property({ length: 50 })
    node_type!: WikiNodeType

    @Property({ length: 255 })
    canonical_name!: string

    @Property({ length: 255 })
    display_name!: string

    @Property({ nullable: true, type: 'text' })
    description?: string | null

    @Property({ type: 'json' })
    metadata: Record<string, unknown> = {}

    @Property({ default: 0.5 })
    confidence!: number

    @Property({ default: 0.5 })
    freshness!: number

    @ManyToOne({
        entity: () => Project,
        fieldName: 'project_id',
        deferMode: DeferMode.INITIALLY_DEFERRED,
        index: 'skald_wiki_node_project_id_idx',
    })
    project!: Project
}
