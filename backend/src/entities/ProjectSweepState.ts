import { DeferMode, Entity, Index, ManyToOne, PrimaryKey, Property, Unique } from '@mikro-orm/core'
import { Project } from '@/entities/Project'

export type SweepType = 'wiki_full_corpus'

@Entity({ tableName: 'skald_project_sweep_state' })
@Index({ name: 'skald_project_sweep_state_project_idx', properties: ['project'] })
@Unique({ name: 'skald_project_sweep_state_project_type_key', properties: ['project', 'sweep_type'] })
export class ProjectSweepState {
    @PrimaryKey({ type: 'uuid' })
    uuid!: string

    @Property()
    created_at!: Date

    @Property()
    updated_at!: Date

    @Property({ length: 100 })
    sweep_type!: SweepType

    @Property({ default: 0 })
    next_offset!: number

    @Property({ nullable: true, type: 'json' })
    metadata?: Record<string, unknown> | null

    @ManyToOne({
        entity: () => Project,
        fieldName: 'project_id',
        deferMode: DeferMode.INITIALLY_DEFERRED,
        index: 'skald_project_sweep_state_project_id_idx',
    })
    project!: Project
}
