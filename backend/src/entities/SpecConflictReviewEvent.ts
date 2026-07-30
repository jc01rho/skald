import { DeferMode, Entity, Index, ManyToOne, PrimaryKey, Property, Unique } from '@mikro-orm/core'
import { Project } from '@/entities/Project'

@Entity({ tableName: 'skald_spec_conflict_review_event' })
@Unique({ name: 'skald_spec_conflict_review_event_project_uuid_key', properties: ['project', 'uuid'] })
@Unique({ name: 'skald_spec_conflict_review_event_project_request_id_key', properties: ['project', 'request_id'] })
@Index({
    name: 'skald_spec_conflict_review_event_project_candidate_created_idx',
    properties: ['project', 'candidate_key', 'created_at'],
})
export class SpecConflictReviewEvent {
    @PrimaryKey({ type: 'uuid' })
    uuid!: string

    @Property({ length: 512 })
    candidate_key!: string

    @Property({ nullable: true, type: 'uuid' })
    left_claim_id?: string | null

    @Property({ nullable: true, type: 'uuid' })
    right_claim_id?: string | null

    @Property({ type: 'uuid' })
    left_revision_id!: string

    @Property({ type: 'uuid' })
    right_revision_id!: string

    @Property({ length: 128 })
    left_evidence_hash!: string

    @Property({ length: 128 })
    right_evidence_hash!: string

    @Property({ length: 512 })
    actor_id!: string

    @Property({ length: 100 })
    decision!: string

    @Property({ type: 'text' })
    reason!: string

    @Property({ length: 512 })
    request_id!: string

    @Property({ nullable: true, type: 'uuid' })
    supersedes_event_id?: string | null

    @Property()
    created_at!: Date

    @ManyToOne({
        entity: () => Project,
        fieldName: 'project_id',
        deferMode: DeferMode.INITIALLY_DEFERRED,
        index: 'skald_spec_conflict_review_event_project_id_idx',
    })
    project!: Project
}
