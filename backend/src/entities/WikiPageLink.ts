import { DeferMode, Entity, Index, ManyToOne, PrimaryKey, Property, Unique } from '@mikro-orm/core'
import { WikiPage } from '@/entities/WikiPage'

export type WikiPageLinkType = 'related' | 'parent' | 'child' | 'see_also' | 'source_digest'

@Entity({ tableName: 'skald_wiki_page_link' })
@Unique({ name: 'skald_wiki_page_link_from_to_type_key', properties: ['from_page', 'to_page', 'link_type'] })
@Index({ name: 'skald_wiki_page_link_from_to_idx', properties: ['from_page', 'to_page'] })
export class WikiPageLink {
    @PrimaryKey({ type: 'uuid' })
    uuid!: string

    @Property({ length: 50 })
    link_type!: WikiPageLinkType

    @Property({ nullable: true, type: 'text' })
    anchor_text?: string | null

    @ManyToOne({
        entity: () => WikiPage,
        fieldName: 'from_page_id',
        deferMode: DeferMode.INITIALLY_DEFERRED,
        index: 'skald_wiki_page_link_from_page_id_idx',
    })
    from_page!: WikiPage

    @ManyToOne({
        entity: () => WikiPage,
        fieldName: 'to_page_id',
        deferMode: DeferMode.INITIALLY_DEFERRED,
        index: 'skald_wiki_page_link_to_page_id_idx',
    })
    to_page!: WikiPage
}
