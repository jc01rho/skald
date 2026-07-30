import { DeferMode, Entity, Index, ManyToOne, PrimaryKey, Property, Unique } from '@mikro-orm/core'
import { Project } from '@/entities/Project'

@Entity({ tableName: 'skald_spec_traversal_snapshot' })
@Unique({ name: 'skald_spec_traversal_snapshot_project_uuid_key', properties: ['project', 'uuid'] })
@Index({ name: 'skald_spec_traversal_snapshot_project_expires_idx', properties: ['project', 'expires_at'] })
export class SpecTraversalSnapshot {
    @PrimaryKey({ type: 'uuid' })
    uuid!: string

    @Property()
    created_at!: Date

    @Property()
    expires_at!: Date

    @Property({ length: 64 })
    filter_hash!: string

    @Property({ length: 64 })
    auth_scope_hash!: string

    @Property({ length: 1024 })
    root_locator!: string

    @Property()
    max_depth!: number

    @Property()
    max_nodes!: number

    @Property()
    traversal_depth!: number

    @Property()
    traversal_complete!: boolean

    @Property({ nullable: true, length: 100 })
    truncated_reason?: string | null

    @Property()
    item_count!: number

    @Property({ nullable: true })
    graph_watermark?: Date | null

    @Property({ nullable: true })
    promotion_watermark?: Date | null

    @ManyToOne({
        entity: () => Project,
        fieldName: 'project_id',
        deferMode: DeferMode.INITIALLY_DEFERRED,
        index: 'skald_spec_traversal_snapshot_project_id_idx',
    })
    project!: Project
}
