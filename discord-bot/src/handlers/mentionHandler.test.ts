import test from 'node:test'
import assert from 'node:assert/strict'
import { __testables__ } from './mentionHandler.js'

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
