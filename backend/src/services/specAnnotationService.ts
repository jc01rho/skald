import { randomUUID } from 'crypto'
import { EntityManager } from '@mikro-orm/postgresql'
import { DI } from '@/di'
import { createNewMemo } from '@/lib/createMemoUtils'
import { Memo } from '@/entities/Memo'
import { MemoChunk } from '@/entities/MemoChunk'
import { MemoContent } from '@/entities/MemoContent'
import { MemoParentChunk } from '@/entities/MemoParentChunk'
import { MemoSummary } from '@/entities/MemoSummary'
import { MemoTag } from '@/entities/MemoTag'
import { Project } from '@/entities/Project'
import { SpecAnnotation, SpecAnnotationKind, SpecAnnotationStatus } from '@/entities/SpecAnnotation'
import { SpecSource } from '@/entities/SpecSource'
import {
    annotationProjectionReferenceId,
    buildAnnotationProjection,
    SPEC_ANNOTATION_MEMO_SOURCE,
    SpecContext,
} from '@/lib/specAnnotationProjection'

export class SpecAnnotationError extends Error {
    constructor(
        public readonly code: string,
        message: string,
        public readonly status: number
    ) {
        super(message)
    }
}

export interface SpecAnnotationFields {
    kind: SpecAnnotationKind
    body: string
    condition?: string | null
    effect?: string | null
    applies_to?: string | null
}

export interface SpecAnnotationView {
    uuid: string
    kind: SpecAnnotationKind
    status: SpecAnnotationStatus
    body: string
    condition: string | null
    effect: string | null
    applies_to: string | null
    anchor_revision_id: string | null
    created_by: string | null
    updated_by: string | null
    created_at: Date
    updated_at: Date
    version: number
}

function toView(annotation: SpecAnnotation): SpecAnnotationView {
    return {
        uuid: annotation.uuid,
        kind: annotation.kind,
        status: annotation.status,
        body: annotation.body,
        condition: annotation.condition ?? null,
        effect: annotation.effect ?? null,
        applies_to: annotation.applies_to ?? null,
        anchor_revision_id: annotation.anchor_revision_id ?? null,
        created_by: annotation.created_by ?? null,
        updated_by: annotation.updated_by ?? null,
        created_at: annotation.created_at,
        updated_at: annotation.updated_at,
        version: annotation.version,
    }
}

export class SpecAnnotationService {
    constructor(private readonly em: EntityManager) {}

    private async specContext(project: Project, where: 'memo' | 'source', id: string): Promise<SpecContext | null> {
        const rows = await this.em.getConnection().execute<SpecContext[]>(
            `SELECT s.uuid AS source_id, s.spec_id, s.memo_id, s.memo_reference_id,
                    COALESCE(r.title, s.spec_id) AS title,
                    r.metadata->'_source'->>'code' AS code,
                    COALESCE(r.metadata->'_source'->>'source_url', s.source_locator) AS source_url,
                    s.active_revision_id, r.content_hash AS active_content_hash
               FROM skald_spec_source s
               LEFT JOIN skald_spec_revision r
                 ON r.project_id = s.project_id AND r.source_id = s.uuid AND r.uuid = s.active_revision_id
              WHERE s.project_id = ? AND ${where === 'memo' ? 's.memo_id' : 's.uuid'} = ?
              LIMIT 1`,
            [project.uuid, id]
        )
        return rows[0] || null
    }

    async list(project: Project, memoUuid: string) {
        const spec = await this.specContext(project, 'memo', memoUuid)
        if (!spec) return { spec: null, annotations: [] }
        const annotations = await this.em.find(
            SpecAnnotation,
            { project, source: { project, uuid: spec.source_id }, status: { $ne: 'ARCHIVED' } },
            { orderBy: { created_at: 'asc' } }
        )
        return { spec, annotations: annotations.map(toView) }
    }

    async create(project: Project, memoUuid: string, fields: SpecAnnotationFields, actor: string | null) {
        const spec = await this.specContext(project, 'memo', memoUuid)
        if (!spec) throw new SpecAnnotationError('NOT_A_SPEC_MEMO', 'Memo is not a canonical spec memo', 404)
        const now = new Date()
        const annotation = this.em.create(SpecAnnotation, {
            uuid: randomUUID(),
            created_at: now,
            updated_at: now,
            ...fields,
            status: 'ACTIVE',
            anchor_revision_id: spec.active_revision_id,
            anchor_content_hash: spec.active_content_hash,
            created_by: actor,
            updated_by: actor,
            version: 1,
            source: this.em.getReference(SpecSource, spec.source_id),
            project,
        })
        await this.em.persistAndFlush(annotation)
        await this.syncProjection(project, spec)
        return toView(annotation)
    }

    async update(project: Project, uuid: string, version: number, fields: Partial<SpecAnnotationFields>, actor: string | null) {
        return this.mutate(project, uuid, version, actor, (annotation, spec) => {
            if (annotation.status === 'ARCHIVED') {
                throw new SpecAnnotationError('ANNOTATION_ARCHIVED', 'Archived annotations cannot be edited', 409)
            }
            Object.assign(annotation, Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)))
            annotation.status = 'ACTIVE'
            annotation.anchor_revision_id = spec.active_revision_id
            annotation.anchor_content_hash = spec.active_content_hash
        })
    }

    async archive(project: Project, uuid: string, version: number, actor: string | null) {
        return this.mutate(project, uuid, version, actor, (annotation) => {
            annotation.status = 'ARCHIVED'
        })
    }

    async confirm(project: Project, uuid: string, version: number, actor: string | null) {
        return this.mutate(project, uuid, version, actor, (annotation, spec) => {
            if (annotation.status === 'ARCHIVED') {
                throw new SpecAnnotationError('ANNOTATION_ARCHIVED', 'Archived annotations cannot be confirmed', 409)
            }
            annotation.status = 'ACTIVE'
            annotation.anchor_revision_id = spec.active_revision_id
            annotation.anchor_content_hash = spec.active_content_hash
        })
    }

    private async mutate(
        project: Project,
        uuid: string,
        version: number,
        actor: string | null,
        apply: (annotation: SpecAnnotation, spec: SpecContext) => void
    ) {
        const annotation = await this.em.findOne(SpecAnnotation, { project, uuid }, { populate: ['source'] })
        if (!annotation) throw new SpecAnnotationError('ANNOTATION_NOT_FOUND', 'Annotation not found', 404)
        if (annotation.version !== version) {
            throw new SpecAnnotationError('VERSION_CONFLICT', 'Annotation was modified by someone else; reload and retry', 409)
        }
        const spec = await this.specContext(project, 'source', annotation.source.uuid)
        if (!spec) throw new SpecAnnotationError('SPEC_NOT_FOUND', 'Annotated spec no longer exists', 404)
        apply(annotation, spec)
        const now = new Date()
        const updated = await this.em.nativeUpdate(
            SpecAnnotation,
            { project, uuid, version },
            {
                kind: annotation.kind,
                status: annotation.status,
                body: annotation.body,
                condition: annotation.condition ?? null,
                effect: annotation.effect ?? null,
                applies_to: annotation.applies_to ?? null,
                anchor_revision_id: annotation.anchor_revision_id ?? null,
                anchor_content_hash: annotation.anchor_content_hash ?? null,
                updated_by: actor,
                updated_at: now,
                version: version + 1,
            }
        )
        if (updated !== 1) {
            throw new SpecAnnotationError('VERSION_CONFLICT', 'Annotation was modified by someone else; reload and retry', 409)
        }
        await this.em.refresh(annotation)
        await this.syncProjection(project, spec)
        return toView(annotation)
    }

    async syncProjectionForSource(project: Project, sourceId: string) {
        const spec = await this.specContext(project, 'source', sourceId)
        if (spec) await this.syncProjection(project, spec)
    }

    private async syncProjection(project: Project, spec: SpecContext) {
        const annotations = await this.em.find(SpecAnnotation, {
            project,
            source: { project, uuid: spec.source_id },
            status: 'ACTIVE',
        })
        const referenceId = annotationProjectionReferenceId(spec.memo_reference_id)
        const projection = buildAnnotationProjection(spec, annotations)
        if (!projection) {
            await this.deleteProjectionMemo(project, referenceId)
            return
        }
        await createNewMemo(
            {
                title: projection.title,
                content: projection.content,
                reference_id: referenceId,
                source: SPEC_ANNOTATION_MEMO_SOURCE,
                metadata: {
                    spec_id: spec.spec_id,
                    spec_code: spec.code,
                    spec_memo_uuid: spec.memo_id,
                    source_url: spec.source_url,
                    annotation_count: annotations.length,
                },
                type: 'plaintext',
            },
            project
        )
    }

    private async deleteProjectionMemo(project: Project, referenceId: string) {
        const memo = await DI.em.fork().findOne(Memo, { project, client_reference_id: referenceId })
        if (!memo) return
        await DI.em.fork().transactional(async (em) => {
            await em.nativeDelete(MemoContent, { memo: { $in: [memo.uuid] } })
            await em.nativeDelete(MemoSummary, { memo: { $in: [memo.uuid] } })
            await em.nativeDelete(MemoTag, { memo: { $in: [memo.uuid] } })
            await em.nativeDelete(MemoParentChunk, { memo: { $in: [memo.uuid] } })
            await em.nativeDelete(MemoChunk, { memo: { $in: [memo.uuid] } })
            await em.nativeDelete(Memo, { uuid: memo.uuid })
        })
    }
}
