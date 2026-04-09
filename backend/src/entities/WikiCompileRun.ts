import { DeferMode, Entity, Index, ManyToOne, PrimaryKey, Property } from '@mikro-orm/core'
import { Project } from '@/entities/Project'

export type WikiCompileRunStatus = 'pending' | 'processing' | 'completed' | 'failed'
export type WikiCompileTriggerType = 'memo_created' | 'memo_updated' | 'document_processed' | 'manual' | 'scheduled'

@Entity({ tableName: 'skald_wiki_compile_run' })
@Index({ name: 'skald_wiki_compile_run_project_status_idx', properties: ['project', 'status'] })
export class WikiCompileRun {
    @PrimaryKey({ type: 'uuid' })
    uuid!: string

    @Property()
    started_at!: Date

    @Property({ nullable: true })
    completed_at?: Date | null

    @Property({ length: 50 })
    trigger_type!: WikiCompileTriggerType

    @Property({ length: 50, default: 'pending' })
    status!: WikiCompileRunStatus

    @Property({ default: 0 })
    memos_considered!: number

    @Property({ default: 0 })
    pages_created!: number

    @Property({ default: 0 })
    pages_updated!: number

    @Property({ default: 0 })
    claims_created!: number

    @Property({ default: 0 })
    edges_created!: number

    @Property({ default: 0 })
    conflicts_found!: number

    @Property({ nullable: true, type: 'json' })
    notes?: Record<string, unknown> | null

    @ManyToOne({
        entity: () => Project,
        fieldName: 'project_id',
        deferMode: DeferMode.INITIALLY_DEFERRED,
        index: 'skald_wiki_compile_run_project_id_idx',
    })
    project!: Project
}
