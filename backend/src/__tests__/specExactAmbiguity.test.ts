import { SpecRevisionError, SpecRevisionService } from '@/services/specRevisionService'
import type { Project } from '@/entities/Project'

const project = { uuid: '11111111-1111-4111-8111-111111111111' } as Project

function row(specId: string, code: string, product: string, precedence: number) {
    return {
        uuid: `uuid-${specId}`,
        spec_id: specId,
        source_system: 'spms',
        source_type: 'function',
        immutable_source_id: specId.split(':').pop(),
        source_locator: `http://spms.test/enterprise/functions/${code}`,
        memo_id: `memo-${specId}`,
        memo_reference_id: code,
        revision_id: `rev-${specId}`,
        title: '비밀번호 초기화',
        display_label: null,
        content: 'body',
        metadata: { _source: { code }, product: { product_id: product, product_name: product.toUpperCase() } },
        revision_number: 1,
        precedence,
    }
}

function serviceReturning(rows: unknown[]) {
    const em = { getConnection: () => ({ execute: jest.fn().mockResolvedValue(rows) }) }
    return new SpecRevisionService(em as any)
}

describe('exact spec lookup ambiguity', () => {
    it('lists every equally ranked candidate so the caller can disambiguate', async () => {
        // Function titles repeat across products (Cloud / On-Demand / Enterprise), so a title
        // lookup legitimately matches several specs at the same precedence.
        const service = serviceReturning([
            row('spms:function:528', 'CLOUD-SVR-RESET-PW', 'cloud', 5),
            row('spms:function:991', 'ONDEMAND-SVR-RESET-PW', 'ondemand', 5),
        ])

        const error = await service.exact(project, '비밀번호 초기화').catch((caught: unknown) => caught)

        expect(error).toBeInstanceOf(SpecRevisionError)
        expect(error).toMatchObject({ code: 'AMBIGUOUS_EXACT_MATCH', status: 409 })
        expect((error as SpecRevisionError).details).toEqual({
            candidates: [
                { spec_id: 'spms:function:528', code: 'CLOUD-SVR-RESET-PW', title: '비밀번호 초기화', product_id: 'cloud', product_name: 'CLOUD' },
                { spec_id: 'spms:function:991', code: 'ONDEMAND-SVR-RESET-PW', title: '비밀번호 초기화', product_id: 'ondemand', product_name: 'ONDEMAND' },
            ],
        })
    })

    it('still resolves a single best match without ambiguity details', async () => {
        const service = serviceReturning([
            row('spms:function:528', 'CLOUD-SVR-RESET-PW', 'cloud', 3),
            row('spms:function:991', 'ONDEMAND-SVR-RESET-PW', 'ondemand', 5),
        ])

        await expect(service.exact(project, 'CLOUD-SVR-RESET-PW')).resolves.toMatchObject({
            spec_id: 'spms:function:528',
            match_precedence: 3,
        })
    })
})
