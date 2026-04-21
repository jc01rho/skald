import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || 'test-token'
process.env.SKALD_API_URL = process.env.SKALD_API_URL || 'http://localhost:3000'
process.env.SKALD_API_KEY = process.env.SKALD_API_KEY || 'test-key'
process.env.SKALD_PROJECT_ID = process.env.SKALD_PROJECT_ID || 'test-project'

const { DiscordStreamEditor } = await import('./DiscordStreamEditor.js')

type FakeMessage = {
    content: string
    edits: string[]
    replies: FakeMessage[]
    deleted: boolean
    edit: (content: string) => Promise<FakeMessage>
    reply: (content: string) => Promise<FakeMessage>
    delete: () => Promise<void>
}

const createFakeMessage = (): FakeMessage => {
    const message: FakeMessage = {
        content: '',
        edits: [],
        replies: [],
        deleted: false,
        async edit(content: string) {
            this.content = content
            this.edits.push(content)
            return this
        },
        async reply(content: string) {
            const reply = createFakeMessage()
            reply.content = content
            reply.edits.push(content)
            this.replies.push(reply)
            return reply
        },
        async delete() {
            this.deleted = true
        },
    }

    return message
}

test('streams long content across multiple discord messages before finalize', async () => {
    const rootMessage = createFakeMessage()
    const editor = new DiscordStreamEditor(rootMessage as never)

    const showStatus = Reflect.get(editor, 'showStatus')
    assert.equal(typeof showStatus, 'function')
    await showStatus.call(editor, 'generating')
    editor.append('가'.repeat(2500))
    await editor.finalize()

    assert.match(rootMessage.edits[0], /관련 문서 확인이 끝나 자세한 답변을 생성하는 중입니다/)
    assert.equal(rootMessage.replies.length, 1)
    assert.ok(rootMessage.replies[0]?.content.includes('가'))
    assert.equal(rootMessage.content.includes('▌'), false)
    assert.equal(rootMessage.content.includes('⏳ 답변을 스트리밍하는 중입니다'), false)
})

test('finalize removes streaming cursor and keeps full content visible', async () => {
    const rootMessage = createFakeMessage()
    const editor = new DiscordStreamEditor(rootMessage as never)

    editor.append('첫 문장입니다.')
    await editor.finalize('최종 응답입니다.')

    assert.equal(rootMessage.content, '최종 응답입니다.')
    assert.equal(rootMessage.content.includes('▌'), false)
    assert.equal(rootMessage.content.includes('⏳'), false)
})

test('showError deletes stale streaming chunks', async () => {
    const rootMessage = createFakeMessage()
    const editor = new DiscordStreamEditor(rootMessage as never)

    editor.append('나'.repeat(2500))
    await editor.finalize()

    const extraMessage = rootMessage.replies[0]
    assert.ok(extraMessage)

    await editor.showError('실패했습니다')

    assert.equal(rootMessage.content, '❌ Error: 실패했습니다')
    assert.equal(extraMessage?.deleted, true)
})

test('setPreview shows preview content with searching status', async () => {
    const rootMessage = createFakeMessage()
    const editor = new DiscordStreamEditor(rootMessage as never)

    const setPreview = Reflect.get(editor, 'setPreview')
    assert.equal(typeof setPreview, 'function')
    await setPreview.call(editor, '미리보기 답변입니다')

    assert.match(rootMessage.content, /미리보기 답변/)
    assert.match(rootMessage.content, /💬.*미리보기 답변/)
    assert.match(rootMessage.content, /질문을 접수했고 관련 문서를 먼저 확인하는 중/)
})

test('showStatus preserves preview content when preview is set', async () => {
    const rootMessage = createFakeMessage()
    const editor = new DiscordStreamEditor(rootMessage as never)

    const setPreview = Reflect.get(editor, 'setPreview')
    await setPreview.call(editor, '미리보기')

    const showStatus = Reflect.get(editor, 'showStatus')
    await showStatus.call(editor, 'generating')

    assert.match(rootMessage.content, /미리보기/)
    assert.match(rootMessage.content, /관련 문서 확인이 끝나 자세한 답변을 생성하는 중/)
})
