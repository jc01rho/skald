import { createHash, createHmac, randomUUID, timingSafeEqual } from 'crypto'
import { IsolationLevel, TransactionPropagation } from '@mikro-orm/core'
import { EntityManager } from '@mikro-orm/postgresql'
import { Memo } from '@/entities/Memo'
import { MemoContent } from '@/entities/MemoContent'
import { Project } from '@/entities/Project'
import { SECRET_KEY } from '@/settings'
import { SpecClaim } from '@/entities/SpecClaim'
import { SpecRelation } from '@/entities/SpecRelation'
import { SpecRevision } from '@/entities/SpecRevision'
import { SpecSource } from '@/entities/SpecSource'
import { SpecTraversalSnapshot } from '@/entities/SpecTraversalSnapshot'
import { SpecTraversalSnapshotItem } from '@/entities/SpecTraversalSnapshotItem'

export interface SpecTargetInput {
    source_system: string
    source_type: string
    immutable_source_id: string
    source_key: string
    title: string
    code: string | null
    source_url: string | null
}

export interface SpecRelationInput {
    relation_type: string
    target: SpecTargetInput
    source_relation_id: string | null
    provenance: string
    evidence: { path: string; label: string }
    properties: string[]
}

export interface SpecClaimInput {
    subject: string
    predicate: string
    value: unknown
    unit: string | null
    condition: string | null
    object: string | null
    evidence: { path: string; excerpt: string; hash: string }
    rule_version: string
}

export interface StageAndPublishInput {
    project_id?: string
    idempotency_key: string
    source: {
        source_key: string
        source_system: string
        source_type: string
        immutable_source_id: string
        title: string
        code: string | null
        source_url: string | null
        status: string | null
        aliases: string[]
    }
    revision: {
        source_revision: string
        source_updated_at: string | null
        parser_version: string
        extractor_version: string
        schema_version: string
        canonical_payload: Record<string, unknown>
        source_payload_hash: string
        content_hash: string
        metadata_hash: string
        relation_hash: string
        claim_hash: string
        relation_input_hash: string
    }
    memo: {
        memo_uuid: string | null
        client_reference_id: string
        title: string
        content: string
        metadata: Record<string, unknown>
        source: string
    }
    relations: SpecRelationInput[]
    claims: SpecClaimInput[]
    expected_relation_count: number
    expected_relation_hash: string
    expected_claim_count: number
    expected_claim_hash: string
}

export interface SpecTraversalRequest {
    locator: string
    max_depth: number
    max_nodes: number
    page_size?: number
    cursor?: string | null
    auth_scope_hash: string
}

export interface SpecTraversalCursorPayload {
    version: 1
    key_id: string
    project_id: string
    auth_scope_hash: string
    filter_hash: string
    snapshot_id: string
    offset: number
    expires_at: number
}

export interface SpecTraversalCursorKeyring {
    activeKeyId: string
    keys: Readonly<Record<string, string>>
}

export interface SpecRevisionServiceOptions {
    cursorKeyring?: SpecTraversalCursorKeyring
    now?: () => Date
}

export class SpecRevisionError extends Error {
    constructor(
        public readonly code: string,
        message: string,
        public readonly status: number
    ) {
        super(message)
    }
}

const compareUnicode = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0)

export function canonicalJson(value: unknown): string {
    if (value === null) return 'null'
    if (typeof value === 'string') return JSON.stringify(value)
    if (typeof value === 'boolean') return value ? 'true' : 'false'
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new SpecRevisionError('INVALID_CANONICAL_JSON', 'Non-finite JSON number', 400)
        return JSON.stringify(value)
    }
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
    if (typeof value === 'object') {
        const record = value as Record<string, unknown>
        return `{${Object.keys(record)
            .sort(compareUnicode)
            .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
            .join(',')}}`
    }
    throw new SpecRevisionError('INVALID_CANONICAL_JSON', 'Value is not JSON compatible', 400)
}

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
const sha256Json = (value: unknown) => sha256(canonicalJson(value))

const TRAVERSAL_TTL_MS = 15 * 60 * 1000
const TRAVERSAL_MAX_PAGE_SIZE = 100
const TRAVERSAL_MAX_NODES = 500
const TRAVERSAL_MAX_DEPTH = 5

function defaultCursorKeyring(): SpecTraversalCursorKeyring {
    const activeKeyId = process.env.SPEC_TRAVERSAL_CURSOR_KEY_ID || 'v1'
    const configuredKeys = process.env.SPEC_TRAVERSAL_CURSOR_KEYS
    if (configuredKeys) {
        try {
            const keys = JSON.parse(configuredKeys) as Record<string, unknown>
            if (typeof keys[activeKeyId] === 'string' && keys[activeKeyId]) {
                return { activeKeyId, keys: keys as Record<string, string> }
            }
        } catch {
            // Fall through to the single-key configuration.
        }
    }
    return {
        activeKeyId,
        keys: { [activeKeyId]: process.env.SPEC_TRAVERSAL_CURSOR_SECRET || SECRET_KEY },
    }
}

export function specTraversalFilterHash(locator: string, maxDepth: number, maxNodes: number): string {
    return sha256Json({ locator, max_depth: maxDepth, max_nodes: maxNodes })
}

export function encodeSpecTraversalCursor(payload: SpecTraversalCursorPayload, keyring: SpecTraversalCursorKeyring): string {
    const key = keyring.keys[payload.key_id]
    if (!key) throw new SpecRevisionError('CURSOR_KEY_UNAVAILABLE', 'Traversal cursor signing key is unavailable', 500)
    const body = Buffer.from(canonicalJson(payload), 'utf8').toString('base64url')
    const signature = createHmac('sha256', key).update(body, 'ascii').digest('base64url')
    return `${body}.${signature}`
}

export function decodeSpecTraversalCursor(
    cursor: string,
    keyring: SpecTraversalCursorKeyring,
    expectedProjectId: string,
    expectedFilterHash: string,
    expectedAuthScopeHash: string,
    now: Date = new Date()
): SpecTraversalCursorPayload {
    const parts = cursor.split('.')
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new SpecRevisionError('INVALID_TRAVERSAL_CURSOR', 'Traversal cursor is invalid', 400)
    }
    let payload: SpecTraversalCursorPayload
    try {
        payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as SpecTraversalCursorPayload
    } catch {
        throw new SpecRevisionError('INVALID_TRAVERSAL_CURSOR', 'Traversal cursor is invalid', 400)
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new SpecRevisionError('INVALID_TRAVERSAL_CURSOR', 'Traversal cursor is invalid', 400)
    }
    const keys = Object.keys(payload as unknown as Record<string, unknown>).sort(compareUnicode)
    const expectedKeys = ['auth_scope_hash', 'expires_at', 'filter_hash', 'key_id', 'offset', 'project_id', 'snapshot_id', 'version']
    if (
        canonicalJson(keys) !== canonicalJson(expectedKeys) ||
        payload.version !== 1 ||
        typeof payload.key_id !== 'string' ||
        typeof payload.project_id !== 'string' ||
        typeof payload.auth_scope_hash !== 'string' ||
        typeof payload.filter_hash !== 'string' ||
        typeof payload.snapshot_id !== 'string' ||
        !Number.isSafeInteger(payload.offset) ||
        payload.offset < 0 ||
        !Number.isSafeInteger(payload.expires_at)
    ) {
        throw new SpecRevisionError('INVALID_TRAVERSAL_CURSOR', 'Traversal cursor is invalid', 400)
    }
    const key = keyring.keys[payload.key_id]
    if (!key) throw new SpecRevisionError('INVALID_TRAVERSAL_CURSOR', 'Traversal cursor key is not recognized', 400)
    const expectedSignature = createHmac('sha256', key).update(parts[0], 'ascii').digest()
    let suppliedSignature: Buffer
    try {
        suppliedSignature = Buffer.from(parts[1], 'base64url')
    } catch {
        throw new SpecRevisionError('INVALID_TRAVERSAL_CURSOR', 'Traversal cursor is invalid', 400)
    }
    if (suppliedSignature.length !== expectedSignature.length || !timingSafeEqual(suppliedSignature, expectedSignature)) {
        throw new SpecRevisionError('INVALID_TRAVERSAL_CURSOR', 'Traversal cursor signature is invalid', 400)
    }
    if (payload.project_id !== expectedProjectId) {
        throw new SpecRevisionError('TRAVERSAL_CURSOR_PROJECT_MISMATCH', 'Traversal cursor belongs to another project', 400)
    }
    if (payload.filter_hash !== expectedFilterHash) {
        throw new SpecRevisionError('TRAVERSAL_CURSOR_FILTER_MISMATCH', 'Traversal cursor filters do not match', 400)
    }
    if (payload.auth_scope_hash !== expectedAuthScopeHash) {
        throw new SpecRevisionError('TRAVERSAL_CURSOR_AUTH_SCOPE_MISMATCH', 'Traversal cursor belongs to another authorization scope', 403)
    }
    if (payload.expires_at <= now.getTime()) {
        throw new SpecRevisionError('TRAVERSAL_CURSOR_EXPIRED', 'Traversal cursor has expired', 410)
    }
    return payload
}

function normalizeRelations(relations: SpecRelationInput[]): SpecRelationInput[] {
    const byIdentity = new Map<string, SpecRelationInput>()
    for (const relation of relations) {
        const normalized = {
            ...relation,
            properties: [...new Set(relation.properties.map((value) => value.trim()).filter(Boolean))].sort(compareUnicode),
        }
        const identity = canonicalJson([
            normalized.relation_type,
            normalized.target.source_key,
            normalized.source_relation_id,
        ])
        const previous = byIdentity.get(identity)
        if (previous && canonicalJson(previous) !== canonicalJson(normalized)) {
            throw new SpecRevisionError('DUPLICATE_RELATION_CONFLICT', 'Duplicate relation identity has different data', 400)
        }
        byIdentity.set(identity, normalized)
    }
    return [...byIdentity.values()].sort((left, right) =>
        compareUnicode(
            `${left.relation_type}\u0000${left.target.source_key}\u0000${left.source_relation_id || ''}`,
            `${right.relation_type}\u0000${right.target.source_key}\u0000${right.source_relation_id || ''}`
        )
    )
}

function normalizeClaims(claims: SpecClaimInput[]): SpecClaimInput[] {
    return [...claims].sort((left, right) =>
        compareUnicode(
            canonicalJson([
                left.subject,
                left.predicate,
                canonicalJson(left.value),
                left.unit || '',
                left.condition || '',
                left.object || '',
                left.evidence.path,
                left.rule_version,
            ]),
            canonicalJson([
                right.subject,
                right.predicate,
                canonicalJson(right.value),
                right.unit || '',
                right.condition || '',
                right.object || '',
                right.evidence.path,
                right.rule_version,
            ])
        )
    )
}

function sourceForHash(source: StageAndPublishInput['source']) {
    return {
        ...source,
        aliases: [...new Set(source.aliases.map((value) => value.trim()).filter(Boolean))].sort(compareUnicode),
    }
}

export class SpecRevisionService {
    private readonly cursorKeyring: SpecTraversalCursorKeyring
    private readonly now: () => Date

    constructor(private readonly rootEm: EntityManager, options: SpecRevisionServiceOptions = {}) {
        this.cursorKeyring = options.cursorKeyring || defaultCursorKeyring()
        this.now = options.now || (() => new Date())
    }

    validate(input: StageAndPublishInput) {
        const relations = normalizeRelations(input.relations)
        const claims = normalizeClaims(input.claims)
        const checks: Array<[boolean, string, string]> = [
            [input.expected_relation_count === relations.length, 'RELATION_COUNT_MISMATCH', 'Relation count mismatch'],
            [input.expected_claim_count === claims.length, 'CLAIM_COUNT_MISMATCH', 'Claim count mismatch'],
            [input.expected_relation_hash === sha256Json(relations), 'RELATION_HASH_MISMATCH', 'Relation hash mismatch'],
            [input.expected_claim_hash === sha256Json(claims), 'CLAIM_HASH_MISMATCH', 'Claim hash mismatch'],
            [input.revision.relation_hash === input.expected_relation_hash, 'RELATION_HASH_MISMATCH', 'Revision relation hash mismatch'],
            [input.revision.claim_hash === input.expected_claim_hash, 'CLAIM_HASH_MISMATCH', 'Revision claim hash mismatch'],
            [input.revision.source_payload_hash === sha256Json(input.revision.canonical_payload), 'PAYLOAD_HASH_MISMATCH', 'Payload hash mismatch'],
            [input.revision.content_hash === sha256(input.memo.content), 'CONTENT_HASH_MISMATCH', 'Content hash mismatch'],
            [input.revision.metadata_hash === sha256Json(input.memo.metadata), 'METADATA_HASH_MISMATCH', 'Metadata hash mismatch'],
            [
                input.revision.relation_input_hash ===
                    sha256Json({
                        source: sourceForHash(input.source),
                        memo_title: input.memo.title,
                        memo_metadata: input.memo.metadata,
                        relations,
                    }),
                'RELATION_INPUT_HASH_MISMATCH',
                'Relation input hash mismatch',
            ],
        ]
        for (const [valid, code, message] of checks) {
            if (!valid) throw new SpecRevisionError(code, message, 400)
        }
        return { relations, claims }
    }

    async stageAndPublish(project: Project, input: StageAndPublishInput) {
        const normalized = this.validate(input)
        const projectId = input.project_id
        const em = this.rootEm.fork({ clear: true, useContext: false, disableContextResolution: true, keepTransactionContext: false })
        const receipt = await (async () => {
            await em.begin()
            try {
                const value = await em.transactional(async (em) => {
                    const managedProject = await em.findOneOrFail(Project, { uuid: projectId })
            const transaction = em.getTransactionContext()
            if (!transaction) {
                throw new SpecRevisionError('TRANSACTION_UNAVAILABLE', 'Canonical publication transaction is unavailable', 503)
            }
            const projectExists = await transaction('skald_project').where({ uuid: projectId }).first('uuid')
            if (!projectExists) {
                throw new SpecRevisionError('PROJECT_NOT_FOUND_IN_TRANSACTION', `Project ${projectId} is unavailable in publication transaction`, 503)
            }
            await transaction.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?))', [
                    projectId,
                input.source.source_key,
            ])

            let source = await em.findOne(
                SpecSource,
                {
                    project: managedProject,
                    source_system: input.source.source_system,
                    source_type: input.source.source_type,
                    immutable_source_id: input.source.immutable_source_id,
                },
                { lockMode: 2 }
            )
            if (source) await em.populate(source, ['active_revision', 'memo'])

            if (source) {
                const replay = await em.findOne(SpecRevision, {
                    project: managedProject,
                    source: { project: managedProject, uuid: source.uuid },
                    idempotency_key: input.idempotency_key,
                })
                if (replay) {
                    if (replay.payload_hash !== input.revision.source_payload_hash || replay.canonical_hash !== input.revision.relation_input_hash) {
                        throw new SpecRevisionError('IDEMPOTENCY_CONFLICT', 'Idempotency key was reused with different content', 409)
                    }
                    return this.receipt(source, replay, true)
                }
                const activeMetadata = source.active_revision?.metadata as Record<string, unknown> | undefined
                const activeSourceRevision = activeMetadata?._source_revision
                const activeUpdatedAt = activeMetadata?._source_updated_at
                if (
                    (input.revision.source_updated_at &&
                        typeof activeUpdatedAt === 'string' &&
                        Date.parse(input.revision.source_updated_at) < Date.parse(activeUpdatedAt)) ||
                    (activeSourceRevision === input.revision.source_revision &&
                        source.active_revision?.payload_hash !== input.revision.source_payload_hash)
                ) {
                    throw new SpecRevisionError('STALE_REVISION', 'Source revision is older than the active revision', 409)
                }
            }

            let memo = source?.memo
            let createdMemo = false
            if (!memo && input.memo.memo_uuid) memo = await em.findOne(Memo, { project: managedProject, uuid: input.memo.memo_uuid }) || undefined
            if (!memo) memo = await em.findOne(Memo, { project: managedProject, client_reference_id: input.memo.client_reference_id }) || undefined
            const now = new Date()
            if (!memo) {
                memo = em.create(Memo, {
                    uuid: input.memo.memo_uuid || randomUUID(),
                    created_at: now,
                    updated_at: now,
                    title: input.memo.title,
                    content_length: input.memo.content.length,
                    content_hash: input.revision.content_hash,
                    metadata: input.memo.metadata,
                    archived: false,
                    processing_status: 'received',
                    type: 'plaintext',
                    source: input.memo.source,
                    client_reference_id: input.memo.client_reference_id,
                    project: managedProject,
                })
                em.persist(memo)
                createdMemo = true
            } else {
                memo.updated_at = now
                memo.title = input.memo.title
                memo.content_length = input.memo.content.length
                memo.content_hash = input.revision.content_hash
                memo.metadata = input.memo.metadata
                memo.source = input.memo.source
                memo.client_reference_id = input.memo.client_reference_id
            }
            let memoContent = await em.findOne(MemoContent, { project: managedProject, memo })
            if (!memoContent) {
                memoContent = em.create(MemoContent, { uuid: randomUUID(), project: managedProject, memo, content: input.memo.content })
                em.persist(memoContent)
            } else {
                memoContent.content = input.memo.content
            }
            if (createdMemo) await em.flush()

            if (!source) {
                const sourceId = randomUUID()
                await transaction('skald_spec_source').insert({
                    uuid: sourceId,
                    created_at: now,
                    updated_at: now,
                    spec_id: input.source.source_key,
                    source_system: input.source.source_system,
                    source_type: input.source.source_type,
                    immutable_source_id: input.source.immutable_source_id,
                    source_locator: input.source.source_url || input.source.source_key,
                    memo_reference_id: input.memo.client_reference_id,
                    memo_projection_revision_id: randomUUID(),
                    memo_projection_canonical_hash: input.revision.content_hash,
                    memo_id: memo.uuid,
                    active_revision_id: null,
                    project_id: projectId,
                })
                const insertedSource = await transaction('skald_spec_source')
                    .where({ uuid: sourceId })
                    .first('project_id', 'memo_id', 'memo_reference_id')
                if (!insertedSource || insertedSource.project_id !== projectId) {
                    throw new SpecRevisionError(
                        'SOURCE_PROJECT_MISMATCH',
                        `Canonical source project mismatch: expected ${projectId}, got ${insertedSource?.project_id || 'missing'}`,
                        503
                    )
                }
                source = em.getReference(SpecSource, sourceId)
                Object.defineProperty(source, '__canonicalNative', { value: true })
            }

            const latest = await em.findOne(SpecRevision, { project: managedProject, source: { project: managedProject, uuid: source.uuid } }, { orderBy: { revision_number: 'desc' } })
            const revision = em.create(SpecRevision, {
                uuid: randomUUID(),
                created_at: now,
                revision_number: (latest?.revision_number || 0) + 1,
                idempotency_key: input.idempotency_key,
                title: input.source.title,
                display_label: input.source.code || input.source.title,
                content: input.memo.content,
                metadata: {
                    ...input.memo.metadata,
                    _source_revision: input.revision.source_revision,
                    _source_updated_at: input.revision.source_updated_at,
                    _source: sourceForHash(input.source),
                    _canonical_payload: input.revision.canonical_payload,
                    _parser_version: input.revision.parser_version,
                    _extractor_version: input.revision.extractor_version,
                    _schema_version: input.revision.schema_version,
                },
                payload_hash: input.revision.source_payload_hash,
                content_hash: input.revision.content_hash,
                metadata_hash: input.revision.metadata_hash,
                relation_hash: input.revision.relation_hash,
                claim_hash: input.revision.claim_hash,
                relation_input_hash: input.revision.relation_input_hash,
                canonical_hash: input.revision.relation_input_hash,
                source,
                project: managedProject,
            }, { persist: false })
            revision.source = source
            revision.project = managedProject
            await transaction('skald_spec_revision').insert({
                uuid: revision.uuid,
                created_at: revision.created_at,
                revision_number: revision.revision_number,
                idempotency_key: revision.idempotency_key,
                title: revision.title,
                display_label: revision.display_label,
                content: revision.content,
                metadata: revision.metadata,
                payload_hash: revision.payload_hash,
                content_hash: revision.content_hash,
                metadata_hash: revision.metadata_hash,
                relation_hash: revision.relation_hash,
                claim_hash: revision.claim_hash,
                relation_input_hash: revision.relation_input_hash,
                canonical_hash: revision.canonical_hash,
                source_id: source.uuid,
                project_id: projectId,
            })
            await em.nativeUpdate(
                SpecRelation,
                { project: managedProject, unresolved_target_spec_id: source.spec_id, target_source: null },
                { target_source: source, unresolved_target_spec_id: null },
                { ctx: transaction }
            )

            for (const relation of normalized.relations) {
                const target = await em.findOne(SpecSource, { project: managedProject, spec_id: relation.target.source_key })
                const persistedRelation = em.create(SpecRelation, {
                    uuid: randomUUID(),
                    created_at: now,
                    relation_id: sha256Json([source.uuid, revision.uuid, relation.relation_type, relation.target.source_key, relation.source_relation_id]),
                    kind: relation.relation_type,
                    unresolved_target_spec_id: target ? null : relation.target.source_key,
                    source_relation_id: relation.source_relation_id,
                    display_label: relation.target.title,
                    provenance: { source: relation.provenance },
                    evidence: [relation.evidence],
                    properties: { values: relation.properties, target: relation.target },
                    source,
                    source_revision: revision,
                    target_source: target || null,
                    project: managedProject,
                })
                em.persist(persistedRelation)
                persistedRelation.source = source
                persistedRelation.source_revision = revision
                if (target) persistedRelation.target_source = target
                em.getUnitOfWork().computeChangeSet(persistedRelation)
            }
            for (const claim of normalized.claims) {
                const persistedClaim = em.create(SpecClaim, {
                    uuid: randomUUID(),
                    created_at: now,
                    claim_id: sha256Json([source.uuid, revision.uuid, claim]),
                    kind: claim.predicate,
                    text: `${claim.subject} ${claim.predicate} ${canonicalJson(claim.value)}`,
                    display_label: claim.subject,
                    subject: claim.subject,
                    predicate: claim.predicate,
                    value: canonicalJson(claim.value),
                    unit: claim.unit,
                    condition: claim.condition,
                    object: claim.object,
                    evidence_excerpt: claim.evidence.excerpt,
                    evidence_path: claim.evidence.path,
                    evidence_hash: claim.evidence.hash,
                    evidence: [claim.evidence],
                    extractor_version: input.revision.extractor_version,
                    rule_version: claim.rule_version,
                    source,
                    source_revision: revision,
                    project: managedProject,
                }, { persist: false })
                await transaction('skald_spec_claim').insert({
                    uuid: persistedClaim.uuid,
                    created_at: persistedClaim.created_at,
                    claim_id: persistedClaim.claim_id,
                    kind: persistedClaim.kind,
                    text: persistedClaim.text,
                    display_label: persistedClaim.display_label,
                    subject: persistedClaim.subject,
                    predicate: persistedClaim.predicate,
                    value: persistedClaim.value,
                    unit: persistedClaim.unit,
                    condition: persistedClaim.condition,
                    object: persistedClaim.object,
                    evidence_excerpt: persistedClaim.evidence_excerpt,
                    evidence_path: persistedClaim.evidence_path,
                    evidence_hash: persistedClaim.evidence_hash,
                    evidence: persistedClaim.evidence,
                    extractor_version: persistedClaim.extractor_version,
                    rule_version: persistedClaim.rule_version,
                    source_id: source.uuid,
                    source_revision_id: revision.uuid,
                    project_id: projectId,
                })
            }
            await transaction('skald_spec_source')
                .where({ project_id: projectId, uuid: source.uuid })
                .update({
                    updated_at: now,
                    spec_id: input.source.source_key,
                    source_locator: input.source.source_url || input.source.source_key,
                    memo_reference_id: input.memo.client_reference_id,
                    memo_projection_revision_id: revision.uuid,
                    memo_projection_canonical_hash: input.revision.content_hash,
                    memo_id: memo.uuid,
                    active_revision_id: revision.uuid,
                })
            if (!('__canonicalNative' in source)) await em.flush()
            source.spec_id = input.source.source_key
            source.memo_reference_id = input.memo.client_reference_id
            source.memo = memo
            return this.receipt(source, revision, false)
                }, { propagation: TransactionPropagation.MANDATORY })
                await em.commit()
                return value
            } catch (error) {
                if (em.isInTransaction()) await em.rollback()
                throw error
            }
        })()
        const persisted = await this.rootEm.getConnection().execute<Array<{ revision_id: string }>>(
            `SELECT r.uuid AS revision_id
               FROM skald_spec_revision r
               JOIN skald_spec_source s
                 ON s.project_id = r.project_id AND s.uuid = r.source_id
              WHERE r.project_id = ? AND r.uuid = ? AND s.uuid = ?`,
            [projectId, receipt.revision_id, receipt.source_id]
        )
        if (persisted.length !== 1) {
            throw new SpecRevisionError('PUBLICATION_NOT_PERSISTED', 'Canonical revision was not persisted', 503)
        }
        return receipt
    }

    private receipt(source: SpecSource, revision: SpecRevision, replay: boolean) {
        return {
            status: 'published',
            source_id: source.uuid,
            source_key: source.spec_id,
            revision_id: revision.uuid,
            memo_uuid: source.memo.uuid,
            memo_reference_id: source.memo_reference_id,
            source_payload_hash: revision.payload_hash,
            relation_hash: revision.relation_hash,
            claim_hash: revision.claim_hash,
            idempotent_replay: replay,
        }
    }

    async exact(project: Project, locator: string, em: EntityManager = this.rootEm) {
        const rows = await em.getConnection().execute<any[]>(
            `SELECT s.uuid, s.spec_id, s.source_system, s.source_type, s.immutable_source_id,
                    s.source_locator, s.memo_id, s.memo_reference_id, r.uuid AS revision_id,
                    r.title, r.display_label, r.content, r.metadata, r.revision_number,
                    CASE
                      WHEN s.uuid::text = ? THEN 1
                      WHEN s.spec_id = ? OR s.immutable_source_id = ? THEN 2
                      WHEN r.metadata->'_source'->>'code' = ? THEN 3
                      WHEN s.source_locator = ? OR r.metadata->'_source'->>'source_url' = ? THEN 4
                      WHEN lower(r.title) = lower(?) THEN 5
                      WHEN s.memo_id::text = ? OR s.memo_reference_id = ? THEN 6
                    END AS precedence
             FROM skald_spec_source s
             JOIN skald_spec_revision r ON r.uuid = s.active_revision_id AND r.source_id = s.uuid AND r.project_id = s.project_id
             WHERE s.project_id = ? AND (
                s.uuid::text = ? OR s.spec_id = ? OR s.immutable_source_id = ? OR
                r.metadata->'_source'->>'code' = ? OR s.source_locator = ? OR
                r.metadata->'_source'->>'source_url' = ? OR lower(r.title) = lower(?) OR
                s.memo_id::text = ? OR s.memo_reference_id = ?)
             ORDER BY precedence, s.spec_id, s.uuid`,
            [locator, locator, locator, locator, locator, locator, locator, locator, locator, project.uuid,
             locator, locator, locator, locator, locator, locator, locator, locator, locator]
        )
        if (!rows.length) throw new SpecRevisionError('SPEC_NOT_FOUND', 'Spec not found', 404)
        const best = Number(rows[0].precedence)
        const candidates = rows.filter((row) => Number(row.precedence) === best)
        if (candidates.length !== 1) {
            throw new SpecRevisionError('AMBIGUOUS_EXACT_MATCH', 'Exact locator is ambiguous', 409)
        }
        return { ...candidates[0], match_precedence: best }
    }

    async relations(project: Project, locator: string, direction: 'outgoing' | 'incoming', em: EntityManager = this.rootEm) {
        const source = await this.exact(project, locator, em)
        const outgoing = direction === 'outgoing'
        return em.getConnection().execute<any[]>(
            `SELECT rel.uuid, rel.kind AS relation_type, rel.source_relation_id, rel.display_label,
                    rel.provenance, rel.evidence, rel.properties, rel.unresolved_target_spec_id,
                    src.spec_id AS source_key, target.spec_id AS target_key,
                    src.active_revision_id AS source_revision_id, target.active_revision_id AS target_revision_id
             FROM skald_spec_relation rel
             JOIN skald_spec_source src ON src.uuid = rel.source_id AND src.project_id = rel.project_id
             LEFT JOIN skald_spec_source target ON target.uuid = rel.target_source_id AND target.project_id = rel.project_id
             WHERE rel.project_id = ? AND rel.source_revision_id = src.active_revision_id
               AND ${outgoing ? 'rel.source_id' : 'rel.target_source_id'} = ?
             ORDER BY rel.kind, src.spec_id, COALESCE(target.spec_id, rel.unresolved_target_spec_id), rel.uuid`,
            [project.uuid, source.uuid]
        )
    }

    async related(project: Project, locators: string[], limit: number) {
        const results = []
        for (const locator of [...new Set(locators)].sort(compareUnicode)) {
            const source = await this.exact(project, locator)
            const [outgoing, incoming] = await Promise.all([
                this.relations(project, source.spec_id, 'outgoing'),
                this.relations(project, source.spec_id, 'incoming'),
            ])
            results.push({ source, relations: [...outgoing, ...incoming].slice(0, limit) })
        }
        return results
    }

    async traverse(project: Project, request: SpecTraversalRequest) {
        const maxDepth = request.max_depth
        const maxNodes = request.max_nodes
        const pageSize = request.page_size ?? TRAVERSAL_MAX_PAGE_SIZE
        if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > TRAVERSAL_MAX_DEPTH) {
            throw new SpecRevisionError('INVALID_TRAVERSAL_DEPTH', 'Traversal depth must be between 1 and 5', 400)
        }
        if (!Number.isInteger(maxNodes) || maxNodes < 1 || maxNodes > TRAVERSAL_MAX_NODES) {
            throw new SpecRevisionError('INVALID_TRAVERSAL_NODE_LIMIT', 'Traversal node limit must be between 1 and 500', 400)
        }
        if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > TRAVERSAL_MAX_PAGE_SIZE) {
            throw new SpecRevisionError('INVALID_TRAVERSAL_PAGE_SIZE', 'Traversal page size must be between 1 and 100', 400)
        }
        const filterHash = specTraversalFilterHash(request.locator, maxDepth, maxNodes)
        const now = this.now()
        if (request.cursor) {
            const cursor = decodeSpecTraversalCursor(
                request.cursor,
                this.cursorKeyring,
                project.uuid,
                filterHash,
                request.auth_scope_hash,
                now
            )
            return this.readTraversalSnapshotPage(
                project,
                cursor.snapshot_id,
                cursor.offset,
                pageSize,
                filterHash,
                request.auth_scope_hash,
                now
            )
        }

        const snapshotId = randomUUID()
        const expiresAt = new Date(now.getTime() + TRAVERSAL_TTL_MS)
        await this.rootEm.transactional(async (em) => {
            const root = await this.exact(project, request.locator, em)
            const visited = new Set<string>([root.spec_id])
            const nodes: any[] = [root]
            const edges: any[] = []
            const edgeIds = new Set<string>()
            let frontier = [root]
            let depth = 0
            while (frontier.length && depth < maxDepth && nodes.length < maxNodes) {
                const next: any[] = []
                for (const node of frontier) {
                    const outgoing = await this.relations(project, node.spec_id, 'outgoing', em)
                    for (const edge of outgoing) {
                        if (!edgeIds.has(edge.uuid)) {
                            edgeIds.add(edge.uuid)
                            edges.push(edge)
                        }
                        if (edge.target_key && !visited.has(edge.target_key) && nodes.length < maxNodes) {
                            const target = await this.exact(project, edge.target_key, em)
                            visited.add(target.spec_id)
                            nodes.push(target)
                            next.push(target)
                        }
                    }
                }
                frontier = next.sort((left, right) => compareUnicode(left.spec_id, right.spec_id))
                depth += 1
            }
            const complete = frontier.length === 0
            const truncatedReason = complete ? null : nodes.length >= maxNodes ? 'max_nodes' : 'max_depth'
            const items = [
                ...nodes.map((payload) => ({ item_type: 'node' as const, payload })),
                ...edges.map((payload) => ({ item_type: 'edge' as const, payload })),
            ]
            const [watermark] = await em.getConnection().execute<Array<{
                graph_watermark: Date | string | null
                promotion_watermark: Date | string | null
            }>>(
                `SELECT (SELECT max(updated_at) FROM skald_spec_source WHERE project_id = ?) AS graph_watermark,
                        (SELECT max(promoted_at) FROM skald_spec_promotion_state
                         WHERE project_id = ? AND state = 'promoted') AS promotion_watermark`,
                [project.uuid, project.uuid]
            )
            const snapshot = em.create(SpecTraversalSnapshot, {
                uuid: snapshotId,
                created_at: now,
                expires_at: expiresAt,
                filter_hash: filterHash,
                auth_scope_hash: request.auth_scope_hash,
                root_locator: request.locator,
                max_depth: maxDepth,
                max_nodes: maxNodes,
                traversal_depth: depth,
                traversal_complete: complete,
                truncated_reason: truncatedReason,
                item_count: items.length,
                graph_watermark: watermark?.graph_watermark ? new Date(watermark.graph_watermark) : null,
                promotion_watermark: watermark?.promotion_watermark ? new Date(watermark.promotion_watermark) : null,
                project,
            })
            em.persist(snapshot)
            for (let ordinal = 0; ordinal < items.length; ordinal += 1) {
                em.persist(em.create(SpecTraversalSnapshotItem, {
                    uuid: randomUUID(),
                    ordinal,
                    item_type: items[ordinal].item_type,
                    payload: items[ordinal].payload,
                    snapshot,
                    project,
                }))
            }
        }, { isolationLevel: IsolationLevel.REPEATABLE_READ })
        return this.readTraversalSnapshotPage(project, snapshotId, 0, pageSize, filterHash, request.auth_scope_hash, now)
    }

    private async readTraversalSnapshotPage(
        project: Project,
        snapshotId: string,
        offset: number,
        pageSize: number,
        filterHash: string,
        authScopeHash: string,
        now: Date
    ) {
        const snapshot = await this.rootEm.findOne(SpecTraversalSnapshot, { project, uuid: snapshotId })
        if (!snapshot || snapshot.filter_hash !== filterHash) {
            throw new SpecRevisionError('TRAVERSAL_SNAPSHOT_NOT_FOUND', 'Traversal snapshot was not found', 404)
        }
        if (snapshot.auth_scope_hash !== authScopeHash) {
            throw new SpecRevisionError('TRAVERSAL_CURSOR_AUTH_SCOPE_MISMATCH', 'Traversal snapshot belongs to another authorization scope', 403)
        }
        if (snapshot.expires_at.getTime() <= now.getTime()) {
            throw new SpecRevisionError('TRAVERSAL_CURSOR_EXPIRED', 'Traversal cursor has expired', 410)
        }
        if (offset > snapshot.item_count) {
            throw new SpecRevisionError('INVALID_TRAVERSAL_CURSOR', 'Traversal cursor offset is invalid', 400)
        }
        const rows = await this.rootEm.find(
            SpecTraversalSnapshotItem,
            { project, snapshot, ordinal: { $gte: offset, $lt: offset + pageSize } },
            { orderBy: { ordinal: 'asc' } }
        )
        const nextOffset = offset + rows.length
        const nextCursor = nextOffset < snapshot.item_count
            ? encodeSpecTraversalCursor({
                  version: 1,
                  key_id: this.cursorKeyring.activeKeyId,
                  project_id: project.uuid,
                  auth_scope_hash: authScopeHash,
                  filter_hash: filterHash,
                  snapshot_id: snapshot.uuid,
                  offset: nextOffset,
                  expires_at: snapshot.expires_at.getTime(),
              }, this.cursorKeyring)
            : null
        return {
            snapshot_id: snapshot.uuid,
            expires_at: snapshot.expires_at.toISOString(),
            graph_watermark: snapshot.graph_watermark?.toISOString() || null,
            promotion_watermark: snapshot.promotion_watermark?.toISOString() || null,
            items: rows.map((row) => ({ ordinal: row.ordinal, type: row.item_type, value: row.payload })),
            next_cursor: nextCursor,
            depth: snapshot.traversal_depth,
            complete: snapshot.traversal_complete,
            truncated_reason: snapshot.truncated_reason || null,
        }
    }

    async conflictCandidates(project: Project, locators: string[], limit: number) {
        const sourceIds = []
        for (const locator of [...new Set(locators)]) sourceIds.push((await this.exact(project, locator)).uuid)
        if (sourceIds.length < 2) return []
        return this.rootEm.getConnection().execute<any[]>(
            `SELECT a.uuid AS left_claim_id, b.uuid AS right_claim_id,
                    sa.spec_id AS left_source_key, sb.spec_id AS right_source_key,
                    a.subject, a.predicate, a.value AS left_value, b.value AS right_value,
                    a.unit, a.condition, a.evidence AS left_evidence, b.evidence AS right_evidence,
                    a.source_revision_id AS left_revision_id, b.source_revision_id AS right_revision_id,
                    'differing_active_claim_values' AS candidate_reason
             FROM skald_spec_claim a
             JOIN skald_spec_source sa ON sa.uuid = a.source_id AND sa.project_id = a.project_id AND sa.active_revision_id = a.source_revision_id
             JOIN skald_spec_claim b ON b.project_id = a.project_id AND b.source_id > a.source_id
                 AND b.subject = a.subject AND b.predicate = a.predicate
                 AND b.value IS DISTINCT FROM a.value
                 AND b.unit IS NOT DISTINCT FROM a.unit AND b.condition IS NOT DISTINCT FROM a.condition
             JOIN skald_spec_source sb ON sb.uuid = b.source_id AND sb.project_id = b.project_id AND sb.active_revision_id = b.source_revision_id
             WHERE a.project_id = ? AND a.source_id IN (?) AND b.source_id IN (?)
               AND jsonb_array_length(a.evidence) > 0 AND jsonb_array_length(b.evidence) > 0
             ORDER BY a.subject, a.predicate, sa.spec_id, sb.spec_id, a.uuid, b.uuid
             LIMIT ?`,
            [project.uuid, sourceIds, sourceIds, limit]
        )
    }
}
