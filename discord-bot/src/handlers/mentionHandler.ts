import { Client, EmbedBuilder, Message, ThreadChannel } from 'discord.js'
import { SkaldClient } from '../client/SkaldClient.js'
import { DiscordStreamEditor } from '../discord/DiscordStreamEditor.js'
import { config } from '../config.js'
import { logger } from '../logger.js'
import { MemoFilter } from '../client/types.js'

const INFO_DOC_ID_REGEX = /\binfo-(\d+)\b/gi
const JIRA_ISSUE_KEY_REGEX = /\b([A-Z][A-Z0-9]+-\d+)\b/g
const INFO_DOC_ID_SINGLE_REGEX = /\binfo-(\d+)\b/i
const JIRA_ISSUE_KEY_SINGLE_REGEX = /\b([A-Z][A-Z0-9]+-\d+)\b/
const HTTP_URL_IN_TEXT_REGEX = /https?:\/\//i
const DEFAULT_JIRA_BASE_URL = 'https://jira.sparrowfasoo.com'
const URL_ACCESS_NOTICE =
    '참고로 저는 질문에 포함된 URL에 직접 접속하거나 그 내용을 읽을 수 없습니다. URL 본문이 필요하면 관련 내용을 함께 보내 주세요.\n\n'
const DISCORD_MENTION_RAG_CONFIG = {
    llm_provider: 'cli-proxy-api',
    query_rewrite: { enabled: false },
    reranking: { enabled: true, top_k: 12 },
    vector_search: { top_k: 28, similarity_threshold: 0.4 },
    references: { enabled: true },
} as const

const DISCORD_MENTION_SYSTEM_PROMPT =
    '제공된 프롬프트와 문맥 안에서만 답하고 없는 내용을 추측해 답하지 말것. 항상 한국어로 답변할 것. 사용자 질문에 대해 최대한 자세히 설명하되, 핵심 결론을 먼저 말하고 근거가 되는 문서 내용과 동작 맥락을 이어서 설명할 것. 가능하면 원인, 동작 방식, 예외/제약, 실무상 주의점까지 포함해 답할 것.'

function isHttpUrl(value: string | undefined): value is string {
    return Boolean(value && /^https?:\/\//i.test(value))
}

function containsHttpUrl(text: string): boolean {
    return HTTP_URL_IN_TEXT_REGEX.test(text)
}

function buildInfoDocUrl(infoId: string): string {
    const base = config.spmsInfoBaseUrl.trim().replace(/\/$/, '')
    if (!base) {
        return `info-${infoId}`
    }
    return `${base}/${infoId}`
}

function buildJiraIssueUrl(issueKey: string): string {
    const base = (config.jiraBaseUrl || DEFAULT_JIRA_BASE_URL)
        .trim()
        .replace(/\/$/, '')
        .replace(/\/browse$/i, '')
    return `${base}/browse/${issueKey}`
}

function linkifyJiraIssueKeys(text: string): string {
    return text.replace(JIRA_ISSUE_KEY_REGEX, (match, issueKey) => {
        if (!issueKey) {
            return match
        }

        return `[${issueKey}](${buildJiraIssueUrl(issueKey)})`
    })
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

function extractFirstInfoDocUrl(text: string): string | undefined {
    const match = text.match(INFO_DOC_ID_SINGLE_REGEX)
    const infoId = match?.[1]
    const url = infoId ? buildInfoDocUrl(infoId) : undefined
    return isHttpUrl(url) ? url : undefined
}

function extractFirstJiraIssueUrl(text: string): string | undefined {
    const issueKey = text.match(JIRA_ISSUE_KEY_SINGLE_REGEX)?.[1]
    const url = issueKey ? buildJiraIssueUrl(issueKey) : undefined
    return isHttpUrl(url) ? url : undefined
}

function extractCitedReferenceKeys(text: string): Set<string> {
    const citedKeys = new Set<string>()
    for (const match of findCitationMatches(text)) {
        citedKeys.add(match.key)
    }

    return citedKeys
}

function selectReferenceEntries(
    fullResponse: string,
    references: Record<string, { memo_uuid: string; memo_title: string; source_url?: string }>
): Array<[string, { memo_uuid: string; memo_title: string; source_url?: string }]> {
    const citedReferenceKeys = extractCitedReferenceKeys(fullResponse)
    const allReferenceEntries = Object.entries(references)

    if (citedReferenceKeys.size === 0) {
        return allReferenceEntries
    }

    const citedReferenceEntries = allReferenceEntries.filter(([key]) => citedReferenceKeys.has(key))
    return citedReferenceEntries.length > 0 ? citedReferenceEntries : allReferenceEntries
}

function shouldPreservePartialResponseOnError(eventType: string, fullResponse: string): boolean {
    return eventType === 'transport_error' && fullResponse.trim().length > 0
}

type ReferenceMap = Record<string, { memo_uuid: string; memo_title: string; source_url?: string }>

function parseReferencesEventContent(content: string | ReferenceMap): ReferenceMap {
    if (typeof content === 'string') {
        try {
            const parsed = JSON.parse(content) as unknown
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return parsed as ReferenceMap
            }
        } catch (parseError) {
            logger.warn({ err: parseError }, 'Failed to parse references event payload')
        }

        return {}
    }

    if (content && typeof content === 'object' && !Array.isArray(content)) {
        return content as ReferenceMap
    }

    return {}
}

function buildMentionErrorMessage(errorMessage: string): string {
    const normalized = errorMessage.trim()

    if (!normalized) {
        return '요청 처리 중 오류가 발생했습니다.'
    }

    if (normalized === 'Service unavailable' || normalized === 'Chat agent unavailable') {
        return '백엔드 채팅 서비스가 현재 응답하지 않습니다. 잠시 후 다시 시도해 주세요.'
    }

    if (
        normalized === 'An error occurred' ||
        normalized === 'Chat stream completed without any response content' ||
        /Failed to parse (trailing )?SSE message/i.test(normalized) ||
        /terminated|fetch failed|socket hang up|other side closed|ECONNRESET|UND_ERR_SOCKET/i.test(normalized)
    ) {
        return '백엔드 스트리밍 응답이 중간에 종료되었습니다. 잠시 후 다시 시도해 주세요.'
    }

    if (/abort|timeout/i.test(normalized)) {
        return '백엔드 응답이 제한 시간 안에 도착하지 않았습니다. 잠시 후 다시 시도해 주세요.'
    }

    if (/^Unauthorized$/i.test(normalized) || /HTTP error:\s*401/i.test(normalized)) {
        return '백엔드 인증에 실패했습니다. 봇 설정을 확인해 주세요.'
    }

    if (/HTTP error:\s*403/i.test(normalized)) {
        return '이 프로젝트에 대한 접근 권한이 없습니다. 봇 설정을 확인해 주세요.'
    }

    if (/HTTP error:\s*404/i.test(normalized)) {
        return '백엔드 채팅 엔드포인트를 찾지 못했습니다. 배포 설정을 확인해 주세요.'
    }

    if (/HTTP error:\s*5\d\d/i.test(normalized)) {
        return '백엔드 서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.'
    }

    return '요청 처리 중 오류가 발생했습니다.'
}

function formatFinalResponse(
    query: string,
    fullResponse: string,
    references: ReferenceMap,
    options: { partial?: boolean } = {}
): string {
    const normalizedResponse = normalizeCitationSpacing(fullResponse)
    const recoveredResponse = recoverPlainNumericCitations(normalizedResponse, references)
    const finalResponse = linkifyCitationsWithReferences(recoveredResponse, references)
    const finalResponseWithNotice = containsHttpUrl(query) ? `${URL_ACCESS_NOTICE}${finalResponse}` : finalResponse

    if (!options.partial) {
        return finalResponseWithNotice
    }

    return `${finalResponseWithNotice}\n\n⚠️ 응답이 중간에 끊겨 일부 내용만 전달되었습니다.`.trim()
}

async function sendReferenceEmbeds(
    responseThread: ThreadChannel,
    fullResponse: string,
    references: ReferenceMap
): Promise<void> {
    const citedReferenceEntries = selectReferenceEntries(fullResponse, references)

    const inferredInfoDocUrls = extractInfoDocUrls(fullResponse)
    const citedReferenceSourceUrls = citedReferenceEntries
        .map(([, ref]) => ref.source_url?.trim())
        .filter((url): url is string => Boolean(url))
    const citedReferenceInfoDocUrls = citedReferenceEntries.flatMap(([, ref]) => extractInfoDocUrls(ref.memo_title))

    const allInfoDocUrls = Array.from(
        new Set([...inferredInfoDocUrls, ...citedReferenceSourceUrls, ...citedReferenceInfoDocUrls])
    )

    if (citedReferenceEntries.length > 0) {
        try {
            const lines = citedReferenceEntries.map(([key, ref]) => {
                const sourceUrl =
                    ref.source_url?.trim() ||
                    extractFirstJiraIssueUrl(ref.memo_title) ||
                    extractFirstInfoDocUrl(ref.memo_title)
                const titleWithJiraLinks = linkifyJiraIssueKeys(ref.memo_title)
                if (sourceUrl) {
                    return `**[${key}]** ${titleWithJiraLinks}\n🔗 ${sourceUrl}`
                }
                return `**[${key}]** ${titleWithJiraLinks}`
            })

            const description = lines.join('\n').slice(0, 4000)

            const refEmbed = new EmbedBuilder().setTitle('📚 참고 자료').setColor(0x5865f2).setDescription(description)
            await responseThread.send({ embeds: [refEmbed] })
        } catch (embedError) {
            logger.warn({ err: embedError }, 'Failed to send reference embed (non-fatal)')
        }
    }

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
            logger.warn({ err: embedError }, 'Failed to send info doc links embed (non-fatal)')
        }
    }
}

function persistConversationHistory(
    historyKey: string,
    history: Array<{ role: string; content: string }>,
    query: string,
    response: string
): void {
    history.push({ role: 'user', content: query })
    history.push({ role: 'assistant', content: response })
    if (history.length > 20) history.splice(0, history.length - 20)
    conversationHistory.set(historyKey, history)
}

type CitationMatch = {
    start: number
    end: number
    raw: string
    key: string
}

function findCitationMatches(text: string): CitationMatch[] {
    const matches: CitationMatch[] = []

    let i = 0
    while (i < text.length) {
        if (text[i] !== '[') {
            i += 1
            continue
        }

        if (text[i + 1] === '[') {
            let j = i + 2
            while (j < text.length && /\d/.test(text[j])) {
                j += 1
            }

            const hasDigits = j > i + 2
            if (hasDigits && text[j] === ']' && text[j + 1] === ']') {
                const key = text.slice(i + 2, j)
                matches.push({
                    start: i,
                    end: j + 2,
                    raw: text.slice(i, j + 2),
                    key,
                })
                i = j + 2
                continue
            }
        }

        let j = i + 1
        while (j < text.length && /\d/.test(text[j])) {
            j += 1
        }

        const hasDigits = j > i + 1
        if (hasDigits && text[j] === ']') {
            const key = text.slice(i + 1, j)
            matches.push({
                start: i,
                end: j + 1,
                raw: text.slice(i, j + 1),
                key,
            })
            i = j + 1
            continue
        }

        i += 1
    }

    return matches
}

function linkifyCitationsWithReferences(
    text: string,
    references: Record<string, { memo_uuid: string; memo_title: string; source_url?: string }>
): string {
    const matches = findCitationMatches(text)
    if (matches.length === 0) {
        return text
    }

    let result = ''
    let cursor = 0

    for (const match of matches) {
        if (match.start > cursor) {
            result += text.slice(cursor, match.start)
        }

        const reference = references[match.key]
        if (!reference) {
            result += `[${match.key}]`
            cursor = match.end
            continue
        }

        const sourceUrl =
            reference.source_url?.trim() ||
            extractFirstJiraIssueUrl(reference.memo_title) ||
            extractFirstInfoDocUrl(reference.memo_title)
        if (!sourceUrl) {
            result += `[${match.key}]`
            cursor = match.end
            continue
        }

        result += `[${match.key}](${sourceUrl})`
        cursor = match.end
    }

    if (cursor < text.length) {
        result += text.slice(cursor)
    }

    return result
}

function normalizeCitationSpacing(text: string): string {
    return text
        .replace(/(\[\[\d+\]\])(?=\[\[\d+\]\])/g, '$1 ')
        .replace(/(\[\d+\])(?=\[\d+\])/g, '$1 ')
        .replace(/([\p{L}\p{N}])(\[\[(\d+)\]\]|\[(\d+)\])/gu, '$1 $2')
        .replace(/(\[\[(\d+)\]\]|\[(\d+)\])([\p{L}\p{N}])/gu, '$1 $4')
}

function recoverPlainNumericCitations(
    text: string,
    references: Record<string, { memo_uuid: string; memo_title: string; source_url?: string }>
): string {
    const availableKeys = new Set(Object.keys(references))
    if (availableKeys.size === 0) {
        return text
    }

    return text.replace(/((?:\[\d+\]|\d+)(?:[\s,]+(?:\[\d+\]|\d+))+)/g, (cluster) => {
        if (!/\[\d+\]/.test(cluster)) {
            return cluster
        }

        return cluster.replace(/(^|[\s,])(\d+)(?=([\s,]+|$))/g, (match, prefix: string, digits: string) => {
            if (!availableKeys.has(digits)) {
                return match
            }

            return `${prefix}[${digits}]`
        })
    })
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
const ERROR_CODE_QUERY_PATTERN = /(에러\s*코드|에러코드|오류\s*코드|오류코드|error\s*codes?)/iu
const NUMERIC_ERROR_CODE_PATTERN = /\b\d{4,}\b/u
const INFORMATION_COMPARISON_QUERY_PATTERN = /(차이|비교|다른 점|뭐가 달라|어떻게 달라|기능 설명|정의|개요|설명)/iu

function shouldSkipProductFilter(query: string): boolean {
    return ERROR_CODE_QUERY_PATTERN.test(query) && NUMERIC_ERROR_CODE_PATTERN.test(query)
}

function shouldUseRelaxedProductFilter(query: string): boolean {
    return INFORMATION_COMPARISON_QUERY_PATTERN.test(query)
}

/**
 * Detect product_id keyword from user query
 * Supports Korean aliases and compound keywords
 * Returns the matched product_id or undefined if not found
 */
export function detectProductId(query: string): ProductId | undefined {
    const lowerQuery = query.toLowerCase()

    if (shouldSkipProductFilter(query)) {
        return undefined
    }

    if (/\b[A-Z][A-Z0-9_]+-\d+\b/.test(query)) {
        return undefined
    }

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
const activeConversationOperations = new Map<string, Promise<void>>()

async function runConversationSerially<T>(historyKey: string, operation: () => Promise<T>): Promise<T> {
    const previous = activeConversationOperations.get(historyKey) ?? Promise.resolve()
    let releaseCurrent!: () => void
    const current = new Promise<void>((resolve) => {
        releaseCurrent = resolve
    })
    const chain = previous.catch(() => undefined).then(() => current)
    activeConversationOperations.set(historyKey, chain)

    await previous.catch(() => undefined)

    try {
        return await operation()
    } finally {
        releaseCurrent()
        if (activeConversationOperations.get(historyKey) === chain) {
            activeConversationOperations.delete(historyKey)
        }
    }
}

function buildThreadName(query: string): string {
    const normalized = query.replace(/\s+/g, ' ').trim()
    if (!normalized) {
        return 'Skald 답변 스레드'
    }

    const compact = normalized.slice(0, 70)
    return `🤖 ${compact}`
}

function stripDiscordMentions(content: string): string {
    return content
        .replace(/<[@#][!&]?\d+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
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

    const hasBroadcastMention = message.mentions.everyone || /(^|\s)@(everyone|here)\b/i.test(message.content)
    if (hasBroadcastMention) return

    if (!client.user || !message.mentions.has(client.user)) return

    const query = stripDiscordMentions(message.content)

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

    await runConversationSerially(historyKey, async () => {
        const history = [...(conversationHistory.get(historyKey) || [])]

        const reply = await responseThread.send(
            '🔎 질문을 접수했고 관련 문서를 먼저 확인하는 중입니다. 곧 자세한 답변을 이어서 보여드릴게요.'
        )
        const editor = new DiscordStreamEditor(reply)
        const startedAt = Date.now()

        try {
            const skaldClient = new SkaldClient({
                baseUrl: config.skaldApiUrl,
                apiKey: config.skaldApiKey,
                projectId: config.skaldProjectId,
            })

            let fullResponse = ''
            let references: ReferenceMap = {}
            let firstTokenLogged = false

            // Detect product_id from query and build filter
            const detectedProductId = detectProductId(query)
            const shouldRelaxProductFilter = shouldUseRelaxedProductFilter(query)
            const filters: MemoFilter[] | undefined =
                detectedProductId && !shouldRelaxProductFilter
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
                logger.info({ detectedProductId, relaxed: shouldRelaxProductFilter }, 'Product ID detected from query')
            }

            for await (const event of skaldClient.chatStream(query, {
                history,
                filters,
                system_prompt: DISCORD_MENTION_SYSTEM_PROMPT,
                rag_config: DISCORD_MENTION_RAG_CONFIG,
            })) {
                if (event.type === 'accepted') {
                    continue
                }

                if (event.type === 'progress') {
                    if (event.status === 'searching' || event.status === 'generating') {
                        await editor.showStatus(event.status)
                    }
                    continue
                }

                if (event.type === 'preview' && event.content) {
                    await editor.setPreview(event.content)
                    continue
                }

                if (event.type === 'token' && event.content) {
                    if (!firstTokenLogged) {
                        firstTokenLogged = true
                        logger.info({ elapsedMs: Date.now() - startedAt }, 'Received first token for mention response')
                    }

                    fullResponse += event.content
                    editor.append(event.content)
                    continue
                }

                if (event.type === 'references' && event.content) {
                    references = parseReferencesEventContent(event.content)
                    continue
                }

                if (event.type === 'done') {
                    continue
                }

                if (event.type === 'error' || event.type === 'transport_error') {
                    const userFacingError = buildMentionErrorMessage(event.content)
                    logger.warn(
                        {
                            eventType: event.type,
                            streamError: event.content,
                            elapsedMs: Date.now() - startedAt,
                            partialResponseLength: fullResponse.length,
                        },
                        'Mention stream failed'
                    )

                    if (shouldPreservePartialResponseOnError(event.type, fullResponse)) {
                        const partialResponse = formatFinalResponse(query, fullResponse, references, { partial: true })

                        try {
                            await editor.finalize(partialResponse)
                        } catch (editError) {
                            logger.error(
                                { err: editError },
                                'Failed to finalize partial response, falling back to plain messages'
                            )
                            await sendFinalResponseFallback(responseThread, partialResponse)
                        }

                        await sendReferenceEmbeds(responseThread, fullResponse, references)
                        await responseThread.send(`⚠️ ${userFacingError}`)
                        persistConversationHistory(historyKey, history, query, partialResponse)
                    } else {
                        await editor.showError(userFacingError)
                    }

                    return
                }
            }

            if (!fullResponse.trim()) {
                throw new Error('Chat stream completed without any response content')
            }

            const finalResponseWithNotice = formatFinalResponse(query, fullResponse, references)

            try {
                await editor.finalize(finalResponseWithNotice)
            } catch (editError) {
                logger.error({ err: editError }, 'Failed to stream final response, falling back to plain messages')
                await sendFinalResponseFallback(responseThread, finalResponseWithNotice)
            }

            await sendReferenceEmbeds(responseThread, fullResponse, references)

            logger.info(
                { elapsedMs: Date.now() - startedAt, responseLength: fullResponse.length },
                'Completed streamed mention response'
            )

            persistConversationHistory(historyKey, history, query, finalResponseWithNotice)
        } catch (error) {
            logger.error({ err: error, elapsedMs: Date.now() - startedAt }, 'Failed to handle mention')
            const fallbackMessage = buildMentionErrorMessage(error instanceof Error ? error.message : String(error))
            await editor.showError(fallbackMessage)
        }
    })
}

export const __testables__ = {
    buildMentionErrorMessage,
    formatFinalResponse,
    extractCitedReferenceKeys,
    selectReferenceEntries,
    extractInfoDocUrls,
    parseReferencesEventContent,
    detectProductId,
    shouldSkipProductFilter,
    shouldPreservePartialResponseOnError,
    stripDiscordMentions,
    buildThreadName,
    DISCORD_MENTION_RAG_CONFIG,
    shouldUseRelaxedProductFilter,
}
