import { DeferMode, Entity, Index, ManyToOne, PrimaryKey, Property, Unique } from '@mikro-orm/core'
import { Project } from '@/entities/Project'

@Entity({ tableName: 'skald_spec_reconciliation_run' })
@Unique({ name: 'skald_spec_reconciliation_run_project_uuid_key', properties: ['project', 'uuid'] })
@Unique({
    name: 'skald_spec_reconciliation_run_project_scope_run_id_key',
    properties: ['project', 'scope_key', 'run_id'],
})
@Index({
    name: 'skald_spec_reconciliation_run_project_scope_completed_idx',
    properties: ['project', 'scope_key', 'completed_at'],
})
export class SpecReconciliationRun {
    @PrimaryKey({ type: 'uuid' })
    uuid!: string

    @Property({ length: 512 })
    run_id!: string

    @Property({ length: 512 })
    scope_key!: string

    @Property({ nullable: true, length: 100 })
    source_system?: string | null

    @Property({ nullable: true, length: 100 })
    source_type?: string | null

    @Property()
    authoritative = false

    @Property()
    complete = false

    @Property({ nullable: true, length: 128 })
    manifest_hash?: string | null

    @Property()
    identity_drift = 0

    @Property()
    revision_drift = 0

    @Property()
    authorization_drift = 0

    @Property()
    relation_drift = 0

    @Property()
    claim_drift = 0

    @Property()
    memo_link_drift = 0

    @Property()
    started_at!: Date

    @Property({ nullable: true })
    completed_at?: Date | null

    @ManyToOne({
        entity: () => Project,
        fieldName: 'project_id',
        deferMode: DeferMode.INITIALLY_DEFERRED,
        index: 'skald_spec_reconciliation_run_project_id_idx',
    })
    project!: Project

    isCleanAuthoritative(): boolean {
        return (
            this.authoritative &&
            this.complete &&
            Boolean(this.manifest_hash) &&
            Boolean(this.completed_at) &&
            this.identity_drift === 0 &&
            this.revision_drift === 0 &&
            this.authorization_drift === 0 &&
            this.relation_drift === 0 &&
            this.claim_drift === 0 &&
            this.memo_link_drift === 0
        )
    }
}
