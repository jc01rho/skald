import { SpecAnnotation, SpecAnnotationKind } from '@/entities/SpecAnnotation'

export const SPEC_ANNOTATION_MEMO_SOURCE = 'spec-annotation'
export const SPEC_ANNOTATION_REFERENCE_PREFIX = 'spec-annotation:'

export const KIND_LABELS: Record<SpecAnnotationKind, string> = {
    ADDITIONAL_NOTE: '추가 참고사항',
    AUTOMATION_HINT: '자동화 변환 시 참고사항',
}

export interface SpecContext {
    source_id: string
    spec_id: string
    memo_id: string
    memo_reference_id: string
    title: string
    code: string | null
    source_url: string | null
    active_revision_id: string | null
    active_content_hash: string | null
}

type ProjectionAnnotation = Pick<SpecAnnotation, 'kind' | 'status' | 'body' | 'condition' | 'effect' | 'applies_to' | 'created_at'>

export function annotationProjectionReferenceId(specMemoReferenceId: string): string {
    return `${SPEC_ANNOTATION_REFERENCE_PREFIX}${specMemoReferenceId}`
}

export function buildAnnotationProjection(
    spec: Pick<SpecContext, 'spec_id' | 'title' | 'code'>,
    annotations: ProjectionAnnotation[]
): { title: string; content: string } | null {
    const active = annotations.filter((annotation) => annotation.status === 'ACTIVE')
    if (active.length === 0) return null

    const label = spec.code ? `${spec.title} (${spec.code})` : spec.title
    const sections = [
        `# [사내 보충 참고사항] ${label}`,
        '',
        `> 이 문서는 SPMS 원문이 아니라 Skald 사용자가 직접 입력한 보충 참고사항입니다. ` +
            `원문 기능 명세: ${spec.code || spec.spec_id} (${spec.spec_id}). 원문과 내용이 충돌하면 원문을 우선합니다.`,
    ]
    for (const kind of Object.keys(KIND_LABELS) as SpecAnnotationKind[]) {
        const items = active
            .filter((annotation) => annotation.kind === kind)
            .sort((left, right) => left.created_at.getTime() - right.created_at.getTime())
        if (items.length === 0) continue
        sections.push('', `## ${KIND_LABELS[kind]}`)
        for (const item of items) {
            sections.push('')
            if (item.applies_to) sections.push(`- 대상: ${item.applies_to}`)
            if (item.condition) sections.push(`- 조건: ${item.condition}`)
            if (item.effect) sections.push(`- 동작: ${item.effect}`)
            sections.push(item.body.trim())
        }
    }
    return { title: `[참고사항] ${label}`.slice(0, 255), content: sections.join('\n') }
}
