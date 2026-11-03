--------------------------- MODULE ConcurrentRuns ---------------------------
(***************************************************************************)
(* H5: a manual POST /sync {source: docs, mode: authoritative} and the     *)
(* scheduled docs_reconciliation job (or a second manual request) running  *)
(* sync_authoritative_endpoint at the same time in the single worker pod.  *)
(* asyncio is single-threaded, so everything between two awaits is one    *)
(* atomic step.  One endpoint, NPages non-empty pages + one empty page.    *)
(*                                                                         *)
(* Code mapping (worktree origin/main):                                    *)
(*  Entry     api/routes.py:300-305, scheduler.py:99-108, 313-319          *)
(*            (no lock; APScheduler max_instances only stops the job       *)
(*            overlapping itself); k8s/worker-deployment.yaml:27 1 replica *)
(*  Begin     docs_collector.py:906-926, sync_state.py:272-280             *)
(*            (joins an existing reconciliation_run_id :909-911)           *)
(*  Fetch     docs_collector.py:935 (await)                                *)
(*  Record    docs_collector.py:952-965 -> sync_state.py:282-296           *)
(*            (raises "No authoritative reconciliation is active" :290-291)*)
(*  Detail    docs_collector.py:966-972 (await, errors caught)             *)
(*  Persist   docs_collector.py:973-977 -> sync_state.py:298-305 (raises)  *)
(*  Finish    docs_collector.py:979-991 -> sync_state.py:336-349           *)
(*            ("Reconciliation run mismatch")                              *)
(* LOCK = TRUE models the proposed fix: a process-wide asyncio.Lock that   *)
(* makes the second caller return 409 "reconciliation already running".   *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS Runners, NPages, LOCK, MaxRunIds

None == 0

VARIABLES runId, nextId, pending, persisted, snapshot, lockHolder,
          pc, myRun, page, outcome

vars == <<runId, nextId, pending, persisted, snapshot, lockHolder, pc, myRun, page, outcome>>

Init == /\ runId = None /\ nextId = 1 /\ pending = {} /\ persisted = 0
        /\ snapshot = {} /\ lockHolder = None
        /\ pc = [r \in Runners |-> "idle"] /\ myRun = [r \in Runners |-> None]
        /\ page = [r \in Runners |-> 0] /\ outcome = [r \in Runners |-> "none"]

Crash(r, why) == /\ pc' = [pc EXCEPT ![r] = "done"]
                 /\ outcome' = [outcome EXCEPT ![r] = why]
                 /\ lockHolder' = IF lockHolder = r THEN None ELSE lockHolder

\* Request arrives; synchronous code up to the first page fetch.
Begin(r) ==
  /\ pc[r] = "idle"
  /\ IF LOCK /\ lockHolder # None
     THEN /\ pc' = [pc EXCEPT ![r] = "done"]
          /\ outcome' = [outcome EXCEPT ![r] = "busy409"]
          /\ UNCHANGED <<runId, nextId, pending, persisted, myRun, page, lockHolder>>
     ELSE /\ lockHolder' = IF LOCK THEN r ELSE lockHolder
          /\ IF runId # None
             THEN /\ myRun' = [myRun EXCEPT ![r] = runId]              \* join :909-911
                  /\ page' = [page EXCEPT ![r] = persisted + 1]        \* :932
                  /\ UNCHANGED <<runId, nextId, pending, persisted>>
             ELSE /\ nextId < MaxRunIds
                  /\ runId' = nextId /\ nextId' = nextId + 1          \* :913-914
                  /\ myRun' = [myRun EXCEPT ![r] = nextId]
                  /\ pending' = {} /\ persisted' = 0                   \* :275, :926
                  /\ page' = [page EXCEPT ![r] = 1]
          /\ pc' = [pc EXCEPT ![r] = "fetch"]
          /\ UNCHANGED outcome
  /\ UNCHANGED snapshot

\* await page fetch returned: record presence of the page's item(s).
Record(r) ==
  /\ pc[r] = "fetch"
  /\ IF page[r] > NPages
     THEN /\ pc' = [pc EXCEPT ![r] = "finish"]                         \* empty terminal page
          /\ UNCHANGED <<pending, outcome, lockHolder>>
     ELSE IF runId = None
          THEN Crash(r, "NoActiveReconciliation") /\ UNCHANGED pending
          ELSE /\ pending' = pending \cup {page[r]}
               /\ pc' = [pc EXCEPT ![r] = "detail"]
               /\ UNCHANGED <<outcome, lockHolder>>
  /\ UNCHANGED <<runId, nextId, persisted, snapshot, myRun, page>>

\* await detail fetch + publish returned: persist manifest, go to next page.
Persist(r) ==
  /\ pc[r] = "detail"
  /\ IF runId = None
     THEN Crash(r, "NoActiveReconciliation") /\ UNCHANGED <<persisted, page>>
     ELSE /\ persisted' = page[r]                       \* writes its own manifest copy
          /\ page' = [page EXCEPT ![r] = page[r] + 1]
          /\ pc' = [pc EXCEPT ![r] = "fetch"]
          /\ UNCHANGED <<outcome, lockHolder>>
  /\ UNCHANGED <<runId, nextId, pending, snapshot, myRun>>

Finish(r) ==
  /\ pc[r] = "finish"
  /\ IF runId = None THEN Crash(r, "NoActiveReconciliation") /\ UNCHANGED <<snapshot, pending, runId>>  \* :982
     ELSE IF runId # myRun[r] THEN Crash(r, "RunMismatch") /\ UNCHANGED <<snapshot, pending, runId>>  \* sync_state.py:348-349
     ELSE /\ snapshot' = pending /\ pending' = {} /\ runId' = None
          /\ pc' = [pc EXCEPT ![r] = "done"]
          /\ outcome' = [outcome EXCEPT ![r] = "ok"]
          /\ lockHolder' = IF lockHolder = r THEN None ELSE lockHolder
  /\ UNCHANGED <<nextId, persisted, myRun, page>>

Next == \E r \in Runners : Begin(r) \/ Record(r) \/ Persist(r) \/ Finish(r)

Done == \A r \in Runners : pc[r] = "done"
Spec == Init /\ [][Next \/ (Done /\ UNCHANGED vars)]_vars

-----------------------------------------------------------------------------
\* No request fails with an internal error because another run is in flight.
NoCrash == \A r \in Runners : outcome[r] \notin {"NoActiveReconciliation", "RunMismatch"}

\* A successful finish always records the complete SPMS list.
SnapshotComplete == snapshot # {} => snapshot = 1..NPages
=============================================================================
