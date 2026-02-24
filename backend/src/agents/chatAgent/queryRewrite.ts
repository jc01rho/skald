import { QUERY_REWRITE_PROMPT, MULTI_QUERY_PROMPT, HYDE_PROMPT, JIRA_HYDE_PROMPT } from '@/agents/chatAgent/prompts'
import { logger } from '@/lib/logger'
import { LLMService } from '@/services/llmService'
import * as Sentry from '@sentry/node'

interface ConversationMessage {
    role: 'user' | 'assistant'
    content: string
}

export const rewrite = async (query: string, conversationHistory: ConversationMessage[] = []): Promise<string> => {
    try {
        const recentHistory = conversationHistory.slice(-3)
        const contextStr =
            recentHistory.length > 0
                ? `\n\nCONVERSATION CONTEXT:\n${recentHistory
                      .map((msg) => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`)
                      .join('\n')}\n`
                : ''

        const userPrompt = `${contextStr}\nQuery to enhance: "${query}"`

        const response = await LLMService.invokeWithRetry({
            messages: [
                { role: 'system', content: QUERY_REWRITE_PROMPT },
                { role: 'user', content: userPrompt },
            ],
            temperature: 0.3,
        })

        const rewrittenQuery = response.content?.toString().trim()

        if (!rewrittenQuery) {
            logger.warn({ query }, 'Query rewriting failed, returning original query')
            return query
        }

        logger.info({ originalQuery: query, rewrittenQuery }, 'Query rewrite completed')
        return rewrittenQuery
    } catch (error) {
        logger.error({ err: error, query }, 'Error rewriting query')
        Sentry.captureException(error, {
            tags: { service: 'query_rewrite' },
            extra: { query },
        })
        return query
    }
}

export const rewriteMultiQuery = async (query: string): Promise<string[]> => {
    try {
        const response = await LLMService.invokeWithRetry({
            messages: [
                { role: 'system', content: MULTI_QUERY_PROMPT },
                { role: 'user', content: `Query: "${query}"` },
            ],
            temperature: 0.3,
        })

        const rewritten = response.content?.toString().trim()

        if (!rewritten) {
            logger.warn({ query }, 'Multi-query rewriting failed, returning original query only')
            return [query]
        }

        // Parse 2-3 query variations, filter empty lines, limit to 3
        const queries = rewritten
            .split('\n')
            .map((q: string) => q.trim())
            .filter((q: string) => q.length > 0)
            .slice(0, 3)

        return queries.length > 0 ? queries : [query]
    } catch (error) {
        logger.error({ err: error, query }, 'Error rewriting multi-query')
        Sentry.captureException(error, {
            tags: { service: 'multi_query_rewrite' },
            extra: { query },
        })
        return [query]
    }
}

export const generateHyDE = async (query: string): Promise<string> => {
    try {
        const response = await LLMService.invokeWithRetry({
            messages: [
                { role: 'system', content: HYDE_PROMPT },
                { role: 'user', content: query },
            ],
            temperature: 0.3,
        })

        const hypothetical = response.content?.toString().trim()

        if (!hypothetical) {
            logger.warn({ query }, 'HyDE generation failed, returning empty string')
            return ''
        }

        return hypothetical
    } catch (error) {
        logger.error({ err: error, query }, 'Error generating HyDE')
        Sentry.captureException(error, {
            tags: { service: 'hyde_generation' },
            extra: { query },
        })
        return ''
    }
}

export const generateJiraHyDE = async (query: string): Promise<string> => {
    try {
        const response = await LLMService.invokeWithRetry({
            messages: [
                { role: 'system', content: JIRA_HYDE_PROMPT },
                { role: 'user', content: query },
            ],
            temperature: 0.3,
        })

        const hypothetical = response.content?.toString().trim()

        if (!hypothetical) {
            logger.warn({ query }, 'Jira HyDE generation failed, returning empty string')
            return ''
        }

        return hypothetical
    } catch (error) {
        logger.error({ err: error, query }, 'Error generating Jira HyDE')
        Sentry.captureException(error, {
            tags: { service: 'jira_hyde_generation' },
            extra: { query },
        })
        return ''
    }
}
