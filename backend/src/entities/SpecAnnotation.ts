import { DeferMode, Entity, Index, ManyToOne, PrimaryKey, Property } from '@mikro-orm/core'
import { Project } from '@/entities/Project'
import { SpecSource } from '@/entities/SpecSource'

export const SPEC_ANNOTATION_KINDS = ['ADDITIONAL_NOTE', 'AUTOMATION_HINT'] as const
export type SpecAnnotationKind = (typeof SPEC_ANNOTATION_KINDS)[number]

export const SPEC_ANNOTATION_STATUSES = ['ACTIVE', 'NEEDS_REVIEW', 'ARCHIVED'] as const
export type SpecAnnotationStatus = (typeof SPEC_ANNOTATION_STATUSES)[number]

/**
 * Human-authored supplement attached to a canonical spec source. It lives outside the
 * collected revision so SPMS re-syncs never overwrite it; the anchor fields record which
 * source content it was written against so a changed source can flag it for review.
 */
@Entity({ tableName: 'skald_spec_annotation' })
@Index({ name: 'skald_spec_annotation_project_source_status_idx', properties: ['project', 'source', 'status'] })
export class SpecAnnotation {
    @PrimaryKey({ type: 'uuid' })
    uuid!: string

    @Property()
    created_at!: Date

    @Property()
    updated_at!: Date

    @Property({ length: 50 })
    kind!: SpecAnnotationKind

    @Property({ length: 30 })
    status!: SpecAnnotationStatus

    @Property({ type: 'text' })
    body!: string

    @Property({ nullable: true, type: 'text' })
    condition?: string | null

    @Property({ nullable: true, type: 'text' })
    effect?: string | null

    @Property({ nullable: true, type: 'text' })
    applies_to?: string | null

    @Property({ nullable: true, type: 'uuid' })
    anchor_revision_id?: string | null

    @Property({ nullable: true, length: 128 })
    anchor_content_hash?: string | null

    @Property({ nullable: true, length: 254 })
    created_by?: string | null

    @Property({ nullable: true, length: 254 })
    updated_by?: string | null

    @Property({ default: 1 })
    version: number = 1

    @ManyToOne({
        entity: () => SpecSource,
        joinColumns: ['project_id', 'source_id'],
        referencedColumnNames: ['project_id', 'uuid'],
        ownColumns: ['source_id'],
        deferMode: DeferMode.INITIALLY_DEFERRED,
        foreignKeyName: 'skald_spec_annotation_project_source_foreign',
    })
    source!: SpecSource

    @ManyToOne({
        entity: () => Project,
        fieldName: 'project_id',
        deferMode: DeferMode.INITIALLY_DEFERRED,
        index: 'skald_spec_annotation_project_id_idx',
    })
    project!: Project
}
