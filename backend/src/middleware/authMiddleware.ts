import { Request, Response, NextFunction } from 'express'

import { DI } from '@/di'
import type { User } from '@/entities/User'
import type { Organization } from '@/entities/Organization'
import type { Project } from '@/entities/Project'
import { SpecPromotionStatus } from '@/entities/SpecPromotionState'


export const PROJECT_SCOPE_MISMATCH = 'PROJECT_SCOPE_MISMATCH'
export const SPEC_SCOPE_NOT_PROMOTED = 'SPEC_SCOPE_NOT_PROMOTED'
export const SPEC_SCOPE_MISMATCH = 'SPEC_SCOPE_MISMATCH'
export class ProjectAuthorizationError extends Error {
    constructor(
        public readonly status: number,
        public readonly code: string,
        message: string
    ) {
        super(message)
        this.name = 'ProjectAuthorizationError'
    }
}

export const requireAuth = () => {
    return async (req: Request, res: Response, next: NextFunction) => {
        if (!req.context || !req.context.requestUser || req.context.requestUser.userType === 'unauthenticatedUser') {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        return next()
    }
}

export const requireSuperuser = () => {
    return async (req: Request, res: Response, next: NextFunction) => {
        if (!req.context || !req.context.requestUser || req.context.requestUser.userType === 'unauthenticatedUser') {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const user = req.context.requestUser.userInstance
        if (!user || !user.is_superuser) {
            return res.status(403).json({ error: 'Forbidden' })
        }

        return next()
    }
}

export const isUserOrgMember = async (user: User, organization: Organization): Promise<boolean> => {
    return (await DI.organizationMemberships.findOne({ user, organization })) !== null
}

export const resolveEffectiveProject = async (req: Request, suppliedProjectId?: string): Promise<Project> => {
    const requestUser = req.context?.requestUser
    if (!requestUser || requestUser.userType === 'unauthenticatedUser') {
        throw new ProjectAuthorizationError(401, 'UNAUTHORIZED', 'Unauthorized')
    }

    if (requestUser.userType === 'projectAPIKeyUser') {
        const project = requestUser.project
        if (!project) {
            throw new ProjectAuthorizationError(403, 'FORBIDDEN', 'Forbidden')
        }
        if (suppliedProjectId && suppliedProjectId !== project.uuid) {
            throw new ProjectAuthorizationError(403, PROJECT_SCOPE_MISMATCH, 'Project scope mismatch')
        }
        return project
    }

    if (!requestUser.userInstance) {
        throw new ProjectAuthorizationError(403, 'FORBIDDEN', 'Forbidden')
    }
    if (!suppliedProjectId) {
        throw new ProjectAuthorizationError(400, 'PROJECT_ID_REQUIRED', 'Project ID is required')
    }

    const project = await DI.projects.findOne({ uuid: suppliedProjectId }, { populate: ['organization'] })
    if (!project) {
        throw new ProjectAuthorizationError(404, 'PROJECT_NOT_FOUND', 'Project not found')
    }
    if (!(await isUserOrgMember(requestUser.userInstance, project.organization))) {
        throw new ProjectAuthorizationError(403, 'FORBIDDEN', 'Forbidden')
    }

    return project
}

export const requireEffectiveProject = () => {
    return async (req: Request, res: Response, next: NextFunction) => {
        const headerProjectId = typeof req.header === 'function'
            ? req.header('x-project-id')
            : (req.headers?.['x-project-id'] as string | undefined)
        const candidates = [
            req.body?.project_id,
            req.body?.projectId,
            req.query?.project_id,
            req.query?.projectId,
            req.params?.project_id,
            req.params?.projectId,
            headerProjectId,
        ].filter((projectId): projectId is string => typeof projectId === 'string')
        const suppliedProjectIds = [...new Set(candidates)]
        const apiKeyProject = req.context?.requestUser?.userType === 'projectAPIKeyUser'
            ? req.context.requestUser.project
            : null
        const suppliedProjectId =
            suppliedProjectIds.find((projectId) => apiKeyProject && projectId !== apiKeyProject.uuid) ??
            suppliedProjectIds[0]
        if (suppliedProjectIds.some((projectId) => projectId !== suppliedProjectId)) {
            return res.status(403).json({ error: 'Project scope mismatch', code: 'PROJECT_SCOPE_MISMATCH' })
        }

        try {
            const project = await resolveEffectiveProject(req, suppliedProjectId)
            req.context!.requestUser!.project = project
            req.context!.project = project
            return next()
        } catch (error) {
            if (error instanceof ProjectAuthorizationError) {
                return res.status(error.status).json({ error: error.message, code: error.code })
            }
            return next(error)
        }
    }
}

export const requirePromotedSpecScope = (defaultScopeKey = 'spms:all') => {
    return async (req: Request, res: Response, next: NextFunction) => {
        try {
            const project = req.context?.project || await resolveEffectiveProject(req)
            const headerScopeKey = typeof req.header === 'function'
                ? req.header('x-spec-scope-key')
                : (req.headers?.['x-spec-scope-key'] as string | undefined)
            const candidates = [
                req.body?.scope_key,
                req.body?.scopeKey,
                req.query?.scope_key,
                req.query?.scopeKey,
                req.params?.scope_key,
                req.params?.scopeKey,
                headerScopeKey,
            ].filter((scopeKey): scopeKey is string => typeof scopeKey === 'string')
            const scopeKeys = [...new Set(candidates)]
            if (scopeKeys.length > 1) {
                return res.status(403).json({ error: 'Spec scope mismatch', code: SPEC_SCOPE_MISMATCH })
            }
            const scopeKey = scopeKeys[0] || defaultScopeKey
            const promotion = await DI.specPromotionStates.findOne({
                project,
                scope_key: scopeKey,
                state: SpecPromotionStatus.PROMOTED,
            })
            if (!promotion) {
                return res.status(409).json({ error: 'Spec scope is not promoted', code: SPEC_SCOPE_NOT_PROMOTED })
            }
            return next()
        } catch (error) {
            if (error instanceof ProjectAuthorizationError) {
                return res.status(error.status).json({ error: error.message, code: error.code })
            }
            return next(error)
        }
    }
}

export const requireProjectAccess = () => requireEffectiveProject()
