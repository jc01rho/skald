import { boundExactLookupContent, buildContextResultHeader, EXACT_LOOKUP_MAX_CONTENT_CHARS } from '../lib/contextFormatting'

describe('RAG context result headers', () => {
    it('labels a result with the memo title and source URL', () => {
        const header = buildContextResultHeader(
            { index: 0, memo_uuid: 'memo-1', memo_title: '제목', source_url: 'https://example.com/doc' },
            undefined,
            undefined,
            1
        )

        expect(header).toBe('Result 1: Title: 제목 Source: https://example.com/doc')
    })

    it('falls back to memo properties when the rerank result has no metadata', () => {
        const header = buildContextResultHeader(
            { index: 3 },
            'memo-2',
            new Map([['memo-2', { title: '메모 제목', source_url: 'https://example.com/memo' }]]),
            4
        )

        expect(header).toBe('Result 4: Title: 메모 제목 Source: https://example.com/memo')
    })

    it('omits unknown title and source instead of printing empty labels', () => {
        expect(buildContextResultHeader({ index: 0 }, undefined, undefined, 2)).toBe('Result 2:')
    })
})

describe('exact-lookup content bounding', () => {
    it('leaves short exact-key content untouched', () => {
        expect(boundExactLookupContent('짧은 내용')).toBe('짧은 내용')
    })

    it('truncates large exact-key memos and states how much was dropped', () => {
        const content = 'a'.repeat(EXACT_LOOKUP_MAX_CONTENT_CHARS + 500)
        const bounded = boundExactLookupContent(content)

        expect(bounded.length).toBeLessThan(content.length)
        expect(bounded.startsWith('a'.repeat(EXACT_LOOKUP_MAX_CONTENT_CHARS))).toBe(true)
        expect(bounded).toContain(
            `[Content truncated: showing the first ${EXACT_LOOKUP_MAX_CONTENT_CHARS} of ${content.length} characters]`
        )
    })
})
