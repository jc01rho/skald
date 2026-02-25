import { Client, EmbedBuilder, Message } from 'discord.js'
import { SkaldClient } from '../client/SkaldClient.js'
import { DiscordStreamEditor } from '../discord/DiscordStreamEditor.js'
import { config } from '../config.js'
import { logger } from '../logger.js'
import { MemoFilter } from '../client/types.js'

// Product ID keywords for automatic detection
const PRODUCT_ID_KEYWORDS = [
    'sast',
    'dast',
    'sparrow',
    'cloud',
    'rasp',
    'sca',
    'sparrow-sca',
    'sparrow-sast',
    'saqt',
    'ihub',
] as const

type ProductId = typeof PRODUCT_ID_KEYWORDS[number]

// Korean keyword aliases for sparrow
const SPARROW_ALIASES = ['엔터프라이즈', '엔터'] as const

// Product keywords that can combine with sparrow alias
const SPARROW_COMBINE_KEYWORDS = ['sast', 'sca'] as const
type SparrowCombineKeyword = typeof SPARROW_COMBINE_KEYWORDS[number]

/**
 * Detect product_id keyword from user query
 * Supports Korean aliases and compound keywords
 * Returns the matched product_id or undefined if not found
 */
function detectProductId(query: string): ProductId | undefined {
    const lowerQuery = query.toLowerCase()
    
    // 1. Check for explicit compound keywords first (longer matches take precedence)
    for (const keyword of ['sparrow-sca', 'sparrow-sast']) {
        if (lowerQuery.includes(keyword)) {
            return keyword as ProductId
        }
    }
    
    // 2. Check for Korean alias + product keyword combinations
    // e.g., '엔터프라이즈 sast' -> sparrow-sast
    const hasSparrowAlias = SPARROW_ALIASES.some(alias => query.includes(alias))
    if (hasSparrowAlias) {
        for (const productKeyword of SPARROW_COMBINE_KEYWORDS) {
            if (lowerQuery.includes(productKeyword)) {
                return `sparrow-${productKeyword}` as ProductId
            }
        }
        // If sparrow alias found but no combination keyword, return sparrow
        return 'sparrow'
    }
    
    // 3. Check for single keywords (skip compound keywords in iteration)
    for (const keyword of PRODUCT_ID_KEYWORDS) {
        if (keyword.startsWith('sparrow-')) continue
        if (lowerQuery.includes(keyword)) {
            return keyword as ProductId
        }
    }
    
    return undefined
}

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
        
        // Detect product_id from query and build filter
        const detectedProductId = detectProductId(query)
        const filters: MemoFilter[] | undefined = detectedProductId
            ? [{
                field: 'product_id',
                operator: 'eq',
                value: detectedProductId,
                filter_type: 'custom_metadata',
            }]
            : undefined
        
        if (detectedProductId) {
            logger.info({ detectedProductId }, 'Product ID detected from query')
        }

        for await (const event of skaldClient.chatStream(query, {
            history,
            filters,
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
