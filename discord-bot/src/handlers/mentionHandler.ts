import { Client, EmbedBuilder, Message, ThreadChannel } from 'discord.js'
import { SkaldClient } from '../client/SkaldClient.js'
import { DiscordStreamEditor } from '../discord/DiscordStreamEditor.js'
import { config } from '../config.js'
import { logger } from '../logger.js'
import { MemoFilter } from '../client/types.js'

const INFO_DOC_ID_REGEX = /\binfo-(\d+)\b/gi

function buildInfoDocUrl(infoId: string): string {
    const base = config.spmsInfoBaseUrl.replace(/\/$/, '')
    return `${base}/${infoId}`
}

function extractInfoDocUrls(text: string): string[] {
    const found = new Set<string>()
    let match: RegExpExecArray | null = null

    INFO_DOC_ID_REGEX.lastIndex = 0

    while ((match = INFO_DOC_ID_REGEX.exec(text)) !== null) {
        const infoId = match[1]
        found.add(buildInfoDocUrl(infoId))
    }

    return Array.from(found)
}

function extractCitedReferenceKeys(text: string): Set<string> {
    const citedKeys = new Set<string>()
    const citationRegex = /\[\[(\d+)\]\]|\[(\d+)\]/g
    let match: RegExpExecArray | null = null

    while ((match = citationRegex.exec(text)) !== null) {
        const key = match[1] ?? match[2]
        if (key) {
            citedKeys.add(key)
        }
    }

    return citedKeys
}

function linkifyCitationsWithReferences(
    text: string,
    references: Record<string, { memo_uuid: string; memo_title: string; source_url?: string }>
): string {
    return text.replace(/\[\[(\d+)\]\]|\[(\d+)\]/g, (match, bracketedKey, plainKey) => {
        const key = bracketedKey ?? plainKey
        if (!key) return match

        const sourceUrl = references[key]?.source_url?.trim()
        if (!sourceUrl) {
            return match
        }

        return `[${key}](${sourceUrl})`
    })
}

function normalizeCitationSpacing(text: string): string {
    return text
        .replace(/(\[\d+\]\([^\s)]+\))(?=\[\d+\]\([^\s)]+\))/g, '$1 ')
        .replace(/(\[\[\d+\]\])(?=\[\[\d+\]\])/g, '$1 ')
        .replace(/(\[\d+\])(?=\[\d+\])/g, '$1 ')
}

function splitForDiscord(content: string, maxLength: number = 1900): string[] {
    const normalized = content.trim()
    if (!normalized) return []
    if (normalized.length <= maxLength) return [normalized]

    const chunks: string[] = []
    const lines = normalized.split('\n')
    let current = ''

    for (const line of lines) {
        const candidate = current ? `${current}\n${line}` : line
        if (candidate.length <= maxLength) {
            current = candidate
            continue
        }

        if (current) {
            chunks.push(current)
            current = ''
        }

        if (line.length <= maxLength) {
            current = line
            continue
        }

        for (let start = 0; start < line.length; start += maxLength) {
            chunks.push(line.slice(start, start + maxLength))
        }
    }

    if (current) {
        chunks.push(current)
    }

    return chunks
}

async function sendFinalResponseFallback(thread: ThreadChannel, finalResponse: string): Promise<void> {
    const chunks = splitForDiscord(finalResponse)
    if (chunks.length === 0) {
        return
    }

    await thread.send('⚠️ 스트리밍 전송 중 문제가 발생해 전체 답변을 일반 메시지로 재전송합니다.')
    for (const chunk of chunks) {
        await thread.send(chunk)
    }
}

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

type ProductId = (typeof PRODUCT_ID_KEYWORDS)[number]

// Korean keyword aliases for sparrow
const SPARROW_ALIASES = ['엔터프라이즈', '엔터'] as const

// Product keywords that can combine with sparrow alias
const SPARROW_COMBINE_KEYWORDS = ['sast', 'sca'] as const

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
    const hasSparrowAlias = SPARROW_ALIASES.some((alias) => query.includes(alias))
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

function buildThreadName(query: string): string {
    const normalized = query.replace(/\s+/g, ' ').trim()
    if (!normalized) {
        return 'Skald 답변 스레드'
    }

    const compact = normalized.slice(0, 70)
    return `🤖 ${compact}`
}

async function resolveResponseThread(message: Message, query: string): Promise<ThreadChannel> {
    if (message.channel.isThread()) {
        return message.channel
    }

    return message.startThread({
        name: buildThreadName(query),
        autoArchiveDuration: 60,
    })
}

export async function handleMention(message: Message, client: Client) {
    if (message.author.bot) return
    if (!client.user || !message.mentions.has(client.user)) return

    const query = message.content.replace(/<@!?\d+>/g, '').trim()

    let responseThread: ThreadChannel
    try {
        responseThread = await resolveResponseThread(message, query)
    } catch (threadError) {
        logger.error({ threadError }, 'Failed to create response thread')

        try {
            await message.author.send('스레드 생성에 실패했습니다. 봇의 스레드 생성 권한을 확인해 주세요.')
        } catch (dmError) {
            logger.warn({ dmError }, 'Failed to DM thread creation failure')
            await message.reply('스레드 생성에 실패했습니다. 봇의 스레드 생성 권한을 확인해 주세요.')
        }

        return
    }

    if (!query) {
        await responseThread.send('질문을 입력해 주세요! 예: `@Skald Bot 우리 프로젝트 아키텍처는?`')
        return
    }

    const historyKey = `${message.author.id}-${responseThread.id}`
    const history = conversationHistory.get(historyKey) || []

    const reply = await responseThread.send('⏳ 답변을 생성하고 있습니다...')
    const editor = new DiscordStreamEditor(reply)

    try {
        const skaldClient = new SkaldClient({
            baseUrl: config.skaldApiUrl,
            apiKey: config.skaldApiKey,
            projectId: config.skaldProjectId,
        })

        let fullResponse = ''
        let references: Record<string, { memo_uuid: string; memo_title: string; source_url?: string }> = {}

        // Detect product_id from query and build filter
        const detectedProductId = detectProductId(query)
        const filters: MemoFilter[] | undefined = detectedProductId
            ? [
                  {
                      field: 'product_id',
                      operator: 'eq',
                      value: detectedProductId,
                      filter_type: 'custom_metadata',
                  },
              ]
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
                vector_search: { top_k: 100, similarity_threshold: 0.4 },
                references: { enabled: true },
            },
        })) {
            switch (event.type) {
                case 'token':
                    fullResponse += event.content
                    editor.append(event.content)
                    break
                case 'references':
                    // Backend sends references as JSON string, need to parse
                    if (typeof event.content === 'string') {
                        references = JSON.parse(event.content)
                    } else {
                        references = event.content
                    }
                    break
                case 'done':
                    break
                case 'error':
                    await editor.showError(event.content)
                    return
            }
        }

        const finalResponse = normalizeCitationSpacing(linkifyCitationsWithReferences(fullResponse, references))

        try {
            await editor.finalize(finalResponse)
        } catch (editError) {
            logger.error({ editError }, 'Failed to stream final response, falling back to plain messages')
            await sendFinalResponseFallback(responseThread, finalResponse)
        }

        const citedReferenceKeys = extractCitedReferenceKeys(fullResponse)
        const citedReferenceEntries = Object.entries(references).filter(([key]) => citedReferenceKeys.has(key))

        const inferredInfoDocUrls = extractInfoDocUrls(fullResponse)
        const citedReferenceSourceUrls = citedReferenceEntries
            .map(([, ref]) => ref.source_url?.trim())
            .filter((url): url is string => Boolean(url))
        const citedReferenceInfoDocUrls = citedReferenceEntries.flatMap(([, ref]) => extractInfoDocUrls(ref.memo_title))

        const allInfoDocUrls = Array.from(
            new Set([...inferredInfoDocUrls, ...citedReferenceSourceUrls, ...citedReferenceInfoDocUrls])
        )

        // Send reference embed (non-fatal - don't fail if this errors)
        if (citedReferenceEntries.length > 0) {
            try {
                const lines = citedReferenceEntries.map(([key, ref]) => {
                    const sourceUrl = ref.source_url?.trim()
                    if (sourceUrl) {
                        return `**[${key}]** ${ref.memo_title}\n🔗 ${sourceUrl}`
                    }
                    return `**[${key}]** ${ref.memo_title}`
                })

                // Discord embed description limit is 4096 chars
                const description = lines.join('\n').slice(0, 4000)

                const refEmbed = new EmbedBuilder()
                    .setTitle('📚 참고 자료')
                    .setColor(0x5865f2)
                    .setDescription(description)
                await responseThread.send({ embeds: [refEmbed] })
            } catch (embedError) {
                logger.warn({ embedError }, 'Failed to send reference embed (non-fatal)')
            }
        }

        // Send info doc links (non-fatal - don't fail if this errors)
        if (allInfoDocUrls.length > 0) {
            try {
                const description = allInfoDocUrls
                    .map((url) => `- ${url}`)
                    .join('\n')
                    .slice(0, 4000)
                const linkEmbed = new EmbedBuilder()
                    .setTitle('🔗 문서 원문 링크')
                    .setColor(0x2ecc71)
                    .setDescription(description)
                await responseThread.send({ embeds: [linkEmbed] })
            } catch (embedError) {
                logger.warn({ embedError }, 'Failed to send info doc links embed (non-fatal)')
            }
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
