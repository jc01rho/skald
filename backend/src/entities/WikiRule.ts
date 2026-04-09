import { DeferMode, Entity, Index, ManyToOne, PrimaryKey, Property } from '@mikro-orm/core'
import { Project } from '@/entities/Project'
import { User } from '@/entities/User'

export type RuleType = 'schema' | 'inclusion' | 'exclusion' | 'transform' | 'priority'

@Entity({ tableName: 'skald_wiki_rule' })
@Index({ name: 'skald_wiki_rule_project_type_idx', properties: ['project', 'rule_type'] })
@Index({ name: 'skald_wiki_rule_project_active_idx', properties: ['project', 'is_active'] })
export class WikiRule {
    @PrimaryKey({ type: 'uuid' })
    uuid!: string

    @Property()
    created_at!: Date

    @Property()
    updated_at!: Date

    @Property({ length: 100 })
    rule_type!: RuleType

    @Property({ length: 255 })
    name!: string

    @Property({ type: 'text' })
    description!: string

    @Property({ type: 'json' })
    config!: Record<string, unknown>

    @Property({ default: 100 })
    priority!: number

    @Property({ default: true })
    is_active!: boolean

    @ManyToOne({
        entity: () => Project,
        fieldName: 'project_id',
        deferMode: DeferMode.INITIALLY_DEFERRED,
        index: 'skald_wiki_rule_project_id_idx',
    })
    project!: Project

    @ManyToOne({
        entity: () => User,
        fieldName: 'created_by_id',
        deferMode: DeferMode.INITIALLY_DEFERRED,
        nullable: true,
        index: 'skald_wiki_rule_created_by_id_idx',
    })
    created_by?: User | null
}
