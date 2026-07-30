import { DeferMode, Entity, Index, ManyToOne, PrimaryKey, Property, Unique } from '@mikro-orm/core'
import { Project } from '@/entities/Project'
import { SpecSource } from '@/entities/SpecSource'

@Entity({ tableName: 'skald_spec_revision' })
@Unique({ name: 'skald_spec_revision_project_uuid_key', properties: ['project', 'uuid'] })
@Unique({
    name: 'skald_spec_revision_project_source_number_key',
    properties: ['project', 'source', 'revision_number'],
})
@Unique({
    name: 'skald_spec_revision_project_source_idempotency_key',
    properties: ['project', 'source', 'idempotency_key'],
})
@Unique({
    name: 'skald_spec_revision_project_source_uuid_key',
    properties: ['project', 'source', 'uuid'],
})
@Index({ name: 'skald_spec_revision_project_source_created_idx', properties: ['project', 'source', 'created_at'] })
@Index({ name: 'skald_spec_revision_project_canonical_hash_idx', properties: ['project', 'canonical_hash'] })
export class SpecRevision {
    @PrimaryKey({ type: 'uuid' })
    uuid!: string

    @Property()
    created_at!: Date

    @Property()
    revision_number!: number

    @Property({ length: 512 })
    idempotency_key!: string

    @Property({ length: 255 })
    title!: string

    @Property({ length: 255 })
    display_label!: string

    @Property({ type: 'text' })
    content!: string

    @Property({ type: 'jsonb' })
    metadata: Record<string, unknown> = {}

    @Property({ length: 128 })
    payload_hash!: string

    @Property({ length: 128 })
    content_hash!: string

    @Property({ length: 128 })
    metadata_hash!: string

    @Property({ length: 128 })
    relation_hash!: string

    @Property({ length: 128 })
    claim_hash!: string

    @Property({ length: 128 })
    relation_input_hash!: string

    @Property({ length: 128 })
    canonical_hash!: string

    @ManyToOne({
        entity: () => SpecSource,
        joinColumns: ['project_id', 'source_id'],
        referencedColumnNames: ['project_id', 'uuid'],
        ownColumns: ['source_id'],
        deferMode: DeferMode.INITIALLY_DEFERRED,
        foreignKeyName: 'skald_spec_revision_project_source_foreign',
    })
    source!: SpecSource

    @ManyToOne({
        entity: () => Project,
        fieldName: 'project_id',
        deferMode: DeferMode.INITIALLY_DEFERRED,
        index: 'skald_spec_revision_project_id_idx',
    })
    project!: Project
}
