import express, { Express } from 'express'
import request from 'supertest'
import { specRevisionRouter } from '@/api/specRevision'
import { DI } from '@/di'
import { SpecPromotionStatus } from '@/entities/SpecPromotionState'
import { requireEffectiveProject } from '@/middleware/authMiddleware'
import { SpecRevisionService } from '@/services/specRevisionService'
const project = { uuid: '00000000-0000-4000-8000-000000000001' } as any

function app(): Express {
    const application = express()
    application.use(express.json())
    application.use((req, _res, next) => {
        ;(req as any).context = {
            requestUser: { userType: 'projectAPIKeyUser', project },
            project,
        }
        next()
    })
    application.use(requireEffectiveProject())

    application.use(specRevisionRouter)

    return application
}

describe('spec capability promotion gate', () => {
    afterEach(() => jest.restoreAllMocks())

    it('keeps exact, relation and traversal surfaces on while the scope is not promoted, and the quality surfaces off', async () => {
        const findOne = jest.fn().mockResolvedValue(null)
        DI.specPromotionStates = { findOne } as any

        const response = await request(app()).get('/spec-capabilities')

        expect(response.status).toBe(200)
        expect(findOne).toHaveBeenCalledWith({
            project,
            scope_key: 'spms:all',
            state: SpecPromotionStatus.PROMOTED,
        })
        expect(response.body).toEqual(expect.objectContaining({
            scope_key: 'spms:all',
            native: true,
            exact: true,
            outgoing: true,
            incoming: true,
            related: false,
            conflict_candidates: false,
            traversal: expect.objectContaining({ supported: true, snapshot_cursor: true }),
        }))
    })

    it('advertises only implemented promoted surfaces for the explicitly promoted scope', async () => {
        const findOne = jest.fn().mockResolvedValue({ state: SpecPromotionStatus.PROMOTED })
        DI.specPromotionStates = { findOne } as any

        const response = await request(app()).get('/spec-capabilities').query({ scope_key: 'github:specs' })

        expect(response.status).toBe(200)
        expect(findOne).toHaveBeenCalledWith({
            project,
            scope_key: 'github:specs',
            state: SpecPromotionStatus.PROMOTED,
        })
        expect(response.body).toEqual(expect.objectContaining({
            scope_key: 'github:specs',
            native: true,
            exact: true,
            outgoing: true,
            incoming: true,
            related: false,
            conflict_candidates: false,
            traversal: {
                supported: true,
                max_depth: 5,
                max_nodes: 500,
                snapshot_cursor: true,
                max_page_size: 100,
                snapshot_ttl_seconds: 900,
            },
        }))
    })

    it.each([
        ['get', '/specs/exact?locator=spec:one', undefined, 'exact', {}],
        ['get', '/specs/outgoing?locator=spec:one', undefined, 'relations', []],
        ['get', '/specs/incoming?locator=spec:one', undefined, 'relations', []],
        ['post', '/specs/traverse', { locator: 'spec:one' }, 'traverse', { nodes: [] }],
    ] as const)('serves %s %s before promotion', async (method, path, body, service, result) => {
        const findOne = jest.fn().mockResolvedValue(null)
        DI.specPromotionStates = { findOne } as any
        jest.spyOn(SpecRevisionService.prototype, service as any).mockResolvedValue(result as never)

        const pending = request(app())[method](path).set('Authorization', 'Bearer test-key')
        const response = body ? await pending.send(body) : await pending

        expect(response.status).toBe(200)
        expect(findOne).not.toHaveBeenCalled()
    })

    it.each([
        ['post', '/specs/related', { locators: ['spec:one'] }],
        ['post', '/specs/conflict-candidates', { locators: ['spec:one'] }],
    ] as const)('rejects %s %s directly before promotion', async (method, path, body) => {
        DI.specPromotionStates = { findOne: jest.fn().mockResolvedValue(null) } as any

        const response = await request(app())[method](path).send(body)

        expect(response.status).toBe(409)
        expect(response.body).toEqual({ error: 'Spec scope is not promoted', code: 'SPEC_SCOPE_NOT_PROMOTED' })
    })

    it('rejects conflicting scope aliases and headers before consulting promotion state', async () => {
        const findOne = jest.fn()
        DI.specPromotionStates = { findOne } as any

        const response = await request(app())
            .get('/specs/exact')
            .query({ locator: 'spec:one', scope_key: 'github:specs', scopeKey: 'notion:specs' })
            .set('x-spec-scope-key', 'header:specs')

        expect(response.status).toBe(403)
        expect(response.body).toEqual({ error: 'Spec scope mismatch', code: 'SPEC_SCOPE_MISMATCH' })
        expect(findOne).not.toHaveBeenCalled()
    })

    it('rejects conflicting project identifier aliases and headers at the router mount', async () => {
        const findOne = jest.fn()
        DI.specPromotionStates = { findOne } as any

        const response = await request(app())
            .get('/specs/exact')
            .query({ locator: 'spec:one', project_id: project.uuid, projectId: '00000000-0000-4000-8000-000000000002' })
            .set('x-project-id', '00000000-0000-4000-8000-000000000003')

        expect(response.status).toBe(403)
        expect(response.body).toEqual({ error: 'Project scope mismatch', code: 'PROJECT_SCOPE_MISMATCH' })
        expect(findOne).not.toHaveBeenCalled()
    })
})
