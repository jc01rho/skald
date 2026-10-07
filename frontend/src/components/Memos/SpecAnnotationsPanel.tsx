import { useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle, NotebookPen, Pencil, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { formatDate } from '@/components/utils/dateUtils'
import {
    type SpecAnnotation,
    type SpecAnnotationInput,
    type SpecAnnotationKind,
    useSpecAnnotationStore,
} from '@/stores/specAnnotationStore'

const KIND_LABELS: Record<SpecAnnotationKind, string> = {
    ADDITIONAL_NOTE: '추가 참고사항',
    AUTOMATION_HINT: '자동화 변환 시 참고사항',
}

const EMPTY_FORM: SpecAnnotationInput = { kind: 'ADDITIONAL_NOTE', body: '', condition: '', effect: '', applies_to: '' }

const toForm = (annotation: SpecAnnotation): SpecAnnotationInput => ({
    kind: annotation.kind,
    body: annotation.body,
    condition: annotation.condition ?? '',
    effect: annotation.effect ?? '',
    applies_to: annotation.applies_to ?? '',
})

interface SpecAnnotationsPanelProps {
    memoUuid: string
}

export const SpecAnnotationsPanel = ({ memoUuid }: SpecAnnotationsPanelProps) => {
    const { spec, annotations, loading, saving, load, create, update, remove, confirm } = useSpecAnnotationStore()
    const [form, setForm] = useState<SpecAnnotationInput>(EMPTY_FORM)
    const [editing, setEditing] = useState<SpecAnnotation | null>(null)

    useEffect(() => {
        load(memoUuid)
        setForm(EMPTY_FORM)
        setEditing(null)
    }, [memoUuid, load])

    if (loading || !spec) return null

    const setField = (field: keyof SpecAnnotationInput) => (value: string) => setForm({ ...form, [field]: value })

    const resetForm = () => {
        setForm(EMPTY_FORM)
        setEditing(null)
    }

    const submit = async () => {
        const saved = editing ? await update(editing, form) : await create(form)
        if (saved) resetForm()
    }

    const startEdit = (annotation: SpecAnnotation) => {
        setEditing(annotation)
        setForm(toForm(annotation))
    }

    const handleDelete = async (annotation: SpecAnnotation) => {
        if (!window.confirm('이 참고사항을 삭제할까요? 삭제하면 되돌릴 수 없고 검색·답변·MCP에서도 사라집니다.')) return
        const deleted = await remove(annotation)
        if (deleted && editing?.uuid === annotation.uuid) resetForm()
    }

    return (
        <Card>
            <CardHeader className="border-b">
                <CardTitle className="flex items-center gap-2">
                    <NotebookPen className="h-5 w-5" />
                    참고사항 ({annotations.length})
                </CardTitle>
                <p className="text-sm text-muted-foreground">
                    SPMS 원문({spec.code || spec.spec_id})과 별도로 저장되어 재수집해도 유지됩니다. 활성 참고사항만
                    검색과 답변에 반영되며, 원문 내용이 바뀌면 검토 필요 상태로 전환됩니다.
                </p>
            </CardHeader>
            <CardContent className="space-y-4 pt-4">
                {annotations.map((annotation) => (
                    <div key={annotation.uuid} className="space-y-2 rounded-xl border bg-background/70 p-4 text-sm">
                        <div className="flex flex-wrap items-center gap-2">
                            <Badge variant="outline">{KIND_LABELS[annotation.kind]}</Badge>
                            {annotation.status === 'NEEDS_REVIEW' ? (
                                <Badge variant="destructive" className="flex items-center gap-1">
                                    <AlertTriangle className="h-3 w-3" />
                                    원문 변경됨 · 검토 필요
                                </Badge>
                            ) : (
                                <Badge variant="default" className="flex items-center gap-1">
                                    <CheckCircle className="h-3 w-3" />
                                    반영됨
                                </Badge>
                            )}
                            <span className="text-xs text-muted-foreground">
                                {annotation.updated_by || annotation.created_by || '알 수 없음'} ·{' '}
                                {formatDate(annotation.updated_at)}
                            </span>
                        </div>
                        {annotation.applies_to && <div>대상: {annotation.applies_to}</div>}
                        {annotation.condition && <div>조건: {annotation.condition}</div>}
                        {annotation.effect && <div>동작: {annotation.effect}</div>}
                        <p className="whitespace-pre-wrap leading-relaxed">{annotation.body}</p>
                        <div className="flex flex-wrap gap-2">
                            <Button size="sm" variant="outline" disabled={saving} onClick={() => startEdit(annotation)}>
                                <Pencil className="h-3 w-3" />
                                수정
                            </Button>
                            {annotation.status === 'NEEDS_REVIEW' && (
                                <Button size="sm" variant="outline" disabled={saving} onClick={() => confirm(annotation)}>
                                    <CheckCircle className="h-3 w-3" />
                                    현재 원문 기준 유효
                                </Button>
                            )}
                            <Button
                                size="sm"
                                variant="ghost"
                                disabled={saving}
                                className="text-destructive hover:text-destructive"
                                onClick={() => handleDelete(annotation)}
                            >
                                <Trash2 className="h-3 w-3" />
                                삭제
                            </Button>
                        </div>
                    </div>
                ))}

                <div className="space-y-3 rounded-xl border border-dashed p-4">
                    <div className="font-medium">{editing ? '참고사항 수정' : '참고사항 추가'}</div>
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                        <div className="space-y-1">
                            <Label>종류</Label>
                            <Select value={form.kind} onValueChange={setField('kind')}>
                                <SelectTrigger>
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {(Object.keys(KIND_LABELS) as SpecAnnotationKind[]).map((kind) => (
                                        <SelectItem key={kind} value={kind}>
                                            {KIND_LABELS[kind]}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="space-y-1">
                            <Label htmlFor="spec-annotation-applies-to">대상 (선택)</Label>
                            <Input
                                id="spec-annotation-applies-to"
                                placeholder="예: 컴포넌트 정보 페이지 > 반입 요청 탭"
                                value={form.applies_to}
                                onChange={(event) => setField('applies_to')(event.target.value)}
                            />
                        </div>
                        <div className="space-y-1">
                            <Label htmlFor="spec-annotation-condition">조건 (선택)</Label>
                            <Input
                                id="spec-annotation-condition"
                                placeholder="예: 관리 > 컴포넌트 저장소에 저장소가 1개 이상 등록됨"
                                value={form.condition}
                                onChange={(event) => setField('condition')(event.target.value)}
                            />
                        </div>
                        <div className="space-y-1">
                            <Label htmlFor="spec-annotation-effect">동작 (선택)</Label>
                            <Input
                                id="spec-annotation-effect"
                                placeholder="예: 반입 요청 탭을 표시"
                                value={form.effect}
                                onChange={(event) => setField('effect')(event.target.value)}
                            />
                        </div>
                    </div>
                    <div className="space-y-1">
                        <Label htmlFor="spec-annotation-body">내용</Label>
                        <Textarea
                            id="spec-annotation-body"
                            rows={4}
                            placeholder="관리 > 컴포넌트 저장소에 컴포넌트 저장소가 1개 이상 등록되어 존재하는 경우, 컴포넌트 정보 페이지에 반입 요청 탭을 표시합니다."
                            value={form.body}
                            onChange={(event) => setField('body')(event.target.value)}
                        />
                    </div>
                    <div className="flex gap-2">
                        <Button size="sm" disabled={saving || !form.body.trim()} onClick={submit}>
                            {editing ? '수정 저장' : '추가'}
                        </Button>
                        {editing && (
                            <Button size="sm" variant="outline" disabled={saving} onClick={resetForm}>
                                취소
                            </Button>
                        )}
                    </div>
                </div>
            </CardContent>
        </Card>
    )
}
