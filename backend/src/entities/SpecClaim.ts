import { DeferMode, Entity, Index, ManyToOne, PrimaryKey, Property, Unique } from '@mikro-orm/core'
import { Project } from '@/entities/Project'
import { SpecRevision } from '@/entities/SpecRevision'
import { SpecSource } from '@/entities/SpecSource'

@Entity({ tableName: 'skald_spec_claim' })
@Unique({ name: 'skald_spec_claim_project_uuid_key', properties: ['project', 'uuid'] })
@Unique({
    name: 'skald_spec_claim_project_revision_claim_id_key',
    properties: ['project', 'source_revision', 'claim_id'],
})
@Index({
    name: 'skald_spec_claim_project_source_revision_idx',
    properties: ['project', 'source', 'source_revision', 'kind'],
})
@Index({ name: 'skald_spec_claim_project_normalized_idx', properties: ['project', 'subject', 'predicate'] })
export class SpecClaim {
    @PrimaryKey({ type: 'uuid' })
    uuid!: string

    @Property()
    created_at!: Date

    @Property({ length: 512 })
    claim_id!: string

    @Property({ length: 100 })
    kind!: string

    @Property({ type: 'text' })
    text!: string

    @Property({ nullable: true, length: 255 })
    display_label?: string | null

    @Property({ nullable: true, type: 'text' })
    subject?: string | null

    @Property({ nullable: true, type: 'text' })
    predicate?: string | null

    @Property({ nullable: true, type: 'text' })
    value?: string | null

    @Property({ nullable: true, length: 100 })
    unit?: string | null

    @Property({ nullable: true, type: 'text' })
    condition?: string | null

    @Property({ nullable: true, type: 'text' })
    object?: string | null

    @Property({ nullable: true, type: 'text' })
    evidence_excerpt?: string | null

    @Property({ nullable: true, type: 'text' })
    evidence_path?: string | null

    @Property({ nullable: true, length: 128 })
    evidence_hash?: string | null

    @Property({ type: 'jsonb' })
    evidence: Record<string, unknown>[] = []

    @Property({ length: 100 })
    extractor_version!: string

    @Property({ length: 100 })
    rule_version!: string

    @ManyToOne({
        entity: () => SpecSource,
        joinColumns: ['project_id', 'source_id'],
        referencedColumnNames: ['project_id', 'uuid'],
        ownColumns: ['source_id'],
        deferMode: DeferMode.INITIALLY_DEFERRED,
        foreignKeyName: 'skald_spec_claim_project_source_foreign',
    })
    source!: SpecSource

    @ManyToOne({
        entity: () => SpecRevision,
        joinColumns: ['project_id', 'source_id', 'source_revision_id'],
        referencedColumnNames: ['project_id', 'source_id', 'uuid'],
        ownColumns: ['source_revision_id'],
        deferMode: DeferMode.INITIALLY_DEFERRED,
        foreignKeyName: 'skald_spec_claim_project_revision_foreign',
    })
    source_revision!: SpecRevision

    @ManyToOne({
        entity: () => Project,
        fieldName: 'project_id',
        deferMode: DeferMode.INITIALLY_DEFERRED,
        index: 'skald_spec_claim_project_id_idx',
    })
    project!: Project
}
