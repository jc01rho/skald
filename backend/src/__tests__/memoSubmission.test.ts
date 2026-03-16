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
            summary: null,
        })
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
})
