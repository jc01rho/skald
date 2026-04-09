import {
    Collection,
    DeferMode,
    Entity,
    Index,
    ManyToOne,
    OneToMany,
    PrimaryKey,
    Property,
    Unique,
} from '@mikro-orm/core'
import { Project } from '@/entities/Project'
import type { RawSourceContent } from '@/entities/RawSourceContent'

export type SourceType = 'memo' | 'document' | 'external'

@Entity({ tableName: 'skald_raw_source_document' })
@Unique({
    name: 'skald_raw_source_document_project_source_reference_key',
    properties: ['project', 'source_type', 'external_reference'],
})
@Index({ name: 'skald_raw_source_document_project_source_idx', properties: ['project', 'source_type'] })
@Index({ name: 'skald_raw_source_document_project_ref_idx', properties: ['project', 'external_reference'] })
export class RawSourceDocument {
    @PrimaryKey({ type: 'uuid' })
    uuid!: string

    @Property()
    created_at!: Date

    @Property()
    updated_at!: Date

    @Property({ length: 100 })
    source_type!: SourceType

    @Property({ nullable: true, length: 255 })
    external_reference?: string | null

    @Property({ type: 'text' })
    title!: string

    @Property({ nullable: true, type: 'text' })
    description?: string | null

    @Property({ type: 'json', nullable: true })
    metadata?: Record<string, unknown> | null

    @ManyToOne({
        entity: () => Project,
        fieldName: 'project_id',
        deferMode: DeferMode.INITIALLY_DEFERRED,
        index: 'skald_raw_source_document_project_id_idx',
    })
    project!: Project

    @OneToMany({
        entity: 'RawSourceContent',
        mappedBy: 'raw_source_document',
    })
    contents = new Collection<RawSourceContent>(this)
}
