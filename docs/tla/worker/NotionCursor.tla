----------------------------- MODULE NotionCursor -----------------------------
(***************************************************************************)
(* Incremental Notion sync cursor: notion_collector.py:497-611 with        *)
(* sync_state.py (record_sync_success 210-247, atomic save 138-177).       *)
(*                                                                         *)
(* Actors                                                                  *)
(*  - Notion users edit / delete pages (environment).                      *)
(*  - Sync runs, all in the single worker process (StatefulSet replicas 1, *)
(*    k8s/worker-deployment.yaml:27), one asyncio loop:                    *)
(*      "cron"   = notion_sync_job (scheduler.py:158-172, cron 355-365).   *)
(*                 APScheduler default max_instances=1: never overlaps     *)
(*                 itself.                                                 *)
(*      "manual" = POST /sync source=notion (api/routes.py:401-423). No    *)
(*                 lock against the cron run (CONCURRENT).                 *)
(*  - Pod crash/restart (CRASH): in-memory run state lost, the sync-state  *)
(*    file keeps the last saved cursor (save() is atomic, 138-177).        *)
(*                                                                         *)
(* Time: monotonic instant counter `now`; every Edit, Delete and run Start *)
(* takes a fresh, strictly larger instant. One Notion "minute" = 3         *)
(* instants. With ROUND, Notion reports last_edited_time truncated to the  *)
(* minute.                                                                 *)
(*                                                                         *)
(* Per run (await-separated steps):                                        *)
(*   Start   : run_started_at (508), cutoff := cursor (511-519), discovery *)
(*             of the tree (546, discover_child_pages 284-395) capturing   *)
(*             each page's last_edited_time (318/378). Only the first      *)
(*             max_pages-1 children are synced, because the root page      *)
(*             already used one slot of the 548 check.                     *)
(*   Meta    : stale check with the discovery-time last_edited_time        *)
(*             (_sync_page 441-452; 444 keeps the discovery value).        *)
(*   Content : fetch_all_block_children (454).                             *)
(*   Upsert  : skald.upsert_memo (469-481; skald.py:406-463 get/compare/   *)
(*             update; last writer wins).                                  *)
(*   Finish  : cursor := run_started_at (587-597).                         *)
(* Page fetch failures only keep the cursor (575-585) and are omitted.     *)
(***************************************************************************)
EXTENDS Integers, Sequences, FiniteSets

CONSTANTS MaxPages,    \* notion_max_pages (config.py:257, default 500)
          MaxNow, MaxEdits,
          ROUND,       \* Notion last_edited_time has minute precision
          CONCURRENT,  \* manual /sync may overlap the cron run
          DELETE,      \* users may delete/move pages out of the tree
          CRASH,       \* pod restarts mid-run
          FIX          \* proposed fixes (see README)

Order == <<"p1", "p2", "p3">>
Pages == {"p1", "p2", "p3"}
Runs  == IF CONCURRENT THEN {"cron", "manual"} ELSE {"cron"}
None  == -100
Never == 1000
Minute == 3
SyncLimit == MaxPages - 1        \* root counts in processed+failed+skipped (535-548)

Floor(t) == IF ROUND THEN (t \div Minute) * Minute ELSE t
Min(a, b) == IF a < b THEN a ELSE b

VARIABLES now, version, editTime, exists, delAt, skald, cursor, cleanAt,
          rpc, rstart, rcut, rlist, rseen, ridx, rbuf, rtrunc

vars == <<now, version, editTime, exists, delAt, skald, cursor, cleanAt,
          rpc, rstart, rcut, rlist, rseen, ridx, rbuf, rtrunc>>

ExistingSeq == SelectSeq(Order, LAMBDA p : exists[p])
NSynced == Min(SyncLimit, Len(ExistingSeq))
\* What the next run will actually sync (the rest is cut off by max_pages).
Covered == {ExistingSeq[i] : i \in 1..NSynced}
Discover == [i \in 1..NSynced |-> [p |-> ExistingSeq[i], et |-> Floor(editTime[ExistingSeq[i]])]]

Init ==
    /\ now = 0
    /\ version = [p \in Pages |-> 0]
    /\ editTime = [p \in Pages |-> 0]
    /\ exists = [p \in Pages |-> TRUE]
    /\ delAt = [p \in Pages |-> Never]
    /\ skald = [p \in Pages |-> -1]           \* -1 = no memo in Skald
    /\ cursor = None
    /\ cleanAt = -1
    /\ rpc = [r \in Runs |-> "idle"]
    /\ rstart = [r \in Runs |-> 0]
    /\ rcut = [r \in Runs |-> None]
    /\ rlist = [r \in Runs |-> <<>>]
    /\ rseen = [r \in Runs |-> {}]
    /\ ridx = [r \in Runs |-> 1]
    /\ rbuf = [r \in Runs |-> -1]
    /\ rtrunc = [r \in Runs |-> FALSE]

Env == <<version, editTime, exists, delAt>>
Cur(r) == rlist[r][ridx[r]]

Advance(r) ==
    IF ridx[r] >= Len(rlist[r])
    THEN rpc' = [rpc EXCEPT ![r] = "finish"] /\ UNCHANGED ridx
    ELSE rpc' = [rpc EXCEPT ![r] = "meta"] /\ ridx' = [ridx EXCEPT ![r] = ridx[r] + 1]

Start(r) ==
    /\ rpc[r] = "idle"
    /\ FIX => \A o \in Runs : rpc[o] = "idle"            \* fix: single-flight per source
    /\ now < MaxNow /\ now' = now + 1
    /\ rstart' = [rstart EXCEPT ![r] = now + 1]
    /\ rcut' = [rcut EXCEPT ![r] = cursor]
    /\ rlist' = [rlist EXCEPT ![r] = Discover]
    /\ rseen' = [rseen EXCEPT ![r] = {ExistingSeq[i] : i \in 1..Len(ExistingSeq)}]
    /\ rtrunc' = [rtrunc EXCEPT ![r] = Len(ExistingSeq) > SyncLimit]
    /\ ridx' = [ridx EXCEPT ![r] = 1]
    /\ rpc' = [rpc EXCEPT ![r] = IF Discover = <<>> THEN "finish" ELSE "meta"]
    /\ UNCHANGED <<Env, skald, cursor, cleanAt, rbuf>>

\* _sync_page 438-452: pages whose discovery-time last_edited_time <= cutoff are "skipped"
Meta(r) ==
    /\ rpc[r] = "meta"
    /\ LET e == Cur(r) IN
       IF rcut[r] # None /\ e.et <= rcut[r]                      \* _is_stale_page 419-428
       THEN Advance(r)
       ELSE rpc' = [rpc EXCEPT ![r] = "content"] /\ UNCHANGED ridx
    /\ UNCHANGED <<now, Env, skald, cursor, cleanAt, rstart, rcut, rlist, rseen, rbuf, rtrunc>>

\* fetch_all_block_children (454): content as of this instant
Content(r) ==
    /\ rpc[r] = "content"
    /\ rbuf' = [rbuf EXCEPT ![r] = version[Cur(r).p]]
    /\ rpc' = [rpc EXCEPT ![r] = "upsert"]
    /\ UNCHANGED <<now, Env, skald, cursor, cleanAt, rstart, rcut, rlist, rseen, ridx, rtrunc>>

\* upsert_memo (469-481): last writer wins
Upsert(r) ==
    /\ rpc[r] = "upsert"
    /\ skald' = [skald EXCEPT ![Cur(r).p] = rbuf[r]]
    /\ Advance(r)
    /\ UNCHANGED <<now, Env, cursor, cleanAt, rstart, rcut, rlist, rseen, rbuf, rtrunc>>

\* 587-597: cursor := run_started_at.
\* FIX: cursor := start of the minute minus one instant, keep the cursor when
\* max_pages truncated the run, and delete memos of pages no longer in the tree.
Finish(r) ==
    /\ rpc[r] = "finish"
    /\ cursor' = IF ~FIX THEN rstart[r]
                 ELSE IF rtrunc[r] THEN cursor
                 ELSE Floor(rstart[r]) - 1
    /\ skald' = IF FIX /\ ~rtrunc[r]
                THEN [p \in Pages |-> IF p \in rseen[r] THEN skald[p] ELSE -1]
                ELSE skald
    /\ cleanAt' = IF FIX /\ rtrunc[r] THEN cleanAt ELSE rstart[r]
    /\ rpc' = [rpc EXCEPT ![r] = "idle"]
    /\ UNCHANGED <<now, Env, rstart, rcut, rlist, rseen, ridx, rbuf, rtrunc>>

Crash ==
    /\ CRASH /\ \E r \in Runs : rpc[r] # "idle"
    /\ rpc' = [r \in Runs |-> "idle"]
    /\ UNCHANGED <<now, Env, skald, cursor, cleanAt, rstart, rcut, rlist, rseen, ridx, rbuf, rtrunc>>

Edit(p) ==
    /\ exists[p] /\ version[p] < MaxEdits
    /\ now < MaxNow /\ now' = now + 1
    /\ version' = [version EXCEPT ![p] = version[p] + 1]
    /\ editTime' = [editTime EXCEPT ![p] = now + 1]
    /\ UNCHANGED <<exists, delAt, skald, cursor, cleanAt,
                   rpc, rstart, rcut, rlist, rseen, ridx, rbuf, rtrunc>>

\* Page deleted or moved out of the root tree: no longer discovered.
Delete(p) ==
    /\ DELETE /\ exists[p] /\ Len(ExistingSeq) > 1
    /\ now < MaxNow /\ now' = now + 1
    /\ exists' = [exists EXCEPT ![p] = FALSE]
    /\ delAt' = [delAt EXCEPT ![p] = now + 1]
    /\ UNCHANGED <<version, editTime, skald, cursor, cleanAt,
                   rpc, rstart, rcut, rlist, rseen, ridx, rbuf, rtrunc>>

Next ==
    \/ \E r \in Runs : Start(r) \/ Meta(r) \/ Content(r) \/ Upsert(r) \/ Finish(r)
    \/ Crash
    \/ \E p \in Pages : Edit(p) \/ Delete(p)

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
AllIdle == \A r \in Runs : rpc[r] = "idle"

\* When no run is active, every page the next incremental run will classify as
\* unchanged (rounded last_edited_time <= cursor) must already hold its latest
\* content in Skald. Otherwise the edit is lost until the page is edited again
\* in a later minute.
NoSilentlySkippedEdit ==
    AllIdle =>
        \A p \in Covered :
            (cursor # None /\ Floor(editTime[p]) <= cursor) => skald[p] = version[p]

\* A page deleted before the start of the last completed run must not still be
\* searchable in Skald.
NoStaleOrphan ==
    \A p \in Pages : delAt[p] < cleanAt => skald[p] = -1
=============================================================================
