import { DeferMode, Entity, Index, ManyToOne, PrimaryKey, Property } from '@mikro-orm/core'
import { Project } from '@/entities/Project'
import { User } from '@/entities/User'

export type MemoSubmissionStatus = 'pending' | 'approved' | 'rejected'

@Entity({ tableName: 'skald_memo_submission' })
@Index({ name: 'skald_memo_submission_project_status_idx', properties: ['project', 'status'] })
@Index({ name: 'skald_memo_submission_created_at_idx', properties: ['created_at'] })
export class MemoSubmission {
    @PrimaryKey({ type: 'uuid' })
    uuid!: string

    @Property()
    created_at!: Date

    @Property()
    updated_at!: Date

    @Property()
    title!: string

    @Property({ type: 'text' })
    content!: string

    @Property({ nullable: true, type: 'text' })
    summary?: string | null

    @Property({ nullable: true, type: 'json' })
    metadata?: Record<string, unknown> | null

    @Property({ nullable: true, type: 'json' })
    tags?: string[] | null

    @Property({ nullable: true })
    source?: string | null

    @Property({ nullable: true })
    type?: string | null

    @Property({ nullable: true })
    reference_id?: string | null

    @Property({ nullable: true })
    submitter_name?: string | null

    @Property({ nullable: true })
    submitter_email?: string | null

    @Property({ nullable: true })
    file_name?: string | null

    @Property({ nullable: true })
    expiration_date?: Date | null

    @Property({ default: 'pending' })
    status!: MemoSubmissionStatus

    @Property({ nullable: true })
    reviewed_at?: Date

    @Property({ nullable: true, type: 'text' })
    rejection_reason?: string

    @ManyToOne({
        entity: () => Project,
        fieldName: 'project_id',
        deferMode: DeferMode.INITIALLY_DEFERRED,
        index: 'skald_memo_submission_project_id_idx',
    })
    project!: Project

    @ManyToOne({
        entity: () => User,
        fieldName: 'reviewed_by',
        deferMode: DeferMode.INITIALLY_DEFERRED,
        nullable: true,
        index: 'skald_memo_submission_reviewed_by_idx',
    })
    reviewer?: User
}
