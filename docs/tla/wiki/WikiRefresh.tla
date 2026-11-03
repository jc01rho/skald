---------------------------- MODULE WikiRefresh ----------------------------
(***************************************************************************)
(* Wiki refresh-request queue for ONE memo / ONE RawSourceDocument whose   *)
(* compile always lands on the same wiki page (same slug).                 *)
(*                                                                         *)
(* Code mapping (backend/src, worktree origin/main):                       *)
(*  MP_Process  memoProcessingServer/processMemo.ts:111-117 +              *)
(*              services/wiki/wikiCompilerService.ts:162-307               *)
(*              (syncRawSourceFromMemo flush :236, enqueueRefreshForMemo   *)
(*               flush :287/:305, then dispatchRefreshRequest :309-317 ->  *)
(*               lib/wikiQueueClient.ts:52-64 publish; a publish error     *)
(*               throws out of processMemo :136-156 and the memo message   *)
(*               is retried, but the retry sees shouldEnqueue=false :269)  *)
(*  Take/Ack/Nack  wikiProcessingServer/rabbitMqConsumer.ts:33-51          *)
(*              (prefetch = WIKI_BATCH_SIZE=5 -> concurrent handlers, :24; *)
(*               k8s rollout maxSurge=1 overlaps two pods)                 *)
(*  Batch       wikiCompilerService.ts:319-343 (cleanupStaleRequests) +    *)
(*              :357-370 (find pending, no row lock)                       *)
(*  Claim       wikiCompilerService.ts:374-407 (blind status writes)       *)
(*  Start       wikiCompilerService.ts:429-451 (read status, then write    *)
(*              processing; accepts pending|claimed; ignores claim_token;  *)
(*              inserts a WikiCompileRun 'processing' :433-451)            *)
(*  Read        wikiCompilerService.ts:471-475 latest RawSourceContent by  *)
(*              created_at; :547 page found, revision_count read :567      *)
(*  LlmFail     :517-529 throws -> catch :797-807 -> 'failed'              *)
(*  Commit      :555-796 single flush :789-796.                            *)
(*              - revision INSERT version = revision_count+1 read earlier; *)
(*                unique (wiki_page_id, version) (Migration20260407120000  *)
(*                :34) -> immediate 23505 when someone committed in        *)
(*                between. MikroORM 6.5.9 (UnitOfWork.js:788-811): the     *)
(*                failed INSERT never reaches register(), so the catch     *)
(*                re-flush :806 re-issues the same INSERT and throws again *)
(*                (probe in README). Request row keeps its value, the      *)
(*                WikiCompileRun stays 'processing', handler nacks (:47).  *)
(*              - memo deleted meanwhile: wiki_source_ref.memo_id FK is    *)
(*                DEFERRABLE INITIALLY DEFERRED (Migration20260407143000   *)
(*                :205) -> 23503 at COMMIT, after the INSERTs succeeded    *)
(*                and were registered -> the catch re-flush only UPDATEs   *)
(*                status='failed' and succeeds (probe in README).          *)
(*  UserUpdate  api/memo.ts:378-431 (content change -> processMemo job)    *)
(*  UserDelete  api/memo.ts:558-564 (no wiki cleanup at all)               *)
(*  Expire      WIKI_STALE_THRESHOLD_SECONDS=900 (settings.ts:280)         *)
(*                                                                         *)
(* Fixes is a set of fix names; each fix can be switched on independently *)
(* so that every defect can be isolated by a config.                       *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, Sequences, TLC

CONSTANTS
    Workers,      \* concurrent consumer handlers (prefetch / pods)
    Contents,     \* possible memo contents (abstract hashes)
    InitContent,  \* content of the memo when created
    MaxUpdates,   \* bound on user content updates
    MaxReq,       \* bound on WikiRefreshRequest rows
    MaxExtra,     \* bound on unrelated wake-up messages (other memos of the project)
    MaxCrash,     \* bound on consumer crashes (pod kill / OOM / rollout)
    MaxFail,      \* bound on LLM / parse failures
    MaxPubFail,   \* bound on publishWikiRefresh failures (broker down / timeout)
    ALLOW_DELETE, \* user may delete the memo
    SLOW,         \* a compile may outlive WIKI_STALE_THRESHOLD_SECONDS
    Fixes         \* subset of FixNames

FixNames == {"claimCAS", "commitCAS", "freshCommit", "enqueueNew", "latestContent", "replaceClaims",
             "deleteCleanup", "retryFailed", "sweeper", "republish", "pageLock", "runCleanup"}

ASSUME Fixes \subseteq FixNames
ASSUME InitContent \in Contents

None == "none"
Reqs == 1..MaxReq
Busy == {"start", "start2", "read", "llm", "commit"}   \* worker holds cur[w]
RunOpen == {"read", "llm", "commit"}         \* WikiCompileRun row exists ('processing')

VARIABLES
    memoContent, memoAlive, updates, memoJobs,
    raw,          \* Seq of RawSourceContent.content in created_at order
    status, token, expired, commits,
    lastCompiled, \* content the wiki was last successfully compiled from
    claims,       \* contents for which WikiClaim rows exist
    pageVer,      \* WikiPage.revision_count
    orphanRuns,   \* WikiCompileRun rows left 'processing' forever
    msgs, extra, crashes, fails, pubFails,
    pc, cur, cands, wContent, wVer

vars == <<memoContent, memoAlive, updates, memoJobs, raw, status, token,
          expired, commits, lastCompiled, claims, pageVer, orphanRuns,
          msgs, extra, crashes, fails, pubFails, pc, cur, cands, wContent, wVer>>

Has(f) == f \in Fixes
Range(s) == {s[i] : i \in 1..Len(s)}
Last(s) == s[Len(s)]
Min(S) == CHOOSE x \in S : \A y \in S : x <= y

Statuses == {"none", "pending", "claimed", "processing", "completed", "failed"}
PcVals == {"idle", "batch", "claim", "start", "start2", "read", "llm", "commit", "ack", "nack"}

TypeOK ==
    /\ memoContent \in Contents
    /\ memoAlive \in BOOLEAN
    /\ status \in [Reqs -> Statuses]
    /\ token \in [Reqs -> Workers \cup {None}]
    /\ expired \in [Reqs -> BOOLEAN]
    /\ commits \in [Reqs -> Nat]
    /\ lastCompiled \in Contents \cup {None}
    /\ claims \subseteq Contents
    /\ pageVer \in Nat
    /\ orphanRuns \in Nat
    /\ pc \in [Workers -> PcVals]
    /\ cur \in [Workers -> Reqs \cup {0}]
    /\ cands \in [Workers -> SUBSET Reqs]
    /\ wContent \in [Workers -> Contents \cup {None}]
    /\ wVer \in [Workers -> Nat]

Init ==
    /\ memoContent = InitContent
    /\ memoAlive = TRUE
    /\ updates = 0
    /\ memoJobs = 1              \* memo creation -> process_memo message
    /\ raw = << >>
    /\ status = [r \in Reqs |-> "none"]
    /\ token = [r \in Reqs |-> None]
    /\ expired = [r \in Reqs |-> FALSE]
    /\ commits = [r \in Reqs |-> 0]
    /\ lastCompiled = None
    /\ claims = {}
    /\ pageVer = 0
    /\ orphanRuns = 0
    /\ msgs = 0 /\ extra = 0 /\ crashes = 0 /\ fails = 0 /\ pubFails = 0
    /\ pc = [w \in Workers |-> "idle"]
    /\ cur = [w \in Workers |-> 0]
    /\ cands = [w \in Workers |-> {}]
    /\ wContent = [w \in Workers |-> None]
    /\ wVer = [w \in Workers |-> 0]

-----------------------------------------------------------------------------
(* Environment: user actions                                               *)

UserUpdate ==
    /\ memoAlive /\ updates < MaxUpdates
    /\ \E c \in Contents \ {memoContent} :
         memoContent' = c
    /\ updates' = updates + 1
    /\ memoJobs' = memoJobs + 1
    /\ UNCHANGED <<memoAlive, raw, status, token, expired, commits, lastCompiled,
                   claims, pageVer, orphanRuns, msgs, extra, crashes, fails, pubFails,
                   pc, cur, cands, wContent, wVer>>

\* api/memo.ts:558-564 deletes Memo/Content/Summary/Tag/Chunk only.
\* FIX deleteCleanup: same transaction deletes this source's claims/source refs
\* (claims/lastCompiled here stand for this source's contribution to the page)
\* and cancels open refresh requests.
UserDelete ==
    /\ ALLOW_DELETE /\ memoAlive
    /\ memoAlive' = FALSE
    /\ IF Has("deleteCleanup")
         THEN /\ claims' = {}
              /\ lastCompiled' = None
              /\ status' = [r \in Reqs |-> IF status[r] = "pending" THEN "completed" ELSE status[r]]
         ELSE UNCHANGED <<claims, lastCompiled, status>>
    /\ UNCHANGED <<memoContent, updates, memoJobs, raw, token, expired, commits,
                   pageVer, orphanRuns, msgs, extra, crashes, fails, pubFails,
                   pc, cur, cands, wContent, wVer>>

\* Messages from other memos of the same project / backfill batch_tick.
OtherTraffic ==
    /\ extra < MaxExtra
    /\ extra' = extra + 1
    /\ msgs' = msgs + 1
    /\ UNCHANGED <<memoContent, memoAlive, updates, memoJobs, raw, status, token,
                   expired, commits, lastCompiled, claims, pageVer, orphanRuns,
                   crashes, fails, pubFails, pc, cur, cands, wContent, wVer>>

\* Time passes beyond WIKI_STALE_THRESHOLD_SECONDS for a claimed/processing row.
\* Without SLOW this only happens when no live worker is working on the row.
Expire(r) ==
    /\ status[r] \in {"claimed", "processing"}
    /\ ~expired[r]
    /\ SLOW \/ ~(\E w \in Workers : pc[w] \in Busy /\ cur[w] = r)
    /\ expired' = [expired EXCEPT ![r] = TRUE]
    /\ UNCHANGED <<memoContent, memoAlive, updates, memoJobs, raw, status, token,
                   commits, lastCompiled, claims, pageVer, orphanRuns, msgs, extra,
                   crashes, fails, pubFails, pc, cur, cands, wContent, wVer>>

SweepNeeded ==
    \E r \in Reqs : \/ status[r] = "pending"
                    \/ (status[r] \in {"claimed", "processing"} /\ expired[r])

\* FIX sweeper: periodic batch_tick publisher (does not exist in the code).
Sweep ==
    /\ Has("sweeper")
    /\ msgs = 0
    /\ SweepNeeded
    /\ msgs' = 1
    /\ UNCHANGED <<memoContent, memoAlive, updates, memoJobs, raw, status, token,
                   expired, commits, lastCompiled, claims, pageVer, orphanRuns,
                   extra, crashes, fails, pubFails, pc, cur, cands, wContent, wVer>>

-----------------------------------------------------------------------------
(* Memo processing server: processMemo -> enqueueRefreshForMemo -> publish *)

FreeReq == {r \in Reqs : status[r] = "none"}

MP_Process ==
    /\ memoJobs > 0
    /\ IF ~memoAlive
         THEN /\ memoJobs' = memoJobs - 1
              /\ UNCHANGED <<raw, status, msgs, pubFails>>   \* MemoNotFoundError
         ELSE
         LET c == memoContent
             \* :209-214 dedups by (document, content_hash) over ALL history.
             \* FIX latestContent: new row whenever latest row differs.
             isNew == IF Has("latestContent")
                        THEN IF raw = << >> THEN TRUE ELSE Last(raw) # c
                        ELSE c \notin Range(raw)
             raw2 == IF isNew THEN Append(raw, c) ELSE raw
             anyReq == \E r \in Reqs : status[r] # "none"
             \* :258-262 treats claimed/processing as "pending".
             openSt == IF Has("enqueueNew") THEN {"pending"}
                                            ELSE {"pending", "claimed", "processing"}
             existingOpen == \E r \in Reqs : status[r] \in openSt
             should == isNew \/ ~anyReq                       \* :269
             \* FIX republish: an unchanged memo whose request is still pending
             \* publishes the (idempotent) wake-up again.
             rewake == Has("republish") /\ \E r \in Reqs : status[r] = "pending"
             st2 == IF ~should THEN status
                    ELSE IF existingOpen THEN status          \* :276-288 touch only
                    ELSE [status EXCEPT ![Min(FreeReq)] = "pending"]   \* :290-305
             publishes == should \/ rewake
         IN
         /\ IF should /\ ~existingOpen THEN FreeReq # {} ELSE TRUE
         /\ raw' = raw2
         /\ status' = st2                                    \* flushed before publish
         /\ \/ /\ publishes                                   \* processMemo.ts:113 ok
               /\ msgs' = msgs + 1
               /\ memoJobs' = memoJobs - 1
               /\ UNCHANGED pubFails
            \/ /\ ~publishes
               /\ memoJobs' = memoJobs - 1
               /\ UNCHANGED <<msgs, pubFails>>
            \/ /\ publishes /\ pubFails < MaxPubFail          \* publish throws:
               /\ pubFails' = pubFails + 1                    \* DB rows already committed,
               /\ UNCHANGED <<msgs, memoJobs>>                \* memo message retried
    /\ UNCHANGED <<memoContent, memoAlive, updates, token, expired, commits,
                   lastCompiled, claims, pageVer, orphanRuns, extra, crashes, fails,
                   pc, cur, cands, wContent, wVer>>

-----------------------------------------------------------------------------
(* Wiki processing server consumer handler w                               *)

Take(w) ==
    /\ pc[w] = "idle" /\ msgs > 0
    /\ msgs' = msgs - 1
    /\ pc' = [pc EXCEPT ![w] = "batch"]
    /\ UNCHANGED <<memoContent, memoAlive, updates, memoJobs, raw, status, token,
                   expired, commits, lastCompiled, claims, pageVer, orphanRuns,
                   extra, crashes, fails, pubFails, cur, cands, wContent, wVer>>

\* cleanupStaleRequests (:319-343) then SELECT pending (:357-370).
\* FIX runCleanup: the same cleanup also fails WikiCompileRun rows that were
\* left 'processing' (abstracted: all orphans are old enough by then).
Batch(w) ==
    /\ pc[w] = "batch"
    /\ LET reset(r) == status[r] \in {"claimed", "processing"} /\ expired[r]
           st1 == [r \in Reqs |-> IF reset(r) THEN "pending" ELSE status[r]]
           pend == {r \in Reqs : st1[r] = "pending"}
       IN /\ status' = st1
          /\ token' = [r \in Reqs |-> IF reset(r) THEN None ELSE token[r]]
          /\ expired' = [r \in Reqs |-> IF reset(r) THEN FALSE ELSE expired[r]]
          /\ cands' = [cands EXCEPT ![w] = pend]
          /\ pc' = [pc EXCEPT ![w] = IF pend = {} THEN "ack" ELSE "claim"]
    /\ orphanRuns' = IF Has("runCleanup") THEN 0 ELSE orphanRuns
    /\ UNCHANGED <<memoContent, memoAlive, updates, memoJobs, raw, commits,
                   lastCompiled, claims, pageVer, msgs, extra, crashes, fails, pubFails,
                   cur, wContent, wVer>>

\* :374-407: oldest pending of the document -> 'claimed', the rest ->
\* 'completed' (superseded). MikroORM flush = UPDATE ... WHERE uuid=? (blind).
\* FIX claimCAS: UPDATE ... WHERE uuid=? AND status='pending'.
Claim(w) ==
    /\ pc[w] = "claim"
    /\ LET o == Min(cands[w])
           ok(r) == ~Has("claimCAS") \/ status[r] = "pending"
       IN /\ status' = [r \in Reqs |->
                          IF r = o /\ ok(r) THEN "claimed"
                          ELSE IF r \in cands[w] \ {o} /\ ok(r) THEN "completed"
                          ELSE status[r]]
          /\ token' = IF ok(o) THEN [token EXCEPT ![o] = w] ELSE token
          /\ expired' = IF ok(o) THEN [expired EXCEPT ![o] = FALSE] ELSE expired
          /\ cur' = [cur EXCEPT ![w] = o]
          /\ pc' = [pc EXCEPT ![w] = IF ok(o) THEN "start" ELSE "ack"]
    /\ UNCHANGED <<memoContent, memoAlive, updates, memoJobs, raw, commits,
                   lastCompiled, claims, pageVer, orphanRuns, msgs, extra, crashes,
                   fails, pubFails, cands, wContent, wVer>>

\* :431-436 findOne + check: accepts pending OR claimed, ignores claim_token.
\* FIX claimCAS: the transition is one UPDATE ... WHERE status='claimed'
\* AND claim_token=mine (check and write in one step).
Start(w) ==
    /\ pc[w] = "start"
    /\ LET r == cur[w]
           ok == IF Has("claimCAS")
                   THEN status[r] = "claimed" /\ token[r] = w
                   ELSE status[r] \in {"pending", "claimed"}
       IN IF ~ok
            THEN /\ pc' = [pc EXCEPT ![w] = "ack"]
                 /\ UNCHANGED <<status, token>>
            ELSE IF Has("claimCAS")
            THEN /\ status' = [status EXCEPT ![r] = "processing"]
                 /\ pc' = [pc EXCEPT ![w] = "read"]
                 /\ UNCHANGED token
            ELSE /\ pc' = [pc EXCEPT ![w] = "start2"]
                 /\ UNCHANGED <<status, token>>
    /\ UNCHANGED <<memoContent, memoAlive, updates, memoJobs, raw, expired, commits,
                   lastCompiled, claims, pageVer, orphanRuns, msgs, extra, crashes,
                   fails, pubFails, cur, cands, wContent, wVer>>

\* :438-446 status='processing' flushed blindly (another await later), then
\* the WikiCompileRun row is inserted (:433-451, folded into this step).
Start2(w) ==
    /\ pc[w] = "start2"
    /\ LET r == cur[w] IN
       /\ status' = [status EXCEPT ![r] = "processing"]
       /\ token' = [token EXCEPT ![r] = IF token[r] = None THEN w ELSE token[r]]
    /\ pc' = [pc EXCEPT ![w] = "read"]
    /\ UNCHANGED <<memoContent, memoAlive, updates, memoJobs, raw, expired, commits,
                   lastCompiled, claims, pageVer, orphanRuns, msgs, extra, crashes,
                   fails, pubFails, cur, cands, wContent, wVer>>

\* :471-475 latest RawSourceContent by created_at; :547/:567 page + revision_count.
Read(w) ==
    /\ pc[w] = "read"
    /\ wContent' = [wContent EXCEPT ![w] = Last(raw)]
    /\ wVer' = [wVer EXCEPT ![w] = pageVer]
    /\ pc' = [pc EXCEPT ![w] = "llm"]
    /\ UNCHANGED <<memoContent, memoAlive, updates, memoJobs, raw, status, token,
                   expired, commits, lastCompiled, claims, pageVer, orphanRuns, msgs,
                   extra, crashes, fails, pubFails, cur, cands>>

LlmOk(w) ==
    /\ pc[w] = "llm"
    /\ pc' = [pc EXCEPT ![w] = "commit"]
    /\ UNCHANGED <<memoContent, memoAlive, updates, memoJobs, raw, status, token,
                   expired, commits, lastCompiled, claims, pageVer, orphanRuns, msgs,
                   extra, crashes, fails, pubFails, cur, cands, wContent, wVer>>

\* catch :797-807 -> 'failed' (blind). Nothing ever re-enqueues a failed row
\* (enqueue :269 skips unchanged content). FIX retryFailed: back to pending
\* with a new wake-up message.
LlmFail(w) ==
    /\ pc[w] = "llm" /\ fails < MaxFail
    /\ fails' = fails + 1
    /\ LET r == cur[w]
           ok == ~Has("commitCAS") \/ (status[r] = "processing" /\ token[r] = w)
       IN
       IF ~ok THEN UNCHANGED <<status, token, msgs>>
       ELSE IF Has("retryFailed")
         THEN /\ status' = [status EXCEPT ![r] = "pending"]
              /\ token' = [token EXCEPT ![r] = None]
              /\ msgs' = msgs + 1
         ELSE /\ status' = [status EXCEPT ![r] = "failed"]
              /\ token' = [token EXCEPT ![r] = None]
              /\ UNCHANGED msgs
    /\ pc' = [pc EXCEPT ![w] = "ack"]
    /\ UNCHANGED <<memoContent, memoAlive, updates, memoJobs, raw, expired, commits,
                   lastCompiled, claims, pageVer, orphanRuns, extra, crashes, pubFails,
                   cur, cands, wContent, wVer>>

\* Final flush :789-796 (one transaction). Claims are only ever INSERTed
\* (:683), never deleted.
\* FIX commitCAS: final UPDATE ... WHERE claim_token = mine AND status='processing'
\*   in the same transaction as the page writes (zero rows -> roll back, mark run failed).
\* FIX freshCommit: compiled content must still be the latest raw content,
\*   otherwise the result is dropped as superseded (a newer request exists).
\* FIX pageLock: SELECT ... FOR UPDATE on the page inside the commit
\*   transaction and compute version from the locked row -> no 23505.
Commit(w) ==
    /\ pc[w] = "commit"
    /\ LET r == cur[w]
           ok == ~Has("commitCAS") \/ (status[r] = "processing" /\ token[r] = w)
           fresh == ~Has("freshCommit") \/ wContent[w] = Last(raw)
           clash == ~Has("pageLock") /\ wVer[w] # pageVer
       IN CASE ~ok ->
                 /\ pc' = [pc EXCEPT ![w] = "ack"]
                 /\ UNCHANGED <<status, token, commits, lastCompiled, claims, pageVer, orphanRuns>>
            [] ~fresh ->
                 /\ status' = [status EXCEPT ![r] = "completed"]
                 /\ token' = [token EXCEPT ![r] = None]
                 /\ pc' = [pc EXCEPT ![w] = "ack"]
                 /\ UNCHANGED <<commits, lastCompiled, claims, pageVer, orphanRuns>>
            [] clash ->
                 \* 23505 on (wiki_page_id, version); catch re-flush re-INSERTs and
                 \* throws again: request row unchanged, run orphaned, nack (:47).
                 /\ orphanRuns' = orphanRuns + 1
                 /\ pc' = [pc EXCEPT ![w] = "nack"]
                 /\ UNCHANGED <<status, token, commits, lastCompiled, claims, pageVer>>
            [] ~memoAlive ->
                 \* 23503 deferred FK at COMMIT; catch flush writes 'failed'.
                 /\ status' = [status EXCEPT ![r] = "failed"]
                 /\ token' = [token EXCEPT ![r] = None]
                 /\ pc' = [pc EXCEPT ![w] = "ack"]
                 /\ UNCHANGED <<commits, lastCompiled, claims, pageVer, orphanRuns>>
            [] OTHER ->
                 /\ lastCompiled' = wContent[w]
                 /\ claims' = IF Has("replaceClaims") THEN {wContent[w]}
                              ELSE claims \cup {wContent[w]}
                 /\ status' = [status EXCEPT ![r] = "completed"]
                 /\ token' = [token EXCEPT ![r] = None]
                 /\ commits' = [commits EXCEPT ![r] = @ + 1]
                 /\ pageVer' = pageVer + 1
                 /\ pc' = [pc EXCEPT ![w] = "ack"]
                 /\ UNCHANGED orphanRuns
    /\ UNCHANGED <<memoContent, memoAlive, updates, memoJobs, raw, expired, msgs,
                   extra, crashes, fails, pubFails, cur, cands, wContent, wVer>>

Ack(w) ==
    /\ pc[w] = "ack"
    /\ pc' = [pc EXCEPT ![w] = "idle"]
    /\ cur' = [cur EXCEPT ![w] = 0]
    /\ cands' = [cands EXCEPT ![w] = {}]
    /\ wContent' = [wContent EXCEPT ![w] = None]
    /\ UNCHANGED <<memoContent, memoAlive, updates, memoJobs, raw, status, token,
                   expired, commits, lastCompiled, claims, pageVer, orphanRuns, msgs,
                   extra, crashes, fails, pubFails, wVer>>

Nack(w) ==
    /\ pc[w] = "nack"
    /\ msgs' = msgs + 1
    /\ pc' = [pc EXCEPT ![w] = "idle"]
    /\ cur' = [cur EXCEPT ![w] = 0]
    /\ cands' = [cands EXCEPT ![w] = {}]
    /\ wContent' = [wContent EXCEPT ![w] = None]
    /\ UNCHANGED <<memoContent, memoAlive, updates, memoJobs, raw, status, token,
                   expired, commits, lastCompiled, claims, pageVer, orphanRuns, extra,
                   crashes, fails, pubFails, wVer>>

\* Pod/handler dies with an unacked message: RabbitMQ redelivers it.
\* A run created by Start stays 'processing' forever.
Crash(w) ==
    /\ pc[w] # "idle" /\ crashes < MaxCrash
    /\ crashes' = crashes + 1
    /\ msgs' = msgs + 1
    /\ orphanRuns' = IF pc[w] \in RunOpen THEN orphanRuns + 1 ELSE orphanRuns
    /\ pc' = [pc EXCEPT ![w] = "idle"]
    /\ cur' = [cur EXCEPT ![w] = 0]
    /\ cands' = [cands EXCEPT ![w] = {}]
    /\ wContent' = [wContent EXCEPT ![w] = None]
    /\ UNCHANGED <<memoContent, memoAlive, updates, memoJobs, raw, status, token,
                   expired, commits, lastCompiled, claims, pageVer, extra, fails,
                   pubFails, wVer>>

-----------------------------------------------------------------------------
Next ==
    \/ UserUpdate \/ UserDelete \/ OtherTraffic \/ Sweep \/ MP_Process
    \/ \E r \in Reqs : Expire(r)
    \/ \E w \in Workers : Take(w) \/ Batch(w) \/ Claim(w) \/ Start(w) \/ Start2(w) \/ Read(w)
                          \/ LlmOk(w) \/ LlmFail(w) \/ Commit(w) \/ Ack(w)
                          \/ Nack(w) \/ Crash(w)

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* Properties                                                              *)

\* Nothing left to do for the system (user may still act). Time has passed
\* for every claimed/processing row; with the sweeper fix nothing needs a tick.
Quiescent ==
    /\ msgs = 0 /\ memoJobs = 0
    /\ \A w \in Workers : pc[w] = "idle"
    /\ \A r \in Reqs : status[r] \in {"claimed", "processing"} => expired[r]
    /\ Has("sweeper") => ~SweepNeeded

\* A request's compile result is committed at most once.
NoDoubleCommit == \A r \in Reqs : commits[r] <= 1

\* When the system is idle the wiki reflects the memo's current content.
QuiescentFresh == (Quiescent /\ memoAlive) => lastCompiled = memoContent

\* When idle, claims exist only for the current content of a live memo.
QuiescentNoStaleClaims ==
    Quiescent => claims \subseteq (IF memoAlive THEN {memoContent} ELSE {})

\* When idle, no refresh request is left open.
QuiescentNoStuck ==
    Quiescent => \A r \in Reqs : status[r] \notin {"pending", "claimed", "processing"}

\* When idle, no WikiCompileRun row is left 'processing'.
QuiescentNoOrphanRun == Quiescent => orphanRuns = 0
=============================================================================
