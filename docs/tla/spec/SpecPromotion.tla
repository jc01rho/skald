---------------------------- MODULE SpecPromotion ----------------------------
(***************************************************************************)
(* Backend promotion state machine for one scope (spms:all).               *)
(*                                                                         *)
(* Code mapping (worktree origin/main):                                    *)
(*  Submit      backend/src/services/specLifecycleService.ts:218-296       *)
(*              (advisory lock :220, replay :225-234, run row :260-279,    *)
(*               applyAuthoritativeRun :295)                               *)
(*  Apply       backend/src/entities/SpecPromotionState.ts:125-165         *)
(*  Clean       backend/src/entities/SpecReconciliationRun.ts:71-84        *)
(*  Quality     specLifecycleService.ts:464-561 (recordQualityEvaluation   *)
(*              binds evidence to last_clean_run_id :482-488)              *)
(*  Capability  SpecPromotionState.ts:118-121 (related/conflict need       *)
(*              quality_readiness.run_id = last_clean_run_id)              *)
(*                                                                         *)
(* The advisory lock (:220) serialises manifests per scope, so each Submit *)
(* is one atomic step.  Time is discrete; GAP ticks = 30 minutes.          *)
(* OUT_OF_ORDER lets a manifest carry a completed_at older than "now"      *)
(* (a run that finished earlier but is submitted later).                   *)
(***************************************************************************)
EXTENDS Integers, FiniteSets

CONSTANTS Runs,          \* run ids the worker may submit
          MaxT,          \* last clock value
          GAP,           \* MIN_AUTHORITATIVE_CLEAN_RUN_GAP_MS in ticks
          OUT_OF_ORDER   \* allow completed_at < now

None == "none"
NoTime == -1

VARIABLES now,          \* wall clock
          accepted,     \* run -> [clean, at] for persisted runs
          st,           \* "shadow" | "canary" | "promoted"
          cnt,          \* consecutive_clean_runs
          lastClean,    \* last_clean_run_id
          prevClean,    \* previous_clean_run_id
          lastAt,       \* last_clean_completed_at (or NoTime)
          quality       \* quality_readiness.reconciliation_run_id (or None)

vars == <<now, accepted, st, cnt, lastClean, prevClean, lastAt, quality>>

Init == /\ now = 0
        /\ accepted = [r \in {} |-> 0]
        /\ st = "shadow" /\ cnt = 0
        /\ lastClean = None /\ prevClean = None /\ lastAt = NoTime
        /\ quality = None

Tick == now < MaxT /\ now' = now + 1 /\ UNCHANGED <<accepted, st, cnt, lastClean, prevClean, lastAt, quality>>

\* SpecPromotionState.applyAuthoritativeRun (SpecPromotionState.ts:125-165)
Apply(r, clean, at) ==
    IF ~clean
    THEN /\ cnt' = 0 /\ lastClean' = None /\ prevClean' = None /\ lastAt' = NoTime
         /\ st' = "shadow" /\ quality' = None                       \* :129-137
    ELSE IF lastClean = r THEN UNCHANGED <<cnt, lastClean, prevClean, lastAt, st, quality>>   \* :140
    ELSE IF lastAt # NoTime /\ at < lastAt + GAP                      \* :142-149 (negative diff too)
         THEN UNCHANGED <<cnt, lastClean, prevClean, lastAt, st, quality>>
    ELSE LET c == IF cnt + 1 > 2 THEN 2 ELSE cnt + 1 IN             \* :155
         /\ quality' = None                                         \* :151
         /\ prevClean' = lastClean                                  \* :153
         /\ cnt' = c
         /\ lastClean' = r /\ lastAt' = at                          \* :156-157
         /\ st' = IF c >= 2 THEN "promoted" ELSE "canary"           \* :158-164

\* New manifest (specLifecycleService.ts:236-296).  Non-clean manifests may be
\* incomplete (completed_at null); `at` is then irrelevant to Apply.
SubmitNew(r) ==
    /\ r \notin DOMAIN accepted
    /\ \E clean \in BOOLEAN, at \in (IF OUT_OF_ORDER THEN 0..now ELSE {now}):
         /\ accepted' = [x \in DOMAIN accepted \cup {r} |->
                           IF x = r THEN [clean |-> clean, at |-> at] ELSE accepted[x]]
         /\ Apply(r, clean, at)
    /\ UNCHANGED now

\* Replay of a persisted run id (:225-234): same payload -> idempotent, other -> 409.
\* Either way nothing changes.
Replay(r) == r \in DOMAIN accepted /\ UNCHANGED vars

\* recordQualityEvaluation (:464-561): accepted only for the current last clean run.
RecordQuality ==
    /\ lastClean # None
    /\ quality' = lastClean
    /\ UNCHANGED <<now, accepted, st, cnt, lastClean, prevClean, lastAt>>

Next == Tick \/ RecordQuality \/ \E r \in Runs : SubmitNew(r) \/ Replay(r)

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
TypeOK == /\ st \in {"shadow", "canary", "promoted"} /\ cnt \in 0..2

\* State and counter agree.
StateMatchesCount == (st = "shadow" <=> cnt = 0) /\ (st = "canary" <=> cnt = 1)
                     /\ (st = "promoted" <=> cnt = 2)

\* Promotion is backed by two distinct clean runs at least GAP apart.
PromotedSound ==
    st = "promoted" =>
        /\ prevClean # None /\ lastClean # None /\ prevClean # lastClean
        /\ accepted[prevClean].clean /\ accepted[lastClean].clean
        /\ accepted[lastClean].at >= accepted[prevClean].at + GAP

\* A replayed / re-submitted run id can never resurrect promotion after a reset.
\* (checked by construction: Replay is UNCHANGED vars)

\* A non-clean run that completed BEFORE the last counted clean run must not
\* demote a promoted scope (only meaningful with OUT_OF_ORDER = TRUE).
OlderFailureDoesNotDemote ==
    [][ \A r \in Runs :
          (r \notin DOMAIN accepted /\ r \in DOMAIN accepted' /\ ~accepted'[r].clean
           /\ st = "promoted" /\ accepted'[r].at < lastAt)
          => st' = "promoted" ]_vars

\* Quality evidence survives further clean runs while promoted (capabilities
\* related/conflict_candidates stay advertised).
QualitySticky ==
    [][ (st = "promoted" /\ quality # None /\ st' = "promoted") => quality' # None ]_vars
=============================================================================
