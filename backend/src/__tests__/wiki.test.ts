import express, { Express } from 'express'
import request from 'supertest'
import { MikroORM, RequestContext } from '@mikro-orm/postgresql'
import cookieParser from 'cookie-parser'
import { wikiRouter } from '../api/wiki'
import { DI } from '../di'
import { createTestDatabase, clearDatabase, closeDatabase } from './testDb'
import {
    createTestOrganization,
    createTestOrganizationMembership,
    createTestProject,
    createTestUser,
} from './testHelpers'
import { generateAccessToken } from '../lib/tokenUtils'
import { userMiddleware } from '../middleware/userMiddleware'
import { User } from '../entities/User'
import { Project } from '../entities/Project'
import { Organization } from '../entities/Organization'
import { OrganizationMembership } from '../entities/OrganizationMembership'
import { WikiPage } from '../entities/WikiPage'
import { WikiPageRevision } from '../entities/WikiPageRevision'

jest.setTimeout(120000)

describe('Wiki API Tests', () => {
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
        DI.wikiPages = orm.em.getRepository(WikiPage)
        DI.wikiPageRevisions = orm.em.getRepository(WikiPageRevision)

        app = express()
        app.use(express.json())
        app.use(cookieParser())
        app.use((_req, _res, next) => RequestContext.create(orm.em, next))
        app.use(userMiddleware())
        app.use('/api/wiki', wikiRouter)
    })

    afterAll(async () => {
        if (orm) {
            await closeDatabase(orm)
        }
    })

    afterEach(async () => {
        if (orm) {
            await clearDatabase(orm)
        }
    })

    it('should create and fetch a wiki page', async () => {
        const user = await createTestUser(orm, 'wiki@example.com', 'password123')
        const org = await createTestOrganization(orm, 'Wiki Org', user)
        await createTestOrganizationMembership(orm, user, org)
        const project = await createTestProject(orm, 'Wiki Project', org, user)
        const token = generateAccessToken(user.email)

        const createResponse = await request(app)
            .post('/api/wiki')
            .set('Cookie', [`accessToken=${token}`])
            .query({ project_id: project.uuid })
            .send({
                title: 'Architecture Overview',
                slug: 'Architecture Overview',
                content: '# Overview\n\nInitial content',
                summary: 'Top-level summary',
                metadata: { source: 'rag-reference' },
                change_note: 'Initial import',
            })

        expect(createResponse.status).toBe(201)
        expect(createResponse.body.slug).toBe('architecture-overview')
        expect(createResponse.body.revision_count).toBe(1)

        const getResponse = await request(app)
            .get('/api/wiki/architecture-overview')
            .set('Cookie', [`accessToken=${token}`])
            .query({ project_id: project.uuid })

        expect(getResponse.status).toBe(200)
        expect(getResponse.body.title).toBe('Architecture Overview')
        expect(getResponse.body.summary).toBe('Top-level summary')
        expect(getResponse.body.metadata).toEqual({ source: 'rag-reference' })
    })

    it('should update a wiki page and append a revision', async () => {
        const user = await createTestUser(orm, 'wiki-update@example.com', 'password123')
        const org = await createTestOrganization(orm, 'Wiki Org', user)
        await createTestOrganizationMembership(orm, user, org)
        const project = await createTestProject(orm, 'Wiki Project', org, user)
        const token = generateAccessToken(user.email)

        await request(app)
            .post('/api/wiki')
            .set('Cookie', [`accessToken=${token}`])
            .query({ project_id: project.uuid })
            .send({
                title: 'Runbook',
                slug: 'runbook',
                content: 'v1',
            })

        const updateResponse = await request(app)
            .patch('/api/wiki/runbook')
            .set('Cookie', [`accessToken=${token}`])
            .query({ project_id: project.uuid })
            .send({
                content: 'v2',
                summary: 'Updated summary',
                change_note: 'Expanded remediation steps',
            })

        expect(updateResponse.status).toBe(200)
        expect(updateResponse.body.content).toBe('v2')
        expect(updateResponse.body.revision_count).toBe(2)

        const revisionsResponse = await request(app)
            .get('/api/wiki/runbook/revisions')
            .set('Cookie', [`accessToken=${token}`])
            .query({ project_id: project.uuid })

        expect(revisionsResponse.status).toBe(200)
        expect(revisionsResponse.body).toHaveLength(2)
        expect(revisionsResponse.body[0].version).toBe(2)
        expect(revisionsResponse.body[0].change_note).toBe('Expanded remediation steps')
        expect(revisionsResponse.body[0].content).toBe('v2')
        expect(revisionsResponse.body[1].version).toBe(1)
        expect(revisionsResponse.body[1].content).toBe('v1')
    })

    it('should list wiki pages for a project', async () => {
        const user = await createTestUser(orm, 'wiki-list@example.com', 'password123')
        const org = await createTestOrganization(orm, 'Wiki Org', user)
        await createTestOrganizationMembership(orm, user, org)
        const project = await createTestProject(orm, 'Wiki Project', org, user)
        const token = generateAccessToken(user.email)

        await request(app)
            .post('/api/wiki')
            .set('Cookie', [`accessToken=${token}`])
            .query({ project_id: project.uuid })
            .send({ title: 'First Page', slug: 'first-page', content: 'content-1' })

        await request(app)
            .post('/api/wiki')
            .set('Cookie', [`accessToken=${token}`])
            .query({ project_id: project.uuid })
            .send({ title: 'Second Page', slug: 'second-page', content: 'content-2' })

        const listResponse = await request(app)
            .get('/api/wiki')
            .set('Cookie', [`accessToken=${token}`])
            .query({ project_id: project.uuid })

        expect(listResponse.status).toBe(200)
        expect(listResponse.body).toHaveLength(2)
        expect(listResponse.body.map((page: { slug: string }) => page.slug).sort()).toEqual([
            'first-page',
            'second-page',
        ])
    })

    it('should require authentication', async () => {
        const response = await request(app)
            .get('/api/wiki')
            .query({ project_id: 'f5be8af9-7af9-4b85-88f1-0fd3be8f9a3b' })
        expect(response.status).toBe(403)
    })

    it('should require project_id', async () => {
        const user = await createTestUser(orm, 'wiki-project@example.com', 'password123')
        const token = generateAccessToken(user.email)

        const response = await request(app)
            .get('/api/wiki')
            .set('Cookie', [`accessToken=${token}`])
        expect(response.status).toBe(400)
        expect(response.body.error).toBe('Project ID is required')
    })
})
