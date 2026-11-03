---------------------------- MODULE MemoPipeline ----------------------------
(***************************************************************************)
(* Memo processing pipeline of Skald (backend, origin/main).               *)
(* All paths below are relative to backend/src/.                           *)
(*                                                                         *)
(* One memo, abstracted payloads.  Actors:                                 *)
(*   - creator   : lib/createMemoUtils.ts:380-411 (insert 'received' in a  *)
(*                 committed tx :251-313, then publish on a fresh,         *)
(*                 non-confirm AMQP channel :341-363)                      *)
(*   - reuse     : same endpoint, existing client_reference_id/source_url  *)
(*                 :148-207 (commit new content+metadata, status untouched)*)
(*                 then publish after commit :386-409                      *)
(*   - consumers : k8s memo-processing replicas (2), prefetch(1)           *)
(*                 memoProcessingServer/rabbitMqConsumer.ts:49,101-112     *)
(*                 -> memoProcessingServer/processMemo.ts:102-155          *)
(*   - sweepers  : one stuck-memo sweeper per replica                      *)
(*                 memoProcessingServer/stuckMemoSweeper.ts:80-131,        *)
(*                 started at memoProcessingServer.ts:78-91                *)
(*   - updater   : PATCH /memo api/memo.ts:342-439                         *)
(*   - lazy      : lib/lazyReprocessService.ts:86-114 (chat/search side,   *)
(*                 api/chat.ts:548, api/chat.ts:783, api/search.ts:94)     *)
(*   - metaWriter: metadata replace (api/memo.ts:417)                      *)
(*   - deleter   : DELETE /memo api/memo.ts:527-567                        *)
(*   - broker    : durable queue, unacked msgs requeued on crash           *)
(*                                                                         *)
(* Chunks are modelled as a set of <<writer, contentVersion>>; one element *)
(* stands for the whole parent/child/summary set written by one run.       *)
(* Two elements = two runs' chunk sets coexist (duplicates).               *)
(*                                                                         *)
(* Fix = TRUE switches to the proposed design (see README):               *)
(*   gen-fenced atomic chunk swap, update/reuse bump gen and mark          *)
(*   'received' in the content tx and publish after commit, SQL jsonb      *)
(*   merge for status writes, lazy reprocess only when contextual          *)
(*   retrieval is enabled and without deleting chunks, bounded retry for   *)
(*   poison messages, sweeper not gated on global queue idleness.          *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS Consumers, Sweepers,
          MaxPub,        \* bound on API-side publishes (update/reuse/lazy)
          MaxContent,    \* bound on content versions (updates/reuse)
          MaxMeta,       \* bound on user metadata writes
          MaxCrash,      \* bound on pod crashes
          MaxFail,       \* bound on transient processing errors (non-poison)
          MaxAttempts,   \* retry bound used only by the fixed design
          MaxLoss,       \* bound on lost/failed publishes
          MaxSweep,      \* bound on stuck_retry_count per stuck episode
          EnUpdate, EnReuse, EnLazy, EnMeta, EnDelete, EnCrash, EnFail,
          SlowProcessing, \* a run may exceed MEMO_STUCK_PROCESSING_STALE_MINUTES (120)
          NarrowGap,      \* sweeper may claim a 'received' memo whose message was
                          \* just delivered but processMemo has not yet written 'processing'
          PublishLoss,    \* sendToQueue without confirms may be lost / publish may throw
          Poison,         \* every processing attempt of this memo fails
          BusyQueue,      \* other traffic may keep the queue non-idle
          SlowPublish,    \* an API-side publish may take longer than
                          \* MEMO_STUCK_RECEIVED_STALE_MINUTES (10) after the commit
          CREnabled,      \* CONTEXTUAL_RETRIEVAL_ENABLED (memoOperations.ts:23)
          Fix

VARIABLES
    \* ---- DB (committed) ----
    mStatus,     \* skald_memo.processing_status (+ "deleted")
    contentVer,  \* committed skald_memocontent version
    gen,         \* processing generation (only meaningful when Fix)
    chunks,      \* committed chunk sets
    metaUser,    \* user-owned part of metadata (version number)
    metaWrites,  \* how many user metadata writes happened (expected metaUser)
    metaCR,      \* metadata.contextual_retrieval_applied
    stuckFirst,  \* metadata.stuck_retry_first_at IS NOT NULL
    sweeps,      \* metadata.stuck_retry_count
    \* ---- broker / environment ----
    ready,       \* ready messages for this memo in the queue
    pubs, losses, crashes, fails, attempts, bg,
    \* ---- consumers ----
    cs, myGen, readVer, snapMeta,
    \* ---- API-side actors ----
    upd, updLocked, rs, lz, cr, sw, del, delSeen,
    \* ---- history ----
    lazyWaste, delFailed

memoVars == <<mStatus, contentVer, gen, chunks, metaUser, metaWrites, metaCR, stuckFirst, sweeps>>
envVars  == <<ready, pubs, losses, crashes, fails, attempts, bg>>
conVars  == <<cs, myGen, readVer, snapMeta>>
apiVars  == <<upd, updLocked, rs, lz, cr, sw, del, delSeen, lazyWaste, delFailed>>
vars == <<memoVars, envVars, conVars, apiVars>>

CStates == {"idle", "got", "started", "read", "deleted", "inserted", "failed", "done"}

TypeOK ==
    /\ mStatus \in {"received", "processing", "processed", "error", "deleted"}
    /\ contentVer \in 1..MaxContent
    /\ chunks \subseteq (Consumers \X (1..MaxContent))
    /\ ready \in Nat
    /\ sweeps \in 0..MaxSweep
    /\ cs \in [Consumers -> CStates]
    /\ upd \in {"none", "open", "published", "committed"}
    /\ rs \in {"none", "committed"}
    /\ lz \in {"none", "deleted", "reset"}
    /\ cr \in {"pending", "done"}
    /\ sw \in [Sweepers -> {"idle", "claimed"}]
    /\ del \in {"none", "open", "memoDeleted"}
    /\ delSeen \subseteq (Consumers \X (1..MaxContent))

Init ==
    \* createMemoUtils.ts:251-313: memo committed as 'received' with content
    /\ mStatus = "received" /\ contentVer = 1 /\ gen = 1 /\ chunks = {}
    /\ metaUser = 0 /\ metaWrites = 0 /\ metaCR = FALSE /\ stuckFirst = FALSE /\ sweeps = 0
    /\ ready = 0 /\ pubs = 0 /\ losses = 0 /\ crashes = 0 /\ fails = 0 /\ attempts = 0 /\ bg = FALSE
    /\ cs = [c \in Consumers |-> "idle"]
    /\ myGen = [c \in Consumers |-> 0]
    /\ readVer = [c \in Consumers |-> 1]
    /\ snapMeta = [c \in Consumers |-> 0]
    /\ upd = "none" /\ updLocked = {} /\ rs = "none" /\ lz = "none" /\ cr = "pending"
    /\ sw = [s \in Sweepers |-> "idle"]
    /\ del = "none" /\ delSeen = {}
    /\ lazyWaste = FALSE /\ delFailed = FALSE

\* A publish either lands in the durable queue or (PublishLoss) is lost:
\* createMemoUtils.ts:341-363 and rabbitMqConsumer.ts:136-142 use sendToQueue
\* on a plain channel (no confirmSelect), so a broker crash/restart can drop
\* it; a publish that throws after the DB commit has the same effect.
Publish == \/ ready' = ready + 1 /\ UNCHANGED losses
           \/ (PublishLoss /\ losses < MaxLoss /\ losses' = losses + 1 /\ ready' = ready)

\* row lock held by an uncommitted DELETE /memo on the memo row
MemoRowFree == del # "memoDeleted"

SetC(f, c, v) == [f EXCEPT ![c] = v]

-----------------------------------------------------------------------------
(* Creator: createMemoUtils.ts:407-409                                     *)
CPublish ==
    /\ cr = "pending" /\ cr' = "done"
    /\ Publish
    /\ UNCHANGED <<memoVars, pubs, crashes, fails, attempts, bg, conVars,
                   upd, updLocked, rs, lz, sw, del, delSeen, lazyWaste, delFailed>>

-----------------------------------------------------------------------------
(* Consumer c (one in-flight message per pod: prefetch(1)).                *)

\* rabbitMqConsumer.ts:101-107
Recv(c) ==
    /\ cs[c] = "idle" /\ ready > 0
    /\ ready' = ready - 1
    /\ cs' = SetC(cs, c, "got")
    /\ UNCHANGED <<memoVars, pubs, losses, crashes, fails, attempts, bg,
                   myGen, readVer, snapMeta, apiVars>>

\* processMemo.ts:104-107 -> memoStatusUtils.ts:19-47.  findOne loads the memo
\* into the fork's identity map (rabbitMqConsumer.ts:105); that snapshot of
\* metadata is reused by the later status writes (MikroORM 6.5.9
\* EntityManager.findOne returns the cached entity, EntityManager.js:536-550).
Start(c) ==
    /\ cs[c] = "got" /\ MemoRowFree
    \* fix: a message for an already 'processed' memo is stale (every content /
    \* reprocess change resets status to 'received' with a new gen) -> ack, skip
    /\ IF mStatus = "deleted" \/ (Fix /\ mStatus = "processed")
         THEN \* MemoNotFoundError -> processMemo.ts:132-135 -> ack (rabbitMqConsumer.ts:71-76)
              /\ cs' = SetC(cs, c, "idle")
              /\ UNCHANGED <<memoVars, myGen, snapMeta>>
         ELSE /\ mStatus' = "processing"
              /\ snapMeta' = SetC(snapMeta, c, metaUser)
              /\ myGen' = SetC(myGen, c, gen)
              /\ cs' = SetC(cs, c, "started")
              /\ UNCHANGED <<contentVer, gen, chunks, metaUser, metaWrites, metaCR, stuckFirst, sweeps>>
    /\ UNCHANGED <<envVars, readVer, apiVars>>

\* processMemo.ts:22-46 (reads committed content; uncommitted PATCH is invisible)
Read(c) ==
    /\ cs[c] = "started"
    /\ IF mStatus = "deleted"
         THEN cs' = SetC(cs, c, "idle") /\ UNCHANGED readVer      \* MemoNotFoundError -> ack
         ELSE cs' = SetC(cs, c, "read") /\ readVer' = SetC(readVer, c, contentVer)
    /\ UNCHANGED <<memoVars, envVars, myGen, snapMeta, apiVars>>

\* Rows deleted-but-uncommitted by an open PATCH tx (memo.ts:408-411) or an
\* open DELETE /memo tx (memo.ts:560-562) make another DELETE of them wait.
ChunkRowsFree ==
    /\ ~(upd \in {"open", "published"} /\ chunks \cap updLocked # {})
    /\ ~(del # "none" /\ chunks \cap delSeen # {})

\* processMemo.ts:86-89, three autocommit DELETEs.
DelChunks(c) ==
    /\ ~Fix
    /\ cs[c] = "read"
    /\ ChunkRowsFree
    /\ chunks' = {}
    /\ cs' = SetC(cs, c, "deleted")
    /\ UNCHANGED <<mStatus, contentVer, gen, metaUser, metaWrites, metaCR, stuckFirst, sweeps,
                   envVars, myGen, readVer, snapMeta, apiVars>>

\* memoOperations.ts:186 / 235 / 267 persistAndFlush (own tx).  FKs to
\* skald_memo are DEFERRABLE INITIALLY DEFERRED (entities/MemoChunk.ts:30-50);
\* the commit-time RI check waits on a memo row deleted by an open DELETE tx
\* and fails once it commits -> not a MemoNotFoundError -> nack requeue.
Insert(c) ==
    /\ ~Fix /\ ~Poison
    /\ cs[c] = "deleted" /\ MemoRowFree
    /\ IF mStatus = "deleted"
         THEN cs' = SetC(cs, c, "failed") /\ UNCHANGED chunks
         ELSE /\ chunks' = chunks \cup {<<c, readVer[c]>>}
              /\ cs' = SetC(cs, c, "inserted")
    /\ UNCHANGED <<mStatus, contentVer, gen, metaUser, metaWrites, metaCR, stuckFirst, sweeps,
                   envVars, myGen, readVer, snapMeta, apiVars>>

\* processMemo.ts:119-127 via memoStatusUtils.ts:19-47: unconditional status
\* write; metadata = {...identityMapSnapshot, contextual_retrieval_applied,
\* stuck reset} -> whole JSON column rewritten from the snapshot taken at Start.
Finish(c) ==
    /\ ~Fix
    /\ cs[c] = "inserted" /\ MemoRowFree
    /\ IF mStatus = "deleted"
         THEN UNCHANGED memoVars                 \* UPDATE hits 0 rows, no error
         ELSE /\ mStatus' = "processed"
              /\ metaUser' = snapMeta[c]
              /\ metaCR' = CREnabled
              /\ stuckFirst' = FALSE /\ sweeps' = 0
              /\ UNCHANGED <<contentVer, gen, chunks, metaWrites>>
    /\ cs' = SetC(cs, c, "done")
    /\ UNCHANGED <<envVars, myGen, readVer, snapMeta, apiVars>>

\* Proposed fix: compute everything outside the DB, then ONE transaction:
\*   UPDATE skald_memo SET status='processed', metadata = metadata || {...}
\*   WHERE uuid=? AND processing_gen=?  -- if 1 row: delete+insert chunks
FinishFix(c) ==
    /\ Fix /\ ~Poison
    /\ cs[c] = "read" /\ MemoRowFree /\ ChunkRowsFree
    /\ IF mStatus # "deleted" /\ gen = myGen[c]
         THEN /\ chunks' = {<<c, readVer[c]>>}
              /\ mStatus' = "processed"
              /\ metaCR' = CREnabled
              /\ stuckFirst' = FALSE /\ sweeps' = 0
              /\ attempts' = 0
              /\ UNCHANGED <<contentVer, gen, metaUser, metaWrites>>
         ELSE UNCHANGED <<memoVars, attempts>>   \* superseded run: discard
    /\ cs' = SetC(cs, c, "done")
    /\ UNCHANGED <<ready, pubs, losses, crashes, fails, bg, myGen, readVer, snapMeta, apiVars>>

\* rabbitMqConsumer.ts:66
Ack(c) ==
    /\ cs[c] = "done"
    /\ cs' = SetC(cs, c, "idle")
    /\ UNCHANGED <<memoVars, envVars, myGen, readVer, snapMeta, apiVars>>

\* Error inside runMemoProcessingAgents (LLM / embedding / docling timeout,
\* FK failure) or in the wiki refresh step (processMemo.ts:111-117):
\* processMemo.ts:137-153 then rabbitMqConsumer.ts:79-84
\* nack(requeue=true) -- no retry limit, no DLQ.
Fail(c) ==
    /\ MemoRowFree
    /\ \/ cs[c] = "failed"
       \/ /\ cs[c] \in (IF Fix THEN {"read"} ELSE {"read", "deleted", "inserted"})
          /\ (Poison \/ (EnFail /\ fails < MaxFail))
    /\ fails' = IF Poison \/ cs[c] = "failed" THEN fails ELSE fails + 1
    /\ IF ~Fix
         THEN /\ IF mStatus # "deleted"
                    THEN /\ mStatus' = "error"
                         /\ metaUser' = snapMeta[c]       \* stale snapshot again
                         /\ stuckFirst' = FALSE /\ sweeps' = 0
                         /\ UNCHANGED <<contentVer, gen, chunks, metaWrites, metaCR>>
                    ELSE UNCHANGED memoVars
              /\ ready' = ready + 1                       \* nack requeue
              /\ UNCHANGED attempts
         ELSE /\ IF mStatus # "deleted" /\ gen = myGen[c]
                    THEN /\ mStatus' = "error"
                         /\ stuckFirst' = FALSE /\ sweeps' = 0
                         /\ UNCHANGED <<contentVer, gen, chunks, metaUser, metaWrites, metaCR>>
                    ELSE UNCHANGED memoVars
              /\ IF attempts + 1 >= MaxAttempts
                    THEN ready' = ready /\ attempts' = 0  \* dead-letter / ack
                    ELSE ready' = ready + 1 /\ attempts' = attempts + 1
    /\ cs' = SetC(cs, c, "idle")
    /\ UNCHANGED <<pubs, losses, crashes, bg, myGen, readVer, snapMeta, apiVars>>

\* Pod crash / rollout / OOM: unacked message is requeued by the broker
\* (noAck:false, rabbitMqConsumer.ts:110; connection close -> exit :121-124).
Crash(c) ==
    /\ EnCrash /\ crashes < MaxCrash
    /\ cs[c] # "idle"
    /\ crashes' = crashes + 1
    /\ ready' = ready + 1
    /\ cs' = SetC(cs, c, "idle")
    /\ UNCHANGED <<memoVars, pubs, losses, fails, attempts, bg, myGen, readVer, snapMeta, apiVars>>

ConsumerStep(c) ==
    Recv(c) \/ Start(c) \/ Read(c) \/ DelChunks(c) \/ Insert(c) \/ Finish(c)
    \/ FinishFix(c) \/ Ack(c) \/ Fail(c)

-----------------------------------------------------------------------------
(* PATCH /memo with new content: memo.ts:342-439                           *)

UBegin ==
    /\ EnUpdate /\ upd = "none" /\ rs = "none" /\ del = "none" /\ mStatus # "deleted"
    /\ contentVer < MaxContent /\ pubs < MaxPub
    /\ IF ~Fix
         THEN \* memo.ts:374,390-411: tx open, chunk rows deleted (uncommitted)
              /\ upd' = "open" /\ updLocked' = chunks
              /\ UNCHANGED memoVars
         ELSE \* fix: one committed tx: content, gen+1, status 'received'
              /\ upd' = "committed" /\ UNCHANGED updLocked
              /\ contentVer' = contentVer + 1
              /\ gen' = gen + 1
              /\ mStatus' = "received"
              /\ UNCHANGED <<chunks, metaUser, metaWrites, metaCR, stuckFirst, sweeps>>
    /\ UNCHANGED <<envVars, conVars, rs, lz, cr, sw, del, delSeen, lazyWaste, delFailed>>

\* memo.ts:426-428: publish BEFORE commit (fix: after commit)
UPublish ==
    /\ \/ (~Fix /\ upd = "open" /\ upd' = "published")
       \/ (Fix /\ upd = "committed" /\ upd' = "none")
    /\ Publish
    /\ pubs' = pubs + 1
    /\ UNCHANGED <<memoVars, crashes, fails, attempts, bg, conVars,
                   updLocked, rs, lz, cr, sw, del, delSeen, lazyWaste, delFailed>>

\* memo.ts:430-431: flush memo + content, commit.  processing_status untouched.
UCommit ==
    /\ ~Fix /\ upd = "published"
    /\ contentVer' = contentVer + 1
    /\ chunks' = chunks \ updLocked
    /\ upd' = "none" /\ updLocked' = {}
    /\ UNCHANGED <<mStatus, gen, metaUser, metaWrites, metaCR, stuckFirst, sweeps,
                   envVars, conVars, rs, lz, cr, sw, del, delSeen, lazyWaste, delFailed>>

-----------------------------------------------------------------------------
(* Create with an existing client_reference_id / source_url and changed    *)
(* content: createMemoUtils.ts:382-387 -> reuseExistingMemoForCreate        *)
(* :148-207 (content + metadata replaced and COMMITTED, chunks and status    *)
(* untouched) -> publish after commit :407-409.                            *)
RCommit ==
    /\ EnReuse /\ rs = "none" /\ upd = "none" /\ del = "none" /\ mStatus # "deleted"
    /\ contentVer < MaxContent /\ pubs < MaxPub
    /\ rs' = "committed"
    /\ contentVer' = contentVer + 1
    /\ metaCR' = FALSE                        \* :155 metadata replaced
    /\ stuckFirst' = FALSE /\ sweeps' = 0
    /\ IF Fix THEN gen' = gen + 1 /\ mStatus' = "received"
              ELSE UNCHANGED <<gen, mStatus>>
    /\ UNCHANGED <<chunks, metaUser, metaWrites, envVars, conVars,
                   upd, updLocked, lz, cr, sw, del, delSeen, lazyWaste, delFailed>>

RPublish ==
    /\ rs = "committed" /\ rs' = "none"
    /\ Publish
    /\ pubs' = pubs + 1
    /\ UNCHANGED <<memoVars, crashes, fails, attempts, bg, conVars,
                   upd, updLocked, lz, cr, sw, del, delSeen, lazyWaste, delFailed>>

-----------------------------------------------------------------------------
(* Lazy reprocess on chat/search: lazyReprocessService.ts:53-114           *)

LDelete ==
    /\ EnLazy /\ lz = "none" /\ mStatus # "deleted" /\ pubs < MaxPub
    /\ ~metaCR                                   \* :60-61 NULL or false
    /\ (~Fix \/ CREnabled)                       \* fix: only when CR is on
    /\ ChunkRowsFree
    /\ lazyWaste' = (lazyWaste \/ (mStatus = "processed" /\ metaCR = CREnabled))
    /\ IF ~Fix
         THEN \* :96-98 delete all chunks immediately (autocommit), no status filter
              /\ chunks' = {} /\ lz' = "deleted"
              /\ UNCHANGED <<mStatus, contentVer, gen, metaUser, metaWrites, metaCR, stuckFirst, sweeps>>
         ELSE /\ gen' = gen + 1 /\ mStatus' = "received" /\ lz' = "reset"
              /\ UNCHANGED <<contentVer, chunks, metaUser, metaWrites, metaCR, stuckFirst, sweeps>>
    /\ UNCHANGED <<envVars, conVars, upd, updLocked, rs, cr, sw, del, delSeen, delFailed>>

\* :101-108 SET processing_status='received' (no updated_at bump)
LReset ==
    /\ lz = "deleted" /\ MemoRowFree
    /\ IF mStatus # "deleted" THEN mStatus' = "received" ELSE UNCHANGED mStatus
    /\ lz' = "reset"
    /\ UNCHANGED <<contentVer, gen, chunks, metaUser, metaWrites, metaCR, stuckFirst, sweeps,
                   envVars, conVars, upd, updLocked, rs, cr, sw, del, delSeen, lazyWaste, delFailed>>

\* :111
LPublish ==
    /\ lz = "reset" /\ lz' = "none"
    /\ Publish
    /\ pubs' = pubs + 1
    /\ UNCHANGED <<memoVars, crashes, fails, attempts, bg, conVars,
                   upd, updLocked, rs, cr, sw, del, delSeen, lazyWaste, delFailed>>

-----------------------------------------------------------------------------
(* User / collector replaces metadata (memo.ts:417; also reuse :155)       *)
MetaWrite ==
    /\ EnMeta /\ metaWrites < MaxMeta /\ mStatus # "deleted"
    /\ upd = "none" /\ rs = "none" /\ MemoRowFree
    /\ metaWrites' = metaWrites + 1
    /\ metaUser' = metaWrites + 1
    /\ metaCR' = FALSE                \* whole JSON replaced
    /\ stuckFirst' = FALSE /\ sweeps' = 0
    /\ UNCHANGED <<mStatus, contentVer, gen, chunks, envVars, conVars, apiVars>>

(* DELETE /memo: memo.ts:558-564, one tx, READ COMMITTED:                  *)
(*   DELETE memocontent/summary/tag/memochunk (rows visible now)           *)
(*   DELETE skald_memo  (parent chunks: ON DELETE CASCADE,                 *)
(*                       Migration20260112100000.ts:31-37)                 *)
(*   COMMIT: deferred RI check skald_memochunk.memo_id (NO ACTION,         *)
(*   Migration20251029191931.ts:247) fails if a chunk committed in between.*)
DOpen ==
    /\ EnDelete /\ del = "none" /\ mStatus # "deleted" /\ upd = "none" /\ rs = "none"
    /\ ChunkRowsFree
    \* fix: lock / delete the memo row FIRST (or ON DELETE CASCADE), so no
    \* chunk insert can commit between the child DELETEs and the memo DELETE
    /\ del' = (IF Fix THEN "memoDeleted" ELSE "open") /\ delSeen' = chunks
    /\ UNCHANGED <<memoVars, envVars, conVars, upd, updLocked, rs, lz, cr, sw, lazyWaste, delFailed>>

DMemo ==
    /\ del = "open" /\ del' = "memoDeleted"
    /\ UNCHANGED <<memoVars, envVars, conVars, upd, updLocked, rs, lz, cr, sw, delSeen, lazyWaste, delFailed>>

DCommit ==
    /\ del = "memoDeleted"
    /\ IF chunks \subseteq delSeen
         THEN /\ mStatus' = "deleted" /\ chunks' = {}
              /\ UNCHANGED delFailed
         ELSE \* FK violation at commit -> rollback, HTTP 500 (no try/catch :558)
              /\ delFailed' = TRUE
              /\ UNCHANGED <<mStatus, chunks>>
    /\ del' = "none" /\ delSeen' = {}
    /\ UNCHANGED <<contentVer, gen, metaUser, metaWrites, metaCR, stuckFirst, sweeps,
                   envVars, conVars, upd, updLocked, rs, lz, cr, sw, lazyWaste>>

-----------------------------------------------------------------------------
(* Stuck memo sweeper, one per replica: stuckMemoSweeper.ts:80-131         *)

\* EXHAUST_SQL :43-52 (72h window abstracted as "eventually")
Exhaust(s) ==
    /\ mStatus \in {"received", "processing"} /\ stuckFirst /\ MemoRowFree
    /\ mStatus' = "error"
    /\ UNCHANGED <<contentVer, gen, chunks, metaUser, metaWrites, metaCR, stuckFirst, sweeps,
                   envVars, conVars, apiVars>>

\* :99-103 idle gate (checkQueue messageCount = READY only), CLAIM_SQL :54-78
\* (received: GREATEST(created_at,updated_at) older than 10 min;
\*  processing: processing_started_at older than 120 min).
Claim(s) ==
    /\ sw[s] = "idle" /\ sweeps < MaxSweep /\ MemoRowFree
    /\ (Fix \/ ready + (IF bg THEN 1 ELSE 0) = 0)
    /\ \/ /\ mStatus = "received"
          /\ (NarrowGap \/ \A c \in Consumers : cs[c] # "got")
          \* GREATEST(created_at, updated_at) < now()-10min (:59-60): creator
          \* (createMemoUtils.ts:271-272), reuse (:160) and PATCH (memo.ts:423)
          \* commit a fresh updated_at and publish milliseconds later, so the
          \* memo is not yet claimable while their publish is pending.  The
          \* lazy reset (lazyReprocessService.ts:101-108) does NOT bump
          \* updated_at, so a lazily reset memo is claimable at once.
          /\ (SlowPublish \/ (cr = "done" /\ rs = "none" /\ upd = "none"))
       \/ /\ mStatus = "processing"
          /\ (SlowProcessing \/ \A c \in Consumers : cs[c] = "idle")
    /\ stuckFirst' = TRUE
    /\ sweeps' = sweeps + 1
    /\ sw' = [sw EXCEPT ![s] = "claimed"]
    /\ UNCHANGED <<mStatus, contentVer, gen, chunks, metaUser, metaWrites, metaCR,
                   envVars, conVars, upd, updLocked, rs, lz, cr, del, delSeen, lazyWaste, delFailed>>

\* :113-121 publishMemoToQueue (failure only logged)
SPublish(s) ==
    /\ sw[s] = "claimed"
    /\ sw' = [sw EXCEPT ![s] = "idle"]
    /\ Publish
    /\ UNCHANGED <<memoVars, pubs, crashes, fails, attempts, bg, conVars,
                   upd, updLocked, rs, lz, cr, del, delSeen, lazyWaste, delFailed>>

\* other memos keep the queue non-idle
BgOn  == BusyQueue /\ ~bg /\ bg' = TRUE
         /\ UNCHANGED <<memoVars, ready, pubs, losses, crashes, fails, attempts, conVars, apiVars>>
BgOff == bg /\ bg' = FALSE
         /\ UNCHANGED <<memoVars, ready, pubs, losses, crashes, fails, attempts, conVars, apiVars>>

-----------------------------------------------------------------------------
Next ==
    \/ CPublish
    \/ \E c \in Consumers : ConsumerStep(c) \/ Crash(c)
    \/ UBegin \/ UPublish \/ UCommit
    \/ RCommit \/ RPublish
    \/ LDelete \/ LReset \/ LPublish
    \/ MetaWrite \/ DOpen \/ DMemo \/ DCommit
    \/ \E s \in Sweepers : Exhaust(s) \/ Claim(s) \/ SPublish(s)
    \/ BgOn \/ BgOff

Fairness ==
    /\ WF_vars(CPublish)
    /\ \A c \in Consumers : WF_vars(ConsumerStep(c))
    /\ WF_vars(UPublish \/ UCommit)
    /\ WF_vars(RPublish)
    /\ WF_vars(LReset \/ LPublish)
    /\ WF_vars(DMemo \/ DCommit)
    /\ \A s \in Sweepers : WF_vars(Claim(s)) /\ WF_vars(SPublish(s)) /\ WF_vars(Exhaust(s))

Spec     == Init /\ [][Next]_vars
LiveSpec == Spec /\ Fairness

-----------------------------------------------------------------------------
(* Properties *)

Quiescent ==
    /\ ready = 0
    /\ \A c \in Consumers : cs[c] = "idle"
    /\ upd = "none" /\ rs = "none" /\ lz = "none" /\ cr = "done" /\ del = "none"
    /\ \A s \in Sweepers : sw[s] = "idle"

\* never two runs' chunk sets at the same time (duplicate retrieval hits)
NoDuplicateChunks == Cardinality(chunks) <= 1

\* a deleted memo leaves no chunks behind (no resurrection)
DeletedNoChunks == mStatus = "deleted" => chunks = {}

\* a user's DELETE never fails because of background processing
DeleteNeverFails == ~delFailed

\* a user's metadata write is never reverted
NoLostMetaUpdate == mStatus # "deleted" => metaUser = metaWrites

\* when nothing is in flight, 'processed' means: chunks exist and match content.
\* (sweeper never looks at 'processed', so such a state is permanent)
ProcessedIsFresh ==
    (Quiescent /\ mStatus = "processed") =>
        /\ chunks # {}
        /\ \A ch \in chunks : ch[2] = contentVer

\* lazy reprocess must not throw away chunks of a memo already processed
\* under the current configuration
NoWastedLazyReprocess == ~lazyWaste

\* liveness
EventuallyQuiet == <>[](ready = 0 /\ \A c \in Consumers : cs[c] = "idle")
ReceivedResolves == [](mStatus = "received" => <>(mStatus \in {"processed", "error", "deleted"}))
=============================================================================
