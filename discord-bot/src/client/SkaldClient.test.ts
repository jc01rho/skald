import test from 'node:test'
import assert from 'node:assert/strict'

import { SkaldClient } from './SkaldClient.js'

const originalFetch = global.fetch

function createSSEStream(chunks: string[], throwAfterChunks?: string) {
    let index = 0
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (throwAfterChunks && index >= chunks.length) {
                throw new Error(throwAfterChunks)
            }

            if (index >= chunks.length) {
                controller.close()
                return
            }

            controller.enqueue(new TextEncoder().encode(chunks[index]))
            index += 1
        },
    })
}

test.afterEach(() => {
    global.fetch = originalFetch
})

test('chatStream yields transport_error instead of retrying after partial token stream terminates', async () => {
    let fetchCalls = 0
    global.fetch = (async () => {
        fetchCalls += 1
        return new Response(createSSEStream(['data: {"type":"token","content":"안녕"}\n\n'], 'terminated'), {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
        })
    }) as typeof fetch

    const client = new SkaldClient({
        baseUrl: 'http://localhost:3000',
        apiKey: 'test-key',
        projectId: 'test-project',
    })

    const events = []
    for await (const event of client.chatStream('질문')) {
        events.push(event)
    }

    assert.equal(fetchCalls, 1)
    assert.deepEqual(events, [
        { type: 'token', content: '안녕' },
        { type: 'transport_error', content: 'terminated' },
    ])
})

test('chatStream keeps retrying pre-stream failures and returns error on last attempt', async () => {
    let fetchCalls = 0
    global.fetch = (async () => {
        fetchCalls += 1
        throw new Error('terminated')
    }) as typeof fetch

    const client = new SkaldClient({
        baseUrl: 'http://localhost:3000',
        apiKey: 'test-key',
        projectId: 'test-project',
    })

    const events = []
    for await (const event of client.chatStream('질문')) {
        events.push(event)
    }

    assert.equal(fetchCalls, 3)
    assert.deepEqual(events, [{ type: 'error', content: 'terminated' }])
})

test('chatStream yields preview event when backend sends it', async () => {
    global.fetch = (async () => {
        return new Response(
            createSSEStream([
                'data: {"type":"accepted","chat_id":"test-chat"}\n\n',
                'data: {"type":"preview","content":"미리보기 답변입니다"}\n\n',
                'data: {"type":"progress","status":"searching"}\n\n',
                'data: {"type":"token","content":"상세 답변"}\n\n',
                'data: {"type":"done","chat_id":"test-chat"}\n\n',
            ]),
            { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
        )
    }) as typeof fetch

    const client = new SkaldClient({
        baseUrl: 'http://localhost:3000',
        apiKey: 'test-key',
        projectId: 'test-project',
    })

    const events = []
    for await (const event of client.chatStream('질문')) {
        events.push(event)
    }

    assert.equal(events.length, 5)
    assert.deepEqual(events[0], { type: 'accepted', chat_id: 'test-chat' })
    assert.deepEqual(events[1], { type: 'preview', content: '미리보기 답변입니다' })
    assert.deepEqual(events[2], { type: 'progress', status: 'searching' })
    assert.deepEqual(events[3], { type: 'token', content: '상세 답변' })
    assert.deepEqual(events[4], { type: 'done', chat_id: 'test-chat' })
})
