import { annotationProjectionReferenceId, buildAnnotationProjection } from '@/lib/specAnnotationProjection'

const spec = { spec_id: 'spms:function:812', title: '컴포넌트 반입 요청 목록 조회', code: 'SVR-COMPONENT-REQUEST-LIST-R' }

function annotation(overrides: Record<string, unknown>) {
    return {
        kind: 'ADDITIONAL_NOTE' as const,
        status: 'ACTIVE' as const,
        body: 'body',
        condition: null,
        effect: null,
        applies_to: null,
        created_at: new Date('2026-10-01T00:00:00.000Z'),
        ...overrides,
    }
}

describe('spec annotation projection', () => {
    it('keys the projection memo off the spec memo reference id so exact lookup can join it', () => {
        expect(annotationProjectionReferenceId('SVR-COMPONENT-REQUEST-LIST-R')).toBe(
            'spec-annotation:SVR-COMPONENT-REQUEST-LIST-R'
        )
    })

    it('returns no projection when nothing is active', () => {
        expect(buildAnnotationProjection(spec, [])).toBeNull()
        expect(
            buildAnnotationProjection(spec, [
                annotation({ status: 'NEEDS_REVIEW' }),
                annotation({ status: 'ARCHIVED' }),
            ])
        ).toBeNull()
    })

    it('projects only active annotations, grouped by kind and ordered by creation time', () => {
        const projection = buildAnnotationProjection(spec, [
            annotation({ kind: 'AUTOMATION_HINT', body: 'HINT-1' }),
            annotation({ body: 'NOTE-2', created_at: new Date('2026-10-02T00:00:00.000Z') }),
            annotation({
                body: 'NOTE-1',
                condition: 'COND-1',
                effect: 'EFFECT-1',
                applies_to: 'TARGET-1',
            }),
            annotation({ body: 'STALE', status: 'NEEDS_REVIEW' }),
        ])

        expect(projection).not.toBeNull()
        const content = projection!.content
        expect(content).not.toContain('STALE')
        expect(content).toContain(spec.code)
        expect(content).toContain(spec.spec_id)
        for (const value of ['COND-1', 'EFFECT-1', 'TARGET-1']) expect(content).toContain(value)
        const order = ['NOTE-1', 'NOTE-2', 'HINT-1'].map((value) => content.indexOf(value))
        expect(order.every((index) => index >= 0)).toBe(true)
        expect([...order].sort((left, right) => left - right)).toEqual(order)
        expect(projection!.title.length).toBeLessThanOrEqual(255)
    })
})
