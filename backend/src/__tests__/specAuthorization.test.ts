import { Request } from 'express'

import { DI } from '../di'
import type { Project } from '../entities/Project'
import {
    PROJECT_SCOPE_MISMATCH,
    requireEffectiveProject,
    requireProjectAccess,
    resolveEffectiveProject,
} from '../middleware/authMiddleware'
import { RequestUser } from '../middleware/requestUser'

const project = (uuid: string): Project =>
    ({ uuid, organization: { uuid: `org-${uuid}` } }) as Project

const request = (requestUser: RequestUser, suppliedProjectId?: string): Request =>
    ({
        body: suppliedProjectId ? { project_id: suppliedProjectId } : {},
        query: {},
        context: { requestUser },
    }) as Request

describe('effective project authorization', () => {
    afterEach(() => {
        jest.restoreAllMocks()
    })

    it('uses the API key project when no project ID is supplied', async () => {
        const boundProject = project('key-project')
        const req = request(new RequestUser(null, 'projectAPIKeyUser', boundProject))

        await expect(resolveEffectiveProject(req)).resolves.toBe(boundProject)
    })

    it('rejects an API key request that supplies another project ID', async () => {
        const req = request(new RequestUser(null, 'projectAPIKeyUser', project('key-project')), 'other-project')

        await expect(resolveEffectiveProject(req, 'other-project')).rejects.toMatchObject({
            status: 403,
            code: PROJECT_SCOPE_MISMATCH,
        })
    })

    it('maps project scope mismatches to a stable HTTP error and does not continue', async () => {
        const req = request(new RequestUser(null, 'projectAPIKeyUser', project('key-project')), 'other-project')
        const json = jest.fn()
        const status = jest.fn(() => ({ json }))
        const next = jest.fn()

        await requireEffectiveProject()(req, { status } as any, next)

        expect(status).toHaveBeenCalledWith(403)
        expect(json).toHaveBeenCalledWith({ error: 'Project scope mismatch', code: PROJECT_SCOPE_MISMATCH })
        expect(next).not.toHaveBeenCalled()
        expect(req.context?.requestUser?.project?.uuid).toBe('key-project')
    })

    it('rejects a mismatch in either body or query instead of trusting the first project ID', async () => {
        const req = request(new RequestUser(null, 'projectAPIKeyUser', project('key-project')), 'key-project')
        req.query.project_id = 'other-project'
        const json = jest.fn()
        const status = jest.fn(() => ({ json }))
        const next = jest.fn()

        await requireEffectiveProject()(req, { status } as any, next)

        expect(json).toHaveBeenCalledWith({ error: 'Project scope mismatch', code: PROJECT_SCOPE_MISMATCH })
        expect(next).not.toHaveBeenCalled()
    })

    it('binds the effective API key project in both shared contexts', async () => {
        const boundProject = project('key-project')
        const req = request(new RequestUser(null, 'projectAPIKeyUser', boundProject))
        const next = jest.fn()

        await requireEffectiveProject()(req, {} as any, next)

        expect(req.context?.project).toBe(boundProject)
        expect(req.context?.requestUser?.project).toBe(boundProject)
        expect(next).toHaveBeenCalledTimes(1)
    })

    it('keeps requireProjectAccess as a compatible middleware wrapper', async () => {
        const boundProject = project('key-project')
        const req = request(new RequestUser(null, 'projectAPIKeyUser', boundProject))
        const next = jest.fn()

        await requireProjectAccess()(req, {} as any, next)

        expect(req.context?.project).toBe(boundProject)
        expect(next).toHaveBeenCalledTimes(1)
    })

    it('retains membership checks for authenticated users', async () => {
        const requestedProject = project('requested-project')
        const user = { uuid: 'user' } as any
        const findProject = jest.fn().mockResolvedValue(requestedProject)
        const findMembership = jest.fn().mockResolvedValue(null)
        const previousProjects = DI.projects
        const previousMemberships = DI.organizationMemberships
        DI.projects = { findOne: findProject } as any
        DI.organizationMemberships = { findOne: findMembership } as any
        const req = request(new RequestUser(user, 'authenticatedUser', null), requestedProject.uuid)

        try {
            await expect(resolveEffectiveProject(req, requestedProject.uuid)).rejects.toEqual(
                expect.objectContaining({ status: 403, code: 'FORBIDDEN' })
            )
            expect(findProject).toHaveBeenCalledWith(
                { uuid: requestedProject.uuid },
                { populate: ['organization'] }
            )
            expect(findMembership).toHaveBeenCalledWith({ user, organization: requestedProject.organization })
        } finally {
            DI.projects = previousProjects
            DI.organizationMemberships = previousMemberships
        }
    })
})
