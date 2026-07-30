import { createHash } from 'crypto'
import { EntityManager } from '@mikro-orm/postgresql'
import {
    canonicalJson,
    SpecRevisionError,
    SpecRevisionService,
    StageAndPublishInput,
} from '@/services/specRevisionService'

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
const sha256Json = (value: unknown) => sha256(canonicalJson(value))

function validInput(): StageAndPublishInput {
    const source = {
        source_key: 'spms:function:574',
        source_system: 'spms',
        source_type: 'function',
        immutable_source_id: '574',
        title: '요청 목록 조회',
        code: 'SVR_MY_REQUEST_LIST_R',
        source_url: 'https://spms.example/spec/574',
        status: 'active',
        aliases: ['SVR_MY_REQUEST_LIST_R'],
    }
    const memo = {
        memo_uuid: null,
        client_reference_id: 'function-SVR_MY_REQUEST_LIST_R',
        title: source.title,
        content: '# 요청 목록 조회',
        metadata: { source_key: source.source_key },
        source: 'spms',
    }
    const relations = [
        {
            relation_type: 'USES_INFORMATION',
            target: {
                source_system: 'spms',
                source_type: 'information',
                immutable_source_id: '1243',
                source_key: 'spms:information:1243',
                title: '요청 정보',
                code: null,
                source_url: 'https://spms.example/information/1243',
            },
            source_relation_id: 'related-info-1243',
            provenance: 'spms.related_info',
            evidence: { path: '$.related_info[0]', label: '요청 정보' },
            properties: ['required'],
        },
    ]
    const claims = [
        {
            subject: 'request.status',
            predicate: 'display_label',
            value: '요청 상태',
            unit: null,
            condition: null,
            object: null,
            evidence: {
                path: '$.detail.fields[0].label',
                excerpt: '요청 상태',
                hash: sha256('요청 상태'),
            },
            rule_version: 'display-label-v1',
        },
    ]
    const canonicalPayload = { id: 574, detail: { title: source.title } }
    const relationHash = sha256Json(relations)
    const claimHash = sha256Json(claims)
    const relationInputHash = sha256Json({
        source,
        memo_title: memo.title,
        memo_metadata: memo.metadata,
        relations,
    })
    return {
        project_id: '8ec25f25-3d26-4b85-a465-88bd69298117',
        idempotency_key: 'spms:function:574:revision-12',
        source,
        revision: {
            source_revision: '12',
            source_updated_at: '2026-07-30T00:00:00.000Z',
            parser_version: '1',
            extractor_version: '1',
            schema_version: '1',
            canonical_payload: canonicalPayload,
            source_payload_hash: sha256Json(canonicalPayload),
            content_hash: sha256(memo.content),
            metadata_hash: sha256Json(memo.metadata),
            relation_hash: relationHash,
            claim_hash: claimHash,
            relation_input_hash: relationInputHash,
        },
        memo,
        relations,
        claims,
        expected_relation_count: relations.length,
        expected_relation_hash: relationHash,
        expected_claim_count: claims.length,
        expected_claim_hash: claimHash,
    }
}

describe('SpecRevisionService validation', () => {
    const service = new SpecRevisionService({} as EntityManager)

    it('matches the worker canonical JSON contract, including Unicode and sorted object keys', () => {
        expect(canonicalJson({ 한글: '값', a: [true, null, 1] })).toBe('{"a":[true,null,1],"한글":"값"}')
        expect(() => canonicalJson(Number.NaN)).toThrow(SpecRevisionError)
    })

    it('accepts a complete publish batch and normalizes relation properties deterministically', () => {
        const input = validInput()
        input.relations[0].properties = ['required', ' required ', '']
        input.revision.relation_hash = input.expected_relation_hash = sha256Json([
            { ...input.relations[0], properties: ['required'] },
        ])
        input.revision.relation_input_hash = sha256Json({
            source: input.source,
            memo_title: input.memo.title,
            memo_metadata: input.memo.metadata,
            relations: [{ ...input.relations[0], properties: ['required'] }],
        })

        const normalized = service.validate(input)
        expect(normalized.relations[0].properties).toEqual(['required'])
        expect(normalized.claims).toHaveLength(1)
    })

    it('fails closed when the declared relation set does not match the transmitted set', () => {
        const input = validInput()
        input.expected_relation_count = 0
        expect(() => service.validate(input)).toThrow(
            expect.objectContaining({ code: 'RELATION_COUNT_MISMATCH', status: 400 })
        )
    })

    it('fails closed when memo metadata changes without updating its canonical hash', () => {
        const input = validInput()
        input.memo.metadata = { source_key: input.source.source_key, changed: true }
        expect(() => service.validate(input)).toThrow(
            expect.objectContaining({ code: 'METADATA_HASH_MISMATCH', status: 400 })
        )
    })

    it('rejects conflicting duplicate relation identities rather than publishing an arbitrary row', () => {
        const input = validInput()
        input.relations.push({ ...input.relations[0], provenance: 'different.provenance' })
        expect(() => service.validate(input)).toThrow(
            expect.objectContaining({ code: 'DUPLICATE_RELATION_CONFLICT', status: 400 })
        )
    })
})
