import express, { Express } from 'express'
import request from 'supertest'
import { MikroORM, RequestContext } from '@mikro-orm/postgresql'
import cookieParser from 'cookie-parser'
import { DI } from '../di'
import { userMiddleware } from '../middleware/userMiddleware'
import { authMemoSubmissionRouter, publicMemoSubmissionRouter } from '../api/memoSubmission'
import { createTestDatabase, clearDatabase, closeDatabase } from './testDb'
import {
    createTestOrganization,
    createTestOrganizationMembership,
    createTestProject,
    createTestUser,
} from './testHelpers'
import { User } from '../entities/User'
import { Project } from '../entities/Project'
import { Organization } from '../entities/Organization'
import { OrganizationMembership } from '../entities/OrganizationMembership'
import { MemoSubmission } from '../entities/MemoSubmission'
import { Memo } from '../entities/Memo'
import { MemoContent } from '../entities/MemoContent'
import { MemoSummary } from '../entities/MemoSummary'
import { MemoTag } from '../entities/MemoTag'
import { MemoChunk } from '../entities/MemoChunk'
import { requireProjectAccess } from '../middleware/authMiddleware'
import { generateAccessToken } from '../lib/tokenUtils'

jest.mock('../lib/createMemoUtils', () => ({
    createNewMemo: jest.fn().mockImplementation(async (memoData: { title: string }) => ({
        uuid: `memo-${memoData.title}`,
    })),
}))

jest.mock('../agents/memoTagsAgent', () => ({
    memoTagsAgent: {
        extractTags: jest.fn().mockResolvedValue({ tags: ['submission', 'preview'] }),
    },
}))

jest.mock('../agents/memoSummaryAgent', () => ({
    memoSummaryAgent: {
        summarize: jest.fn().mockResolvedValue({ summary: 'Preview summary for approval.' }),
    },
}))

jest.setTimeout(30000)

describe('Memo submission API', () => {
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
        DI.memoSubmissions = orm.em.getRepository(MemoSubmission)
        DI.memos = orm.em.getRepository(Memo)
        DI.memoContents = orm.em.getRepository(MemoContent)
        DI.memoSummaries = orm.em.getRepository(MemoSummary)
        DI.memoTags = orm.em.getRepository(MemoTag)
        DI.memoChunks = orm.em.getRepository(MemoChunk)

        app = express()
        app.use(express.json())
        app.use(cookieParser())
        app.use((req, res, next) => RequestContext.create(orm.em, next))
        app.use(userMiddleware())
        app.use('/api/public/memo-submissions', publicMemoSubmissionRouter)
        app.use('/api/v1/memo-submissions', [requireProjectAccess()], authMemoSubmissionRouter)
    })

    afterAll(async () => {
        await closeDatabase(orm)
    })

    afterEach(async () => {
        await clearDatabase(orm)
        jest.clearAllMocks()
    })

    it('allows unauthenticated public memo submission and lists it as pending', async () => {
        const user = await createTestUser(orm, 'owner@example.com', 'password123')
        const organization = await createTestOrganization(orm, 'Test Org', user)
        await createTestOrganizationMembership(orm, user, organization)
        const project = await createTestProject(orm, 'Test Project', organization, user)

        const createResponse = await request(app)
            .post('/api/public/memo-submissions')
            .query({ project_id: project.uuid })
            .send({
                title: 'Public memo title',
                content: 'Public memo content awaiting approval.',
            })

        expect(createResponse.status).toBe(201)
        expect(createResponse.body.submission_uuid).toBeDefined()

        const listResponse = await request(app)
            .get('/api/public/memo-submissions')
            .query({ project_id: project.uuid, status: 'pending', page: 1, page_size: 10 })

        expect(listResponse.status).toBe(200)
        expect(listResponse.body.count).toBe(1)
        expect(listResponse.body.results[0]).toMatchObject({
            title: 'Public memo title',
            status: 'pending',
            summary: 'Preview summary for approval.',
            tags: expect.arrayContaining(['submission', 'preview']),
        })
        expect(listResponse.body.results[0].metadata.search_aliases.length).toBeGreaterThan(0)
    })

    it('approves a pending submission and exposes it in approved public list', async () => {
        const user = await createTestUser(orm, 'owner@example.com', 'password123')
        const organization = await createTestOrganization(orm, 'Test Org', user)
        await createTestOrganizationMembership(orm, user, organization)
        const project = await createTestProject(orm, 'Test Project', organization, user)
        const token = generateAccessToken('owner@example.com')

        const createResponse = await request(app)
            .post('/api/public/memo-submissions')
            .query({ project_id: project.uuid })
            .send({
                title: 'Needs approval',
                content: 'Review this public memo submission.',
            })

        const submissionUuid = createResponse.body.submission_uuid
        expect(submissionUuid).toBeDefined()

        const approveResponse = await request(app)
            .post(`/api/v1/memo-submissions/${submissionUuid}/approve`)
            .set('Cookie', [`accessToken=${token}`])
            .query({ project_id: project.uuid })
            .send({ review_note: 'Approved in test' })

        expect(approveResponse.status).toBe(200)
        expect(approveResponse.body.memo_uuid).toBeDefined()

        const approvedListResponse = await request(app)
            .get('/api/public/memo-submissions')
            .query({ project_id: project.uuid, status: 'approved', page: 1, page_size: 10 })

        expect(approvedListResponse.status).toBe(200)
        expect(approvedListResponse.body.count).toBe(1)
        expect(approvedListResponse.body.results[0]).toMatchObject({
            uuid: submissionUuid,
            title: 'Needs approval',
            status: 'approved',
        })

        const detailResponse = await request(app)
            .get(`/api/v1/memo-submissions/${submissionUuid}`)
            .set('Cookie', [`accessToken=${token}`])
            .query({ project_id: project.uuid })

        expect(detailResponse.status).toBe(200)
        expect(detailResponse.body).toMatchObject({
            uuid: submissionUuid,
            title: 'Needs approval',
            status: 'approved',
            review_note: 'Approved in test',
        })
    })

    it('blocks approval when submission enrichment is incomplete', async () => {
        const user = await createTestUser(orm, 'owner@example.com', 'password123')
        const organization = await createTestOrganization(orm, 'Test Org', user)
        await createTestOrganizationMembership(orm, user, organization)
        const project = await createTestProject(orm, 'Test Project', organization, user)
        const token = generateAccessToken('owner@example.com')

        const em = orm.em.fork()
        const submission = em.create(MemoSubmission, {
            uuid: '11111111-1111-1111-1111-111111111111',
            project,
            title: 'Incomplete preview',
            content: 'No enrichment attached yet',
            status: 'pending',
            created_at: new Date(),
            updated_at: new Date(),
            summary: null,
            metadata: null,
            tags: null,
        })
        await em.persistAndFlush(submission)

        const approveResponse = await request(app)
            .post(`/api/v1/memo-submissions/${submission.uuid}/approve`)
            .set('Cookie', [`accessToken=${token}`])
            .query({ project_id: project.uuid })
            .send({ review_note: 'Approved in test' })

        expect(approveResponse.status).toBe(400)
        expect(approveResponse.body.error).toContain('summary')
    })

    it('regenerates preview enrichment for a pending submission', async () => {
        const user = await createTestUser(orm, 'owner@example.com', 'password123')
        const organization = await createTestOrganization(orm, 'Test Org', user)
        await createTestOrganizationMembership(orm, user, organization)
        const project = await createTestProject(orm, 'Test Project', organization, user)
        const token = generateAccessToken('owner@example.com')

        const em = orm.em.fork()
        const submission = em.create(MemoSubmission, {
            uuid: '22222222-2222-2222-2222-222222222222',
            project,
            title: 'Regenerate preview',
            content: 'Need regenerated preview',
            status: 'pending',
            created_at: new Date(),
            updated_at: new Date(),
            summary: null,
            metadata: null,
            tags: null,
        })
        await em.persistAndFlush(submission)

        const response = await request(app)
            .post(`/api/v1/memo-submissions/${submission.uuid}/regenerate-preview`)
            .set('Cookie', [`accessToken=${token}`])
            .query({ project_id: project.uuid })
            .send({})

        expect(response.status).toBe(200)
        expect(response.body.summary).toBe('Preview summary for approval.')
        expect(response.body.tags).toEqual(expect.arrayContaining(['submission', 'preview']))
        expect(response.body.metadata.search_aliases.length).toBeGreaterThan(0)
    })

    it('backfills preview enrichment for all pending submissions', async () => {
        const user = await createTestUser(orm, 'owner@example.com', 'password123')
        const organization = await createTestOrganization(orm, 'Test Org', user)
        await createTestOrganizationMembership(orm, user, organization)
        const project = await createTestProject(orm, 'Test Project', organization, user)
        const token = generateAccessToken('owner@example.com')

        const em = orm.em.fork()
        const first = em.create(MemoSubmission, {
            uuid: '33333333-3333-3333-3333-333333333333',
            project,
            title: 'First pending preview',
            content: 'Need first regenerated preview',
            status: 'pending',
            created_at: new Date(),
            updated_at: new Date(),
            summary: null,
            metadata: null,
            tags: null,
        })
        const second = em.create(MemoSubmission, {
            uuid: '44444444-4444-4444-4444-444444444444',
            project,
            title: 'Second pending preview',
            content: 'Need second regenerated preview',
            status: 'pending',
            created_at: new Date(),
            updated_at: new Date(),
            summary: null,
            metadata: null,
            tags: null,
        })
        await em.persistAndFlush([first, second])

        const response = await request(app)
            .post('/api/v1/memo-submissions/backfill-preview')
            .set('Cookie', [`accessToken=${token}`])
            .query({ project_id: project.uuid })
            .send({})

        expect(response.status).toBe(200)
        expect(response.body.updated_count).toBe(2)

        const refreshed = await orm.em.fork().find(MemoSubmission, { project, status: 'pending' })
        expect(refreshed.every((item) => item.summary === 'Preview summary for approval.')).toBe(true)
        expect(refreshed.every((item) => Array.isArray(item.tags) && item.tags.length > 0)).toBe(true)
    })
})
