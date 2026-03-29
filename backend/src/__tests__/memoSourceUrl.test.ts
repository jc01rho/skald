import { buildMemoSourceUrl } from '../lib/memoSourceUrl'

describe('buildMemoSourceUrl', () => {
    it('returns existing source url when present', () => {
        expect(
            buildMemoSourceUrl({
                projectUuid: 'project-1',
                memoUuid: 'memo-1',
                sourceUrl: 'https://example.com/doc',
                source: 'public-submission',
                submissionId: 'submission-1',
            })
        ).toBe('https://example.com/doc')
    })

    it('builds internal memo url for approved manual submissions without source url', () => {
        expect(
            buildMemoSourceUrl({
                projectUuid: 'project-1',
                memoUuid: 'memo-1',
                sourceUrl: '',
                source: 'public-submission',
                submissionId: 'submission-1',
            })
        ).toContain('/projects/project-1/memos/memo-1')
    })

    it('returns empty string for non-submission memos without source url', () => {
        expect(
            buildMemoSourceUrl({
                projectUuid: 'project-1',
                memoUuid: 'memo-1',
                sourceUrl: '',
                source: 'jira',
                submissionId: null,
            })
        ).toBe('')
    })
})
