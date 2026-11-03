----------------------------- MODULE DiscordStream -----------------------------
(***************************************************************************)
(* Discord mention streaming: DiscordStreamEditor.ts + the handler loop    *)
(* in mentionHandler.ts:622-765.                                           *)
(*                                                                         *)
(* Every Discord write goes through one promise chain `editChain`          *)
(* (DiscordStreamEditor.ts:11, 54-70, 199-288); a closure computes its     *)
(* chunks when it RUNS (formatChunks at :58), not when it is queued.       *)
(* Each closure is a sequence of awaited REST calls (syncMessages 147-173: *)
(* edit main, edit/reply extra chunks, delete stale extras); any call may  *)
(* fail when FAIL (rate limit, missing permission, network).               *)
(*                                                                         *)
(* Content is abstract: n = number of appended token batches. While        *)
(* streaming, the "⏳ ... 스트리밍" prefix (15) makes the text need 2       *)
(* chunks once n >= 2 (formatStreamingPreviewChunks 123-145). The final    *)
(* text (splitMessage 72-113, no prefix) needs FinalChunks chunks.         *)
(*                                                                         *)
(* Closure owners: "timer" (scheduleEdit 31-52; on failure it re-arms the  *)
(* timer unless finalized, 46-49) and "handler" (awaited by the handler:   *)
(* showStatus 242-265, finalize 175-197, showError 199-233).               *)
(***************************************************************************)
EXTENDS Integers, Sequences

CONSTANTS MaxTok,       \* token batches the stream delivers
          FinalChunks,  \* chunks of the final text (1 or 2)
          FAIL,         \* Discord REST calls may fail
          PARTIAL,      \* stream may end with transport_error after tokens
          FIX           \* proposed fixes (README 4)

None == [k |-> "none", o |-> "none"]
SC(x) == IF x >= 2 THEN 2 ELSE 1

VARIABLES n, fin, errMode, timer, chain, cur, cstep, ck, ckind, cfail,
          main, extraN, extraK, h, delivered, fallback, partialPath
vars == <<n, fin, errMode, timer, chain, cur, cstep, ck, ckind, cfail,
          main, extraN, extraK, h, delivered, fallback, partialPath>>

Init ==
    /\ n = 0 /\ fin = FALSE /\ errMode = FALSE /\ timer = FALSE
    /\ chain = <<>> /\ cur = None /\ cstep = "none" /\ ck = 0 /\ ckind = "none"
    /\ cfail = FALSE
    /\ main = "init"                 \* reply sent at mentionHandler.ts:625
    /\ extraN = 0 /\ extraK = "none"
    /\ h = "loop" /\ delivered = FALSE /\ fallback = FALSE /\ partialPath = FALSE

Enq(c) == chain' = Append(chain, c)
HandlerWaiting == h \in {"wStatus", "wFinal", "wError"}

-----------------------------------------------------------------------------
(* Handler (mentionHandler.ts:661-764)                                      *)

\* token event: fullResponse += ..; editor.append (683-691, 22-29) - sync
Token ==
    /\ h = "loop" /\ n < MaxTok
    /\ n' = n + 1
    /\ timer' = TRUE                  \* scheduleEdit: no-op if already armed
    /\ UNCHANGED <<fin, errMode, chain, cur, cstep, ck, ckind, cfail, main,
                   extraN, extraK, h, delivered, fallback, partialPath>>

\* progress event: await editor.showStatus (671-675, 242-265)
Status ==
    /\ h = "loop"
    /\ Enq([k |-> "status", o |-> "handler"])
    /\ h' = "wStatus"
    /\ UNCHANGED <<n, fin, errMode, timer, cur, cstep, ck, ckind, cfail, main,
                   extraN, extraK, delivered, fallback, partialPath>>

\* finalize(): isFinalized, clear timer, queue the final edit (175-197)
DoFinalize(isPartial) ==
    /\ fin' = TRUE /\ timer' = FALSE
    /\ Enq([k |-> "edit", o |-> "handler"])
    /\ h' = "wFinal" /\ partialPath' = isPartial

\* stream end: done (739-746) or transport_error with partial text (715-719)
End ==
    /\ h = "loop" /\ n > 0
    /\ \E p \in (IF PARTIAL THEN {FALSE, TRUE} ELSE {FALSE}) : DoFinalize(p)
    /\ UNCHANGED <<n, errMode, cur, cstep, ck, ckind, cfail, main, extraN, extraK,
                   delivered, fallback>>

\* showError(): isFinalized, buffer = '', queue the error edit (199-233)
DoShowError ==
    /\ fin' = TRUE /\ errMode' = TRUE /\ timer' = FALSE
    /\ Enq([k |-> "error", o |-> "handler"])
    /\ h' = "wError"

\* empty stream -> throw (739-741) -> catch -> showError (760-763)
EndEmpty ==
    /\ h = "loop" /\ n = 0
    /\ DoShowError
    /\ UNCHANGED <<n, cur, cstep, ck, ckind, cfail, main, extraN, extraK,
                   delivered, fallback, partialPath>>

\* finalize resolved or threw (745-750, 718-726)
AfterFinal ==
    /\ h = "fin?"
    /\ IF cfail
       THEN /\ h' = "fallback"
            /\ UNCHANGED delivered
       ELSE /\ delivered' = TRUE
            /\ h' = IF partialPath THEN "warn" ELSE "done"   \* embeds are non-fatal (200-255)
    /\ UNCHANGED <<n, fin, errMode, timer, chain, cur, cstep, ck, ckind, cfail,
                   main, extraN, extraK, fallback, partialPath>>

\* sendFinalResponseFallback (445-455): thread.send x chunks; may throw
Fallback ==
    /\ h = "fallback"
    /\ \/ /\ fallback' = TRUE
          /\ h' = IF partialPath THEN "warn" ELSE "done"
          /\ UNCHANGED <<fin, errMode, timer, chain>>
       \/ /\ FAIL                                  \* throw -> catch 760 -> showError
          /\ fallback' = TRUE                      \* some chunks may already be sent
          /\ DoShowError
    /\ UNCHANGED <<n, cur, cstep, ck, ckind, cfail, main, extraN, extraK,
                   delivered, partialPath>>

\* partial path: await responseThread.send('⚠️ ...') (729) is not in a try
Warn ==
    /\ h = "warn"
    /\ \/ /\ h' = "done"
          /\ UNCHANGED <<fin, errMode, timer, chain>>
       \/ /\ FAIL /\ ~FIX                          \* throw -> catch 760 -> showError
          /\ DoShowError
       \/ /\ FAIL /\ FIX                           \* fix: never showError after delivery
          /\ h' = "done"
          /\ UNCHANGED <<fin, errMode, timer, chain>>
    /\ UNCHANGED <<n, cur, cstep, ck, ckind, cfail, main, extraN, extraK,
                   delivered, fallback, partialPath>>

HandlerResume ==
    /\ HandlerWaiting /\ cur = None
    /\ ~\E i \in 1..Len(chain) : chain[i].o = "handler"
    /\ h' = CASE h = "wStatus" -> "loop"
              [] h = "wFinal"  -> "fin?"
              [] h = "wError"  -> "done"
    /\ UNCHANGED <<n, fin, errMode, timer, chain, cur, cstep, ck, ckind, cfail,
                   main, extraN, extraK, delivered, fallback, partialPath>>

-----------------------------------------------------------------------------
(* Timer and the edit chain                                                 *)

\* setTimeout callback (40-51): timer = null; performEdit()
TimerFire ==
    /\ timer
    /\ timer' = FALSE
    /\ Enq([k |-> "edit", o |-> "timer"])
    /\ UNCHANGED <<n, fin, errMode, cur, cstep, ck, ckind, cfail, main, extraN,
                   extraK, h, delivered, fallback, partialPath>>

\* The next closure starts; performEdit computes chunks NOW (58, 115-121).
Begin ==
    /\ cur = None /\ chain # <<>>
    /\ LET c == Head(chain) IN
       /\ cur' = c /\ chain' = Tail(chain) /\ cfail' = FALSE
       /\ CASE c.k = "edit" ->
                 IF fin /\ errMode
                 THEN ck' = 0 /\ ckind' = "none" /\ cstep' = "end"     \* chunks.length === 0 (60-62)
                 ELSE IF fin
                 THEN ck' = FinalChunks /\ ckind' = "final" /\ cstep' = "main"
                 ELSE ck' = SC(n) /\ ckind' = "stream" /\ cstep' = "main"
            [] c.k = "status" -> ck' = 1 /\ ckind' = "status" /\ cstep' = "main"
            [] c.k = "error"  -> ck' = 1 /\ ckind' = "error" /\ cstep' = "main"
    /\ UNCHANGED <<n, fin, errMode, timer, main, extraN, extraK, h, delivered,
                   fallback, partialPath>>

\* A REST call fails: the closure rejects (edit/status) at this step.
CallFail ==
    /\ FAIL /\ cur # None /\ cstep \in {"main", "extra"}
    /\ cfail' = TRUE /\ cstep' = "end"
    /\ UNCHANGED <<n, fin, errMode, timer, chain, cur, ck, ckind, main, extraN,
                   extraK, h, delivered, fallback, partialPath>>

\* await this.message.edit(chunks[0]) (148, 256, 279, 214)
EditMain ==
    /\ cur # None /\ cstep = "main"
    /\ main' = ckind
    /\ cstep' = IF ckind \in {"stream", "final"} THEN "extra"
                ELSE IF ckind = "error" THEN "del" ELSE "end"
    /\ UNCHANGED <<n, fin, errMode, timer, chain, cur, ck, ckind, cfail, extraN,
                   extraK, h, delivered, fallback, partialPath>>

\* chunks[1]: edit the existing extra message or reply a new one (150-161)
EditExtra ==
    /\ cur # None /\ cstep = "extra"
    /\ IF ck >= 2
       THEN extraN' = 1 /\ extraK' = ckind
       ELSE UNCHANGED <<extraN, extraK>>
    /\ cstep' = "del"
    /\ UNCHANGED <<n, fin, errMode, timer, chain, cur, ck, ckind, cfail, main,
                   h, delivered, fallback, partialPath>>

\* delete stale extras (163-171, 216-225); a failed delete is only logged
DelStale ==
    /\ cur # None /\ cstep = "del"
    /\ LET keep == IF ckind = "error" THEN 0 ELSE ck - 1 IN
       IF extraN > keep
       THEN \/ extraN' = 0 /\ extraK' = "none"              \* deleted
            \/ FAIL /\ UNCHANGED <<extraN, extraK>>          \* warn, message stays
       ELSE UNCHANGED <<extraN, extraK>>
    /\ cstep' = "end"
    /\ UNCHANGED <<n, fin, errMode, timer, chain, cur, ck, ckind, cfail, main,
                   h, delivered, fallback, partialPath>>

\* closure settles; a failed timer edit re-arms unless finalized (44-49)
Settle ==
    /\ cur # None /\ cstep = "end"
    /\ timer' = IF cur.o = "timer" /\ cfail /\ ~fin THEN TRUE ELSE timer
    /\ cur' = None /\ cstep' = "none"
    /\ UNCHANGED <<n, fin, errMode, chain, ck, ckind, cfail, main, extraN, extraK,
                   h, delivered, fallback, partialPath>>

\* With FIX, a failed finalize first clears the streaming placeholder (main
\* edited to a short "see below" note, extras deleted) before the fallback.
FixPlaceholder ==
    /\ FIX /\ h = "fallback" /\ cur = None /\ chain = <<>>
    /\ main # "note"
    /\ main' = "note" /\ extraN' = 0 /\ extraK' = "none"
    /\ UNCHANGED <<n, fin, errMode, timer, chain, cur, cstep, ck, ckind, cfail,
                   h, delivered, fallback, partialPath>>

Next ==
    \/ Token \/ Status \/ End \/ EndEmpty \/ AfterFinal \/ Warn \/ HandlerResume
    \/ (Fallback /\ (FIX => main = "note"))
    \/ FixPlaceholder
    \/ TimerFire \/ Begin \/ CallFail \/ EditMain \/ EditExtra \/ DelStale \/ Settle

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
Quiet == cur = None /\ chain = <<>>

\* No in-flight streaming edit lands after the final answer: once finalize()
\* resolved, the main message shows the final text from then on (until an
\* error edit, checked separately).
FinalStays == (delivered /\ ~errMode) => main = "final"

\* Once the answer was delivered, no error message replaces it.
NoErrorOverDelivered == delivered => main # "error"

\* When the handler is done and Discord is quiet, the main message no longer
\* shows the streaming placeholder ("⏳ ... 스트리밍하는 중" + cursor).
NoStuckStreaming == (h = "done" /\ Quiet) => main # "stream"

\* ... and no extra chunk message is left over from streaming.
NoStaleExtra == (h = "done" /\ Quiet) => extraK # "stream"

\* The fallback re-send must not leave a second (partial) copy above it.
NoDuplicateAnswer == (fallback /\ h = "done" /\ Quiet) => main \notin {"final", "stream"}
=============================================================================
