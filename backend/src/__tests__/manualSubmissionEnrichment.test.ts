import { __testables__ } from '../api/memoSubmission'

jest.mock('../agents/memoTagsAgent', () => ({
    memoTagsAgent: {
        extractTags: jest.fn().mockResolvedValue({ tags: ['manual-submission', 'error-codes'] }),
    },
}))

describe('manual submission enrichment', () => {
    it('builds aliases and metadata for enterprise error code memo titles', async () => {
        const aliases = __testables__.buildManualSubmissionAliases('sparrow-enterprise-backend-error-codes')
        const enrichment = await __testables__.buildApprovedSubmissionEnrichment(
            'sparrow-enterprise-backend-error-codes',
            '엔터프라이즈 에러코드 설명 문서'
        )

        expect(aliases).toEqual(
            expect.arrayContaining([
                '엔터프라이즈 에러코드',
                'sparrow enterprise backend error codes',
                'sparrow-enterprise-backend-error-codes',
            ])
        )

        expect(enrichment.tags).toEqual(
            expect.arrayContaining([
                'sparrow',
                'enterprise',
                'backend',
                'error',
                'codes',
                'manual-submission',
                'error-codes',
            ])
        )

        expect(enrichment.metadata).toMatchObject({
            enrichment_source: 'submission-approval',
        })
        expect(enrichment.metadata.search_aliases).toEqual(expect.arrayContaining(['엔터프라이즈 에러코드']))
        expect(enrichment.metadata.search_text).toContain('sparrow-enterprise-backend-error-codes')
    })
})
