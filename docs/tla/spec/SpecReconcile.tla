---------------------------- MODULE SpecReconcile ----------------------------
(***************************************************************************)
(* Worker authoritative reconciliation + backend manifest acceptance.      *)
(* One runner (concurrency is in ConcurrentRuns.tla).  Payloads are        *)
(* abstracted to SPMS item identities.                                     *)
(*                                                                         *)
(* Code mapping (worktree origin/main):                                    *)
(*  Start     docs_collector.py:906-926  (new run id per endpoint)         *)
(*  Ep(e)     docs_collector.py:930-1049 (enumerate :933-977,              *)
(*            finish_authoritative_reconciliation :983-991 ->              *)
(*            sync_state.py:336-419 which save()s at :419, evidence        *)
(*            :992-1045, exact refetch checked_at :1005/:1009, save :1048) *)
(*            source_key spms:<singular>:<id>  :954-959                    *)
(*  Submit    docs_collector.py:1069-1167 (completed_at :1075, evidence    *)
(*            dropped unless complete :1161, submit :1164)                 *)
(*            backend specLifecycleService.ts:218-426 (one transaction:    *)
(*            memo lookup :299-311 -> 404 rolls back everything,           *)
(*            cert window 15 min :41, tombstone :352-358)                  *)
(*            zod cap lifecycle_evidence .max(5000) specLifecycle.ts:54    *)
(*  Promotion SpecPromotionState.ts:125-165 (gap assumed satisfied: runs   *)
(*            are >= 30 min apart; see SpecPromotion.tla for the gap)      *)
(*                                                                         *)
(* Flags reproduce each hypothesis; "fix" flags model the proposed fix.    *)
(***************************************************************************)
EXTENDS Integers, FiniteSets

CONSTANTS FKeys,         \* function/information keys (resolvable via skald_spec_source)
          TKeys,         \* techs/troubleshoots keys (plain upsert_memo memos)
          KEY_BUG,       \* H1: lifecycle key spms:tech:<id> vs memo key spms:techs:<id>
          COMMIT_FIRST,  \* H2: local snapshot/absence advanced before the manifest is accepted
          SLOW,          \* H3: endpoints after the first take > 15 min
          FIX_CERT,      \* H3 fix: exact refetch / checked_at taken at submit time
          PRUNE,         \* H4 fix: stop re-sending absence for memos the backend tombstoned
          CAP,           \* zod max on lifecycle_evidence (5000 in code)
          MaxToggles, MaxEpErrs, MaxSubFails

Keys == FKeys \cup TKeys
Eps  == <<"F", "T">>                  \* functions/information first, techs/troubleshoots later
KeysOf(e) == IF e = "F" THEN FKeys ELSE TKeys
NextPc(e) == IF e = "F" THEN "T" ELSE "submit"
Resolvable(k) == k \in FKeys \/ ~KEY_BUG

VARIABLES spms, toggles,                \* environment: SPMS completed list
          snap, abs, tomb,              \* worker durable state (authoritative_snapshot,
                                        \*   absence_evidence run count 0..2, PRUNE memory)
          stSnap, stAbs,                \* staged copies (only used when ~COMMIT_FIRST)
          pc, incomplete, ev, runPresent,
          epErrs, subFails,
          bq, cnt, lastResult, rejStreak, lastAccPresent

vars == <<spms, toggles, snap, abs, tomb, stSnap, stAbs, pc, incomplete, ev, runPresent,
          epErrs, subFails, bq, cnt, lastResult, rejStreak, lastAccPresent>>

Init == /\ spms = Keys /\ toggles = 0
        /\ snap = Keys /\ abs = [k \in Keys |-> 0] /\ tomb = [k \in Keys |-> FALSE]
        /\ stSnap = Keys /\ stAbs = [k \in Keys |-> 0]
        /\ pc = "idle" /\ incomplete = FALSE /\ ev = {} /\ runPresent = {}
        /\ epErrs = 0 /\ subFails = 0
        /\ bq = [k \in Keys |-> "none"]
        /\ cnt = 2                       \* live state: promoted (2026-09-23)
        /\ lastResult = "none" /\ rejStreak = 0 /\ lastAccPresent = {}

\* SPMS adds/removes an item (deprecated, deleted, restored).
Toggle(k) == /\ toggles < MaxToggles
             /\ spms' = IF k \in spms THEN spms \ {k} ELSE spms \cup {k}
             /\ toggles' = toggles + 1
             /\ UNCHANGED <<snap, abs, tomb, stSnap, stAbs, pc, incomplete, ev, runPresent,
                            epErrs, subFails, bq, cnt, lastResult, rejStreak, lastAccPresent>>

Start == /\ pc = "idle"
         /\ pc' = "F" /\ incomplete' = FALSE /\ ev' = {} /\ runPresent' = {}
         /\ stSnap' = snap /\ stAbs' = abs
         /\ UNCHANGED <<spms, toggles, snap, abs, tomb, epErrs, subFails, bq, cnt,
                        lastResult, rejStreak, lastAccPresent>>

\* One endpoint: enumerate to the terminal page, finish, build evidence.
Ep(e) ==
  /\ pc = e
  /\ LET KE   == KeysOf(e)
         obs  == spms \cap KE
         bSnap == IF COMMIT_FIRST THEN snap ELSE stSnap
         bAbs  == IF COMMIT_FIRST THEN abs ELSE stAbs
         prevE == bSnap \cap KE
         absE  == prevE \ obs                                   \* sync_state.py:363-365
         nAbs(k) == IF k \in absE THEN (IF bAbs[k] = 0 THEN 1 ELSE 2) ELSE 0   \* :376-403
         newSnap == (bSnap \ KE) \cup obs \cup absE             \* :407 keeps absent keys
         newAbs  == [k \in Keys |-> IF k \in KE THEN nAbs(k) ELSE bAbs[k]]
         present == {k \in KE : k \in obs /\ (bAbs[k] > 0 \/ (PRUNE /\ tomb[k]))}  \* :995-1003
         absent  == {k \in KE : nAbs(k) > 0}                     \* :1004-1045
         newEv   == {[k |-> k, absent |-> FALSE, cert |-> FALSE, ep |-> e] : k \in present}
                    \cup {[k |-> k, absent |-> TRUE,
                           cert |-> (nAbs(k) = 2 /\ k \notin spms),    \* candidate + refetch 404
                           ep |-> e] : k \in absent}
     IN \/ /\ epErrs < MaxEpErrs                                 \* page error -> incomplete
           /\ epErrs' = epErrs + 1
           /\ incomplete' = TRUE                                 \* finish(complete=False) :350-358
           /\ UNCHANGED <<snap, abs, stSnap, stAbs, ev, runPresent>>
        \/ /\ ev' = ev \cup newEv
           /\ runPresent' = runPresent \cup obs
           /\ IF COMMIT_FIRST
                 THEN /\ snap' = newSnap /\ abs' = newAbs /\ UNCHANGED <<stSnap, stAbs>>
                 ELSE /\ stSnap' = newSnap /\ stAbs' = newAbs /\ UNCHANGED <<snap, abs>>
           /\ UNCHANGED <<epErrs, incomplete>>
  /\ pc' = NextPc(e)
  /\ UNCHANGED <<spms, toggles, tomb, subFails, bq, cnt, lastResult, rejStreak, lastAccPresent>>

Stale(x) == x.cert /\ x.ep = "F" /\ SLOW /\ ~FIX_CERT

Submit ==
  /\ pc = "submit"
  /\ LET complete == ~incomplete
         sendEv   == IF complete THEN ev ELSE {}                  \* :1161
         nowTomb  == {x.k : x \in {y \in sendEv : y.absent /\ y.cert /\ bq[y.k] \in {"quarantined", "tombstoned"}}}
         newBq    == [k \in Keys |->
                        IF \E x \in sendEv : x.k = k
                        THEN LET x == CHOOSE y \in sendEv : y.k = k IN
                             IF ~x.absent THEN "present"
                             ELSE IF k \in nowTomb THEN "tombstoned" ELSE "quarantined"
                        ELSE bq[k]]
         perm     == IF \E x \in sendEv : ~Resolvable(x.k) THEN "404_MEMO_NOT_FOUND"
                     ELSE IF \E x \in sendEv : Stale(x) THEN "400_STALE_CERT"
                     ELSE IF Cardinality(sendEv) > CAP THEN "400_CAP"
                     ELSE "none"
     IN \/ /\ perm # "none"                                      \* transaction rolled back
           /\ lastResult' = perm
           /\ rejStreak' = IF rejStreak < 3 THEN rejStreak + 1 ELSE 3
           /\ UNCHANGED <<bq, cnt, lastAccPresent, subFails, snap, abs, tomb>>
        \/ /\ perm = "none" /\ subFails < MaxSubFails              \* 429/503/network
           /\ subFails' = subFails + 1
           /\ lastResult' = "5xx"
           /\ UNCHANGED <<bq, cnt, lastAccPresent, rejStreak, snap, abs, tomb>>
        \/ /\ perm = "none"
           /\ bq' = newBq
           /\ cnt' = IF complete THEN (IF cnt = 2 THEN 2 ELSE cnt + 1) ELSE 0
           /\ lastResult' = IF complete THEN "ok" ELSE "ok_incomplete"
           /\ rejStreak' = 0
           /\ lastAccPresent' = IF complete THEN runPresent ELSE lastAccPresent
           /\ LET cSnap == IF COMMIT_FIRST THEN snap ELSE IF complete THEN stSnap ELSE snap
                  cAbs  == IF COMMIT_FIRST THEN abs  ELSE IF complete THEN stAbs  ELSE abs
              IN IF PRUNE
                 THEN /\ snap' = cSnap \ nowTomb
                      /\ abs' = [k \in Keys |-> IF k \in nowTomb THEN 0 ELSE cAbs[k]]
                      /\ tomb' = [k \in Keys |-> IF k \in nowTomb THEN TRUE
                                                 ELSE IF \E x \in sendEv : x.k = k /\ ~x.absent THEN FALSE
                                                 ELSE tomb[k]]
                 ELSE /\ snap' = cSnap /\ abs' = cAbs /\ UNCHANGED tomb
           /\ UNCHANGED subFails
  /\ pc' = "idle"
  /\ UNCHANGED <<spms, toggles, stSnap, stAbs, incomplete, ev, runPresent, epErrs>>

Next == \/ \E k \in Keys : Toggle(k)
        \/ Start \/ Ep("F") \/ Ep("T") \/ Submit

Spec == Init /\ [][Next]_vars /\ WF_vars(Start) /\ WF_vars(Ep("F")) /\ WF_vars(Ep("T")) /\ WF_vars(Submit)

-----------------------------------------------------------------------------
\* H2: after a complete manifest is accepted, nothing SPMS listed in that run is
\* still quarantined/tombstoned in Skald.
QuarantineConsistent == \A k \in lastAccPresent : bq[k] \in {"none", "present"}

\* H1/H4 consequence: promotion must not survive two consecutive permanently
\* rejected reconciliations (no accepted manifest = no freshness proof).
PromotionNotStale == cnt = 2 => rejStreak < 2

\* H4: the worker never re-sends absence evidence for a memo Skald already tombstoned.
EvidenceOnlyLive == \A x \in ev : (x.absent /\ pc = "submit") => bq[x.k] # "tombstoned"

\* H1/H3/H4: once SPMS and the infrastructure stop misbehaving, complete
\* manifests keep being accepted.
AcceptedInfinitelyOften == []<>(lastResult = "ok")
=============================================================================
