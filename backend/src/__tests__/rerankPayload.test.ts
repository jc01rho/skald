import { buildRerankDocument, buildRerankQuery } from '../lib/rerankPayload'

describe('rerank payload construction', () => {
    it('builds the same Title/Summary/Chunk document chat retrieval sends', () => {
        const document = buildRerankDocument('본문 청크', {
            title: '이슈 검출 규칙 옵션 유형',
            summary: '옵션 유형 요약',
        })

        expect(document).toBe(
            'Title: 이슈 검출 규칙 옵션 유형\n\nFull content summary: 옵션 유형 요약\n\nChunk content: 본문 청크\n\n'
        )
    })

    it('falls back to the bare chunk only when no memo metadata exists', () => {
        expect(buildRerankDocument('본문 청크')).toBe('본문 청크')
        expect(buildRerankDocument('본문 청크', null)).toBe('본문 청크')
    })

    it('keeps empty title/summary fields empty instead of dropping the document frame', () => {
        expect(buildRerankDocument('chunk', { title: null, summary: null })).toBe(
            'Title: \n\nFull content summary: \n\nChunk content: chunk\n\n'
        )
    })

    it('sends the rewritten query alone without the original-query wrapper', () => {
        const query = buildRerankQuery('  이슈 검출 규칙 옵션 유형  ')

        expect(query).toBe('이슈 검출 규칙 옵션 유형')
        expect(query).not.toContain('Rewritten retrieval query')
        expect(query).not.toContain('\n\n')
    })
})
