import express, { Request, Response } from 'express'
import { parseFilter } from '@/lib/filterUtils'
import { streamChatAgent } from '@/agents/chatAgent/chatAgent'
import { IS_CLOUD, IS_DEVELOPMENT } from '@/settings'
import { logger } from '@/lib/logger'
import * as Sentry from '@sentry/node'
import { createChatMessagePair } from '@/lib/chatUtils'
import { CachedQueries } from '@/queries/cachedQueries'
import { DI } from '@/di'
import { ragGraph } from '@/agents/chatAgent/ragGraph'
import { parseRagConfig } from '@/lib/ragUtils'
import { routeQuery } from '@/lib/queryRouter'
import { ChatPromptTemplate } from '@langchain/core/prompts'
import { Project } from '@/entities/Project'
import { chatRateLimiter } from '@/middleware/rateLimitMiddleware'
import { trackChatUsage } from '@/middleware/trackChatUsageMiddleware'
import { posthogCapture } from '@/lib/posthogUtils'
import { SelfRagEvaluator } from '@/lib/selfRagEvaluator'
import { ComplexityCalculator } from '@/lib/complexityCalculator'
import {
    checkAndQueueLazyReprocess,
    extractMemoUuidsFromRerankResults,
    extractMemoUuidsFromReferences,
} from '@/lib/lazyReprocessService'

export const chat = async (req: Request, res: Response) => {
    const query = req.body.query
    const stream = req.body.stream || false
    const filters = req.body.filters || []
    const chatId = req.body.chat_id
    const clientSystemPrompt = req.body.system_prompt || null
    const ragConfig = req.body.rag_config || {}

    if (!query) {
        return res.status(400).json({ error: 'Query is required' })
    }

    if (!Array.isArray(filters)) {
        return res.status(400).json({ error: 'Filters must be a list' })
    }
    const { parsedRagConfig, error } = parseRagConfig(ragConfig)
    if (error || !parsedRagConfig) {
        return res.status(400).json({ error: error || 'Error parsing rag_config' })
    }

    const project = req.context?.requestUser?.project
    if (!project) {
        // we should never get here, but do this for type safety and extra security
        return res.status(404).json({ error: 'Project not found' })
    }

    if (IS_CLOUD) {
        const isOrgOnFreePlan = await CachedQueries.isOrganizationOnFreePlan(DI.em, project.organization.uuid)
        if (isOrgOnFreePlan) {
            const usage = await CachedQueries.getOrganizationUsage(DI.em, project.organization.uuid)
            if (usage.chatQueries >= 100) {
                return res.status(403).json({
                    error: "You've reached your plan limit of 100 chat queries. Upgrade your plan to continue using chat.",
                })
            }
            if (usage.memoWrites > 1000) {
                return res.status(403).json({
                    error: "You've reached your plan limit of 1000 memo writes. Upgrade your plan to continue chat.",
                })
            }
        }
    }

    const memoFilters = []
    for (const filter of filters) {
        const { filter: memoFilter, error } = parseFilter(filter)
        if (memoFilter && !error) {
            memoFilters.push(memoFilter)
        } else {
            return res.status(400).json({ error: `Invalid filter: ${error}` })
        }
    }

    const routeResult = routeQuery(query)
    if (routeResult.route !== 'rag' && routeResult.response) {
        const directResponse = routeResult.response
        const finalChatId = await createChatMessagePair(project, query, directResponse, chatId, clientSystemPrompt)

        if (stream) {
            _setStreamingResponseHeaders(res)
            res.write(': ping\n\n')
            res.write(`data: ${JSON.stringify({ type: 'token', content: directResponse })}\n\n`)
            res.write(`data: ${JSON.stringify({ type: 'done', chat_id: finalChatId })}\n\n`)
            res.end()
            return
        }

        return res.status(200).json({
            ok: true,
            chat_id: finalChatId,
            response: directResponse,
            intermediate_steps: [],
        })
    }

    // For streaming, we want to start the response immediately to avoid 504 timeouts
    // caused by long-running RAG processes (especially with local LLMs)
    if (stream) {
        // Log that we are entering streaming mode
        logger.info({ chatId, query }, 'Starting streaming response for chat')

        // We do NOT await ragGraph here for streaming. We pass the config into _generateStreamingResponse
        // and let it run the RAG graph *after* sending headers.
        return await _generateStreamingResponse({
            res,
            query,
            project,
            chatId,
            filters,
            clientSystemPrompt,
            parsedRagConfig,
        })
    }

    logger.info(
        {
            similarityThreshold: parsedRagConfig.vectorSearch.similarityThreshold,
            topK: parsedRagConfig.vectorSearch.topK,
            rerankingEnabled: parsedRagConfig.reranking.enabled,
            rerankingTopK: parsedRagConfig.reranking.topK,
            hybridSearchEnabled: parsedRagConfig.hybridSearch?.enabled,
        },
        'RAG request configuration'
    )

    const ragResultState = await ragGraph.invoke({
        query,
        project,
        chatId,
        filters,
        clientSystemPrompt,
        ragConfig: parsedRagConfig,
    })

    const { query: finalQuery, contextStr, prompt, rerankedResults } = ragResultState

    posthogCapture({
        event: 'chat_api_call',
        distinctId: req.context?.requestUser?.userInstance?.email || `project:${project.uuid}`,
        groups: {
            organization: project.organization.uuid,
        },
        properties: {
            query: query,
            filters: filters,
            ragConfig: parsedRagConfig,
        },
    })

    try {
        // non-streaming response - compose full response from stream
        let fullResponse = ''
        let references: Record<number, { memo_uuid: string; memo_title: string }> | undefined

        for await (const chunk of streamChatAgent({
            query: finalQuery,
            prompt,
            contextStr: contextStr || '',
            rerankResults: rerankedResults || [],
            enableReferences: parsedRagConfig.references.enabled,
            llmProvider: parsedRagConfig.llmProvider,
        })) {
            if (chunk.type === 'token') {
                fullResponse += chunk.content || ''
            } else if (chunk.type === 'references' && chunk.content) {
                references = JSON.parse(chunk.content)
            }
        }

        const contextLength = contextStr?.length || 0
        const rerankedCount = rerankedResults?.length || 0
        const hasContext = contextLength > 0
        const responseType = fullResponse.length < 50 ? 'rejected' : fullResponse.length < 200 ? 'partial' : 'detailed'

        logger.info(
            {
                contextLength,
                rerankedCount,
                hasContext,
                responseType,
                responseLength: fullResponse.length,
            },
            'RAG result metrics'
        )

        let finalResponse = fullResponse

        if (parsedRagConfig.selfRag?.enabled) {
            const complexity = ComplexityCalculator.calculate(query)
            if (complexity.requiresSelfRag) {
                const contextChunks = (rerankedResults || []).map((r: any) => r.document || r.chunk_content || '')
                const initialEval = await SelfRagEvaluator.evaluate(query, fullResponse, contextChunks)
                const qualityThreshold = parsedRagConfig.selfRag.qualityThreshold

                if (SelfRagEvaluator.requiresRegeneration(initialEval, qualityThreshold)) {
                    logger.info(
                        {
                            initialScore: initialEval.overall,
                            threshold: qualityThreshold,
                        },
                        'Self-RAG: quality insufficient, attempting regeneration'
                    )

                    const retryRagConfig = {
                        ...parsedRagConfig,
                        vectorSearch: {
                            ...parsedRagConfig.vectorSearch,
                            topK: Math.min(parsedRagConfig.vectorSearch.topK * 3, 200),
                        },
                        reranking: {
                            ...parsedRagConfig.reranking,
                            topK: Math.min(parsedRagConfig.reranking.topK * 2, 100),
                        },
                    }

                    try {
                        const retryState = await ragGraph.invoke({
                            query,
                            project,
                            chatId,
                            filters,
                            clientSystemPrompt,
                            ragConfig: retryRagConfig,
                        })

                        let retryResponse = ''
                        let retryReferences: Record<number, { memo_uuid: string; memo_title: string }> | undefined

                        for await (const chunk of streamChatAgent({
                            query: retryState.query,
                            prompt: retryState.prompt,
                            contextStr: retryState.contextStr || '',
                            rerankResults: retryState.rerankedResults || [],
                            enableReferences: retryRagConfig.references.enabled,
                            llmProvider: retryRagConfig.llmProvider,
                        })) {
                            if (chunk.type === 'token') retryResponse += chunk.content || ''
                            if (chunk.type === 'references' && chunk.content) {
                                retryReferences = JSON.parse(chunk.content)
                            }
                        }

                        const retryContextChunks = (retryState.rerankedResults || []).map(
                            (r: any) => r.document || r.chunk_content || ''
                        )
                        const retryEval = await SelfRagEvaluator.evaluate(query, retryResponse, retryContextChunks)

                        if (
                            SelfRagEvaluator.shouldRollback(
                                initialEval,
                                retryEval,
                                parsedRagConfig.selfRag.rollbackThreshold
                            )
                        ) {
                            logger.warn(
                                {
                                    initialScore: initialEval.overall,
                                    retryScore: retryEval.overall,
                                },
                                'Self-RAG: regeneration worse, rolling back to original'
                            )
                        } else {
                            finalResponse = retryResponse
                            if (retryReferences) {
                                references = retryReferences
                            }
                            logger.info(
                                {
                                    initialScore: initialEval.overall,
                                    retryScore: retryEval.overall,
                                    improvement: retryEval.overall - initialEval.overall,
                                },
                                'Self-RAG: regeneration improved response'
                            )
                        }
                    } catch (retryError) {
                        logger.error({ err: retryError }, 'Self-RAG: regeneration failed, using original response')
                    }
                }
            }
        }

        const finalChatId = await createChatMessagePair(project, query, finalResponse, chatId, clientSystemPrompt)

        const response: any = {
            ok: true,
            chat_id: finalChatId,
            response: finalResponse,
            intermediate_steps: [],
        }

        if (references) {
            response.references = references
        }

        // Fire-and-forget lazy reprocessing (don't await to avoid response delay)
        const memoUuids = references
            ? extractMemoUuidsFromReferences(references)
            : extractMemoUuidsFromRerankResults(rerankedResults || [])
        if (memoUuids.length > 0) {
            checkAndQueueLazyReprocess(memoUuids, project.uuid).catch((err) => {
                logger.warn({ err }, 'Lazy reprocess: failed to trigger (non-blocking)')
            })
        }

        return res.status(200).json(response)
    } catch (error) {
        logger.error({ err: error }, 'Chat agent error')
        Sentry.captureException(error)
        return res.status(503).json({ error: 'Chat agent unavailable' })
    }
}

export const _setStreamingResponseHeaders = (res: Response) => {
    // set headers for Server-Sent Events (SSE)
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('X-Accel-Buffering', 'no')
}

interface RerankResult {
    memo_uuid?: string
    memo_title?: string
}

export const _generateStreamingResponse = async ({
    res,
    query,
    project,
    chatId,
    filters,
    clientSystemPrompt,
    parsedRagConfig,
}: {
    res: Response
    query: string
    project: Project
    chatId?: string
    filters: any[]
    clientSystemPrompt: string | null
    parsedRagConfig: any
}): Promise<void> => {
    _setStreamingResponseHeaders(res)

    // establish connection immediately to prevent 504
    res.write(': ping\n\n')

    logger.info({ provider: parsedRagConfig.llmProvider }, 'Starting RAG process for stream')

    let fullResponse = ''
    let streamingRerankedResults: Array<{ memo_uuid?: string }> = []
    try {
        // Run RAG graph *after* headers are sent
        const ragResultState = await ragGraph.invoke({
            query,
            project,
            chatId,
            filters,
            clientSystemPrompt,
            ragConfig: parsedRagConfig,
        })

        const { query: finalQuery, contextStr, prompt, rerankedResults } = ragResultState
        streamingRerankedResults = rerankedResults || []

        logger.info('RAG process completed, starting generation')

        for await (const chunk of streamChatAgent({
            query: finalQuery,
            prompt,
            contextStr: contextStr || '',
            rerankResults: rerankedResults || [],
            enableReferences: parsedRagConfig.references.enabled,
            llmProvider: parsedRagConfig.llmProvider,
        })) {
            // format as Server-Sent Event
            const data = JSON.stringify(chunk)
            res.write(`data: ${data}\n\n`)

            // Only accumulate token content, not references or other event types
            if (chunk.type === 'token') {
                fullResponse += chunk.content || ''
            }
        }

        // Save chat to DB
        const finalChatId = await createChatMessagePair(project, query, fullResponse, chatId, clientSystemPrompt)
        res.write(`data: ${JSON.stringify({ type: 'done', chat_id: finalChatId })}\n\n`)
    } catch (error) {
        Sentry.captureException(error)
        logger.error(
            { err: error, llmProvider: parsedRagConfig?.llmProvider, errorMessage: (error as Error)?.message },
            'Streaming chat agent error - check if model is supported by CLI Proxy'
        )
        const errorMsg =
            IS_DEVELOPMENT && error instanceof Error ? `${error.message}\n${error.stack}` : 'An error occurred'
        const errorData = JSON.stringify({ type: 'error', content: errorMsg })
        res.write(`data: ${errorData}\n\n`)
    } finally {
        res.end()

        // Fire-and-forget lazy reprocessing after stream ends (don't block response)
        const memoUuids = extractMemoUuidsFromRerankResults(streamingRerankedResults)
        if (memoUuids.length > 0) {
            checkAndQueueLazyReprocess(memoUuids, project.uuid).catch((err) => {
                logger.warn({ err }, 'Lazy reprocess: failed to trigger after stream (non-blocking)')
            })
        }
    }
}
export const listChats = async (req: Request, res: Response) => {
    const project = req.context?.requestUser?.project as Project

    if (!project) {
        return res.status(404).json({ error: 'Project not found' })
    }

    const page = parseInt(req.query.page as string) || 1
    const pageSize = parseInt(req.query.page_size as string) || 20
    const maxPageSize = 100

    if (pageSize > maxPageSize) {
        return res.status(400).json({ error: `page_size must be less than or equal to ${maxPageSize}` })
    }

    if (page < 1) {
        return res.status(400).json({ error: 'page must be greater than or equal to 1' })
    }

    const offset = (page - 1) * pageSize

    const [chats, totalCount] = await DI.chats.findAndCount(
        { project },
        {
            orderBy: { created_at: 'DESC' },
            limit: pageSize,
            offset: offset,
        }
    )

    // Get all messages for these chats
    const chatUuids = chats.map((chat) => chat.uuid)
    const allMessages = await DI.chatMessages.find(
        {
            chat: { $in: chatUuids },
        },
        {
            orderBy: { sent_at: 'ASC' },
        }
    )

    // Group messages by chat and extract relevant data
    const chatDataMap = new Map<
        string,
        {
            firstUserMessage: string | null
            messageCount: number
            lastMessageAt: Date | null
        }
    >()

    for (const message of allMessages) {
        const chatId = message.chat.uuid
        const chatData = chatDataMap.get(chatId) || {
            firstUserMessage: null,
            messageCount: 0,
            lastMessageAt: null,
        }

        chatData.messageCount++

        if (message.sent_by === 'user' && !chatData.firstUserMessage) {
            chatData.firstUserMessage = message.content
        }

        if (!chatData.lastMessageAt || message.sent_at > chatData.lastMessageAt) {
            chatData.lastMessageAt = message.sent_at
        }

        chatDataMap.set(chatId, chatData)
    }

    const results = chats.map((chat) => {
        const chatData = chatDataMap.get(chat.uuid) || {
            firstUserMessage: null,
            messageCount: 0,
            lastMessageAt: null,
        }

        return {
            uuid: chat.uuid,
            created_at: chat.created_at,
            title: chatData.firstUserMessage || 'Untitled Chat',
            message_count: chatData.messageCount,
            last_message_at: chatData.lastMessageAt || chat.created_at,
        }
    })

    return res.status(200).json({
        results,
        count: totalCount,
        page,
        page_size: pageSize,
        total_pages: Math.ceil(totalCount / pageSize),
    })
}

export const getChat = async (req: Request, res: Response) => {
    const project = req.context?.requestUser?.project as Project
    const { id } = req.params

    const chat = await DI.chats.findOne({ uuid: id, project })

    if (!chat) {
        return res.status(404).json({ error: 'Chat not found' })
    }

    // Get all messages for this chat
    const messages = await DI.chatMessages.find(
        { chat },
        {
            orderBy: { sent_at: 'ASC' },
        }
    )

    const chatMessages = messages.map((message) => ({
        uuid: message.uuid,
        content: message.content,
        sent_by: message.sent_by,
        sent_at: message.sent_at,
        skald_system_prompt: message.skald_system_prompt,
        client_system_prompt: message.client_system_prompt,
    }))

    return res.status(200).json({
        uuid: chat.uuid,
        created_at: chat.created_at,
        messages: chatMessages,
    })
}

export const chatRouter = express.Router({ mergeParams: true })
chatRouter.get('/', listChats)
chatRouter.get('/:id', getChat)
chatRouter.post('/', [chatRateLimiter, trackChatUsage()], chat)