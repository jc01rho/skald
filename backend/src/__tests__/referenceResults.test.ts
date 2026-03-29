import { buildReferenceResults } from '../lib/referenceResults'

describe('buildReferenceResults', () => {
    it('prepends exact lookup hits ahead of rerank-only references', () => {
        const results = buildReferenceResults(
            [{ memo_uuid: 'memo-2', memo_title: '일반 문서', source_url: 'https://example.com/2' }],
            [
                {
                    memo_uuid: 'memo-1',
                    title: 'manual submit memo',
                    source_url: 'https://example.com/manual',
                    found: true,
                    status: 'hit',
                },
            ]
        )

        expect(results).toEqual([
            { memo_uuid: 'memo-1', memo_title: 'manual submit memo', source_url: 'https://example.com/manual' },
            { memo_uuid: 'memo-2', memo_title: '일반 문서', source_url: 'https://example.com/2' },
        ])
    })

    it('deduplicates the same memo when exact lookup and rerank both include it', () => {
        const results = buildReferenceResults(
            [{ memo_uuid: 'memo-1', memo_title: 'manual submit memo', source_url: 'https://example.com/manual' }],
            [
                {
                    memo_uuid: 'memo-1',
                    title: 'manual submit memo',
                    source_url: 'https://example.com/manual',
                    found: true,
                    status: 'hit',
                },
            ]
        )

        expect(results).toEqual([
            { memo_uuid: 'memo-1', memo_title: 'manual submit memo', source_url: 'https://example.com/manual' },
        ])
    })
})
