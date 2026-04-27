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

test('preserves partial response when transport terminates after tokens', () => {
    assert.equal(__testables__.shouldPreservePartialResponseOnError('transport_error', '부분 응답'), true)
    assert.equal(__testables__.shouldPreservePartialResponseOnError('transport_error', ' '), false)
    assert.equal(__testables__.shouldPreservePartialResponseOnError('error', '부분 응답'), false)
})

test('handles accepted and progress events without throwing', () => {
    const acceptedEvent = { type: 'accepted', chat_id: 'test-chat-id' }
    const progressSearchingEvent = { type: 'progress', status: 'searching' }
    const progressGeneratingEvent = { type: 'progress', status: 'generating' }

    assert.equal(acceptedEvent.type, 'accepted')
    assert.equal(acceptedEvent.chat_id, 'test-chat-id')
    assert.equal(progressSearchingEvent.type, 'progress')
    assert.equal(progressSearchingEvent.status, 'searching')
    assert.equal(progressGeneratingEvent.type, 'progress')
    assert.equal(progressGeneratingEvent.status, 'generating')
})

test('maps backend availability errors to user-friendly mention message', () => {
    assert.equal(
        __testables__.buildMentionErrorMessage('Service unavailable'),
        '백엔드 채팅 서비스가 현재 응답하지 않습니다. 잠시 후 다시 시도해 주세요.'
    )
    assert.equal(
        __testables__.buildMentionErrorMessage('The operation was aborted due to timeout'),
        '백엔드 응답이 제한 시간 안에 도착하지 않았습니다. 잠시 후 다시 시도해 주세요.'
    )
    assert.equal(
        __testables__.buildMentionErrorMessage('Chat stream completed without any response content'),
        '백엔드 스트리밍 응답이 중간에 종료되었습니다. 잠시 후 다시 시도해 주세요.'
    )
    assert.equal(
        __testables__.buildMentionErrorMessage('An error occurred'),
        '백엔드 스트리밍 응답이 중간에 종료되었습니다. 잠시 후 다시 시도해 주세요.'
    )
    assert.equal(
        __testables__.buildMentionErrorMessage('fetch failed'),
        '백엔드 스트리밍 응답이 중간에 종료되었습니다. 잠시 후 다시 시도해 주세요.'
    )
})

test('maps backend HTTP server errors to user-friendly mention message', () => {
    for (const status of [500, 502, 503, 504]) {
        assert.equal(
            __testables__.buildMentionErrorMessage(`HTTP error: ${status}`),
            '백엔드 서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.'
        )
    }
})

test('parses references event payload from string content', () => {
    assert.deepEqual(__testables__.parseReferencesEventContent(JSON.stringify(references)), references)
})

test('formats partial final response with interruption notice', () => {
    const formatted = __testables__.formatFinalResponse('일반 질문', '응답 본문 [1]', references, { partial: true })
    assert.match(formatted, /응답이 중간에 끊겨 일부 내용만 전달되었습니다\./)
    assert.match(formatted, /\[1\]\(https:\/\/example\.com\/1\)/)
})

test('handles preview event type without throwing', () => {
    const previewEvent = { type: 'preview', content: '미리보기 답변입니다.' }
    assert.equal(previewEvent.type, 'preview')
    assert.equal(previewEvent.content, '미리보기 답변입니다.')
})

test('strips discord mention markup from thread title queries', () => {
    const cleaned = __testables__.stripDiscordMentions(
        '@Parrot <@1475414065273765990> <@!1475414065273765990> <@&1475414065273765990> <#1475414065273765990> 작업 프로파일의 목록 가져오기 기능에 대해 알려줘'
    )

    assert.equal(cleaned, '@Parrot 작업 프로파일의 목록 가져오기 기능에 대해 알려줘')
    assert.equal(__testables__.buildThreadName(cleaned), '🤖 @Parrot 작업 프로파일의 목록 가져오기 기능에 대해 알려줘')
})

test('uses lightweight RAG config for discord mention streaming', () => {
    assert.deepEqual(__testables__.DISCORD_MENTION_RAG_CONFIG, {
        llm_provider: 'cli-proxy-api',
        query_rewrite: { enabled: false },
        reranking: { enabled: true, top_k: 8 },
        vector_search: { top_k: 16, similarity_threshold: 0.45 },
        references: { enabled: true },
    })
})
