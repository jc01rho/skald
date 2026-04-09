import { DeferMode, Entity, Index, ManyToOne, PrimaryKey, Property } from '@mikro-orm/core'
import { WikiClaim } from '@/entities/WikiClaim'
import { WikiSourceRef } from '@/entities/WikiSourceRef'

export type WikiSupportType = 'supports' | 'contradicts' | 'mentions'

@Entity({ tableName: 'skald_wiki_claim_source_ref' })
@Index({ name: 'skald_wiki_claim_source_ref_claim_idx', properties: ['claim'] })
export class WikiClaimSourceRef {
    @PrimaryKey({ type: 'uuid' })
    uuid!: string

    @Property({ length: 50 })
    support_type!: WikiSupportType

    @Property({ default: 0.5 })
    confidence!: number

    @Property({ nullable: true, type: 'text' })
    excerpt?: string | null

    @ManyToOne({
        entity: () => WikiClaim,
        fieldName: 'claim_id',
        deferMode: DeferMode.INITIALLY_DEFERRED,
        index: 'skald_wiki_claim_source_ref_claim_id_idx',
    })
    claim!: WikiClaim

    @ManyToOne({
        entity: () => WikiSourceRef,
        fieldName: 'source_ref_id',
        deferMode: DeferMode.INITIALLY_DEFERRED,
        index: 'skald_wiki_claim_source_ref_source_ref_id_idx',
    })
    source_ref!: WikiSourceRef
}
