import { logger } from '@/lib/logger'

export type QueryRoute = 'rag' | 'direct_greeting' | 'direct_chitchat'

export interface QueryRouteResult {
    route: QueryRoute
    response?: string
}

const GREETING_PATTERNS = ['안녕', '반갑', '하이', '헬로', 'hi', 'hello', '좋은 아침', '좋은 저녁', '좋은 하루']

const FAREWELL_PATTERNS = ['잘가', '안녕히', 'bye', 'goodbye', '바이', '수고']

const THANKS_PATTERNS = ['고마', '감사', 'thank', 'thx', 'ㄱㅅ', '땡큐']

export function routeQuery(query: string): QueryRouteResult {
    const q = query.toLowerCase().trim()

    if (q.length >= 30) {
        return { route: 'rag' }
    }

    if (GREETING_PATTERNS.some((p) => q.includes(p))) {
        logger.debug({ query, route: 'direct_greeting' }, 'Query routed to direct greeting')
        return { route: 'direct_greeting', response: '안녕하세요! 무엇을 도와드릴까요?' }
    }

    if (FAREWELL_PATTERNS.some((p) => q.includes(p))) {
        logger.debug({ query, route: 'direct_greeting' }, 'Query routed to farewell')
        return { route: 'direct_greeting', response: '안녕히 가세요! 도움이 필요하시면 언제든 말씀해주세요.' }
    }

    if (THANKS_PATTERNS.some((p) => q.includes(p))) {
        logger.debug({ query, route: 'direct_greeting' }, 'Query routed to thanks')
        return {
            route: 'direct_greeting',
            response: '도움이 되셨다니 기쁩니다! 다른 궁금한 점이 있으시면 말씀해주세요.',
        }
    }

    return { route: 'rag' }
}
