import { __testables__ } from '../agents/chatAgent/chatAgent'

describe('chatAgent reference payload fallback', () => {
    it('returns all references when citations are missing', () => {
        const payload = __testables__.buildReferencesPayload('설명만 있고 citation 없음', [
            { memo_uuid: 'memo-1', memo_title: '문서 1', source_url: 'https://example.com/1' },
            { memo_uuid: 'memo-2', memo_title: '문서 2', source_url: 'https://example.com/2' },
        ])

        expect(payload).toEqual({
            1: { memo_uuid: 'memo-1', memo_title: '문서 1', source_url: 'https://example.com/1' },
            2: { memo_uuid: 'memo-2', memo_title: '문서 2', source_url: 'https://example.com/2' },
        })
    })

    it('falls back to all references when cited numbers do not map to available references', () => {
        const payload = __testables__.buildReferencesPayload('응답 [[9]]', [
            { memo_uuid: 'memo-1', memo_title: '문서 1', source_url: 'https://example.com/1' },
        ])

        expect(payload).toEqual({
            1: { memo_uuid: 'memo-1', memo_title: '문서 1', source_url: 'https://example.com/1' },
        })
    })

    it('keeps cited-only references when valid citations exist', () => {
        const payload = __testables__.buildReferencesPayload('응답 [[2]]', [
            { memo_uuid: 'memo-1', memo_title: '문서 1', source_url: 'https://example.com/1' },
            { memo_uuid: 'memo-2', memo_title: '문서 2', source_url: 'https://example.com/2' },
        ])

        expect(payload).toEqual({
            2: { memo_uuid: 'memo-2', memo_title: '문서 2', source_url: 'https://example.com/2' },
        })
    })
})
