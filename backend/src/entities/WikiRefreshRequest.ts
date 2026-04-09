import { DeferMode, Entity, Index, ManyToOne, PrimaryKey, Property } from '@mikro-orm/core'
import { Project } from '@/entities/Project'
import { RawSourceDocument } from '@/entities/RawSourceDocument'

export type RefreshStatus = 'pending' | 'claimed' | 'processing' | 'completed' | 'failed'
export type RefreshTrigger = 'memo_created' | 'memo_updated' | 'document_processed' | 'manual' | 'scheduled'

@Entity({ tableName: 'skald_wiki_refresh_request' })
@Index({ name: 'skald_wiki_refresh_request_project_status_idx', properties: ['project', 'status'] })
@Index({ name: 'skald_wiki_refresh_request_source_idx', properties: ['raw_source_document', 'status'] })
@Index({ name: 'skald_wiki_refresh_request_created_idx', properties: ['created_at'] })
export class WikiRefreshRequest {
    @PrimaryKey({ type: 'uuid' })
    uuid!: string

    @Property()
    created_at!: Date

    @Property({ nullable: true })
    updated_at?: Date | null

    @Property({ length: 50 })
    trigger!: RefreshTrigger

    @Property({ default: 'pending' })
    status!: RefreshStatus

    @Property({ nullable: true, type: 'text' })
    error_message?: string | null

    @Property({ nullable: true })
    process_started_at?: Date | null

    @Property({ nullable: true })
    process_completed_at?: Date | null

    @Property({ nullable: true })
    claimed_at?: Date | null

    @Property({ nullable: true, length: 255 })
    claim_token?: string | null

    @Property({ default: 100 })
    priority!: number

    @Property({ nullable: true, length: 255 })
    batch_key?: string | null

    @Property({ type: 'json', nullable: true })
    metadata?: Record<string, unknown> | null

    @ManyToOne({
        entity: () => RawSourceDocument,
        fieldName: 'raw_source_document_id',
        deferMode: DeferMode.INITIALLY_DEFERRED,
        nullable: true,
        index: 'skald_wiki_refresh_request_document_id_idx',
    })
    raw_source_document?: RawSourceDocument | null

    @ManyToOne({
        entity: () => Project,
        fieldName: 'project_id',
        deferMode: DeferMode.INITIALLY_DEFERRED,
        index: 'skald_wiki_refresh_request_project_id_idx',
    })
    project!: Project
}
