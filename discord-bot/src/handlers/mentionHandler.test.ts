import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || 'test-token'
process.env.SKALD_API_URL = process.env.SKALD_API_URL || 'http://localhost:3000'
process.env.SKALD_API_KEY = process.env.SKALD_API_KEY || 'test-key'
process.env.SKALD_PROJECT_ID = process.env.SKALD_PROJECT_ID || 'test-project'

const { __testables__ } = await import('./mentionHandler.js')

const references = {
    '1': { memo_uuid: 'memo-1', memo_title: '문서 1 info-123', source_url: 'https://example.com/1' },
    '2': { memo_uuid: 'memo-2', memo_title: '문서 2', source_url: 'https://example.com/2' },
}

test('falls back to all references when citations are missing', () => {
    const entries = __testables__.selectReferenceEntries('citation 없는 응답', references)

    assert.equal(entries.length, 2)
})

test('uses cited references when citations exist', () => {
    const entries = __testables__.selectReferenceEntries('응답 [[2]]', references)

    assert.deepEqual(entries, [['2', references['2']]])
})

test('extracts info doc urls from memo titles', () => {
    assert.equal(__testables__.extractInfoDocUrls('문서 제목 info-123 안내').length, 1)
})

test('skips automatic product filter for numeric error code queries', () => {
    assert.equal(__testables__.shouldSkipProductFilter('레거시 sast 오류코드 450002 에 대해 모두 알려줘'), true)
    assert.equal(__testables__.shouldSkipProductFilter('엔터프라이즈 에러코드 27000 에 대해 모두 알려줘'), true)
    assert.equal(__testables__.detectProductId('레거시 sast 오류코드 450002 에 대해 모두 알려줘'), undefined)
    assert.equal(__testables__.detectProductId('엔터프라이즈 에러코드 27000 에 대해 모두 알려줘'), undefined)
})

test('keeps automatic product filter for non-error-code product queries', () => {
    assert.equal(__testables__.detectProductId('엔터프라이즈 sast 설정 알려줘'), 'sparrow-sast')
    assert.equal(__testables__.detectProductId('엔터프라이즈 기능 설명해줘'), 'sparrow')
})
