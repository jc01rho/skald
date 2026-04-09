import {
    __testables__,
    getLowConfidenceGuidanceMode,
    shouldInjectLowConfidenceGuidance,
} from '../agents/chatAgent/ragGraph'

describe('ragGraph low-confidence guidance', () => {
    const createBuildInputsState = (
        overrides: Partial<Parameters<typeof __testables__.buildLLMInputsNode>[0]> = {}
    ): Parameters<typeof __testables__.buildLLMInputsNode>[0] => ({
        project: null as never,
        query: 'What does this mean?',
        filters: [],
        clientSystemPrompt: null,
        userContext: null,
        ragConfig: {
            llmProvider: 'cli-proxy-api',
            references: { enabled: false },
            queryRewrite: { enabled: false },
            vectorSearch: { topK: 20, similarityThreshold: 0.4 },
            reranking: { enabled: true, topK: 20 },
            confidence: { threshold: 0.35 },
        },
        chatId: null,
        conversationHistory: null,
        queryUnderstanding: null,
        rewrittenQuery: null,
        subQuestions: null,
        chunkResults: null,
        rerankedResults: [],
        memoPropertiesMap: null,
        parentChunkMap: null,
        precomputedQueryEmbedding: null,
        cragValidation: null,
        prompt: undefined as never,
        contextStr: null,
        exactLookupKeys: null,
        exactLookupResults: null,
        lookupHit: false,
        wikiTraversal: null,
        ...overrides,
    })

    it('returns user_context_only_partial when retrieval is weak but user context exists', () => {
        const mode = getLowConfidenceGuidanceMode({
            lookupHit: false,
            rerankedResults: [],
            confidenceThreshold: 0.35,
            hasUserContext: true,
        })

        expect(mode).toBe('user_context_only_partial')
        expect(
            shouldInjectLowConfidenceGuidance({
                lookupHit: false,
                rerankedResults: [],
                confidenceThreshold: 0.35,
                hasUserContext: true,
            })
        ).toBe(true)
    })

    it('returns retrieval_only_partial for weak retrieval without user context', () => {
        const mode = getLowConfidenceGuidanceMode({
            lookupHit: false,
            rerankedResults: [{ index: 0, document: 'weak', relevance_score: 0.2 }],
            confidenceThreshold: 0.35,
        })

        expect(mode).toBe('retrieval_only_partial')
    })

    it('returns both_weak_limitations when weak retrieval coexists with user context', () => {
        const mode = getLowConfidenceGuidanceMode({
            lookupHit: false,
            rerankedResults: [{ index: 0, document: 'weak', relevance_score: 0.2 }],
            confidenceThreshold: 0.35,
            hasUserContext: true,
        })

        expect(mode).toBe('both_weak_limitations')
    })

    it('returns key_miss_with_alternatives when requested key is missing but alternatives exist', () => {
        const mode = getLowConfidenceGuidanceMode({
            lookupHit: false,
            rerankedResults: [{ index: 0, document: 'alternative', relevance_score: 0.61 }],
            confidenceThreshold: 0.35,
            hasKeyMisses: true,
        })

        expect(mode).toBe('key_miss_with_alternatives')
    })

    it('prioritizes key_miss_with_alternatives over strong literal anchor suppression', () => {
        const mode = getLowConfidenceGuidanceMode({
            lookupHit: false,
            rerankedResults: [{ index: 0, document: '오류 코드 450002', relevance_score: 0.05 }],
            confidenceThreshold: 0.35,
            hasStrongLiteralAnchorEvidence: true,
            hasKeyMisses: true,
        })

        expect(mode).toBe('key_miss_with_alternatives')
    })

    it('suppresses guidance when literal anchor evidence is strong', () => {
        const mode = getLowConfidenceGuidanceMode({
            lookupHit: false,
            rerankedResults: [{ index: 0, document: '오류 코드 450002', relevance_score: 0.05 }],
            confidenceThreshold: 0.35,
            hasStrongLiteralAnchorEvidence: true,
            hasUserContext: true,
        })

        expect(mode).toBe('none')
        expect(
            shouldInjectLowConfidenceGuidance({
                lookupHit: false,
                rerankedResults: [{ index: 0, document: '오류 코드 450002', relevance_score: 0.05 }],
                confidenceThreshold: 0.35,
                hasStrongLiteralAnchorEvidence: true,
                hasUserContext: true,
            })
        ).toBe(false)
    })

    it('returns insufficient_evidence when retrieval is empty and there is no user context', () => {
        const mode = getLowConfidenceGuidanceMode({
            lookupHit: false,
            rerankedResults: [],
            confidenceThreshold: 0.35,
        })

        expect(mode).toBe('insufficient_evidence')
    })

    it('returns none when lookup hit already provides reliable evidence', () => {
        const mode = getLowConfidenceGuidanceMode({
            lookupHit: true,
            rerankedResults: [],
            confidenceThreshold: 0.35,
            hasUserContext: true,
        })

        expect(mode).toBe('none')
    })

    it('returns key_miss_with_alternatives when only user context can serve as alternative evidence', () => {
        const mode = getLowConfidenceGuidanceMode({
            lookupHit: false,
            rerankedResults: [],
            confidenceThreshold: 0.35,
            hasUserContext: true,
            hasKeyMisses: true,
        })

        expect(mode).toBe('key_miss_with_alternatives')
    })

    it('builds user-context-only guidance that prefers partial answers over blanket abstain', () => {
        const guidance = __testables__.buildLowConfidenceGuidance({
            mode: 'user_context_only_partial',
            avgRelevanceScore: 0,
        })

        expect(guidance).toContain('[응답 제한 모드: 사용자 제공 컨텍스트 우선]')
        expect(guidance).toContain('[User-Provided Context]에 직접 포함된 사실만 제한적으로 답변')
        expect(guidance).toContain('확인된 부분과 아직 확인되지 않은 부분을 분리')
    })

    it('builds key-miss guidance that distinguishes missing requested docs from alternatives', () => {
        const guidance = __testables__.buildLowConfidenceGuidance({
            mode: 'key_miss_with_alternatives',
            avgRelevanceScore: 0.42,
        })

        expect(guidance).toContain('[응답 제한 모드: 요청 문서 없음 + 대체 근거]')
        expect(guidance).toContain('요청 문서 자체를 찾은 것처럼 말하지 말고')
        expect(guidance).toContain('대체 근거임을 명확히 밝힌 뒤 제한적으로 답변')
    })

    it('injects user-context-only guidance into the final system prompt', async () => {
        const result = __testables__.buildLLMInputsNode(
            createBuildInputsState({
                userContext: 'Customer environment: OAuth gateway enabled',
            })
        )

        const messages = await result.prompt.formatMessages({
            input: 'What does this mean?',
            context: result.contextStr ?? '',
        })
        const systemMessage = messages[0]?.content

        expect(systemMessage).toContain('[응답 제한 모드: 사용자 제공 컨텍스트 우선]')
        expect(systemMessage).toContain('[User-Provided Context]에 직접 포함된 사실만 제한적으로 답변')
    })

    it('escapes citation-shaped tokens inside the user-context evidence block', () => {
        const block = __testables__.buildUserContextEvidenceBlock(
            'Observed markers [[1]] and [2] should stay user-provided only.'
        )

        expect(block).toContain('Observed markers ［［1］］ and ［2］ should stay user-provided only.')
        expect(block).not.toContain('Observed markers [[1]] and [2] should stay user-provided only.')
    })

    it('injects key-miss alternative guidance and suppresses duplicate key-not-found guidance', async () => {
        const result = __testables__.buildLLMInputsNode(
            createBuildInputsState({
                userContext: 'Customer says the issue appears after OAuth redirect.',
                exactLookupResults: [
                    {
                        key: 'DOC-404',
                        title: 'Missing document',
                        content: '',
                        source_url: '',
                        found: false,
                        status: 'miss',
                    },
                ],
            })
        )

        const messages = await result.prompt.formatMessages({
            input: 'Find DOC-404',
            context: result.contextStr ?? '',
        })
        const systemMessage = messages[0]?.content

        expect(systemMessage).toContain('[응답 제한 모드: 요청 문서 없음 + 대체 근거]')
        expect(systemMessage).not.toContain('[Key-Not-Found Guidance]')
    })

    it('does not inject limitation guidance when strong literal anchor evidence exists without key miss', async () => {
        const result = __testables__.buildLLMInputsNode(
            createBuildInputsState({
                query: '오류 코드 450002 는 무엇인가?',
                chunkResults: [
                    {
                        chunk: {
                            uuid: 'chunk-1',
                            chunk_content: '오류 코드 450002 는 인증 실패를 의미합니다.',
                        },
                    },
                ] as Parameters<typeof __testables__.buildLLMInputsNode>[0]['chunkResults'],
                rerankedResults: [
                    {
                        index: 0,
                        document: '오류 코드 450002 는 인증 실패를 의미합니다.',
                        relevance_score: 0.05,
                        memo_uuid: 'memo-1',
                    },
                ],
            })
        )

        const messages = await result.prompt.formatMessages({
            input: '오류 코드 450002 는 무엇인가?',
            context: result.contextStr ?? '',
        })
        const systemMessage = messages[0]?.content

        expect(systemMessage).not.toContain('[응답 제한 모드:')
    })

    it('injects separated grounded answer guidance when mixed-question decomposition exists', async () => {
        const result = __testables__.buildLLMInputsNode(
            createBuildInputsState({
                subQuestions: ['원본 질문', '장애 요약', '원인 분석', '권장 조치'],
            })
        )

        const messages = await result.prompt.formatMessages({
            input: '원본 질문',
            context: result.contextStr ?? '',
        })
        const systemMessage = messages[0]?.content

        expect(systemMessage).toContain('[Mixed-Question Answer Format]')
        expect(systemMessage).toContain('Answer in separated grounded sections')
        expect(systemMessage).toContain('Distinguish grounded facts from limited recommendations')
        expect(result.contextStr).toContain('[Mixed-Question Decomposition]')
        expect(result.contextStr).toContain('Sub-question 1: 장애 요약')
        expect(result.contextStr).toContain('Sub-question 3: 권장 조치')
    })

    it('injects browseable wiki context blocks into final context assembly', () => {
        const result = __testables__.buildLLMInputsNode(
            createBuildInputsState({
                wikiTraversal: {
                    pages: [
                        {
                            slug: 'oauth-gateway',
                            title: 'OAuth Gateway',
                            summary: '인증 게이트웨이 동작 개요',
                            canonical: 'oauth_gateway',
                            confidence: 0.9,
                            freshness: 0.8,
                        },
                    ],
                    nodes: [
                        {
                            canonicalName: 'oauth_gateway',
                            displayName: 'OAuth Gateway',
                            description: '인증 리다이렉트를 담당하는 컴포넌트',
                            nodeType: 'artifact',
                            confidence: 0.9,
                            freshness: 0.8,
                        },
                    ],
                    edges: [
                        {
                            fromCanonicalName: 'oauth_gateway',
                            toCanonicalName: 'auth_callback',
                            edgeType: 'depends_on',
                            weight: 0.8,
                        },
                    ],
                },
            })
        )

        expect(result.contextStr).toContain('[Related Wiki Pages]')
        expect(result.contextStr).toContain('OAuth Gateway (oauth-gateway): 인증 게이트웨이 동작 개요')
        expect(result.contextStr).toContain('[Wiki Graph Nodes]')
        expect(result.contextStr).toContain('OAuth Gateway <artifact>: 인증 리다이렉트를 담당하는 컴포넌트')
        expect(result.contextStr).toContain('[Wiki Graph Relationships]')
        expect(result.contextStr).toContain('oauth_gateway --[depends_on]--> auth_callback')
    })
})
