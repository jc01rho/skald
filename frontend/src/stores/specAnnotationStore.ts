import { create } from 'zustand'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { useProjectStore } from './projectStore'

export type SpecAnnotationKind = 'ADDITIONAL_NOTE' | 'AUTOMATION_HINT'
export type SpecAnnotationStatus = 'ACTIVE' | 'NEEDS_REVIEW' | 'ARCHIVED'

export interface SpecAnnotationSpec {
    source_id: string
    spec_id: string
    memo_id: string
    title: string
    code: string | null
    source_url: string | null
    active_revision_id: string | null
}

export interface SpecAnnotation {
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
    created_at: string
    updated_at: string
    version: number
}

export interface SpecAnnotationInput {
    kind: SpecAnnotationKind
    body: string
    condition: string
    effect: string
    applies_to: string
}

interface ListResponse {
    spec: SpecAnnotationSpec | null
    annotations: SpecAnnotation[]
}

interface SpecAnnotationState {
    memoUuid: string | null
    spec: SpecAnnotationSpec | null
    annotations: SpecAnnotation[]
    loading: boolean
    saving: boolean
    load: (memoUuid: string) => Promise<void>
    create: (input: SpecAnnotationInput) => Promise<boolean>
    update: (annotation: SpecAnnotation, input: SpecAnnotationInput) => Promise<boolean>
    archive: (annotation: SpecAnnotation) => Promise<boolean>
    confirm: (annotation: SpecAnnotation) => Promise<boolean>
}

const projectQuery = () => {
    const project = useProjectStore.getState().currentProject
    if (!project) throw new Error('No project selected')
    return `project_id=${project.uuid}`
}

export const useSpecAnnotationStore = create<SpecAnnotationState>((set, get) => {
    const replace = (next: SpecAnnotation) =>
        set({
            annotations: get()
                .annotations.map((item) => (item.uuid === next.uuid ? next : item))
                .filter((item) => item.status !== 'ARCHIVED'),
        })

    const mutate = async (
        request: () => Promise<{ data?: SpecAnnotation; error?: string }>,
        apply: (annotation: SpecAnnotation) => void,
        successMessage: string
    ) => {
        set({ saving: true })
        try {
            const response = await request()
            if (response.error || !response.data) {
                toast.error(`참고사항 저장 실패: ${response.error}`)
                return false
            }
            apply(response.data)
            toast.success(successMessage)
            return true
        } finally {
            set({ saving: false })
        }
    }

    return {
        memoUuid: null,
        spec: null,
        annotations: [],
        loading: false,
        saving: false,

        load: async (memoUuid) => {
            set({ memoUuid, spec: null, annotations: [], loading: true })
            try {
                const response = await api.get<ListResponse>(
                    `/v1/spec-annotations?memo_uuid=${memoUuid}&${projectQuery()}`
                )
                if (get().memoUuid !== memoUuid) return
                if (response.error || !response.data) {
                    toast.error(`참고사항 조회 실패: ${response.error}`)
                    return
                }
                set({ spec: response.data.spec, annotations: response.data.annotations })
            } finally {
                if (get().memoUuid === memoUuid) set({ loading: false })
            }
        },

        create: async (input) => {
            const memoUuid = get().memoUuid
            if (!memoUuid) return false
            return mutate(
                () =>
                    api.post<SpecAnnotation>(`/v1/spec-annotations?${projectQuery()}`, {
                        memo_uuid: memoUuid,
                        ...input,
                    }),
                (created) => set({ annotations: [...get().annotations, created] }),
                '참고사항을 추가했습니다'
            )
        },

        update: async (annotation, input) =>
            mutate(
                () =>
                    api.patch<SpecAnnotation>(`/v1/spec-annotations/${annotation.uuid}?${projectQuery()}`, {
                        version: annotation.version,
                        ...input,
                    }),
                replace,
                '참고사항을 수정했습니다'
            ),

        archive: async (annotation) =>
            mutate(
                () =>
                    api.post<SpecAnnotation>(`/v1/spec-annotations/${annotation.uuid}/archive?${projectQuery()}`, {
                        version: annotation.version,
                    }),
                replace,
                '참고사항을 보관했습니다'
            ),

        confirm: async (annotation) =>
            mutate(
                () =>
                    api.post<SpecAnnotation>(`/v1/spec-annotations/${annotation.uuid}/confirm?${projectQuery()}`, {
                        version: annotation.version,
                    }),
                replace,
                '현재 원문 기준으로 유효함을 확인했습니다'
            ),
    }
})
