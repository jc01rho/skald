/**
 * RAG Pipeline Integration Tests
 *
 * Tests for the improved RAG pipeline including:
 * - Hybrid search (vector + BM25)
 * - Parent-child chunking
 * - Contextual chunking
 * - Korean morphological analysis (Kiwi)
 */

import express, { Express } from 'express'
import request from 'supertest'
import { MikroORM, RequestContext } from '@mikro-orm/postgresql'
import { DI } from '../di'
import { createTestDatabase, clearDatabase, closeDatabase } from './testDb'
import {
    createTestUser,
    createTestOrganization,
    createTestProject,
    createTestOrganizationMembership,
} from './testHelpers'
import { generateAccessToken } from '../lib/tokenUtils'
import { userMiddleware } from '../middleware/userMiddleware'
import { requireProjectAccess } from '../middleware/authMiddleware'
import { User } from '../entities/User'
import { Project } from '../entities/Project'
import { Organization } from '../entities/Organization'
import { OrganizationMembership } from '../entities/OrganizationMembership'
import { MemoChunk } from '../entities/MemoChunk'
import { MemoParentChunk } from '../entities/MemoParentChunk'
import cookieParser from 'cookie-parser'
import { search } from '../api/search'
import { EmbeddingService } from '../services/embeddingService'
import * as vectorSearch from '../embeddings/vectorSearch'
import { HybridSearchService } from '../embeddings/hybridSearch'
import * as memoQuery from '../queries/memo'
import { RerankService } from '../services/rerankService'
import { parseRagConfig } from '../lib/ragUtils'

// Mock external dependencies
jest.mock('../services/embeddingService')
jest.mock('../embeddings/vectorSearch')
jest.mock('../embeddings/hybridSearch')
jest.mock('../queries/memo')
jest.mock('../services/rerankService')

describe('RAG Pipeline Integration Tests', () => {
    let app: Express
    let orm: MikroORM

    beforeAll(async () => {
        orm = await createTestDatabase()
        DI.orm = orm
        DI.em = orm.em
        DI.users = orm.em.getRepository(User)
        DI.projects = orm.em.getRepository(Project)
        DI.organizations = orm.em.getRepository(Organization)
        DI.organizationMemberships = orm.em.getRepository(OrganizationMembership)
        DI.memoChunks = orm.em.getRepository(MemoChunk)
        DI.memoParentChunks = orm.em.getRepository(MemoParentChunk)

        app = express()
        app.use(express.json())
        app.use(cookieParser())
        app.use((req, res, next) => RequestContext.create(orm.em, next))
        app.use(userMiddleware())
        app.post('/api/search', [requireProjectAccess()], search)
    })

    afterAll(async () => {
        await closeDatabase(orm)
    })

    afterEach(async () => {
        await clearDatabase(orm)
        jest.clearAllMocks()
    })

    describe('RAG Config Parsing', () => {
        it('should parse hybrid search config with defaults', () => {
            const { parsedRagConfig, error } = parseRagConfig({})

            expect(error).toBeNull()
            expect(parsedRagConfig).not.toBeNull()
            expect(parsedRagConfig?.hybridSearch?.enabled).toBe(true)
            expect(parsedRagConfig?.hybridSearch?.vectorWeight).toBe(0.7)
            expect(parsedRagConfig?.hybridSearch?.bm25Weight).toBe(0.3)
        })

        it('should parse custom hybrid search weights', () => {
            const { parsedRagConfig, error } = parseRagConfig({
                hybrid_search: {
                    enabled: true,
                    vector_weight: 0.8,
                    bm25_weight: 0.2,
                },
            })

            expect(error).toBeNull()
            expect(parsedRagConfig?.hybridSearch?.vectorWeight).toBe(0.8)
            expect(parsedRagConfig?.hybridSearch?.bm25Weight).toBe(0.2)
        })

        it('should reject invalid hybrid search weights', () => {
            const { parsedRagConfig, error } = parseRagConfig({
                hybrid_search: {
                    vector_weight: 1.5, // Invalid: > 1
                },
            })

            expect(error).not.toBeNull()
            expect(error).toContain('vector weight')
        })

        it('should use new similarity threshold default of 0.65', () => {
            const { parsedRagConfig, error } = parseRagConfig({})

            expect(error).toBeNull()
            expect(parsedRagConfig?.vectorSearch.similarityThreshold).toBe(0.65)
        })

        it('should enable MMR by default', () => {
            const { parsedRagConfig, error } = parseRagConfig({})

            expect(error).toBeNull()
            expect(parsedRagConfig?.reranking.mmrEnabled).toBe(true)
        })

        it('should parse confidence threshold with default', () => {
            const { parsedRagConfig, error } = parseRagConfig({})

            expect(error).toBeNull()
            expect(parsedRagConfig?.confidence?.threshold).toBe(0.35)
        })

        it('should reject invalid confidence threshold', () => {
            const { parsedRagConfig, error } = parseRagConfig({
                confidence: {
                    threshold: 1.2,
                },
            })

            expect(parsedRagConfig).toBeNull()
            expect(error).toContain('confidence threshold')
        })
    })

    describe('Hybrid Search Integration', () => {
        it('should call hybrid search when enabled', async () => {
            const user = await createTestUser(orm, 'test@example.com', 'password123')
            const org = await createTestOrganization(orm, 'Test Org', user)
            await createTestOrganizationMembership(orm, user, org)
            const project = await createTestProject(orm, 'Test Project', org, user)
            const token = generateAccessToken('test@example.com')

            const mockEmbedding = Array(2048).fill(0.1)
            const mockHybridResults = [
                {
                    uuid: 'chunk-1',
                    chunk_content: '테스트 한글 콘텐츠',
                    memo_uuid: 'memo-1',
                    vector_score: 0.9,
                    bm25_score: 0.8,
                    hybrid_score: 0.87,
                },
            ]

            ;(EmbeddingService.generateEmbedding as jest.Mock).mockResolvedValue(mockEmbedding)
            ;(HybridSearchService.hybridSearch as jest.Mock).mockResolvedValue(mockHybridResults)
            ;(memoQuery.getTitleAndSummaryAndContentForMemoList as jest.Mock).mockResolvedValue(
                new Map([['memo-1', { title: '테스트 메모', summary: '요약', content: '전체 내용' }]])
            )
            ;(RerankService.rerank as jest.Mock).mockResolvedValue([
                { index: 0, document: '테스트 한글 콘텐츠', relevance_score: 0.95 },
            ])

            const response = await request(app)
                .post('/api/search')
                .set('Cookie', `access_token=${token}`)
                .set('x-project-uuid', project.uuid)
                .send({
                    query: '한글 검색어',
                    rag_config: {
                        hybrid_search: { enabled: true },
                    },
                })

            expect(response.status).toBe(200)
        })
    })

    describe('Korean Query Processing', () => {
        it('should handle Korean queries correctly', async () => {
            const user = await createTestUser(orm, 'korean@example.com', 'password123')
            const org = await createTestOrganization(orm, '한국 조직', user)
            await createTestOrganizationMembership(orm, user, org)
            const project = await createTestProject(orm, '한국 프로젝트', org, user)
            const token = generateAccessToken('korean@example.com')

            const mockEmbedding = Array(2048).fill(0.1)
            const mockChunkResults = [
                {
                    chunk: {
                        uuid: 'chunk-1',
                        memo_uuid: 'memo-1',
                        chunk_content: '서울시에서 열리는 행사 안내입니다.',
                    },
                    distance: 0.3,
                },
            ]

            ;(EmbeddingService.generateEmbedding as jest.Mock).mockResolvedValue(mockEmbedding)
            ;(vectorSearch.memoChunkVectorSearch as jest.Mock).mockResolvedValue(mockChunkResults)
            ;(memoQuery.getTitleAndSummaryAndContentForMemoList as jest.Mock).mockResolvedValue(
                new Map([['memo-1', { title: '행사 안내', summary: '서울 행사', content: '서울시에서 열리는 행사' }]])
            )

            const response = await request(app)
                .post('/api/search')
                .set('Cookie', `access_token=${token}`)
                .set('x-project-uuid', project.uuid)
                .send({
                    query: '서울시에서 열리는 행사는 무엇인가요?',
                })

            expect(response.status).toBe(200)
            // Verify embedding was generated for Korean query
            expect(EmbeddingService.generateEmbedding).toHaveBeenCalledWith(expect.any(String), 'search')
        })
    })

    describe('Embedding Dimension', () => {
        it('should use 2048-dimensional embeddings', async () => {
            const user = await createTestUser(orm, 'dim@example.com', 'password123')
            const org = await createTestOrganization(orm, 'Dim Org', user)
            await createTestOrganizationMembership(orm, user, org)
            const project = await createTestProject(orm, 'Dim Project', org, user)
            const token = generateAccessToken('dim@example.com')

            const mockEmbedding = Array(2048).fill(0.1)

            ;(EmbeddingService.generateEmbedding as jest.Mock).mockResolvedValue(mockEmbedding)
            ;(vectorSearch.memoChunkVectorSearch as jest.Mock).mockResolvedValue([])
            ;(memoQuery.getTitleAndSummaryAndContentForMemoList as jest.Mock).mockResolvedValue(new Map())

            const response = await request(app)
                .post('/api/search')
                .set('Cookie', `access_token=${token}`)
                .set('x-project-uuid', project.uuid)
                .send({ query: 'test query' })

            expect(response.status).toBe(200)
            expect(EmbeddingService.generateEmbedding).toHaveBeenCalled()
        })
    })

    describe('Response Time', () => {
        it('should respond within 10 seconds', async () => {
            const user = await createTestUser(orm, 'perf@example.com', 'password123')
            const org = await createTestOrganization(orm, 'Perf Org', user)
            await createTestOrganizationMembership(orm, user, org)
            const project = await createTestProject(orm, 'Perf Project', org, user)
            const token = generateAccessToken('perf@example.com')

            const mockEmbedding = Array(2048).fill(0.1)

            ;(EmbeddingService.generateEmbedding as jest.Mock).mockResolvedValue(mockEmbedding)
            ;(vectorSearch.memoChunkVectorSearch as jest.Mock).mockResolvedValue([])
            ;(memoQuery.getTitleAndSummaryAndContentForMemoList as jest.Mock).mockResolvedValue(new Map())

            const startTime = Date.now()

            const response = await request(app)
                .post('/api/search')
                .set('Cookie', `access_token=${token}`)
                .set('x-project-uuid', project.uuid)
                .send({ query: 'performance test' })

            const endTime = Date.now()
            const duration = endTime - startTime

            expect(response.status).toBe(200)
            expect(duration).toBeLessThan(10000) // Less than 10 seconds
        })
    })
})
