---------------------------- MODULE PublishRace ----------------------------
(***************************************************************************)
(* stage-and-publish under the two docs jobs that publish the same SPMS    *)
(* items: the incremental docs_sync (CronTrigger) and the authoritative    *)
(* reconciliation (IntervalTrigger / manual /sync).  Both call             *)
(* DocsCollector.sync_item -> POST /api/v1/spec-revisions/stage-and-publish.*)
(*                                                                         *)
(* Code mapping (worktree origin/main):                                    *)
(*  Fetch    docs_collector.py:967 (auth detail), :1237 (incremental)      *)
(*  Publish  backend specRevisionService.ts:354-664, one transaction:      *)
(*           advisory lock on source_key (+relation targets) :372-375,     *)
(*           replay by idempotency key :390-410,                           *)
(*           STALE_REVISION if source_updated_at older :411-422,           *)
(*           memo by source.memo else client_reference_id = function code *)
(*           :425-456 (docs_collector.py:745 code as memo key), memo row   *)
(*           overwritten :449-456, active_revision_id :603-614             *)
(*  Drift    409 -> SkaldClientRequestError (clients/skald.py:64-75) ->    *)
(*           manifest error stage detail_or_publish (docs_collector.py:    *)
(*           969-972) -> revision_drift (:1151) -> run not clean ->        *)
(*           promotion reset (SpecPromotionState.ts:130-137)               *)
(*  Overlap  scheduler.py:297-319 (docs_sync cron and reconciliation       *)
(*           interval are independent; no shared lock)                     *)
(* Versions stand for SPMS date_updated (monotonic with edits).            *)
(* SHARED_CODE: the two SPMS ids carry the same function_id code.          *)
(* FIX_STALE: an older-than-active publish is reported as "superseded"     *)
(*            (not drift).  FIX_MEMO: memo key = immutable source key.     *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS Sources, Jobs, MaxEdits, SHARED_CODE, FIX_STALE, FIX_MEMO

VARIABLES spms, edits, active, memo, fetched, pc, authDrift

vars == <<spms, edits, active, memo, fetched, pc, authDrift>>

MemoOf(s) == IF SHARED_CODE /\ ~FIX_MEMO THEN "shared" ELSE s
Memos == {MemoOf(s) : s \in Sources}

Init == /\ spms = [s \in Sources |-> 1] /\ edits = 0
        /\ active = [s \in Sources |-> 1]
        /\ memo = [m \in Memos |-> "none"]                   \* whose content the memo row holds
        /\ fetched = [j \in Jobs |-> [s \in Sources |-> 0]]
        /\ pc = [j \in Jobs |-> [s \in Sources |-> "todo"]]
        /\ authDrift = FALSE

Edit(s) == /\ edits < MaxEdits
           /\ spms' = [spms EXCEPT ![s] = @ + 1] /\ edits' = edits + 1
           /\ UNCHANGED <<active, memo, fetched, pc, authDrift>>

Fetch(j, s) == /\ pc[j][s] = "todo"
               /\ fetched' = [fetched EXCEPT ![j][s] = spms[s]]
               /\ pc' = [pc EXCEPT ![j][s] = "fetched"]
               /\ UNCHANGED <<spms, edits, active, memo, authDrift>>

Publish(j, s) ==
  /\ pc[j][s] = "fetched"
  /\ LET v == fetched[j][s] IN
     IF v < active[s]
     THEN /\ authDrift' = (authDrift \/ (j = "auth" /\ ~FIX_STALE))     \* 409 STALE_REVISION
          /\ UNCHANGED <<active, memo>>
     ELSE /\ active' = [active EXCEPT ![s] = v]                         \* replay or new revision
          /\ memo' = [memo EXCEPT ![MemoOf(s)] = s]                      \* memo row overwritten
          /\ UNCHANGED authDrift
  /\ pc' = [pc EXCEPT ![j][s] = "done"]
  /\ UNCHANGED <<spms, edits, fetched>>

Next == \/ \E s \in Sources : Edit(s)
        \/ \E j \in Jobs, s \in Sources : Fetch(j, s) \/ Publish(j, s)

Done == \A j \in Jobs, s \in Sources : pc[j][s] = "done"
Spec == Init /\ [][Next \/ (Done /\ UNCHANGED vars)]_vars

-----------------------------------------------------------------------------
\* The authoritative run reports drift only when SPMS and Skald really diverge;
\* losing a publish race to a newer revision of the same SPMS item is not drift.
NoSpuriousDrift == ~authDrift

\* Every spec's memo (what RAG search / memo exact lookup serve) shows that spec.
MemoMatchesSource == \A s \in Sources :
    (\E j \in Jobs : pc[j][s] = "done") => memo[MemoOf(s)] = s
=============================================================================
