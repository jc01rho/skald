import { DeferMode, Entity, Index, ManyToOne, PrimaryKey, Property, Unique } from '@mikro-orm/core'
import { Project } from '@/entities/Project'
import { WikiNode } from '@/entities/WikiNode'

export type WikiEdgeType =
    | 'defines'
    | 'relates_to'
    | 'depends_on'
    | 'part_of'
    | 'contrasts_with'
    | 'supersedes'
    | 'supported_by'
    | 'contradicts'
    | 'derived_from'
    | 'mentioned_in'

@Entity({ tableName: 'skald_wiki_edge' })
@Unique({
    name: 'skald_wiki_edge_project_from_to_type_key',
    properties: ['project', 'from_node', 'to_node', 'edge_type'],
})
@Index({ name: 'skald_wiki_edge_project_type_idx', properties: ['project', 'edge_type'] })
@Index({ name: 'skald_wiki_edge_from_to_idx', properties: ['from_node', 'to_node'] })
export class WikiEdge {
    @PrimaryKey({ type: 'uuid' })
    uuid!: string

    @Property()
    created_at!: Date

    @Property()
    updated_at!: Date

    @Property({ length: 50 })
    edge_type!: WikiEdgeType

    @Property({ default: 1 })
    weight!: number

    @Property({ nullable: true, length: 50 })
    provenance_type?: string | null

    @ManyToOne({
        entity: () => WikiNode,
        fieldName: 'from_node_id',
        deferMode: DeferMode.INITIALLY_DEFERRED,
        index: 'skald_wiki_edge_from_node_id_idx',
    })
    from_node!: WikiNode

    @ManyToOne({
        entity: () => WikiNode,
        fieldName: 'to_node_id',
        deferMode: DeferMode.INITIALLY_DEFERRED,
        index: 'skald_wiki_edge_to_node_id_idx',
    })
    to_node!: WikiNode

    @ManyToOne({
        entity: () => Project,
        fieldName: 'project_id',
        deferMode: DeferMode.INITIALLY_DEFERRED,
        index: 'skald_wiki_edge_project_id_idx',
    })
    project!: Project
}
