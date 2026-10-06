import express, { Request, Response } from 'express'
import { z } from 'zod'
import { DI } from '@/di'
import { Project } from '@/entities/Project'
import { SPEC_ANNOTATION_KINDS } from '@/entities/SpecAnnotation'
import { SpecAnnotationError, SpecAnnotationService } from '@/services/specAnnotationService'

const OptionalText = z
    .string()
    .max(2000)
    .optional()
    .nullable()
    .transform((value) => (value === undefined ? undefined : value && value.trim() ? value.trim() : null))
const Fields = z.object({
    kind: z.enum(SPEC_ANNOTATION_KINDS),
    body: z.string().trim().min(1, 'body is required').max(20000),
    condition: OptionalText,
    effect: OptionalText,
    applies_to: OptionalText,
})
const ListQuery = z.object({ memo_uuid: z.string().uuid() })
const CreateRequest = Fields.extend({ memo_uuid: z.string().uuid() })
const VersionedRequest = z.object({ version: z.number().int().min(1) })
const DeleteQuery = z.object({ version: z.coerce.number().int().min(1) })
const UpdateRequest = Fields.partial().extend({ version: z.number().int().min(1) })
const IdParam = z.object({ id: z.string().uuid() })

function validationError(res: Response, error: z.ZodError) {
    const detail = error.issues.map((issue) => `${issue.path.join('.') || 'request'}: ${issue.message}`).join(', ')
    return res.status(400).json({ error: `Request validation failed: ${detail}`, code: 'INVALID_REQUEST', issues: error.issues })
}

function sendError(res: Response, error: unknown) {
    if (error instanceof SpecAnnotationError) {
        return res.status(error.status).json({ error: error.message, code: error.code })
    }
    throw error
}

function actorOf(req: Request): string | null {
    const requestUser = req.context?.requestUser
    if (requestUser?.userType === 'authenticatedUser' && requestUser.userInstance) return requestUser.userInstance.email
    if (requestUser?.userType === 'projectAPIKeyUser') return 'project-api-key'
    return null
}

const service = () => new SpecAnnotationService(DI.em)
const projectOf = (req: Request) => req.context?.requestUser?.project as Project

export const specAnnotationRouter = express.Router({ mergeParams: true })

specAnnotationRouter.get('/', async (req, res) => {
    const parsed = ListQuery.safeParse(req.query)
    if (!parsed.success) return validationError(res, parsed.error)
    try {
        return res.json(await service().list(projectOf(req), parsed.data.memo_uuid))
    } catch (error) {
        return sendError(res, error)
    }
})

specAnnotationRouter.post('/', async (req, res) => {
    const parsed = CreateRequest.safeParse(req.body)
    if (!parsed.success) return validationError(res, parsed.error)
    const { memo_uuid, ...fields } = parsed.data
    try {
        return res.status(201).json(await service().create(projectOf(req), memo_uuid, fields, actorOf(req)))
    } catch (error) {
        return sendError(res, error)
    }
})

specAnnotationRouter.patch('/:id', async (req, res) => {
    const params = IdParam.safeParse(req.params)
    if (!params.success) return validationError(res, params.error)
    const parsed = UpdateRequest.safeParse(req.body)
    if (!parsed.success) return validationError(res, parsed.error)
    const { version, ...fields } = parsed.data
    try {
        return res.json(await service().update(projectOf(req), params.data.id, version, fields, actorOf(req)))
    } catch (error) {
        return sendError(res, error)
    }
})

specAnnotationRouter.post('/:id/confirm', async (req, res) => {
    const params = IdParam.safeParse(req.params)
    if (!params.success) return validationError(res, params.error)
    const parsed = VersionedRequest.safeParse(req.body)
    if (!parsed.success) return validationError(res, parsed.error)
    try {
        return res.json(await service().confirm(projectOf(req), params.data.id, parsed.data.version, actorOf(req)))
    } catch (error) {
        return sendError(res, error)
    }
})

specAnnotationRouter.delete('/:id', async (req, res) => {
    const params = IdParam.safeParse(req.params)
    if (!params.success) return validationError(res, params.error)
    const parsed = DeleteQuery.safeParse(req.query)
    if (!parsed.success) return validationError(res, parsed.error)
    try {
        await service().delete(projectOf(req), params.data.id, parsed.data.version)
        return res.status(204).send()
    } catch (error) {
        return sendError(res, error)
    }
})
