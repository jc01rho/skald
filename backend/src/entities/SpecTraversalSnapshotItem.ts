import { DeferMode, Entity, ManyToOne, PrimaryKey, Property, Unique } from '@mikro-orm/core'
import { Project } from '@/entities/Project'
import { SpecTraversalSnapshot } from '@/entities/SpecTraversalSnapshot'

@Entity({ tableName: 'skald_spec_traversal_snapshot_item' })
@Unique({ name: 'skald_spec_traversal_snapshot_item_project_snapshot_ordinal_key', properties: ['project', 'snapshot', 'ordinal'] })
export class SpecTraversalSnapshotItem {
    @PrimaryKey({ type: 'uuid' })
    uuid!: string

    @Property()
    ordinal!: number

    @Property({ length: 20 })
    item_type!: string

    @Property({ type: 'jsonb' })
    payload!: Record<string, unknown>

    @ManyToOne({
        entity: () => SpecTraversalSnapshot,
        joinColumns: ['project_id', 'snapshot_id'],
        referencedColumnNames: ['project_id', 'uuid'],
        ownColumns: ['snapshot_id'],
        deferMode: DeferMode.INITIALLY_DEFERRED,
        foreignKeyName: 'skald_spec_traversal_snapshot_item_snapshot_foreign',
    })
    snapshot!: SpecTraversalSnapshot

    @ManyToOne({
        entity: () => Project,
        fieldName: 'project_id',
        deferMode: DeferMode.INITIALLY_DEFERRED,
        index: 'skald_spec_traversal_snapshot_item_project_id_idx',
    })
    project!: Project
}
