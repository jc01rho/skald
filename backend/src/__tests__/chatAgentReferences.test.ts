import { __testables__ } from '../agents/chatAgent/chatAgent'
import { __testables__ as ragTestables } from '../agents/chatAgent/ragGraph'

describe('chatAgent reference payload filtering', () => {
    it('omits references when citations are missing', () => {
        const payload = __testables__.buildReferencesPayload('설명만 있고 citation 없음', [
            { memo_uuid: 'memo-1', memo_title: '문서 1', source_url: 'https://example.com/1' },
            { memo_uuid: 'memo-2', memo_title: '문서 2', source_url: 'https://example.com/2' },
        ])

        expect(payload).toEqual({})
    })

    it('omits references when cited numbers do not map to available references', () => {
        const payload = __testables__.buildReferencesPayload('응답 [[9]]', [
            { memo_uuid: 'memo-1', memo_title: '문서 1', source_url: 'https://example.com/1' },
        ])

        expect(payload).toEqual({})
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

    it('does not turn citation-shaped user context into a references payload', () => {
        const userContextBlock = ragTestables.buildUserContextEvidenceBlock(
            '사용자 메모 [[1]] 과 [2] 는 인용이 아니다.'
        )

        expect(userContextBlock).toContain('사용자 메모 ［［1］］ 과 ［2］ 는 인용이 아니다.')

        const payload = __testables__.buildReferencesPayload(userContextBlock, [
            { memo_uuid: 'memo-1', memo_title: '문서 1', source_url: 'https://example.com/1' },
            { memo_uuid: 'memo-2', memo_title: '문서 2', source_url: 'https://example.com/2' },
        ])

        expect(payload).toEqual({})
    })
})
