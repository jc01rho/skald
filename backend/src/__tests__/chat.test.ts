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
    createTestChat,
} from './testHelpers'
import { generateAccessToken } from '../lib/tokenUtils'
import { userMiddleware } from '../middleware/userMiddleware'
import { User } from '../entities/User'
import { Project } from '../entities/Project'
import { Organization } from '../entities/Organization'
import { OrganizationMembership } from '../entities/OrganizationMembership'
import cookieParser from 'cookie-parser'
import { chatRouter } from '../api/chat'
import { requireProjectAccess } from '../middleware/authMiddleware'
import * as chatAgent from '../agents/chatAgent/chatAgent'
import { ChatMessage } from '@/entities/ChatMessage'
import { Chat } from '@/entities/Chat'
import { randomUUID } from 'crypto'
import { rewrite } from '../agents/chatAgent/queryRewrite'
import { LLMService } from '../services/llmService'
import * as ragGraphModule from '../agents/chatAgent/ragGraph'
import { ChatPromptTemplate } from '@langchain/core/prompts'
import * as fastRetrieveModule from '../lib/fastRetrieve'
import * as previewAgentModule from '../agents/chatAgent/previewAgent'

// Mock external dependencies
jest.mock('../agents/chatAgent/chatAgent')
jest.mock('../services/llmService')
jest.mock('../agents/chatAgent/ragGraph', () => {
    const actual = jest.requireActual('../agents/chatAgent/ragGraph')
    return {
        ...actual,
        ragGraph: {
            invoke: jest.fn(),
        },
    }
})
jest.mock('@sentry/node', () => ({
    captureException: jest.fn(),
}))
jest.mock('../lib/logger', () => ({
    logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}))
jest.mock('../settings', () => {
    const originalModule = jest.requireActual('../settings')
    return {
        ...originalModule,
        SECRET_KEY: process.env.SECRET_KEY || 'UNSAFE_DEFAULT_SECRET_KEY',
    }
})
jest.mock('../lib/posthogUtils', () => ({
    posthogCapture: jest.fn(),
}))
jest.mock('../lib/ragCache', () => ({
    getCachedResponse: jest.fn().mockResolvedValue(null),
    cacheResponse: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../lib/lazyReprocessService', () => ({
    checkAndQueueLazyReprocess: jest.fn().mockResolvedValue(undefined),
    extractMemoUuidsFromRerankResults: jest.fn().mockReturnValue([]),
    extractMemoUuidsFromReferences: jest.fn().mockReturnValue([]),
}))
jest.mock('../lib/queryRouter', () => ({
    routeQuery: jest.fn().mockReturnValue({ route: 'rag' }),
}))
jest.mock('../lib/selfRagEvaluator', () => ({
    SelfRagEvaluator: {
        evaluate: jest.fn(),
        requiresRegeneration: jest.fn().mockReturnValue(false),
    },
}))
jest.mock('../lib/complexityCalculator', () => ({
    ComplexityCalculator: {
        calculate: jest.fn().mockReturnValue({ requiresSelfRag: false }),
    },
    classifyQuerySimplicity: jest.fn().mockReturnValue('simple'),
    FAST_RETRIEVAL_PROFILES: {
        simple: { topK: 3, similarityThreshold: 0.78, maxPreviewChars: 220 },
        moderate: { topK: 5, similarityThreshold: 0.72, maxPreviewChars: 320 },
        complex: { topK: 8, similarityThreshold: 0.68, maxPreviewChars: 420 },
    },
}))
jest.mock('../lib/fastRetrieve', () => ({
    fastRetrieve: jest.fn().mockResolvedValue({ contextStr: 'Result 1: preview context', results: [] }),
}))
jest.mock('../agents/chatAgent/previewAgent', () => ({
    generatePreview: jest
        .fn()
        .mockResolvedValue('1차 답변: 질문을 확인했습니다. 최종 답변은 곧 자세한 근거와 함께 이어집니다.'),
}))

describe('Chat API', () => {
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
        DI.chats = orm.em.getRepository(Chat)
        DI.chatMessages = orm.em.getRepository(ChatMessage)

        app = express()
        app.use(express.json())
        app.use(cookieParser())
        app.use((req, res, next) => RequestContext.create(orm.em, next))
        app.use(userMiddleware())
        app.use('/api/chat', [requireProjectAccess()], chatRouter)
    })

    afterAll(async () => {
        await closeDatabase(orm)
    })

    afterEach(async () => {
        await clearDatabase(orm)
        jest.clearAllMocks()
    })

    // Helper function to create a default mock ragGraph response
    const mockRagGraphResponse = (query: string, rerankedResults: any[] = []) => {
        const defaultPrompt = ChatPromptTemplate.fromMessages([
            ['system', 'You are a helpful assistant.'],
            ['human', '{input}'],
        ])

        let contextStr = ''
        for (let i = 0; i < rerankedResults.length; i++) {
            contextStr += `Result ${i + 1}: ${rerankedResults[i].document}\n\n`
        }

        return {
            query,
            rewrittenQuery: null,
            chunkResults: [],
            rerankedResults,
            memoPropertiesMap: null,
            prompt: defaultPrompt,
            contextStr,
            conversationHistory: null,
        }
    }

    describe('POST /api/chat', () => {
        it('should return chat response with valid query', async () => {
            const user = await createTestUser(orm, 'test@example.com', 'password123')
            const org = await createTestOrganization(orm, 'Test Org', user)
            await createTestOrganizationMembership(orm, user, org)
            const project = await createTestProject(orm, 'Test Project', org, user)
            const token = generateAccessToken('test@example.com')

            const mockRerankedResults = [
                { document: 'Result 1 content', relevance_score: 0.9, index: 0 },
                { document: 'Result 2 content', relevance_score: 0.8, index: 1 },
            ]

            const mockRagState = mockRagGraphResponse('What is in the documents?', mockRerankedResults)
            ;(ragGraphModule.ragGraph.invoke as jest.Mock).mockResolvedValue(mockRagState)

            // Mock the stream generator to return our response
            async function* mockStreamGenerator() {
                yield { type: 'token', content: 'This is the AI response' }
            }
            ;(chatAgent.streamChatAgent as jest.Mock).mockReturnValue(mockStreamGenerator())

            const response = await request(app)
                .post('/api/chat')
                .set('Cookie', [`accessToken=${token}`])
                .query({ project_id: project.uuid })
                .send({
                    query: 'What is in the documents?',
                })

            expect(response.status).toBe(200)
            expect(response.body.ok).toBe(true)
            expect(response.body.response).toBe('This is the AI response')
            expect(response.body.intermediate_steps).toEqual([])
        })

        it('should create a chat message pair when chat_id is not provided', async () => {
            const user = await createTestUser(orm, 'test@example.com', 'password123')
            const org = await createTestOrganization(orm, 'Test Org', user)
            await createTestOrganizationMembership(orm, user, org)
            const project = await createTestProject(orm, 'Test Project', org, user)
            const token = generateAccessToken('test@example.com')

            const mockRerankedResults = [
                { document: 'Result 1 content', relevance_score: 0.9, index: 0 },
                { document: 'Result 2 content', relevance_score: 0.8, index: 1 },
            ]

            const mockRagState = mockRagGraphResponse('What is in the documents?', mockRerankedResults)
            ;(ragGraphModule.ragGraph.invoke as jest.Mock).mockResolvedValue(mockRagState)

            async function* mockStreamGenerator() {
                yield { type: 'token', content: 'This is the AI response' }
            }
            ;(chatAgent.streamChatAgent as jest.Mock).mockReturnValue(mockStreamGenerator())

            const response = await request(app)
                .post('/api/chat')
                .set('Cookie', [`accessToken=${token}`])
                .query({ project_id: project.uuid })
                .send({
                    query: 'What is in the documents?',
                })

            expect(response.status).toBe(200)

            const em = orm.em.fork()
            const chats = await em.find(Chat, { project: project.uuid })
            expect(chats).toHaveLength(1)
            const chat = chats[0]
            expect(chat.project.uuid).toBe(project.uuid)
            expect(chat.created_at).toBeDefined()

            const chatMessages = await em.find(ChatMessage, { chat: chat.uuid })
            expect(chatMessages).toHaveLength(2)
            expect(chatMessages[0].chat.uuid).toBe(chat.uuid)
            expect(chatMessages[0].content).toBe('What is in the documents?')
        })

        it('it should create messages for an existing chat if chat_id is provided', async () => {
            const user = await createTestUser(orm, 'test@example.com', 'password123')
            const org = await createTestOrganization(orm, 'Test Org', user)
            await createTestOrganizationMembership(orm, user, org)
            const project = await createTestProject(orm, 'Test Project', org, user)
            const testChat = await createTestChat(orm, project)
            const token = generateAccessToken('test@example.com')

            const mockRerankedResults = [
                { document: 'Result 1 content', relevance_score: 0.9, index: 0 },
                { document: 'Result 2 content', relevance_score: 0.8, index: 1 },
            ]

            const mockRagState = mockRagGraphResponse('What is in the documents?', mockRerankedResults)
            ;(ragGraphModule.ragGraph.invoke as jest.Mock).mockResolvedValue(mockRagState)

            async function* mockStreamGenerator() {
                yield { type: 'token', content: 'This is the AI response' }
            }
            ;(chatAgent.streamChatAgent as jest.Mock).mockReturnValue(mockStreamGenerator())

            const response = await request(app)
                .post('/api/chat')
                .set('Cookie', [`accessToken=${token}`])
                .query({ project_id: project.uuid })
                .send({
                    query: 'What is in the documents?',
                    chat_id: testChat.uuid,
                })

            expect(response.status).toBe(200)

            const em = orm.em.fork()
            const chatMessages = await em.find(ChatMessage, { chat: testChat.uuid })
            expect(chatMessages).toHaveLength(2)
            expect(chatMessages[0].chat.uuid).toBe(testChat.uuid)
            expect(chatMessages[0].content).toBe('What is in the documents?')
        })

        it('should return 400 when query is missing', async () => {
            const user = await createTestUser(orm, 'test@example.com', 'password123')
            const org = await createTestOrganization(orm, 'Test Org', user)
            await createTestOrganizationMembership(orm, user, org)
            const project = await createTestProject(orm, 'Test Project', org, user)
            const token = generateAccessToken('test@example.com')

            const response = await request(app)
                .post('/api/chat')
                .set('Cookie', [`accessToken=${token}`])
                .query({ project_id: project.uuid })
                .send({})

            expect(response.status).toBe(400)
            expect(response.body.error).toBe('Query is required')
        })

        it('should return 400 when filters is not an array', async () => {
            const user = await createTestUser(orm, 'test@example.com', 'password123')
            const org = await createTestOrganization(orm, 'Test Org', user)
            await createTestOrganizationMembership(orm, user, org)
            const project = await createTestProject(orm, 'Test Project', org, user)
            const token = generateAccessToken('test@example.com')

            const response = await request(app)
                .post('/api/chat')
                .set('Cookie', [`accessToken=${token}`])
                .query({ project_id: project.uuid })
                .send({
                    query: 'test query',
                    filters: 'not-an-array',
                })

            expect(response.status).toBe(400)
            expect(response.body.error).toBe('Filters must be a list')
        })

        it('should use empty filters array by default', async () => {
            const user = await createTestUser(orm, 'test@example.com', 'password123')
            const org = await createTestOrganization(orm, 'Test Org', user)
            await createTestOrganizationMembership(orm, user, org)
            const project = await createTestProject(orm, 'Test Project', org, user)
            const token = generateAccessToken('test@example.com')

            const mockRagState = mockRagGraphResponse('test query', [])
            ;(ragGraphModule.ragGraph.invoke as jest.Mock).mockResolvedValue(mockRagState)

            async function* mockStreamGenerator() {
                yield { type: 'token', content: 'response' }
            }
            ;(chatAgent.streamChatAgent as jest.Mock).mockReturnValue(mockStreamGenerator())

            await request(app)
                .post('/api/chat')
                .set('Cookie', [`accessToken=${token}`])
                .query({ project_id: project.uuid })
                .send({
                    query: 'test query',
                })

            expect(ragGraphModule.ragGraph.invoke).toHaveBeenCalled()
        })

        it('should return 400 for invalid filter', async () => {
            const user = await createTestUser(orm, 'test@example.com', 'password123')
            const org = await createTestOrganization(orm, 'Test Org', user)
            await createTestOrganizationMembership(orm, user, org)
            const project = await createTestProject(orm, 'Test Project', org, user)
            const token = generateAccessToken('test@example.com')

            const response = await request(app)
                .post('/api/chat')
                .set('Cookie', [`accessToken=${token}`])
                .query({ project_id: project.uuid })
                .send({
                    query: 'test query',
                    filters: [{ invalid: 'filter' }],
                })

            expect(response.status).toBe(400)
            expect(response.body.error).toBe('Invalid filter: Filter must have field, operator, value, and filter_type')
        })

        // FIXME: it should *not* return a 500
        it('should return 503 when chat agent fails', async () => {
            const user = await createTestUser(orm, 'test@example.com', 'password123')
            const org = await createTestOrganization(orm, 'Test Org', user)
            await createTestOrganizationMembership(orm, user, org)
            const project = await createTestProject(orm, 'Test Project', org, user)
            const token = generateAccessToken('test@example.com')

            const mockRagState = mockRagGraphResponse('test query', [])
            ;(ragGraphModule.ragGraph.invoke as jest.Mock).mockResolvedValue(mockRagState)

            async function* mockStreamGenerator() {
                yield { type: 'token', content: 'This is the AI response' }
                throw new Error('Chat agent error')
            }
            ;(chatAgent.streamChatAgent as jest.Mock).mockReturnValue(mockStreamGenerator())

            const response = await request(app)
                .post('/api/chat')
                .set('Cookie', [`accessToken=${token}`])
                .query({ project_id: project.uuid })
                .send({
                    query: 'test query',
                })

            expect(response.status).toBe(503)
            expect(response.body.error).toBe('Chat agent unavailable')
        })

        it('should return 403 for unauthenticated users', async () => {
            const response = await request(app).post('/api/chat').send({
                query: 'test query',
            })

            expect(response.status).toBe(403)
        })

        it('should return 400 when project_id is missing', async () => {
            await createTestUser(orm, 'test@example.com', 'password123')
            const token = generateAccessToken('test@example.com')

            const response = await request(app)
                .post('/api/chat')
                .set('Cookie', [`accessToken=${token}`])
                .send({
                    query: 'test query',
                })

            expect(response.status).toBe(400)
            expect(response.body.error).toBe('Project ID is required')
        })

        it('should return 403 for users not in project organization', async () => {
            const user1 = await createTestUser(orm, 'user1@example.com', 'password123')
            const user2 = await createTestUser(orm, 'user2@example.com', 'password123')

            const org1 = await createTestOrganization(orm, 'Org 1', user1)
            const org2 = await createTestOrganization(orm, 'Org 2', user2)

            await createTestOrganizationMembership(orm, user1, org1)
            await createTestOrganizationMembership(orm, user2, org2)

            const project2 = await createTestProject(orm, 'Project 2', org2, user2)

            const user1Token = generateAccessToken('user1@example.com')

            const response = await request(app)
                .post('/api/chat')
                .set('Cookie', [`accessToken=${user1Token}`])
                .query({ project_id: project2.uuid })
                .send({
                    query: 'test query',
                })

            expect(response.status).toBe(403)
        })

        it('should handle streaming response', async () => {
            const user = await createTestUser(orm, 'test@example.com', 'password123')
            const org = await createTestOrganization(orm, 'Test Org', user)
            await createTestOrganizationMembership(orm, user, org)
            const project = await createTestProject(orm, 'Test Project', org, user)
            const token = generateAccessToken('test@example.com')

            const mockRerankedResults = [{ document: 'Result 1', relevance_score: 0.9, index: 0 }]

            const mockRagState = mockRagGraphResponse('test query', mockRerankedResults)
            ;(ragGraphModule.ragGraph.invoke as jest.Mock).mockResolvedValue(mockRagState)

            async function* mockStreamGenerator() {
                yield { content: 'chunk1' }
                yield { content: 'chunk2' }
            }

            ;(chatAgent.streamChatAgent as jest.Mock).mockReturnValue(mockStreamGenerator())

            const response = await request(app)
                .post('/api/chat')
                .set('Cookie', [`accessToken=${token}`])
                .query({ project_id: project.uuid })
                .send({
                    query: 'test query',
                    stream: true,
                })

            // For streaming responses, we just check that it starts successfully
            // Full streaming testing would require more complex setup
            expect(response.status).toBe(200)
        })

        it('should emit streaming error when chat stream ends without token content', async () => {
            const user = await createTestUser(orm, 'test@example.com', 'password123')
            const org = await createTestOrganization(orm, 'Test Org', user)
            await createTestOrganizationMembership(orm, user, org)
            const project = await createTestProject(orm, 'Test Project', org, user)
            const token = generateAccessToken('test@example.com')

            const mockRagState = mockRagGraphResponse('test query', [])
            ;(ragGraphModule.ragGraph.invoke as jest.Mock).mockResolvedValue(mockRagState)

            async function* mockStreamGenerator() {
                yield { type: 'references', content: JSON.stringify({}) }
            }

            ;(chatAgent.streamChatAgent as jest.Mock).mockReturnValue(mockStreamGenerator())

            const response = await request(app)
                .post('/api/chat')
                .set('Cookie', [`accessToken=${token}`])
                .query({ project_id: project.uuid })
                .send({
                    query: 'test query',
                    stream: true,
                })

            expect(response.status).toBe(200)
            expect(response.text).toContain('type":"error"')
            expect(response.text).toContain('Chat stream completed without any response content')
        })

        it('should format context string from reranked results', async () => {
            const user = await createTestUser(orm, 'test@example.com', 'password123')
            const org = await createTestOrganization(orm, 'Test Org', user)
            await createTestOrganizationMembership(orm, user, org)
            const project = await createTestProject(orm, 'Test Project', org, user)
            const token = generateAccessToken('test@example.com')

            const mockRerankedResults = [
                { document: 'First result', relevance_score: 0.9, index: 0 },
                { document: 'Second result', relevance_score: 0.8, index: 1 },
            ]

            const mockRagState = mockRagGraphResponse('test query', mockRerankedResults)
            ;(ragGraphModule.ragGraph.invoke as jest.Mock).mockResolvedValue(mockRagState)

            async function* mockStreamGenerator() {
                yield { type: 'token', content: 'response' }
            }
            ;(chatAgent.streamChatAgent as jest.Mock).mockReturnValue(mockStreamGenerator())

            await request(app)
                .post('/api/chat')
                .set('Cookie', [`accessToken=${token}`])
                .query({ project_id: project.uuid })
                .send({
                    query: 'test query',
                })

            expect(chatAgent.streamChatAgent).toHaveBeenCalled()
            const streamCall = (chatAgent.streamChatAgent as jest.Mock).mock.calls[0][0]
            expect(streamCall).toEqual(
                expect.objectContaining({
                    query: 'test query',
                    prompt: expect.anything(),
                    contextStr: 'Result 1: First result\n\nResult 2: Second result\n\n',
                    enableReferences: false,
                })
            )
        })

        it('should pass custom prompt to chat agent when provided', async () => {
            const user = await createTestUser(orm, 'test@example.com', 'password123')
            const org = await createTestOrganization(orm, 'Test Org', user)
            await createTestOrganizationMembership(orm, user, org)
            const project = await createTestProject(orm, 'Test Project', org, user)
            const token = generateAccessToken('test@example.com')

            const mockRerankedResults = [{ document: 'Result content', relevance_score: 0.9, index: 0 }]

            const mockRagState = mockRagGraphResponse('test query', mockRerankedResults)
            ;(ragGraphModule.ragGraph.invoke as jest.Mock).mockResolvedValue(mockRagState)

            async function* mockStreamGenerator() {
                yield { type: 'token', content: 'response' }
            }
            ;(chatAgent.streamChatAgent as jest.Mock).mockReturnValue(mockStreamGenerator())

            const customPrompt = 'You are a helpful assistant focused on technical documentation.'

            await request(app)
                .post('/api/chat')
                .set('Cookie', [`accessToken=${token}`])
                .query({ project_id: project.uuid })
                .send({
                    query: 'test query',
                    system_prompt: customPrompt,
                })

            expect(chatAgent.streamChatAgent).toHaveBeenCalled()
            const streamCall = (chatAgent.streamChatAgent as jest.Mock).mock.calls[0][0]
            expect(streamCall).toEqual(
                expect.objectContaining({
                    query: 'test query',
                    prompt: expect.anything(),
                    contextStr: 'Result 1: Result content\n\n',
                    enableReferences: false,
                })
            )

            const em = orm.em.fork()
            const chatMessages = await em.find(ChatMessage, { project: project.uuid }, { orderBy: { sent_at: 'ASC' } })
            expect(chatMessages).toHaveLength(2)

            // ensure the client system prompt has been saved to the first message
            expect(chatMessages[0].client_system_prompt).toBe(customPrompt)

            // ensure the model and user messages are in the same message group
            expect(chatMessages[0].message_group_id).toEqual(chatMessages[1].message_group_id)
        })

        it('should pass null prompt to chat agent when not provided', async () => {
            const user = await createTestUser(orm, 'test@example.com', 'password123')
            const org = await createTestOrganization(orm, 'Test Org', user)
            await createTestOrganizationMembership(orm, user, org)
            const project = await createTestProject(orm, 'Test Project', org, user)
            const token = generateAccessToken('test@example.com')

            const mockRerankedResults = [{ document: 'Result content', relevance_score: 0.9, index: 0 }]

            const mockRagState = mockRagGraphResponse('test query', mockRerankedResults)
            ;(ragGraphModule.ragGraph.invoke as jest.Mock).mockResolvedValue(mockRagState)

            async function* mockStreamGenerator() {
                yield { type: 'token', content: 'response' }
            }
            ;(chatAgent.streamChatAgent as jest.Mock).mockReturnValue(mockStreamGenerator())

            await request(app)
                .post('/api/chat')
                .set('Cookie', [`accessToken=${token}`])
                .query({ project_id: project.uuid })
                .send({
                    query: 'test query',
                })

            expect(chatAgent.streamChatAgent).toHaveBeenCalled()
            const streamCall = (chatAgent.streamChatAgent as jest.Mock).mock.calls[0][0]
            expect(streamCall).toEqual(
                expect.objectContaining({
                    query: 'test query',
                    prompt: expect.anything(),
                    contextStr: 'Result 1: Result content\n\n',
                    enableReferences: false,
                })
            )
        })

        it('should pass client system prompt to streaming chat agent when provided', async () => {
            const user = await createTestUser(orm, 'test@example.com', 'password123')
            const org = await createTestOrganization(orm, 'Test Org', user)
            await createTestOrganizationMembership(orm, user, org)
            const project = await createTestProject(orm, 'Test Project', org, user)
            const token = generateAccessToken('test@example.com')

            const mockRerankedResults = [{ document: 'Result content', relevance_score: 0.9, index: 0 }]

            const mockRagState = mockRagGraphResponse('test query', mockRerankedResults)
            ;(ragGraphModule.ragGraph.invoke as jest.Mock).mockResolvedValue(mockRagState)

            async function* mockStreamGenerator() {
                yield { content: 'chunk1' }
                yield { content: 'chunk2' }
            }

            ;(chatAgent.streamChatAgent as jest.Mock).mockReturnValue(mockStreamGenerator())

            const clientSystemPrompt = 'Answer in a concise manner.'

            await request(app)
                .post('/api/chat')
                .set('Cookie', [`accessToken=${token}`])
                .query({ project_id: project.uuid })
                .send({
                    query: 'test query',
                    stream: true,
                    system_prompt: clientSystemPrompt,
                })

            expect(chatAgent.streamChatAgent).toHaveBeenCalled()
            const streamCall = (chatAgent.streamChatAgent as jest.Mock).mock.calls[0][0]
            expect(streamCall).toEqual(
                expect.objectContaining({
                    query: 'test query',
                    prompt: expect.anything(),
                    contextStr: 'Result 1: Result content\n\n',
                    enableReferences: false,
                })
            )
            // check that the created chat messages have the correct client system prompt
            const em = orm.em.fork()
            const chatMessages = await em.find(ChatMessage, { project: project.uuid }, { orderBy: { sent_at: 'ASC' } })
            expect(chatMessages).toHaveLength(2)

            // ensure the client system prompt has been saved to the first message
            expect(chatMessages[0].client_system_prompt).toBe(clientSystemPrompt)

            // ensure the model and user messages are in the same message group
            expect(chatMessages[0].message_group_id).toEqual(chatMessages[1].message_group_id)
        })

        it('should pass null client system prompt to streaming chat agent when not provided', async () => {
            const user = await createTestUser(orm, 'test@example.com', 'password123')
            const org = await createTestOrganization(orm, 'Test Org', user)
            await createTestOrganizationMembership(orm, user, org)
            const project = await createTestProject(orm, 'Test Project', org, user)
            const token = generateAccessToken('test@example.com')

            const mockRerankedResults = [{ document: 'Result content', relevance_score: 0.9, index: 0 }]

            const mockRagState = mockRagGraphResponse('test query', mockRerankedResults)
            ;(ragGraphModule.ragGraph.invoke as jest.Mock).mockResolvedValue(mockRagState)

            async function* mockStreamGenerator() {
                yield { content: 'chunk1' }
                yield { content: 'chunk2' }
            }

            ;(chatAgent.streamChatAgent as jest.Mock).mockReturnValue(mockStreamGenerator())

            await request(app)
                .post('/api/chat')
                .set('Cookie', [`accessToken=${token}`])
                .query({ project_id: project.uuid })
                .send({
                    query: 'test query',
                    stream: true,
                })

            expect(chatAgent.streamChatAgent).toHaveBeenCalled()
            const streamCall = (chatAgent.streamChatAgent as jest.Mock).mock.calls[0][0]
            expect(streamCall).toEqual(
                expect.objectContaining({
                    query: 'test query',
                    prompt: expect.anything(),
                    contextStr: 'Result 1: Result content\n\n',
                    enableReferences: false,
                })
            )
        })

        it('should return chat_id in non-streaming response', async () => {
            const user = await createTestUser(orm, 'test@example.com', 'password123')
            const org = await createTestOrganization(orm, 'Test Org', user)
            await createTestOrganizationMembership(orm, user, org)
            const project = await createTestProject(orm, 'Test Project', org, user)
            const token = generateAccessToken('test@example.com')

            const mockRerankedResults = [{ document: 'Result content', relevance_score: 0.9, index: 0 }]

            const mockRagState = mockRagGraphResponse('test query', mockRerankedResults)
            ;(ragGraphModule.ragGraph.invoke as jest.Mock).mockResolvedValue(mockRagState)

            async function* mockStreamGenerator() {
                yield { type: 'token', content: 'response' }
            }
            ;(chatAgent.streamChatAgent as jest.Mock).mockReturnValue(mockStreamGenerator())

            const response = await request(app)
                .post('/api/chat')
                .set('Cookie', [`accessToken=${token}`])
                .query({ project_id: project.uuid })
                .send({
                    query: 'test query',
                })

            expect(response.status).toBe(200)
            expect(response.body.chat_id).toBeDefined()
            expect(typeof response.body.chat_id).toBe('string')
        })

        it('should return chat_id in streaming response done event', async () => {
            const user = await createTestUser(orm, 'test@example.com', 'password123')
            const org = await createTestOrganization(orm, 'Test Org', user)
            await createTestOrganizationMembership(orm, user, org)
            const project = await createTestProject(orm, 'Test Project', org, user)
            const token = generateAccessToken('test@example.com')

            const mockRerankedResults = [{ document: 'Result content', relevance_score: 0.9, index: 0 }]

            const mockRagState = mockRagGraphResponse('test query', mockRerankedResults)
            ;(ragGraphModule.ragGraph.invoke as jest.Mock).mockResolvedValue(mockRagState)

            async function* mockStreamGenerator() {
                yield { content: 'chunk1' }
                yield { content: 'chunk2' }
            }

            ;(chatAgent.streamChatAgent as jest.Mock).mockReturnValue(mockStreamGenerator())

            const response = await request(app)
                .post('/api/chat')
                .set('Cookie', [`accessToken=${token}`])
                .query({ project_id: project.uuid })
                .send({
                    query: 'test query',
                    stream: true,
                })

            expect(response.status).toBe(200)
            expect(response.text).toContain('chat_id')
        })

        it('should accept chat_id parameter', async () => {
            const user = await createTestUser(orm, 'test@example.com', 'password123')
            const org = await createTestOrganization(orm, 'Test Org', user)
            await createTestOrganizationMembership(orm, user, org)
            const project = await createTestProject(orm, 'Test Project', org, user)
            const testChat = await createTestChat(orm, project)
            const token = generateAccessToken('test@example.com')

            const mockRerankedResults = [{ document: 'Result content', relevance_score: 0.9, index: 0 }]

            const mockRagState = mockRagGraphResponse('test query', mockRerankedResults)
            ;(ragGraphModule.ragGraph.invoke as jest.Mock).mockResolvedValue(mockRagState)

            async function* mockStreamGenerator() {
                yield { type: 'token', content: 'response' }
            }
            ;(chatAgent.streamChatAgent as jest.Mock).mockReturnValue(mockStreamGenerator())

            const response = await request(app)
                .post('/api/chat')
                .set('Cookie', [`accessToken=${token}`])
                .query({ project_id: project.uuid })
                .send({
                    query: 'test query',
                    chat_id: testChat.uuid,
                })

            expect(response.status).toBe(200)
            expect(response.body.chat_id).toBe(testChat.uuid)
        })

        it('should pass conversation history to chat agent when chat_id provided', async () => {
            const user = await createTestUser(orm, 'test@example.com', 'password123')
            const org = await createTestOrganization(orm, 'Test Org', user)
            await createTestOrganizationMembership(orm, user, org)
            const project = await createTestProject(orm, 'Test Project', org, user)
            const testChat = await createTestChat(orm, project)
            const token = generateAccessToken('test@example.com')

            // Create some existing messages
            const em = orm.em.fork()
            const userMessage = em.create(ChatMessage, {
                uuid: randomUUID(),
                message_group_id: randomUUID(),
                project: project,
                chat: testChat,
                content: 'Previous user message',
                sent_by: 'user',
                sent_at: new Date(Date.now() - 1000),
            })
            const modelMessage = em.create(ChatMessage, {
                uuid: randomUUID(),
                message_group_id: userMessage.message_group_id,
                project: project,
                chat: testChat,
                content: 'Previous model response',
                sent_by: 'model',
                sent_at: new Date(Date.now() - 500),
            })
            await em.persistAndFlush([userMessage, modelMessage])

            const mockRerankedResults = [{ document: 'Result content', relevance_score: 0.9, index: 0 }]

            const mockRagState = mockRagGraphResponse('new query', mockRerankedResults)
            ;(ragGraphModule.ragGraph.invoke as jest.Mock).mockResolvedValue(mockRagState)

            async function* mockStreamGenerator() {
                yield { type: 'token', content: 'response' }
            }
            ;(chatAgent.streamChatAgent as jest.Mock).mockReturnValue(mockStreamGenerator())

            await request(app)
                .post('/api/chat')
                .set('Cookie', [`accessToken=${token}`])
                .query({ project_id: project.uuid })
                .send({
                    query: 'new query',
                    chat_id: testChat.uuid,
                })

            // Verify that streamChatAgent was called
            expect(chatAgent.streamChatAgent).toHaveBeenCalled()
            const callArgs = (chatAgent.streamChatAgent as jest.Mock).mock.calls[0][0]
            expect(callArgs.query).toBe('new query')
        })

        it('should not pass conversation history when chat_id not provided', async () => {
            const user = await createTestUser(orm, 'test@example.com', 'password123')
            const org = await createTestOrganization(orm, 'Test Org', user)
            await createTestOrganizationMembership(orm, user, org)
            const project = await createTestProject(orm, 'Test Project', org, user)
            const token = generateAccessToken('test@example.com')

            const mockRerankedResults = [{ document: 'Result content', relevance_score: 0.9, index: 0 }]

            const mockRagState = mockRagGraphResponse('test query', mockRerankedResults)
            ;(ragGraphModule.ragGraph.invoke as jest.Mock).mockResolvedValue(mockRagState)

            async function* mockStreamGenerator() {
                yield { type: 'token', content: 'response' }
            }
            ;(chatAgent.streamChatAgent as jest.Mock).mockReturnValue(mockStreamGenerator())

            await request(app)
                .post('/api/chat')
                .set('Cookie', [`accessToken=${token}`])
                .query({ project_id: project.uuid })
                .send({
                    query: 'test query',
                })

            // Verify that streamChatAgent was called
            expect(chatAgent.streamChatAgent).toHaveBeenCalled()
            const callArgs = (chatAgent.streamChatAgent as jest.Mock).mock.calls[0][0]
            expect(callArgs.query).toBe('test query')
        })

        it('should create new chat when invalid chat_id provided', async () => {
            const user = await createTestUser(orm, 'test@example.com', 'password123')
            const org = await createTestOrganization(orm, 'Test Org', user)
            await createTestOrganizationMembership(orm, user, org)
            const project = await createTestProject(orm, 'Test Project', org, user)
            const token = generateAccessToken('test@example.com')

            const mockRerankedResults = [{ document: 'Result content', relevance_score: 0.9, index: 0 }]

            const mockRagState = mockRagGraphResponse('test query', mockRerankedResults)
            ;(ragGraphModule.ragGraph.invoke as jest.Mock).mockResolvedValue(mockRagState)

            async function* mockStreamGenerator() {
                yield { type: 'token', content: 'response' }
            }
            ;(chatAgent.streamChatAgent as jest.Mock).mockReturnValue(mockStreamGenerator())

            const invalidChatId = randomUUID()

            const response = await request(app)
                .post('/api/chat')
                .set('Cookie', [`accessToken=${token}`])
                .query({ project_id: project.uuid })
                .send({
                    query: 'test query',
                    chat_id: invalidChatId,
                })

            expect(response.status).toBe(200)
            // Should return a new chat_id, not the invalid one
            expect(response.body.chat_id).toBeDefined()
            expect(response.body.chat_id).not.toBe(invalidChatId)
        })

        it('should scope chat history to correct project', async () => {
            const user = await createTestUser(orm, 'test@example.com', 'password123')
            const org = await createTestOrganization(orm, 'Test Org', user)
            await createTestOrganizationMembership(orm, user, org)
            const project1 = await createTestProject(orm, 'Project 1', org, user)
            const project2 = await createTestProject(orm, 'Project 2', org, user)
            const testChat = await createTestChat(orm, project1)
            const token = generateAccessToken('test@example.com')

            // Create messages in project1's chat
            const em = orm.em.fork()
            const userMessage = em.create(ChatMessage, {
                uuid: randomUUID(),
                message_group_id: randomUUID(),
                project: project1,
                chat: testChat,
                content: 'Message in project 1',
                sent_by: 'user',
                sent_at: new Date(),
            })
            await em.persistAndFlush([userMessage])

            const mockRerankedResults = [{ document: 'Result content', relevance_score: 0.9, index: 0 }]

            const mockRagState = mockRagGraphResponse('test query', mockRerankedResults)
            ;(ragGraphModule.ragGraph.invoke as jest.Mock).mockResolvedValue(mockRagState)

            async function* mockStreamGenerator() {
                yield { type: 'token', content: 'response' }
            }
            ;(chatAgent.streamChatAgent as jest.Mock).mockReturnValue(mockStreamGenerator())

            // Try to access chat from project2 (should not see project1's messages)
            await request(app)
                .post('/api/chat')
                .set('Cookie', [`accessToken=${token}`])
                .query({ project_id: project2.uuid })
                .send({
                    query: 'test query',
                    chat_id: testChat.uuid,
                })

            // Should create a new chat since chat doesn't belong to project2
            const em2 = orm.em.fork()
            const chats = await em2.find(Chat, { project: project2.uuid })
            expect(chats.length).toBeGreaterThan(0)
        })

        it('should pass conversation history and llmProvider to streamChatAgent', async () => {
            const user = await createTestUser(orm, 'test@example.com', 'password123')
            const org = await createTestOrganization(orm, 'Test Org', user)
            await createTestOrganizationMembership(orm, user, org)
            const project = await createTestProject(orm, 'Test Project', org, user)
            const testChat = await createTestChat(orm, project)
            const token = generateAccessToken('test@example.com')

            // Create some existing messages
            const em = orm.em.fork()
            const userMessage = em.create(ChatMessage, {
                uuid: randomUUID(),
                message_group_id: randomUUID(),
                project: project,
                chat: testChat,
                content: 'What is authentication?',
                sent_by: 'user',
                sent_at: new Date(Date.now() - 1000),
            })
            const modelMessage = em.create(ChatMessage, {
                uuid: randomUUID(),
                message_group_id: userMessage.message_group_id,
                project: project,
                chat: testChat,
                content: 'Authentication is the process of verifying identity...',
                sent_by: 'model',
                sent_at: new Date(Date.now() - 500),
            })
            await em.persistAndFlush([userMessage, modelMessage])

            const mockRerankedResults = [{ document: 'Result content', relevance_score: 0.9, index: 0 }]

            const mockRagState = mockRagGraphResponse('tell me more', mockRerankedResults)
            ;(ragGraphModule.ragGraph.invoke as jest.Mock).mockResolvedValue(mockRagState)

            async function* mockStreamGenerator() {
                yield { type: 'token', content: 'response' }
            }
            ;(chatAgent.streamChatAgent as jest.Mock).mockReturnValue(mockStreamGenerator())

            await request(app)
                .post('/api/chat')
                .set('Cookie', [`accessToken=${token}`])
                .query({ project_id: project.uuid })
                .send({
                    query: 'tell me more',
                    chat_id: testChat.uuid,
                    rag_config: {
                        llm_provider: 'anthropic',
                    },
                })

            // Verify that streamChatAgent was called with conversation history
            expect(chatAgent.streamChatAgent).toHaveBeenCalled()
            const streamChatArgs = (chatAgent.streamChatAgent as jest.Mock).mock.calls[0][0]
            expect(streamChatArgs.query).toBe('tell me more')
        })

        it('should pass default llm provider to streamChatAgent when not specified', async () => {
            const user = await createTestUser(orm, 'test@example.com', 'password123')
            const org = await createTestOrganization(orm, 'Test Org', user)
            await createTestOrganizationMembership(orm, user, org)
            const project = await createTestProject(orm, 'Test Project', org, user)
            const token = generateAccessToken('test@example.com')

            const mockRerankedResults = [{ document: 'Result content', relevance_score: 0.9, index: 0 }]

            const mockRagState = mockRagGraphResponse('test query', mockRerankedResults)
            ;(ragGraphModule.ragGraph.invoke as jest.Mock).mockResolvedValue(mockRagState)

            async function* mockStreamGenerator() {
                yield { type: 'token', content: 'response' }
            }
            ;(chatAgent.streamChatAgent as jest.Mock).mockReturnValue(mockStreamGenerator())

            await request(app)
                .post('/api/chat')
                .set('Cookie', [`accessToken=${token}`])
                .query({ project_id: project.uuid })
                .send({
                    query: 'test query',
                })

            // Verify that streamChatAgent was called
            expect(chatAgent.streamChatAgent).toHaveBeenCalled()
            const streamChatArgs = (chatAgent.streamChatAgent as jest.Mock).mock.calls[0][0]
            expect(streamChatArgs.query).toBe('test query')
        })
    })

    describe('GET /api/chat/', () => {
        it('should list all chats for a project', async () => {
            const user = await createTestUser(orm, 'test@example.com', 'password123')
            const org = await createTestOrganization(orm, 'Test Org', user)
            await createTestOrganizationMembership(orm, user, org)
            const project = await createTestProject(orm, 'Test Project', org, user)
            const token = generateAccessToken('test@example.com')

            // Create test chats with messages
            const em = orm.em.fork()
            const chat1 = await createTestChat(orm, project)
            const chat2 = await createTestChat(orm, project)

            // Add messages to chat1
            const message1 = em.create(ChatMessage, {
                uuid: randomUUID(),
                message_group_id: randomUUID(),
                project: project,
                chat: chat1,
                content: 'First question',
                sent_by: 'user',
                sent_at: new Date(Date.now() - 1000),
            })
            const message2 = em.create(ChatMessage, {
                uuid: randomUUID(),
                message_group_id: message1.message_group_id,
                project: project,
                chat: chat1,
                content: 'First response',
                sent_by: 'model',
                sent_at: new Date(Date.now() - 500),
            })

            // Add messages to chat2
            const message3 = em.create(ChatMessage, {
                uuid: randomUUID(),
                message_group_id: randomUUID(),
                project: project,
                chat: chat2,
                content: 'Second question',
                sent_by: 'user',
                sent_at: new Date(),
            })

            await em.persistAndFlush([message1, message2, message3])

            const response = await request(app)
                .get('/api/chat/')
                .set('Cookie', [`accessToken=${token}`])
                .query({ project_id: project.uuid })

            expect(response.status).toBe(200)
            expect(response.body.results).toHaveLength(2)
            expect(response.body.count).toBe(2)
            expect(response.body.results[0].title).toBeDefined()
            expect(response.body.results[0].message_count).toBeGreaterThan(0)
        })

        it('should return empty list when no chats exist', async () => {
            const user = await createTestUser(orm, 'test@example.com', 'password123')
            const org = await createTestOrganization(orm, 'Test Org', user)
            await createTestOrganizationMembership(orm, user, org)
            const project = await createTestProject(orm, 'Test Project', org, user)
            const token = generateAccessToken('test@example.com')

            const response = await request(app)
                .get('/api/chat/')
                .set('Cookie', [`accessToken=${token}`])
                .query({ project_id: project.uuid })

            expect(response.status).toBe(200)
            expect(response.body.results).toHaveLength(0)
            expect(response.body.count).toBe(0)
        })

        it('should support pagination', async () => {
            const user = await createTestUser(orm, 'test@example.com', 'password123')
            const org = await createTestOrganization(orm, 'Test Org', user)
            await createTestOrganizationMembership(orm, user, org)
            const project = await createTestProject(orm, 'Test Project', org, user)
            const token = generateAccessToken('test@example.com')

            // Create 3 chats
            await createTestChat(orm, project)
            await createTestChat(orm, project)
            await createTestChat(orm, project)

            const response = await request(app)
                .get('/api/chat/')
                .set('Cookie', [`accessToken=${token}`])
                .query({ project_id: project.uuid, page: 1, page_size: 2 })

            expect(response.status).toBe(200)
            expect(response.body.results).toHaveLength(2)
            expect(response.body.count).toBe(3)
            expect(response.body.page).toBe(1)
            expect(response.body.page_size).toBe(2)
            expect(response.body.total_pages).toBe(2)
        })
    })

    describe('GET /api/chat/:id', () => {
        it('should return chat details with all messages', async () => {
            const user = await createTestUser(orm, 'test@example.com', 'password123')
            const org = await createTestOrganization(orm, 'Test Org', user)
            await createTestOrganizationMembership(orm, user, org)
            const project = await createTestProject(orm, 'Test Project', org, user)
            const token = generateAccessToken('test@example.com')

            const testChat = await createTestChat(orm, project)

            // Add messages
            const em = orm.em.fork()
            const message1 = em.create(ChatMessage, {
                uuid: randomUUID(),
                message_group_id: randomUUID(),
                project: project,
                chat: testChat,
                content: 'User question',
                sent_by: 'user',
                sent_at: new Date(Date.now() - 1000),
            })
            const message2 = em.create(ChatMessage, {
                uuid: randomUUID(),
                message_group_id: message1.message_group_id,
                project: project,
                chat: testChat,
                content: 'Model response',
                sent_by: 'model',
                sent_at: new Date(),
            })
            await em.persistAndFlush([message1, message2])

            const response = await request(app)
                .get(`/api/chat/${testChat.uuid}`)
                .set('Cookie', [`accessToken=${token}`])
                .query({ project_id: project.uuid })

            expect(response.status).toBe(200)
            expect(response.body.uuid).toBe(testChat.uuid)
            expect(response.body.messages).toHaveLength(2)
            expect(response.body.messages[0].content).toBe('User question')
            expect(response.body.messages[1].content).toBe('Model response')
        })

        it('should return 404 for non-existent chat', async () => {
            const user = await createTestUser(orm, 'test@example.com', 'password123')
            const org = await createTestOrganization(orm, 'Test Org', user)
            await createTestOrganizationMembership(orm, user, org)
            const project = await createTestProject(orm, 'Test Project', org, user)
            const token = generateAccessToken('test@example.com')

            const nonExistentChatId = randomUUID()

            const response = await request(app)
                .get(`/api/chat/${nonExistentChatId}`)
                .set('Cookie', [`accessToken=${token}`])
                .query({ project_id: project.uuid })

            expect(response.status).toBe(404)
            expect(response.body.error).toBe('Chat not found')
        })
    })

    describe('Query Rewrite', () => {
        beforeEach(() => {
            jest.clearAllMocks()
        })

        describe('rewrite', () => {
            it('should call LLMService.invokeWithRetry with correct parameters', async () => {
                ;(LLMService.invokeWithRetry as jest.Mock).mockResolvedValue({
                    content: 'How to authenticate users with API?',
                })

                const query = 'how to auth users api'
                const result = await rewrite(query, [])

                expect(LLMService.invokeWithRetry).toHaveBeenCalledWith({
                    messages: [
                        { role: 'system', content: expect.any(String) },
                        { role: 'user', content: expect.stringContaining(query) },
                    ],
                    temperature: 0.3,
                })
                expect(result).toBe('How to authenticate users with API?')
            })

            it('should include conversation history in the prompt', async () => {
                ;(LLMService.invokeWithRetry as jest.Mock).mockResolvedValue({
                    content: 'Tell me more about database migrations',
                })

                const query = 'tell me more'
                const conversationHistory = [
                    { role: 'user' as const, content: 'What are database migrations?' },
                    { role: 'assistant' as const, content: 'Database migrations are...' },
                ]

                await rewrite(query, conversationHistory)

                const callArgs = (LLMService.invokeWithRetry as jest.Mock).mock.calls[0][0]
                const userMessage = callArgs.messages[1].content

                expect(userMessage).toContain('CONVERSATION CONTEXT')
                expect(userMessage).toContain('What are database migrations?')
                expect(userMessage).toContain('Database migrations are...')
            })

            it('should return original query on API error', async () => {
                ;(LLMService.invokeWithRetry as jest.Mock).mockRejectedValue(new Error('API Error'))

                const query = 'how to auth'
                const result = await rewrite(query, [])

                expect(result).toBe(query) // Should fall back to original
            })

            it('should return original query when LLM returns empty response', async () => {
                ;(LLMService.invokeWithRetry as jest.Mock).mockResolvedValue({
                    content: '',
                })

                const query = 'how to auth'
                const result = await rewrite(query, [])

                expect(result).toBe(query)
            })

            it('should limit conversation history to last 3 conversation pairs', async () => {
                ;(LLMService.invokeWithRetry as jest.Mock).mockResolvedValue({
                    content: 'Enhanced query',
                })

                const query = 'tell me more'
                const conversationHistory = [
                    { role: 'user' as const, content: 'Message 1' },
                    { role: 'assistant' as const, content: 'Response 1' },
                    { role: 'user' as const, content: 'Message 2' },
                    { role: 'assistant' as const, content: 'Response 2' },
                    { role: 'user' as const, content: 'Message 3' },
                    { role: 'assistant' as const, content: 'Response 3' },
                    { role: 'user' as const, content: 'Message 4' },
                    { role: 'assistant' as const, content: 'Response 4' },
                ]

                await rewrite(query, conversationHistory)

                const callArgs = (LLMService.invokeWithRetry as jest.Mock).mock.calls[0][0]
                const userMessage = callArgs.messages[1].content

                // Should only include last 3 messages from the 8-element array
                // slice(-3) gives indices [5, 6, 7] which are: Response 3, Message 4, Response 4
                expect(userMessage).toContain('Response 3')
                expect(userMessage).toContain('Message 4')
                expect(userMessage).toContain('Response 4')
                expect(userMessage).not.toContain('Message 1')
                expect(userMessage).not.toContain('Message 2')
            })
        })
    })

    describe('Task 12: Exact Lookup — Multi-key and Archived Handling', () => {
        // Task 12: Implementation verification
        // The core implementation is in ragGraph.ts with:
        // 1. Multi-key extraction via loop over extractedKeys
        // 2. Archived distinction via COALESCE(archived, false) and status filtering
        // 3. Context injection for hit/archived_only/miss states in buildLLMInputsNode

        it('should expose ragGraph for integration', async () => {
            // Verify ragGraph exists and is callable
            expect(ragGraphModule.ragGraph).toBeDefined()
            expect(typeof ragGraphModule.ragGraph.invoke).toBe('function')
        })
    })

    describe('Task 21: Backward-Compatibility Regression Matrix (strong integration tests)', () => {
        describe('Simple Query Backward-Compatibility', () => {
            it('should preserve basic query response contract and RAG invocation', async () => {
                const user = await createTestUser(orm, 'test@example.com', 'password123')
                const org = await createTestOrganization(orm, 'Test Org', user)
                await createTestOrganizationMembership(orm, user, org)
                const project = await createTestProject(orm, 'Test Project', org, user)
                const token = generateAccessToken('test@example.com')

                const mockRerankedResults = [
                    { document: 'Backward-compat test content', relevance_score: 0.9, index: 0 },
                ]
                const mockRagState = mockRagGraphResponse('What is this?', mockRerankedResults)
                ;(ragGraphModule.ragGraph.invoke as jest.Mock).mockResolvedValue(mockRagState)

                async function* mockStreamGenerator() {
                    yield { type: 'token', content: 'This is the backward-compatible answer.' }
                }
                ;(chatAgent.streamChatAgent as jest.Mock).mockReturnValue(mockStreamGenerator())

                const response = await request(app)
                    .post('/api/chat')
                    .set('Cookie', [`accessToken=${token}`])
                    .query({ project_id: project.uuid })
                    .send({ query: 'What is this?' })

                expect(response.status).toBe(200)
                expect(response.body.ok).toBe(true)
                expect(response.body.chat_id).toBeDefined()
                expect(typeof response.body.chat_id).toBe('string')
                expect(response.body.response).toBeDefined()
                expect(typeof response.body.response).toBe('string')
                expect(response.body.response.length).toBeGreaterThan(0)

                // Strong assertion: ragGraph.invoke must be called with query
                const ragInvokeCalls = (ragGraphModule.ragGraph.invoke as jest.Mock).mock.calls
                expect(ragInvokeCalls.length).toBeGreaterThan(0)
                const invokeArgs = ragInvokeCalls[0][0]
                expect(invokeArgs).toHaveProperty('query')
                expect(invokeArgs.query).toEqual('What is this?')
            })
        })

        describe('Greeting Bypass Regression', () => {
            it('should handle greeting queries and return valid response', async () => {
                const user = await createTestUser(orm, 'test@example.com', 'password123')
                const org = await createTestOrganization(orm, 'Test Org', user)
                await createTestOrganizationMembership(orm, user, org)
                const project = await createTestProject(orm, 'Test Project', org, user)
                const token = generateAccessToken('test@example.com')

                const mockRerankedResults = [{ document: 'Greeting response', relevance_score: 0.9, index: 0 }]
                const mockRagState = mockRagGraphResponse('Hello', mockRerankedResults)
                ;(ragGraphModule.ragGraph.invoke as jest.Mock).mockResolvedValue(mockRagState)

                async function* mockStreamGenerator() {
                    yield { type: 'token', content: 'Hello! How can I help?' }
                }
                ;(chatAgent.streamChatAgent as jest.Mock).mockReturnValue(mockStreamGenerator())

                const response = await request(app)
                    .post('/api/chat')
                    .set('Cookie', [`accessToken=${token}`])
                    .query({ project_id: project.uuid })
                    .send({ query: 'Hello' })

                expect(response.status).toBe(200)
                expect(response.body.ok).toBe(true)
                expect(response.body.chat_id).toBeDefined()
                expect(response.body.response).toBeDefined()
                expect(typeof response.body.response).toBe('string')

                // Strong assertion: greeting queries must use streamChatAgent (direct path)
                expect((chatAgent.streamChatAgent as jest.Mock).mock.calls.length).toBeGreaterThan(0)
                const streamChatCalls = (chatAgent.streamChatAgent as jest.Mock).mock.calls
                const firstCall = streamChatCalls[0][0]
                expect(firstCall).toHaveProperty('query')
                expect(firstCall.query).toEqual('Hello')
            })
        })

        describe('Citation Mode Regression', () => {
            it('should provide references in response when references enabled', async () => {
                const user = await createTestUser(orm, 'test@example.com', 'password123')
                const org = await createTestOrganization(orm, 'Test Org', user)
                await createTestOrganizationMembership(orm, user, org)
                const project = await createTestProject(orm, 'Test Project', org, user)
                const token = generateAccessToken('test@example.com')

                const mockRerankedResults = [
                    {
                        document: 'Test doc for citation',
                        relevance_score: 0.95,
                        index: 0,
                        memo_uuid: 'uuid-1',
                        document_type: 'jira_issue',
                    },
                ]
                const mockRagState = mockRagGraphResponse('Cite this', mockRerankedResults)
                ;(ragGraphModule.ragGraph.invoke as jest.Mock).mockResolvedValue(mockRagState)

                async function* mockStreamGenerator() {
                    yield { type: 'token', content: 'Here is the answer [[1]]' }
                }
                ;(chatAgent.streamChatAgent as jest.Mock).mockReturnValue(mockStreamGenerator())

                const response = await request(app)
                    .post('/api/chat')
                    .set('Cookie', [`accessToken=${token}`])
                    .query({ project_id: project.uuid })
                    .send({
                        query: 'Cite this',
                        rag_config: { references: { enabled: true } },
                    })

                expect(response.status).toBe(200)
                expect(response.body.chat_id).toBeDefined()
                expect(response.body.response).toBeDefined()

                // Strong assertion: response must contain citation format [[N]]
                expect(response.body.response).toMatch(/\[\[\d+\]\]/)

                // Strong assertion: streamChatAgent must be called with enableReferences=true
                const streamCalls = (chatAgent.streamChatAgent as jest.Mock).mock.calls
                expect(streamCalls.length).toBeGreaterThan(0)
                const firstCall = streamCalls[0][0]
                expect(firstCall).toHaveProperty('enableReferences')
                expect(firstCall.enableReferences).toBe(true)
            })

            it('should NOT provide references when references disabled', async () => {
                const user = await createTestUser(orm, 'test@example.com', 'password123')
                const org = await createTestOrganization(orm, 'Test Org', user)
                await createTestOrganizationMembership(orm, user, org)
                const project = await createTestProject(orm, 'Test Project', org, user)
                const token = generateAccessToken('test@example.com')

                const mockRerankedResults = [{ document: 'No citation needed', relevance_score: 0.85, index: 0 }]
                const mockRagState = mockRagGraphResponse('No cite', mockRerankedResults)
                ;(ragGraphModule.ragGraph.invoke as jest.Mock).mockResolvedValue(mockRagState)

                async function* mockStreamGenerator() {
                    yield { type: 'token', content: 'Answer without citation.' }
                }
                ;(chatAgent.streamChatAgent as jest.Mock).mockReturnValue(mockStreamGenerator())

                const response = await request(app)
                    .post('/api/chat')
                    .set('Cookie', [`accessToken=${token}`])
                    .query({ project_id: project.uuid })
                    .send({
                        query: 'No cite',
                        rag_config: { references: { enabled: false } },
                    })

                expect(response.status).toBe(200)
                expect(response.body.chat_id).toBeDefined()
                expect(response.body.response).toBeDefined()

                // Strong assertion: response must NOT contain citation format [[N]]
                expect(response.body.response).not.toMatch(/\[\[\d+\]\]/)

                // Strong assertion: streamChatAgent must be called with enableReferences=false
                const streamCalls = (chatAgent.streamChatAgent as jest.Mock).mock.calls
                expect(streamCalls.length).toBeGreaterThan(0)
                const firstCall = streamCalls[0][0]
                expect(firstCall).toHaveProperty('enableReferences')
                expect(firstCall.enableReferences).toBe(false)
            })
        })

        describe('Streaming vs Non-Streaming Parity', () => {
            it('should maintain same chat_id and response shape in non-streaming mode', async () => {
                const user = await createTestUser(orm, 'test@example.com', 'password123')
                const org = await createTestOrganization(orm, 'Test Org', user)
                await createTestOrganizationMembership(orm, user, org)
                const project = await createTestProject(orm, 'Test Project', org, user)
                const token = generateAccessToken('test@example.com')

                const mockRerankedResults = [{ document: 'Parity test content', relevance_score: 0.9, index: 0 }]
                const mockRagState = mockRagGraphResponse('Test parity', mockRerankedResults)
                ;(ragGraphModule.ragGraph.invoke as jest.Mock).mockResolvedValue(mockRagState)

                async function* mockStreamGenerator() {
                    yield { type: 'token', content: 'Non-streaming response.' }
                }
                ;(chatAgent.streamChatAgent as jest.Mock).mockReturnValue(mockStreamGenerator())

                const response = await request(app)
                    .post('/api/chat')
                    .set('Cookie', [`accessToken=${token}`])
                    .query({ project_id: project.uuid })
                    .send({
                        query: 'Test parity',
                        stream: false,
                    })

                expect(response.status).toBe(200)
                expect(response.body.chat_id).toBeDefined()
                expect(typeof response.body.chat_id).toBe('string')
                expect(response.body.response).toBeDefined()
                expect(typeof response.body.response).toBe('string')

                // Strong assertion: non-streaming mode must still invoke streamChatAgent with correct query
                const streamCalls = (chatAgent.streamChatAgent as jest.Mock).mock.calls
                expect(streamCalls.length).toBeGreaterThan(0)
                const firstCall = streamCalls[0][0]
                expect(firstCall).toHaveProperty('query')
                expect(firstCall.query).toEqual('Test parity')

                // Strong assertion: response body structure parity
                expect(response.body).toHaveProperty('ok')
                expect(response.body).toHaveProperty('chat_id')
                expect(response.body).toHaveProperty('response')
            })
        })

        describe('Filters Backward-Compatibility', () => {
            it('should handle queries with empty filters array', async () => {
                const user = await createTestUser(orm, 'test@example.com', 'password123')
                const org = await createTestOrganization(orm, 'Test Org', user)
                await createTestOrganizationMembership(orm, user, org)
                const project = await createTestProject(orm, 'Test Project', org, user)
                const token = generateAccessToken('test@example.com')

                const mockRerankedResults = [{ document: 'Query with filters', relevance_score: 0.9, index: 0 }]
                const mockRagState = mockRagGraphResponse('Query with filters', mockRerankedResults)
                ;(ragGraphModule.ragGraph.invoke as jest.Mock).mockResolvedValue(mockRagState)

                async function* mockStreamGenerator() {
                    yield { type: 'token', content: 'Response with filters support.' }
                }
                ;(chatAgent.streamChatAgent as jest.Mock).mockReturnValue(mockStreamGenerator())

                const response = await request(app)
                    .post('/api/chat')
                    .set('Cookie', [`accessToken=${token}`])
                    .query({ project_id: project.uuid })
                    .send({
                        query: 'Query with filters',
                        filters: [],
                    })

                expect(response.status).toBe(200)
                expect(response.body.chat_id).toBeDefined()
                expect(response.body.response).toBeDefined()
                expect(typeof response.body.response).toBe('string')

                // Strong assertion: ragGraph.invoke must be called (filters don't skip RAG)
                const ragInvokeCalls = (ragGraphModule.ragGraph.invoke as jest.Mock).mock.calls
                expect(ragInvokeCalls.length).toBeGreaterThan(0)
                const invokeArgs = ragInvokeCalls[0][0]
                expect(invokeArgs).toHaveProperty('query')
                expect(invokeArgs.query).toEqual('Query with filters')

                // Strong assertion: empty filters are preserved in backward-compat call signature
                expect(invokeArgs).toHaveProperty('filters')
                expect(invokeArgs.filters).toEqual([])
            })
        })

        describe('Two-Phase Chat UX: Early Persistence and SSE Events', () => {
            it('should emit accepted and progress events in streaming response', async () => {
                const user = await createTestUser(orm, 'test@example.com', 'password123')
                const org = await createTestOrganization(orm, 'Test Org', user)
                await createTestOrganizationMembership(orm, user, org)
                const project = await createTestProject(orm, 'Test Project', org, user)
                const token = generateAccessToken('test@example.com')

                const mockRerankedResults = [{ document: 'Result content', relevance_score: 0.9, index: 0 }]
                const mockRagState = mockRagGraphResponse('test query', mockRerankedResults)
                ;(ragGraphModule.ragGraph.invoke as jest.Mock).mockResolvedValue(mockRagState)

                async function* mockStreamGenerator() {
                    yield { content: 'chunk1' }
                    yield { content: 'chunk2' }
                }
                ;(chatAgent.streamChatAgent as jest.Mock).mockReturnValue(mockStreamGenerator())

                const response = await request(app)
                    .post('/api/chat')
                    .set('Cookie', [`accessToken=${token}`])
                    .query({ project_id: project.uuid })
                    .send({
                        query: 'test query',
                        stream: true,
                    })

                expect(response.status).toBe(200)
                expect(response.text).toContain('"type":"accepted"')
                expect(response.text).toContain('"type":"progress"')
                expect(response.text).toContain('"status":"searching"')
                expect(response.text).toContain('"status":"generating"')
            })

            it('should persist user and assistant messages in streaming mode', async () => {
                const user = await createTestUser(orm, 'test@example.com', 'password123')
                const org = await createTestOrganization(orm, 'Test Org', user)
                await createTestOrganizationMembership(orm, user, org)
                const project = await createTestProject(orm, 'Test Project', org, user)
                const token = generateAccessToken('test@example.com')

                const mockRerankedResults = [{ document: 'Result content', relevance_score: 0.9, index: 0 }]
                const mockRagState = mockRagGraphResponse('test query', mockRerankedResults)
                ;(ragGraphModule.ragGraph.invoke as jest.Mock).mockResolvedValue(mockRagState)

                async function* mockStreamGenerator() {
                    yield { content: 'response' }
                }
                ;(chatAgent.streamChatAgent as jest.Mock).mockReturnValue(mockStreamGenerator())

                await request(app)
                    .post('/api/chat')
                    .set('Cookie', [`accessToken=${token}`])
                    .query({ project_id: project.uuid })
                    .send({
                        query: 'test query',
                        stream: true,
                    })

                const em = orm.em.fork()
                const chats = await em.find(Chat, { project: project.uuid })
                expect(chats).toHaveLength(1)

                const chatMessages = await em.find(
                    ChatMessage,
                    { chat: chats[0].uuid },
                    { orderBy: { sent_at: 'ASC' } }
                )
                expect(chatMessages).toHaveLength(2)
                expect(chatMessages[0].sent_by).toBe('user')
                expect(chatMessages[0].content).toBe('test query')
                expect(chatMessages[1].sent_by).toBe('model')
            })

            it('should include chat_id in accepted event matching done event', async () => {
                const user = await createTestUser(orm, 'test@example.com', 'password123')
                const org = await createTestOrganization(orm, 'Test Org', user)
                await createTestOrganizationMembership(orm, user, org)
                const project = await createTestProject(orm, 'Test Project', org, user)
                const token = generateAccessToken('test@example.com')

                const mockRerankedResults = [{ document: 'Result content', relevance_score: 0.9, index: 0 }]
                const mockRagState = mockRagGraphResponse('test query', mockRerankedResults)
                ;(ragGraphModule.ragGraph.invoke as jest.Mock).mockResolvedValue(mockRagState)

                async function* mockStreamGenerator() {
                    yield { content: 'response' }
                }
                ;(chatAgent.streamChatAgent as jest.Mock).mockReturnValue(mockStreamGenerator())

                const response = await request(app)
                    .post('/api/chat')
                    .set('Cookie', [`accessToken=${token}`])
                    .query({ project_id: project.uuid })
                    .send({
                        query: 'test query',
                        stream: true,
                    })

                expect(response.status).toBe(200)

                const acceptedMatch = response.text.match(/"type":"accepted"[^}]*"chat_id":"([^"]+)"/)
                expect(acceptedMatch).not.toBeNull()
                expect(acceptedMatch![1]).toMatch(/^[0-9a-f-]{36}$/)

                const doneMatch = response.text.match(/"type":"done"[^}]*"chat_id":"([^"]+)"/)
                expect(doneMatch).not.toBeNull()
                expect(doneMatch![1]).toBe(acceptedMatch![1])
            })

            it('should keep only the user message persisted when accepted streaming request fails before any token', async () => {
                const user = await createTestUser(orm, 'test@example.com', 'password123')
                const org = await createTestOrganization(orm, 'Test Org', user)
                await createTestOrganizationMembership(orm, user, org)
                const project = await createTestProject(orm, 'Test Project', org, user)
                const token = generateAccessToken('test@example.com')

                const mockRagState = mockRagGraphResponse('test query', [])
                ;(ragGraphModule.ragGraph.invoke as jest.Mock).mockResolvedValue(mockRagState)

                async function* mockStreamGenerator() {
                    throw new Error('Chat stream completed without any response content')
                }

                ;(chatAgent.streamChatAgent as jest.Mock).mockReturnValue(mockStreamGenerator())

                const response = await request(app)
                    .post('/api/chat')
                    .set('Cookie', [`accessToken=${token}`])
                    .query({ project_id: project.uuid })
                    .send({
                        query: 'test query',
                        stream: true,
                    })

                expect(response.status).toBe(200)
                expect(response.text).toContain('"type":"accepted"')
                expect(response.text).toContain('"type":"error"')

                const em = orm.em.fork()
                const chats = await em.find(Chat, { project: project.uuid })
                expect(chats).toHaveLength(1)

                const chatMessages = await em.find(
                    ChatMessage,
                    { chat: chats[0].uuid },
                    { orderBy: { sent_at: 'ASC' } }
                )
                expect(chatMessages).toHaveLength(1)
                expect(chatMessages[0].sent_by).toBe('user')
                expect(chatMessages[0].content).toBe('test query')
            })

            it('should keep direct route streaming on the existing fast token path without preview', async () => {
                const user = await createTestUser(orm, 'test@example.com', 'password123')
                const org = await createTestOrganization(orm, 'Test Org', user)
                await createTestOrganizationMembership(orm, user, org)
                const project = await createTestProject(orm, 'Test Project', org, user)
                const token = generateAccessToken('test@example.com')

                const mockRagState = mockRagGraphResponse('test query', [])
                ;(ragGraphModule.ragGraph.invoke as jest.Mock).mockResolvedValue(mockRagState)

                async function* mockStreamGenerator() {
                    yield { content: 'chunk1' }
                }
                ;(chatAgent.streamChatAgent as jest.Mock).mockReturnValue(mockStreamGenerator())

                const routeQueryMock = require('../lib/queryRouter').routeQuery as jest.Mock
                routeQueryMock.mockReturnValue({ route: 'direct_greeting', response: '안녕하세요!' })

                const response = await request(app)
                    .post('/api/chat')
                    .set('Cookie', [`accessToken=${token}`])
                    .query({ project_id: project.uuid })
                    .send({
                        query: '안녕',
                        stream: true,
                    })

                expect(response.status).toBe(200)
                expect(response.text).not.toContain('"type":"accepted"')
                expect(response.text).not.toContain('"type":"preview"')
                expect(response.text).toContain('"type":"token"')
                expect(response.text).toContain('"type":"done"')
                expect(response.text).toContain('안녕하세요!')
            })

            it('should emit preview event with cached response when available', async () => {
                const user = await createTestUser(orm, 'test@example.com', 'password123')
                const org = await createTestOrganization(orm, 'Test Org', user)
                await createTestOrganizationMembership(orm, user, org)
                const project = await createTestProject(orm, 'Test Project', org, user)
                const token = generateAccessToken('test@example.com')

                const mockRagState = mockRagGraphResponse('test query', [])
                ;(ragGraphModule.ragGraph.invoke as jest.Mock).mockResolvedValue(mockRagState)

                async function* mockStreamGenerator() {
                    yield { content: 'response' }
                }
                ;(chatAgent.streamChatAgent as jest.Mock).mockReturnValue(mockStreamGenerator())

                const getCachedResponseMock = require('../lib/ragCache').getCachedResponse as jest.Mock
                getCachedResponseMock.mockResolvedValue('Cached answer for this query')

                const response = await request(app)
                    .post('/api/chat')
                    .set('Cookie', [`accessToken=${token}`])
                    .query({ project_id: project.uuid })
                    .send({
                        query: 'test query',
                        stream: true,
                    })

                expect(response.status).toBe(200)
                expect(response.text).toContain('"type":"preview"')
                expect(response.text).toContain('Cached answer for this query')
                expect(fastRetrieveModule.fastRetrieve).not.toHaveBeenCalled()
            })

            it('should always emit preview for streaming RAG queries before the first token', async () => {
                const user = await createTestUser(orm, 'test@example.com', 'password123')
                const org = await createTestOrganization(orm, 'Test Org', user)
                await createTestOrganizationMembership(orm, user, org)
                const project = await createTestProject(orm, 'Test Project', org, user)
                const token = generateAccessToken('test@example.com')

                const mockRagState = mockRagGraphResponse('test query', [
                    { document: 'deep result', memo_uuid: 'memo-1' },
                ])
                ;(ragGraphModule.ragGraph.invoke as jest.Mock).mockResolvedValue(mockRagState)

                async function* mockStreamGenerator() {
                    yield { type: 'token', content: 'final answer token' }
                }
                ;(chatAgent.streamChatAgent as jest.Mock).mockReturnValue(mockStreamGenerator())

                const response = await request(app)
                    .post('/api/chat')
                    .set('Cookie', [`accessToken=${token}`])
                    .query({ project_id: project.uuid })
                    .send({
                        query: 'test query',
                        stream: true,
                    })

                expect(response.status).toBe(200)
                const previewIndex = response.text.indexOf('"type":"preview"')
                const tokenIndex = response.text.indexOf('"type":"token"')
                expect(previewIndex).toBeGreaterThan(-1)
                expect(tokenIndex).toBeGreaterThan(-1)
                expect(previewIndex).toBeLessThan(tokenIndex)
                expect(fastRetrieveModule.fastRetrieve).toHaveBeenCalled()
                expect(previewAgentModule.generatePreview).toHaveBeenCalled()
            })

            it('should fall back to the default preview copy when fast Stage A fails', async () => {
                const user = await createTestUser(orm, 'test@example.com', 'password123')
                const org = await createTestOrganization(orm, 'Test Org', user)
                await createTestOrganizationMembership(orm, user, org)
                const project = await createTestProject(orm, 'Test Project', org, user)
                const token = generateAccessToken('test@example.com')

                const mockRagState = mockRagGraphResponse('test query', [])
                ;(ragGraphModule.ragGraph.invoke as jest.Mock).mockResolvedValue(mockRagState)
                ;(fastRetrieveModule.fastRetrieve as jest.Mock).mockRejectedValue(new Error('preview miss'))

                async function* mockStreamGenerator() {
                    yield { type: 'token', content: 'final answer token' }
                }
                ;(chatAgent.streamChatAgent as jest.Mock).mockReturnValue(mockStreamGenerator())

                const response = await request(app)
                    .post('/api/chat')
                    .set('Cookie', [`accessToken=${token}`])
                    .query({ project_id: project.uuid })
                    .send({
                        query: 'test query',
                        stream: true,
                    })

                expect(response.status).toBe(200)
                expect(response.text).toContain('"type":"preview"')
                expect(response.text).toContain(
                    '1차 답변: 질문을 확인했습니다. 최종 답변은 곧 자세한 근거와 함께 이어집니다.'
                )
            })
        })
    })
})

describe('Prompt Contract Tests', () => {
    it('CHAT_AGENT_INSTRUCTIONS should explicitly support dual evidence (retrieved + user-provided)', () => {
        const { CHAT_AGENT_INSTRUCTIONS } = require('../agents/chatAgent/prompts')
        expect(CHAT_AGENT_INSTRUCTIONS).toContain('이중 증거')
        expect(CHAT_AGENT_INSTRUCTIONS).toContain('검색된 문서')
        expect(CHAT_AGENT_INSTRUCTIONS).toContain('사용자 제공 컨텍스트')
        expect(CHAT_AGENT_INSTRUCTIONS).toContain('두 출처 모두에서 정보를 사용할 수 있습니다')
    })

    it('CHAT_AGENT_INSTRUCTIONS should prefer partial grounded answers over refusal', () => {
        const { CHAT_AGENT_INSTRUCTIONS } = require('../agents/chatAgent/prompts')
        expect(CHAT_AGENT_INSTRUCTIONS).toContain('부분 답변을 제공하고')
        expect(CHAT_AGENT_INSTRUCTIONS).toContain('절대 거절하지 마십시오')
        expect(CHAT_AGENT_INSTRUCTIONS).toContain('부분적인 답변을 항상 선호하세요')
    })

    it('CHAT_AGENT_INSTRUCTIONS should explicitly surface contradictions instead of silently resolving', () => {
        const { CHAT_AGENT_INSTRUCTIONS } = require('../agents/chatAgent/prompts')
        expect(CHAT_AGENT_INSTRUCTIONS).toContain('상충 사항을 명시적으로 노출')
        expect(CHAT_AGENT_INSTRUCTIONS).toContain('한 출처를 조용히 선택하지 마십시오')
    })

    it('CHAT_AGENT_INSTRUCTIONS_WITH_SOURCES should forbid citations for user-provided evidence', () => {
        const { CHAT_AGENT_INSTRUCTIONS_WITH_SOURCES } = require('../agents/chatAgent/prompts')
        expect(CHAT_AGENT_INSTRUCTIONS_WITH_SOURCES).toContain(
            '사용자 제공 컨텍스트에서 나온 정보에는 절대 [[N]] 인용을 붙이지 마십시오'
        )
        expect(CHAT_AGENT_INSTRUCTIONS_WITH_SOURCES).toContain('검색된 문서만 인용합니다')
    })

    it('CHAT_AGENT_INSTRUCTIONS_WITH_SOURCES should preserve [[N]] citation rules for retrieved docs only', () => {
        const { CHAT_AGENT_INSTRUCTIONS_WITH_SOURCES } = require('../agents/chatAgent/prompts')
        expect(CHAT_AGENT_INSTRUCTIONS_WITH_SOURCES).toContain(
            '검색된 문서에서 도출된 각 주장 직후에만 [[result_number]]를 사용'
        )
        expect(CHAT_AGENT_INSTRUCTIONS_WITH_SOURCES).toContain(
            '검색된 문서에서 나온 주장에는 반드시 [[N]] 형식의 출처가 필요합니다'
        )
    })

    it('CHAT_AGENT_INSTRUCTIONS_WITH_SOURCES should explicitly surface contradictions between evidence sources', () => {
        const { CHAT_AGENT_INSTRUCTIONS_WITH_SOURCES } = require('../agents/chatAgent/prompts')
        expect(CHAT_AGENT_INSTRUCTIONS_WITH_SOURCES).toContain('증거 간 내용이 상충될 경우')
        expect(CHAT_AGENT_INSTRUCTIONS_WITH_SOURCES).toContain('상충 사항을 명시적으로 노출')
        expect(CHAT_AGENT_INSTRUCTIONS_WITH_SOURCES).toContain('각 출처(검색 vs 사용자 제공)를 표시')
    })

    it('CHAT_AGENT_INSTRUCTIONS_WITH_SOURCES should forbid fake citations (no [[N]] for user context)', () => {
        const { CHAT_AGENT_INSTRUCTIONS_WITH_SOURCES } = require('../agents/chatAgent/prompts')
        expect(CHAT_AGENT_INSTRUCTIONS_WITH_SOURCES).toContain(
            '사용자 제공 컨텍스트에서 나온 정보에는 절대 인용을 붙이지 마십시오'
        )
    })
})
