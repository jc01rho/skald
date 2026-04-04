import { __testables__ } from '../agents/chatAgent/ragGraph'
import { QueryUnderstandingAgent } from '../agents/queryUnderstandingAgent'
import * as queryRewrite from '../agents/chatAgent/queryRewrite'
import { EmbeddingService } from '../services/embeddingService'
import { HNSWOptimizationService } from '../lib/hnswOptimization'
import { HybridSearchService } from '../embeddings/hybridSearch'
import { Project } from '../entities/Project'
import { ChatPromptTemplate } from '@langchain/core/prompts'

jest.mock('../agents/queryUnderstandingAgent', () => ({
    QueryUnderstandingAgent: {
        understandQuery: jest.fn(),
    },
}))

jest.mock('../agents/chatAgent/queryRewrite', () => ({
    rewrite: jest.fn(),
    rewriteMultiQuery: jest.fn(),
    generateHyDE: jest.fn(),
    generateJiraHyDE: jest.fn(),
    decomposeQuery: jest.fn(),
}))

jest.mock('../services/embeddingService', () => ({
    EmbeddingService: {
        generateEmbedding: jest.fn(),
        generateEmbeddingsBatch: jest.fn(),
    },
}))

jest.mock('../lib/hnswOptimization', () => ({
    HNSWOptimizationService: {
        applyRuntimeSearchTuning: jest.fn(),
    },
}))

jest.mock('../embeddings/hybridSearch', () => ({
    HybridSearchService: {
        hybridSearch: jest.fn(),
    },
}))

jest.mock('../di', () => ({
    DI: { em: {} },
}))

describe('ragGraph decomposition wiring', () => {
    const createTestProject = () => ({ uuid: 'project-1' }) as Project

    const createBaseRagConfig = () => ({
        llmProvider: 'cli-proxy-api' as const,
        references: { enabled: true },
        queryUnderstanding: { enabled: true },
        queryRewrite: { enabled: true, multiQuery: false },
        vectorSearch: { topK: 5, similarityThreshold: 0.4 },
        reranking: { enabled: true, topK: 5, mmrEnabled: false },
        hybridSearch: { enabled: true, vectorWeight: 0.7, bm25Weight: 0.3 },
    })

    const createAnalyzeState = () => ({
        project: createTestProject(),
        query: '원본 질문',
        filters: [],
        clientSystemPrompt: null,
        userContext: null,
        ragConfig: createBaseRagConfig(),
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
        prompt: ChatPromptTemplate.fromMessages([
            ['system', 'test'],
            ['human', '{input}'],
        ]),
        contextStr: null,
        exactLookupKeys: null,
        exactLookupResults: null,
        lookupHit: null,
    })

    const createVectorSearchState = () => ({
        ...createAnalyzeState(),
        subQuestions: ['원본 질문', '하위 질문 1', '하위 질문 2'],
        precomputedQueryEmbedding: [0.1, 0.2],
    })

    beforeEach(() => {
        jest.clearAllMocks()
    })

    it('adds bounded decomposition metadata for eligible mixed queries', async () => {
        ;(QueryUnderstandingAgent.understandQuery as jest.Mock).mockResolvedValue({
            intent: 'comparison',
            entities: [],
            query_type: 'broad',
            jira_specific: false,
            suggested_filters: [],
        })
        ;(queryRewrite.rewrite as jest.Mock).mockResolvedValue('rewritten query')
        ;(queryRewrite.decomposeQuery as jest.Mock).mockResolvedValue(['원본 질문', '하위 질문 1', '하위 질문 2'])
        ;(EmbeddingService.generateEmbedding as jest.Mock).mockResolvedValue([0.1, 0.2])

        const result = await __testables__.analyzeAndRewriteNode(createAnalyzeState())

        expect(result.queryUnderstanding).toBeTruthy()
        expect(result.subQuestions).toEqual(['원본 질문', '하위 질문 1', '하위 질문 2'])
    })

    it('injects decomposition sub-questions into vector search queries', async () => {
        ;(HNSWOptimizationService.applyRuntimeSearchTuning as jest.Mock).mockResolvedValue(undefined)
        ;(queryRewrite.rewriteMultiQuery as jest.Mock).mockResolvedValue([])
        ;(queryRewrite.generateHyDE as jest.Mock).mockResolvedValue('')
        ;(queryRewrite.generateJiraHyDE as jest.Mock).mockResolvedValue('')
        ;(EmbeddingService.generateEmbeddingsBatch as jest.Mock).mockResolvedValue([
            [0.3, 0.4],
            [0.5, 0.6],
        ])
        ;(HybridSearchService.hybridSearch as jest.Mock).mockResolvedValue([])

        await __testables__.vectorSearchNode(createVectorSearchState())

        const usedQueries = (HybridSearchService.hybridSearch as jest.Mock).mock.calls.map((call) => call[2])
        expect(usedQueries).toEqual(expect.arrayContaining(['원본 질문', '하위 질문 1', '하위 질문 2']))
    })
})
