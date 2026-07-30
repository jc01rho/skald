import { deleteMemo, getMemo, updateMemo } from '@/api/memo'
import { DI } from '@/di'
import { sha256 } from '@/lib/hashUtils'

const project = { uuid: '00000000-0000-4000-8000-000000000001' } as any
const memo = {
    uuid: '00000000-0000-4000-8000-000000000002',
    title: 'Canonical spec',
    metadata: {},
    content_hash: sha256('published content'),
    processing_status: 'processed',
    project,
} as any

function request(method: 'GET' | 'PATCH' | 'DELETE', query: Record<string, string> = {}, body: unknown = {}) {
    return {
        method,
        params: { id: memo.uuid },
        query,
        body,
        context: { requestUser: { project } },
    } as any
}

function response() {
    const res: any = {}
    res.status = jest.fn(() => res)
    res.json = jest.fn(() => res)
    res.send = jest.fn(() => res)
    return res
}

function installRepositories(options: {
    activeRevisionId?: string | null
    projectionRevisionId?: string
    revisionContentHash?: string
    projectionContentHash?: string
    memoContent?: string | null
}) {
    const revisionId = options.activeRevisionId === undefined
        ? '00000000-0000-4000-8000-000000000003'
        : options.activeRevisionId
    DI.memos = { findOne: jest.fn().mockResolvedValue(memo) } as any
    DI.memoContents = {
        findOne: jest.fn().mockResolvedValue(options.memoContent === null ? null : { content: options.memoContent || 'published content' }),
    } as any
    DI.memoSummaries = { findOne: jest.fn().mockResolvedValue(null) } as any
    DI.memoTags = { find: jest.fn().mockResolvedValue([]) } as any
    DI.memoChunks = { find: jest.fn().mockResolvedValue([]) } as any
    DI.em = {
        getConnection: jest.fn().mockReturnValue({
            execute: jest.fn().mockResolvedValue([{
                active_revision_id: revisionId,
                memo_projection_revision_id: options.projectionRevisionId || revisionId,
                memo_projection_canonical_hash: options.projectionContentHash || sha256('published content'),
                revision_content_hash: revisionId ? (options.revisionContentHash || sha256('published content')) : null,
            }]),
        }),
    } as any
}

function installLegacyRepositories() {
    installRepositories({})
    ;(DI.em.getConnection().execute as jest.Mock).mockResolvedValue([])
}

describe('canonical exact memo reads', () => {
    afterEach(() => jest.restoreAllMocks())

    it('rejects a requested revision that is not the active canonical revision', async () => {
        installRepositories({})
        const res = response()

        await getMemo(request('GET', { required_revision_id: '00000000-0000-4000-8000-000000000004' }), res)

        expect(res.status).toHaveBeenCalledWith(409)
        expect(res.json).toHaveBeenCalledWith({
            error: {
                code: 'MEMO_REVISION_MISMATCH',
                message: 'Canonical memo revision does not match published content',
            },
        })
    })

    it('rejects mixed memo content even when the requested revision is active', async () => {
        const revisionId = '00000000-0000-4000-8000-000000000003'
        installRepositories({ activeRevisionId: revisionId, memoContent: 'stale content' })
        const res = response()

        await getMemo(request('GET', { required_revision_id: revisionId }), res)

        expect(res.status).toHaveBeenCalledWith(409)
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            error: expect.objectContaining({ code: 'MEMO_REVISION_MISMATCH' }),
        }))
    })

    it('fails closed while the canonical projection has no active revision', async () => {
        installRepositories({ activeRevisionId: null })
        const res = response()

        await getMemo(request('GET'), res)

        expect(res.status).toHaveBeenCalledWith(409)
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            error: expect.objectContaining({ code: 'SPEC_PROCESSING' }),
        }))
    })
})

describe('legacy memo compatibility', () => {
    afterEach(() => jest.restoreAllMocks())

    it('returns legacy memos when no canonical projection exists', async () => {
        installLegacyRepositories()
        const res = response()

        await getMemo(request('GET'), res)

        expect(res.status).toHaveBeenCalledWith(200)
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ uuid: memo.uuid, content: 'published content' }))
    })
})

describe('canonical memo legacy mutation guard', () => {
    afterEach(() => jest.restoreAllMocks())

    it.each([
        ['PATCH', updateMemo, { title: 'mutated' }],
        ['DELETE', deleteMemo, {}],
    ] as const)('blocks %s and requires stage-and-publish', async (method, handler, body) => {
        installRepositories({})
        const res = response()

        await handler(request(method, {}, body), res)

        expect(res.status).toHaveBeenCalledWith(409)
        expect(res.json).toHaveBeenCalledWith({
            error: {
                code: 'CANONICAL_MEMO_MUTATION_FORBIDDEN',
                message: 'Canonical spec memos must be changed through stage-and-publish',
            },
        })
    })
})
