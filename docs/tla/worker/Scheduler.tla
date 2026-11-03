------------------------------- MODULE Scheduler -------------------------------
(***************************************************************************)
(* Scheduled job vs. manual POST /sync overlap, and retry boundedness,    *)
(* for one source item (e.g. one Jira issue) in the single worker process *)
(* (StatefulSet replicas 1, k8s/worker-deployment.yaml:27).               *)
(*                                                                         *)
(*  - "cron": APScheduler job (scheduler.py:279-370). add_job sets no      *)
(*    max_instances, so the APScheduler 3.11 default max_instances=1      *)
(*    applies: a fire while the previous run is still running is skipped. *)
(*  - Manuals: POST /sync (api/routes.py:239-459). Each request awaits     *)
(*    collector.sync_all() inline; nothing shares a lock with the job, so *)
(*    any number of requests may run beside the job and beside each other.*)
(*  - Fetch  : the collector reads the item from the source (Jira search,  *)
(*    jira_collector.py:574-584).                                          *)
(*  - Write  : upsert_memo (skald.py:406-463) get/compare/update; POST     *)
(*    create is itself an upsert on the backend (createMemoUtils.ts:380-  *)
(*    404 reuses the existing memo on unique violation), so every write is *)
(*    "last writer wins".                                                  *)
(*  - Each HTTP call is wrapped in with_retry (retry.py:91-130,            *)
(*    stop_after_attempt(3), wait_exponential max 30s) inside the circuit *)
(*    breaker (skald.py:243-255), with httpx timeout 60s (skald.py:218).  *)
(*    WriteFail = one failed attempt; after MaxAttempts the item fails.   *)
(***************************************************************************)
EXTENDS Integers, FiniteSets

CONSTANTS Manuals,      \* ids of concurrent manual /sync requests
          MaxVer,       \* number of source edits
          MaxAttempts,  \* stop_after_attempt (retry.py:83,118)
          FIX           \* single-flight lock shared by the job and /sync

Runs == {"cron"} \cup Manuals

VARIABLES ver, skald, pc, buf, att
vars == <<ver, skald, pc, buf, att>>

Init ==
    /\ ver = 0
    /\ skald = -1
    /\ pc = [r \in Runs |-> "idle"]
    /\ buf = [r \in Runs |-> -1]
    /\ att = [r \in Runs |-> 0]

Free == \A r \in Runs : pc[r] = "idle"

\* APScheduler max_instances=1: only from idle. Manual: always allowed.
Start(r) ==
    /\ pc[r] = "idle"
    /\ FIX => Free
    /\ pc' = [pc EXCEPT ![r] = "fetch"]
    /\ UNCHANGED <<ver, skald, buf, att>>

Fetch(r) ==
    /\ pc[r] = "fetch"
    /\ buf' = [buf EXCEPT ![r] = ver]
    /\ att' = [att EXCEPT ![r] = 0]
    /\ pc' = [pc EXCEPT ![r] = "write"]
    /\ UNCHANGED <<ver, skald>>

WriteOk(r) ==
    /\ pc[r] = "write"
    /\ skald' = buf[r]
    /\ pc' = [pc EXCEPT ![r] = "idle"]
    /\ UNCHANGED <<ver, buf, att>>

\* One failed attempt; tenacity retries until stop_after_attempt, then the
\* item is counted as failed and the run ends (reraise=True).
WriteFail(r) ==
    /\ pc[r] = "write"
    /\ IF att[r] + 1 < MaxAttempts
       THEN /\ att' = [att EXCEPT ![r] = att[r] + 1]
            /\ UNCHANGED pc
       ELSE /\ pc' = [pc EXCEPT ![r] = "idle"]
            /\ UNCHANGED att
    /\ UNCHANGED <<ver, skald, buf>>

Edit ==
    /\ ver < MaxVer
    /\ ver' = ver + 1
    /\ UNCHANGED <<skald, pc, buf, att>>

Next ==
    \/ Edit
    \/ \E r \in Runs : Start(r) \/ Fetch(r) \/ WriteOk(r) \/ WriteFail(r)

Fairness ==
    /\ WF_vars(Start("cron"))
    /\ \A r \in Runs : WF_vars(Fetch(r)) /\ WF_vars(WriteOk(r) \/ WriteFail(r))
    /\ \A r \in Runs : SF_vars(WriteOk(r))     \* the backend eventually answers

Spec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------
TypeOK == /\ ver \in 0..MaxVer /\ skald \in -1..MaxVer
          /\ \A r \in Runs : att[r] \in 0..(MaxAttempts - 1)

\* Skald must never go back to an older version of the item.
NoRegression == [][skald' >= skald]_skald

\* Every run that starts ends (retry is bounded).
RunsTerminate == \A r \in Runs : (pc[r] # "idle") ~> (pc[r] = "idle")

\* Once edits stop, Skald converges to the latest version (Jira: the job
\* re-reads issues updated within the last day every 10 minutes).
EventuallyFresh == <>[](skald = ver)
=============================================================================
