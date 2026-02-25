import { Client, EmbedBuilder, Message } from 'discord.js'
import { SkaldClient } from '../client/SkaldClient.js'
import { DiscordStreamEditor } from '../discord/DiscordStreamEditor.js'
import { config } from '../config.js'
import { logger } from '../logger.js'

const conversationHistory = new Map<string, Array<{ role: string; content: string }>>()

export async function handleMention(message: Message, client: Client) {
    if (message.author.bot) return
    if (!client.user || !message.mentions.has(client.user)) return

    const query = message.content.replace(/<@!?\d+>/g, '').trim()
    if (!query) {
        await message.reply('질문을 입력해 주세요! 예: `@Skald Bot 우리 프로젝트 아키텍처는?`')
        return
    }

    const historyKey = `${message.author.id}-${message.channelId}`
    const history = conversationHistory.get(historyKey) || []

    const reply = await message.reply('⏳ 답변을 생성하고 있습니다...')
    const editor = new DiscordStreamEditor(reply)

    try {
        const skaldClient = new SkaldClient({
            baseUrl: config.skaldApiUrl,
            apiKey: config.skaldApiKey,
            projectId: config.skaldProjectId,
        })

        let fullResponse = ''
        let references: Record<string, { memo_uuid: string; memo_title: string }> = {}

        for await (const event of skaldClient.chatStream(query, {
            history,
            system_prompt: '제공된 프롬프트와 문맥 안에서만 답하고 그 외 없는 내용으로는 답변하지 말것.',
            rag_config: {
                llm_provider: 'cli-proxy-api',
                query_rewrite: { enabled: true },
                reranking: { enabled: true, top_k: 100 },
                vector_search: { top_k: 100, similarity_threshold: 0.40 },
                references: { enabled: false }
            },
        })) {
            switch (event.type) {
                case 'token':
                    fullResponse += event.content
                    editor.append(event.content)
                    break
                case 'references':
                    references = event.content
                    break
                case 'done':
                    break
                case 'error':
                    await editor.showError(event.content)
                    return
            }
        }

        await editor.finalize()

        if (Object.keys(references).length > 0) {
            const refEmbed = new EmbedBuilder()
                .setTitle('📚 참고 자료')
                .setColor(0x5865f2)
                .setDescription(
                    Object.entries(references)
                        .map(([key, ref]) => `**[${key}]** ${ref.memo_title}`)
                        .join('\n')
                )
            await message.reply({ embeds: [refEmbed] })
        }

        history.push({ role: 'user', content: query })
        history.push({ role: 'assistant', content: fullResponse })
        if (history.length > 20) history.splice(0, history.length - 20)
        conversationHistory.set(historyKey, history)
    } catch (error) {
        logger.error({ error }, 'Failed to handle mention')
        await editor.showError('요청 처리 중 오류가 발생했습니다.')
    }
}
