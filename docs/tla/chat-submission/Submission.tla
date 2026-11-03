---------------------------- MODULE Submission ----------------------------
(***************************************************************************)
(* Memo submission approval workflow.                                      *)
(*                                                                         *)
(* Code: backend/src/api/memoSubmission.ts (approve 596-675, reject        *)
(*       732-769), backend/src/lib/createMemoUtils.ts (createNewMemo       *)
(*       380-412, findExistingMemoForCreate 114-131, _createMemoObject     *)
(*       252-310, reuseExistingMemoForCreate 148-207,                      *)
(*       shouldEnqueueMemoProcessing 29-35, sendMemoForAsyncProcessing     *)
(*       366-379), migrations/Migration20260311093000.ts (partial unique   *)
(*       index on (project_id, client_reference_id)).                      *)
(*                                                                         *)
(* Each HTTP request is a process q.  Every await that touches the DB or   *)
(* the queue is a separate step.  api has replicas: 2 and requests carry   *)
(* no lock, so requests interleave freely (two reviewers, two tabs, or a   *)
(* client retry after a 500).                                              *)
(*                                                                         *)
(* FIX = TRUE models the proposed fix: one DB transaction that does a      *)
(* conditional status update (UPDATE ... WHERE status='pending') plus the  *)
(* memo insert plus an outbox row; a relay publishes the outbox later.     *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS Subs,      \* submissions (model values)
          Reqs,      \* concurrent HTTP requests (model values)
          HasRef,    \* submissions carry reference_id (client_reference_id)
          SameRef,   \* all submissions share one reference_id
          FIX,
          Sweeper,   \* memoProcessingServer/stuckMemoSweeper.ts enabled
          MaxMemos

NoRef == "none"
Ref(s) == IF ~HasRef THEN NoRef ELSE IF SameRef THEN "r0" ELSE s

VARIABLES status,   \* skald_memo_submission.status
          decided,  \* first decision ever written (history variable)
          memos,    \* skald_memo rows: [id, ref, owner (= metadata.submission_id), enq]
          nextId,
          outbox,   \* FIX only: memo ids waiting to be published
          pc, kind, sub, found, resp

vars == <<status, decided, memos, nextId, outbox, pc, kind, sub, found, resp>>

MemoIds == {m.id : m \in memos}
MemoById(i) == CHOOSE m \in memos : m.id = i
OwnedBy(s) == {m \in memos : m.owner = s}
WithRef(r) == {m \in memos : r # NoRef /\ m.ref = r}

Init ==
    /\ status = [s \in Subs |-> "pending"]
    /\ decided = [s \in Subs |-> "none"]
    /\ memos = {}
    /\ nextId = 1
    /\ outbox = {}
    /\ pc = [q \in Reqs |-> "idle"]
    /\ kind = [q \in Reqs |-> "none"]
    /\ sub = [q \in Reqs |-> CHOOSE s \in Subs : TRUE]
    /\ found = [q \in Reqs |-> 0]
    /\ resp = [q \in Reqs |-> "none"]

SetStatus(s, v) ==
    /\ status' = [status EXCEPT ![s] = v]
    /\ decided' = IF decided[s] = "none" THEN [decided EXCEPT ![s] = v] ELSE decided

Finish(q, r) == /\ resp' = [resp EXCEPT ![q] = r]
                /\ pc' = [pc EXCEPT ![q] = "done"]

Goto(q, l) == pc' = [pc EXCEPT ![q] = l]

\* A reviewer clicks approve or reject on some submission.
Start(q) ==
    /\ pc[q] = "idle"
    /\ \E k \in {"approve", "reject"}, s \in Subs :
        /\ kind' = [kind EXCEPT ![q] = k]
        /\ sub' = [sub EXCEPT ![q] = s]
        /\ Goto(q, IF k = "approve" THEN "a_read" ELSE "r_read")
    /\ UNCHANGED <<status, decided, memos, nextId, outbox, found, resp>>

(***************************** current code *******************************)

\* memoSubmission.ts:616 findOne + :622 status check (no lock, no version).
ARead(q) ==
    /\ ~FIX /\ pc[q] = "a_read"
    /\ IF status[sub[q]] # "pending"
         THEN Finish(q, "400")
         ELSE /\ Goto(q, "a_find") /\ UNCHANGED resp
    /\ UNCHANGED <<status, decided, memos, nextId, outbox, kind, sub, found>>

\* createMemoUtils.ts:382 findExistingMemoForCreate (by client_reference_id).
AFind(q) ==
    /\ ~FIX /\ pc[q] = "a_find"
    /\ LET ex == WithRef(Ref(sub[q])) IN
        IF ex # {}
          THEN /\ found' = [found EXCEPT ![q] = (CHOOSE m \in ex : TRUE).id]
               /\ Goto(q, "a_reuse")
          ELSE /\ Goto(q, "a_insert") /\ UNCHANGED found
    /\ UNCHANGED <<status, decided, memos, nextId, outbox, kind, sub, resp>>

\* createMemoUtils.ts:390 _createMemoObject: own forked em, own tx, commits
\* immediately.  Unique index only exists when client_reference_id IS NOT NULL;
\* on 23505 the code falls back to reuse (396-403).  Other DB error -> 500.
AInsert(q) ==
    /\ ~FIX /\ pc[q] = "a_insert"
    /\ LET s == sub[q]
           ex == WithRef(Ref(s)) IN
        \/ /\ ex # {}
           /\ found' = [found EXCEPT ![q] = (CHOOSE m \in ex : TRUE).id]
           /\ Goto(q, "a_reuse")
           /\ UNCHANGED <<memos, nextId, resp>>
        \/ /\ ex = {}
           /\ nextId <= MaxMemos
           /\ memos' = memos \cup {[id |-> nextId, ref |-> Ref(s), owner |-> s, enq |-> FALSE]}
           /\ found' = [found EXCEPT ![q] = nextId]
           /\ nextId' = nextId + 1
           /\ Goto(q, "a_enqueue")
           /\ UNCHANGED resp
        \/ /\ Finish(q, "500")          \* tx rolled back
           /\ UNCHANGED <<memos, nextId, found>>
    /\ UNCHANGED <<status, decided, outbox, kind, sub>>

\* createMemoUtils.ts:148-207 reuseExistingMemoForCreate overwrites metadata
\* (incl. submission_id) in its own tx; 386-387 enqueue only if content hash
\* changed.  Same submission => same content => hash equal => no enqueue.
AReuse(q) ==
    /\ ~FIX /\ pc[q] = "a_reuse"
    /\ LET s == sub[q]
           m == MemoById(found[q])
           shouldEnq == m.owner # s IN
        /\ memos' = (memos \ {m}) \cup {[m EXCEPT !.owner = s]}
        /\ Goto(q, IF shouldEnq THEN "a_enqueue" ELSE "a_flush")
    /\ UNCHANGED <<status, decided, nextId, outbox, kind, sub, found, resp>>

\* createMemoUtils.ts:407-409 sendMemoForAsyncProcessing; a throw propagates to
\* memoSubmission.ts:671 catch -> 500 while the memo row is already committed.
AEnqueue(q) ==
    /\ ~FIX /\ pc[q] = "a_enqueue"
    /\ LET m == MemoById(found[q]) IN
        \/ /\ memos' = (memos \ {m}) \cup {[m EXCEPT !.enq = TRUE]}
           /\ Goto(q, "a_flush") /\ UNCHANGED resp
        \/ /\ Finish(q, "500") /\ UNCHANGED memos
    /\ UNCHANGED <<status, decided, nextId, outbox, kind, sub, found>>

\* memoSubmission.ts:659-667 blind UPDATE of changed columns (no WHERE status).
AFlush(q) ==
    /\ ~FIX /\ pc[q] = "a_flush"
    /\ \/ /\ SetStatus(sub[q], "approved") /\ Finish(q, "ok")
       \/ /\ Finish(q, "500") /\ UNCHANGED <<status, decided>>
    /\ UNCHANGED <<memos, nextId, outbox, kind, sub, found>>

\* memoSubmission.ts:748 findOne + :754 check.
RRead(q) ==
    /\ ~FIX /\ pc[q] = "r_read"
    /\ IF status[sub[q]] # "pending"
         THEN Finish(q, "400")
         ELSE /\ Goto(q, "r_flush") /\ UNCHANGED resp
    /\ UNCHANGED <<status, decided, memos, nextId, outbox, kind, sub, found>>

\* memoSubmission.ts:758-766 blind UPDATE.
RFlush(q) ==
    /\ ~FIX /\ pc[q] = "r_flush"
    /\ SetStatus(sub[q], "rejected") /\ Finish(q, "ok")
    /\ UNCHANGED <<memos, nextId, outbox, kind, sub, found>>

(******************************* proposed fix *****************************)

\* One transaction: SELECT ... FOR UPDATE (or UPDATE ... WHERE status='pending'
\* RETURNING), refuse to take over a memo owned by another submission, insert
\* memo + outbox row, set status.  Either all commits or nothing.
FApprove(q) ==
    /\ FIX /\ pc[q] = "a_read"
    /\ LET s == sub[q]
           foreign == {m \in WithRef(Ref(s)) : m.owner # s} IN
        IF status[s] # "pending" THEN
            /\ Finish(q, "409") /\ UNCHANGED <<status, decided, memos, nextId, outbox>>
        ELSE IF foreign # {} THEN
            /\ Finish(q, "409") /\ UNCHANGED <<status, decided, memos, nextId, outbox>>
        ELSE
            \/ /\ OwnedBy(s) = {}
               /\ nextId <= MaxMemos
               /\ memos' = memos \cup {[id |-> nextId, ref |-> Ref(s), owner |-> s, enq |-> FALSE]}
               /\ outbox' = outbox \cup {nextId}
               /\ nextId' = nextId + 1
               /\ SetStatus(s, "approved")
               /\ Finish(q, "ok")
            \/ /\ Finish(q, "500")     \* tx rolled back, nothing visible
               /\ UNCHANGED <<status, decided, memos, nextId, outbox>>
    /\ UNCHANGED <<kind, sub, found>>

FReject(q) ==
    /\ FIX /\ pc[q] = "r_read"
    /\ IF status[sub[q]] = "pending"
         THEN SetStatus(sub[q], "rejected") /\ Finish(q, "ok")
         ELSE Finish(q, "409") /\ UNCHANGED <<status, decided>>
    /\ UNCHANGED <<memos, nextId, outbox, kind, sub, found>>

\* Outbox relay: publish, mark enqueued, delete outbox row.  Publish failures
\* are just "not taking this step yet" (retried).
Relay(i) ==
    /\ FIX /\ i \in outbox
    /\ LET m == MemoById(i) IN memos' = (memos \ {m}) \cup {[m EXCEPT !.enq = TRUE]}
    /\ outbox' = outbox \ {i}
    /\ UNCHANGED <<status, decided, nextId, pc, kind, sub, found, resp>>

\* stuckMemoSweeper.ts:55-79 CLAIM_SQL + publish: any memo still 'received'
\* after receivedStaleMinutes is re-published, regardless of who owns it or
\* whether its submission was ever approved.  (MEMO_STUCK_SWEEP_ENABLED defaults
\* to true, settings.ts:88; started in rabbitmq mode, memoProcessingServer.ts:78.)
Sweep(i) ==
    /\ Sweeper
    /\ i \in MemoIds
    /\ ~MemoById(i).enq
    /\ LET m == MemoById(i) IN memos' = (memos \ {m}) \cup {[m EXCEPT !.enq = TRUE]}
    /\ UNCHANGED <<status, decided, nextId, outbox, pc, kind, sub, found, resp>>

Next ==
    \/ \E q \in Reqs : Start(q) \/ ARead(q) \/ AFind(q) \/ AInsert(q) \/ AReuse(q)
                       \/ AEnqueue(q) \/ AFlush(q) \/ RRead(q) \/ RFlush(q)
                       \/ FApprove(q) \/ FReject(q)
    \/ \E i \in 1..MaxMemos : Relay(i) \/ Sweep(i)

Spec == Init /\ [][Next]_vars
        /\ \A i \in 1..MaxMemos : WF_vars(Relay(i)) /\ WF_vars(Sweep(i))

(******************************* properties *******************************)

NoDuplicateMemo == \A s \in Subs : Cardinality(OwnedBy(s)) <= 1

DecisionFinal == \A s \in Subs : status[s] = "pending" \/ status[s] = decided[s]

RejectedHasNoMemo == \A s \in Subs : status[s] = "rejected" => OwnedBy(s) = {}

\* No request is in flight (transient states during a request are not errors).
Quiescent == \A q \in Reqs : pc[q] \in {"idle", "done"}

ApprovedHasMemo == Quiescent => \A s \in Subs : status[s] = "approved" => OwnedBy(s) # {}

NoConflictingSuccess ==
    ~\E q1, q2 \in Reqs :
        /\ sub[q1] = sub[q2]
        /\ kind[q1] = "approve" /\ kind[q2] = "reject"
        /\ resp[q1] = "ok" /\ resp[q2] = "ok"

\* A reviewer was told "approved" => the memo will be processed (queued now or
\* sitting in the outbox that is drained by Relay).
OkImpliesProcessed ==
    Quiescent => \A q \in Reqs :
        (kind[q] = "approve" /\ resp[q] = "ok") =>
            \E m \in OwnedBy(sub[q]) : m.enq \/ m.id \in outbox

\* A memo that got processed (chunked, embedded, is_public = true, therefore
\* returned by listPublicMemos and by RAG search) belongs to an approved
\* submission once all requests are finished.
PublishedOnlyIfApproved ==
    Quiescent => \A m \in memos : m.enq => status[m.owner] = "approved"

\* Liveness: an approved submission's memo eventually gets processed.
ApprovedEventuallyProcessed ==
    \A s \in Subs : (status[s] = "approved") ~> (\E m \in OwnedBy(s) : m.enq)

OutboxDrains == \A i \in 1..MaxMemos : (i \in outbox) ~> (i \notin outbox)
=============================================================================
