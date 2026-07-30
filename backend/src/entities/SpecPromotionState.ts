import { DeferMode, Entity, Enum, ManyToOne, PrimaryKey, Property, Unique } from '@mikro-orm/core'
import { Project } from '@/entities/Project'
import { SpecReconciliationRun } from '@/entities/SpecReconciliationRun'

export const MIN_AUTHORITATIVE_CLEAN_RUN_GAP_MS = 30 * 60 * 1000

export enum SpecPromotionStatus {
    SHADOW = 'shadow',
    CANARY_ELIGIBLE = 'canary_eligible',
    PROMOTED = 'promoted',
}

export type SpecNativeSurface = 'exact' | 'outgoing' | 'incoming' | 'traversal' | 'related' | 'conflict_candidates'

export interface SpecQualityReadinessThresholds {
    related_recall_at_50: number
    conflict_recall_at_20: number
    conflict_precision_at_20: number
    conflict_false_positives_per_query_max: number
    evidence_validity: number
    phrase_recall_at_10: number
    korean_no_result: true
}

export interface SpecQualityReadinessMetrics {
    related_recall_at_50: number
    conflict_recall_at_20: number
    conflict_precision_at_20: number
    conflict_false_positives_per_query_max: number
    evidence_validity: number
    phrase_recall_at_10: number
    korean_no_result: boolean
}

export interface SpecQualityReadinessEvidence {
    schema_version: '1.0'
    kind: 'skald.spec-quality-readiness'
    status: 'completed'
    pass: boolean
    artifact_sha256: string
    generated_at: string
    reviewed_at: string
    dataset: string
    version: string
    owner: string
    project_id: string
    scope_key: string
    reconciliation_run_id: string
    query_manifest_sha256: string
    thresholds: SpecQualityReadinessThresholds
    metrics: SpecQualityReadinessMetrics
    recorded_at: string
    recorded_by: string
    related_ready: boolean
    conflict_candidates_ready: boolean
}

export interface SpecCapabilityReadiness {
    exact: boolean
    outgoing: boolean
    incoming: boolean
    traversal: boolean
    related: boolean
    conflict_candidates: boolean
}
@Entity({ tableName: 'skald_spec_promotion_state' })
@Unique({ name: 'skald_spec_promotion_state_project_uuid_key', properties: ['project', 'uuid'] })
@Unique({ name: 'skald_spec_promotion_state_project_scope_key', properties: ['project', 'scope_key'] })
export class SpecPromotionState {
    @PrimaryKey({ type: 'uuid' })
    uuid!: string

    @Property({ length: 512 })
    scope_key!: string

    @Property()
    consecutive_clean_runs = 0

    @Property({ nullable: true, length: 512 })
    last_clean_run_id?: string | null

    @Property({ nullable: true, length: 512 })
    previous_clean_run_id?: string | null

    @Property({ nullable: true })
    last_clean_completed_at?: Date | null

    @Enum({ items: () => SpecPromotionStatus })
    state: SpecPromotionStatus = SpecPromotionStatus.SHADOW

    @Property({ nullable: true })
    promoted_at?: Date | null

    @Property({ type: 'jsonb', nullable: true })
    quality_readiness?: SpecQualityReadinessEvidence | null

    @Property()
    created_at!: Date

    @Property()
    updated_at!: Date

    @ManyToOne({
        entity: () => Project,
        fieldName: 'project_id',
        deferMode: DeferMode.INITIALLY_DEFERRED,
        index: 'skald_spec_promotion_state_project_id_idx',
    })
    project!: Project

    nativeCapabilityReadiness(): SpecCapabilityReadiness {
        const promoted = this.state === SpecPromotionStatus.PROMOTED
        return {
            exact: promoted,
            outgoing: promoted,
            incoming: promoted,
            traversal: promoted,
            related: promoted && this.quality_readiness?.related_ready === true &&
                this.quality_readiness.reconciliation_run_id === this.last_clean_run_id,
            conflict_candidates: promoted && this.quality_readiness?.conflict_candidates_ready === true &&
                this.quality_readiness.reconciliation_run_id === this.last_clean_run_id,
        }
    }

    applyAuthoritativeRun(run: SpecReconciliationRun): void {
        if (run.scope_key !== this.scope_key) throw new Error('Reconciliation run scope does not match promotion scope')

        this.updated_at = run.completed_at || new Date()
        if (!run.isCleanAuthoritative()) this.quality_readiness = null
        if (!run.isCleanAuthoritative()) {
            this.consecutive_clean_runs = 0
            this.last_clean_run_id = null
            this.previous_clean_run_id = null
            this.last_clean_completed_at = null
            this.state = SpecPromotionStatus.SHADOW
            this.promoted_at = null
            return
        }

        if (this.last_clean_run_id === run.run_id) return

        const previousCompletedAt = this.last_clean_completed_at
        if (
            previousCompletedAt &&
            run.completed_at &&
            run.completed_at.getTime() - previousCompletedAt.getTime() < MIN_AUTHORITATIVE_CLEAN_RUN_GAP_MS
        ) {
            return
        }

        this.quality_readiness = null

        this.previous_clean_run_id = this.last_clean_run_id || null

        this.consecutive_clean_runs = Math.min(this.consecutive_clean_runs + 1, 2)
        this.last_clean_run_id = run.run_id
        this.last_clean_completed_at = run.completed_at
        if (this.consecutive_clean_runs >= 2) {
            this.state = SpecPromotionStatus.PROMOTED
            this.promoted_at ||= run.completed_at
        } else {
            this.state = SpecPromotionStatus.CANARY_ELIGIBLE
            this.promoted_at = null
        }
    }
}
