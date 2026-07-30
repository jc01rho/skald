import { DeferMode, Entity, Index, ManyToOne, PrimaryKey, Property, Unique } from '@mikro-orm/core'
import { Memo } from '@/entities/Memo'
import { Project } from '@/entities/Project'
import { SpecRevision } from '@/entities/SpecRevision'

@Entity({ tableName: 'skald_spec_source' })
@Unique({ name: 'skald_spec_source_project_uuid_key', properties: ['project', 'uuid'] })
@Unique({ name: 'skald_spec_source_project_spec_id_key', properties: ['project', 'spec_id'] })
@Unique({
    name: 'skald_spec_source_project_identity_key',
    properties: ['project', 'source_system', 'source_type', 'immutable_source_id'],
})
@Index({ name: 'skald_spec_source_project_memo_idx', properties: ['project', 'memo'] })
@Index({ name: 'skald_spec_source_project_active_revision_idx', properties: ['project', 'active_revision'] })
export class SpecSource {
    @PrimaryKey({ type: 'uuid' })
    uuid!: string

    @Property()
    created_at!: Date

    @Property()
    updated_at!: Date

    @Property({ length: 512 })
    spec_id!: string

    @Property({ length: 100 })
    source_system!: string

    @Property({ length: 100 })
    source_type!: string

    @Property({ length: 512 })
    immutable_source_id!: string

    @Property({ type: 'text' })
    source_locator!: string

    @Property({ length: 512 })
    memo_reference_id!: string

    @Property({ type: 'uuid' })
    memo_projection_revision_id!: string

    @Property({ length: 128 })
    memo_projection_canonical_hash!: string

    @ManyToOne({
        entity: () => Memo,
        joinColumns: ['project_id', 'memo_id', 'memo_reference_id'],
        referencedColumnNames: ['project_id', 'uuid', 'client_reference_id'],
        ownColumns: ['memo_id', 'memo_reference_id'],
        deferMode: DeferMode.INITIALLY_DEFERRED,
        foreignKeyName: 'skald_spec_source_project_memo_foreign',
    })
    memo!: Memo

    @ManyToOne({
        entity: () => SpecRevision,
        joinColumns: ['project_id', 'uuid', 'active_revision_id'],
        referencedColumnNames: ['project_id', 'source_id', 'uuid'],
        ownColumns: ['active_revision_id'],
        deferMode: DeferMode.INITIALLY_DEFERRED,
        nullable: true,
        foreignKeyName: 'skald_spec_source_project_active_revision_foreign',
    })
    active_revision?: SpecRevision | null

    @ManyToOne({
        entity: () => Project,
        fieldName: 'project_id',
        deferMode: DeferMode.INITIALLY_DEFERRED,
        index: 'skald_spec_source_project_id_idx',
    })
    project!: Project
}
