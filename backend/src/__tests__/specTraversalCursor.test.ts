import {
    decodeSpecTraversalCursor,
    encodeSpecTraversalCursor,
    SpecRevisionError,
    specTraversalFilterHash,
    SpecTraversalCursorKeyring,
    SpecTraversalCursorPayload,
} from '@/services/specRevisionService'

const keyring: SpecTraversalCursorKeyring = {
    activeKeyId: 'current',
    keys: { current: 'cursor-secret', previous: 'previous-secret' },
}
const now = new Date('2026-07-30T12:00:00.000Z')
const projectId = '11111111-1111-4111-8111-111111111111'
const filterHash = specTraversalFilterHash('SPEC-1', 3, 100)
const authScopeHash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const payload: SpecTraversalCursorPayload = {
    version: 1,
    key_id: 'current',
    project_id: projectId,
    auth_scope_hash: authScopeHash,
    filter_hash: filterHash,
    snapshot_id: '22222222-2222-4222-8222-222222222222',
    offset: 100,
    expires_at: now.getTime() + 15 * 60 * 1000,
}

function expectCursorError(action: () => unknown, code: string) {
    try {
        action()
        throw new Error('Expected cursor rejection')
    } catch (error) {
        expect(error).toBeInstanceOf(SpecRevisionError)
        expect((error as SpecRevisionError).code).toBe(code)
    }
}

describe('spec traversal cursor', () => {
    it('round-trips the signed opaque cursor', () => {
        const cursor = encodeSpecTraversalCursor(payload, keyring)
        expect(cursor).not.toContain(projectId)
        expect(decodeSpecTraversalCursor(cursor, keyring, projectId, filterHash, authScopeHash, now)).toEqual(payload)
    })

    it('rejects payload and signature tampering', () => {
        const cursor = encodeSpecTraversalCursor(payload, keyring)
        const [body, signature] = cursor.split('.')
        const tamperedPayload = `${body.slice(0, -1)}${body.endsWith('A') ? 'B' : 'A'}.${signature}`
        const tamperedSignature = `${body}.${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`
        expectCursorError(() => decodeSpecTraversalCursor(tamperedPayload, keyring, projectId, filterHash, authScopeHash, now), 'INVALID_TRAVERSAL_CURSOR')
        expectCursorError(() => decodeSpecTraversalCursor(tamperedSignature, keyring, projectId, filterHash, authScopeHash, now), 'INVALID_TRAVERSAL_CURSOR')
    })

    it('rejects another project or traversal filter', () => {
        const cursor = encodeSpecTraversalCursor(payload, keyring)
        expectCursorError(
            () => decodeSpecTraversalCursor(cursor, keyring, '33333333-3333-4333-8333-333333333333', filterHash, authScopeHash, now),
            'TRAVERSAL_CURSOR_PROJECT_MISMATCH'
        )
        expectCursorError(
            () => decodeSpecTraversalCursor(cursor, keyring, projectId, specTraversalFilterHash('SPEC-1', 4, 100), authScopeHash, now),
            'TRAVERSAL_CURSOR_FILTER_MISMATCH'
        )
    })

    it('rejects replay by another authenticated principal scope', () => {
        const cursor = encodeSpecTraversalCursor(payload, keyring)
        expectCursorError(
            () => decodeSpecTraversalCursor(
                cursor,
                keyring,
                projectId,
                filterHash,
                'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                now
            ),
            'TRAVERSAL_CURSOR_AUTH_SCOPE_MISMATCH'
        )
    })

    it('rejects expiry and accepts a retained signing key', () => {
        const previousPayload = { ...payload, key_id: 'previous' }
        const cursor = encodeSpecTraversalCursor(previousPayload, keyring)
        expect(decodeSpecTraversalCursor(cursor, keyring, projectId, filterHash, authScopeHash, now)).toEqual(previousPayload)
        expectCursorError(
            () => decodeSpecTraversalCursor(cursor, keyring, projectId, filterHash, authScopeHash, new Date(payload.expires_at)),
            'TRAVERSAL_CURSOR_EXPIRED'
        )
    })

    it('keeps discovery and snapshot persistence in one repeatable-read transaction', () => {
        const source = require('fs').readFileSync(require.resolve('@/services/specRevisionService'), 'utf8')
        const traversal = source.slice(source.indexOf('async traverse('), source.indexOf('async conflictCandidates('))
        expect(traversal).toContain('isolationLevel: IsolationLevel.REPEATABLE_READ')
        expect(traversal.indexOf('transactional(async (em)')).toBeLessThan(traversal.indexOf('this.exact(project, request.locator, em)'))
        expect(traversal).toContain("this.relations(project, node.spec_id, 'outgoing', em)")
        expect(traversal).toContain('this.exact(project, edge.target_key, em)')
        expect(traversal.indexOf('em.create(SpecTraversalSnapshot')).toBeGreaterThan(traversal.indexOf('this.exact(project, request.locator, em)'))
    })
})
