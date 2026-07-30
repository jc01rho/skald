import { DeferMode, Entity, Index, ManyToOne, PrimaryKey, Property, Unique } from '@mikro-orm/core'
import { Project } from '@/entities/Project'
import { SpecRevision } from '@/entities/SpecRevision'
import { SpecSource } from '@/entities/SpecSource'

@Entity({ tableName: 'skald_spec_relation' })
@Unique({ name: 'skald_spec_relation_project_uuid_key', properties: ['project', 'uuid'] })
@Unique({
    name: 'skald_spec_relation_project_revision_relation_id_key',
    properties: ['project', 'source_revision', 'relation_id'],
})
@Index({
    name: 'skald_spec_relation_project_forward_idx',
    properties: ['project', 'source', 'source_revision', 'kind', 'target_source'],
})
@Index({
    name: 'skald_spec_relation_project_reverse_idx',
    properties: ['project', 'target_source', 'kind', 'source', 'source_revision'],
})
export class SpecRelation {
    @PrimaryKey({ type: 'uuid' })
    uuid!: string

    @Property()
    created_at!: Date

    @Property({ length: 512 })
    relation_id!: string

    @Property({ length: 100 })
    kind!: string

    @Property({ nullable: true, length: 512 })
    unresolved_target_spec_id?: string | null

    @Property({ nullable: true, length: 512 })
    source_relation_id?: string | null

    @Property({ nullable: true, length: 255 })
    display_label?: string | null

    @Property({ type: 'jsonb' })
    provenance: Record<string, unknown> = {}

    @Property({ type: 'jsonb' })
    evidence: Record<string, unknown>[] = []

    @Property({ type: 'jsonb' })
    properties: Record<string, unknown> = {}

    @ManyToOne({
        entity: () => SpecSource,
        joinColumns: ['project_id', 'source_id'],
        referencedColumnNames: ['project_id', 'uuid'],
        ownColumns: ['source_id'],
        deferMode: DeferMode.INITIALLY_DEFERRED,
        foreignKeyName: 'skald_spec_relation_project_source_foreign',
    })
    source!: SpecSource

    @ManyToOne({
        entity: () => SpecRevision,
        joinColumns: ['project_id', 'source_id', 'source_revision_id'],
        referencedColumnNames: ['project_id', 'source_id', 'uuid'],
        ownColumns: ['source_revision_id'],
        deferMode: DeferMode.INITIALLY_DEFERRED,
        foreignKeyName: 'skald_spec_relation_project_revision_foreign',
    })
    source_revision!: SpecRevision

    @ManyToOne({
        entity: () => SpecSource,
        joinColumns: ['project_id', 'target_source_id'],
        referencedColumnNames: ['project_id', 'uuid'],
        ownColumns: ['target_source_id'],
        deferMode: DeferMode.INITIALLY_DEFERRED,
        nullable: true,
        foreignKeyName: 'skald_spec_relation_project_target_foreign',
    })
    target_source?: SpecSource | null

    @ManyToOne({
        entity: () => Project,
        fieldName: 'project_id',
        deferMode: DeferMode.INITIALLY_DEFERRED,
        index: 'skald_spec_relation_project_id_idx',
    })
    project!: Project
}
