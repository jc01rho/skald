----------------------------- MODULE ChatStream -----------------------------
(***************************************************************************)
(* Chat SSE streaming: server handler -> fetch reader -> Zustand store.    *)
(*                                                                         *)
(* MODE = "private": backend/src/api/chat.ts _generateStreamingResponse    *)
(*   (582-788) + frontend/src/stores/chatStore.ts sendMessage (157-337).   *)
(* MODE = "public":  ee/src/api/publicChat.ts chat (48-95) and             *)
(*   _generateStreamingResponse (109-160) + frontend/src/stores/           *)
(*   publicChatStore.ts sendMessage (77-211).                              *)
(* Transport: frontend/src/lib/api.ts api.stream (197-313).                *)
(*                                                                         *)
(* Each stream s is one sendMessage call / one HTTP request.  Server       *)
(* steps are the awaits of the handler; client steps are reader.read()     *)
(* resolutions.  Payloads are abstracted to event kinds and message        *)
(* content kinds.  The store is one module-level Zustand store, so a       *)
(* stream keeps writing into it after clearMessages / component remount.   *)
(*                                                                         *)
(* Environment switches (each one is a nondeterministic option):           *)
(*   DBFail      createChatWithUserMessage / persistAssistantMessage /     *)
(*               createChatMessagePair throws                               *)
(*   DeepFail    ragGraph.invoke / streamChatAgent throws                  *)
(*   EarlyReject ragGraph rejects while the preview stage is pending       *)
(*   CutOn       connection cut (pod termination, network)                 *)
(*   CutIsEOF    the cut is seen by fetch as clean EOF (else as an error)  *)
(*   Hang        a server await never settles (no timeout in the code)     *)
(*   ParseErr    a data: line fails JSON.parse (MODEL-ONLY, see README)    *)
(*   TabCloseOn  the user closes the tab mid-stream                        *)
(*   MaxEpoch    number of clearMessages calls allowed                     *)
(* FIXC / FIXS: proposed client / server fixes (README B, fixes).          *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets, TLC

CONSTANTS N, MODE, DBFail, DeepFail, EarlyReject, CutOn, CutIsEOF, Hang,
          ParseErr, TabCloseOn, MaxEpoch, FIXC, FIXS

Streams == 1..N
Msgs == Streams \X {"o", "a"}      \* o = first assistant message, a = authoritative one created on preview
Kinds == {"empty", "preview", "answer", "error", "garbled"}
NetStates == {"none", "pending", "open", "ended", "cut_eof", "reset", "httpErr"}
Working == {"persistUser", "preview", "deep", "gen", "persist", "rag"}
Running == Working \cup {"end", "hung"}
CutNet == IF CutIsEOF THEN "cut_eof" ELSE "reset"

VARIABLES
    \* ---- server / network ----
    srv,        \* handler program counter per stream
    deep,       \* private: deepStagePromise state ("pending" | "fail")
    chan,       \* SSE events written by the server, not yet read by the client
    net,        \* connection state seen by fetch
    leak,       \* keepAlive setInterval left running after the request ended
    crashed,    \* the API process died of an unhandled rejection
    chatOf,     \* server chat uuid used by the stream (0 = not yet)
    persisted,  \* assistant message persisted
    terms,      \* number of terminal events (done/error) written
    genDone,    \* the server finished generating the full answer
    wasted,     \* the server generated/persisted after the client had gone
    \* ---- client (closure + api.stream) ----
    sent, epoch, sendEpoch, reqChat, reader, aborted, gone, sawTerm, tabClosed,
    \* ---- Zustand store ----
    present, content, spin, isStreaming, session, active, lost

srvVars == <<srv, deep, net, leak, crashed, chatOf, persisted, terms, genDone, wasted>>
cliVars == <<sent, epoch, sendEpoch, reqChat, reader, aborted, gone, sawTerm, tabClosed>>
UIvars  == <<present, content, spin, isStreaming, session, active, lost>>
vars    == <<srvVars, chan, cliVars, UIvars>>

Live(s) == reader[s] \in {"pending", "reading"}

TypeOK ==
    /\ srv \in [Streams -> {"idle", "closed", "dead"} \cup Running]
    /\ deep \in [Streams -> {"pending", "fail"}]
    /\ net \in [Streams -> NetStates]
    /\ chatOf \in [Streams -> 0..N]
    /\ session \in 0..N
    /\ reqChat \in [Streams -> 0..N]
    /\ content \in [Msgs -> Kinds]
    /\ reader \in [Streams -> {"none", "pending", "reading", "done", "failed", "aborted", "gone"}]
    /\ active \in [Streams -> {"o", "a"}]
    /\ terms \in [Streams -> 0..3]

Init ==
    /\ srv = [s \in Streams |-> "idle"]
    /\ deep = [s \in Streams |-> "pending"]
    /\ chan = [s \in Streams |-> <<>>]
    /\ net = [s \in Streams |-> "none"]
    /\ leak = [s \in Streams |-> FALSE]
    /\ crashed = FALSE
    /\ chatOf = [s \in Streams |-> 0]
    /\ persisted = [s \in Streams |-> FALSE]
    /\ terms = [s \in Streams |-> 0]
    /\ genDone = [s \in Streams |-> FALSE]
    /\ wasted = [s \in Streams |-> FALSE]
    /\ sent = 0
    /\ epoch = 0
    /\ sendEpoch = [s \in Streams |-> 0]
    /\ reqChat = [s \in Streams |-> 0]
    /\ reader = [s \in Streams |-> "none"]
    /\ aborted = [s \in Streams |-> FALSE]
    /\ gone = [s \in Streams |-> FALSE]
    /\ sawTerm = [s \in Streams |-> FALSE]
    /\ tabClosed = FALSE
    /\ present = [m \in Msgs |-> FALSE]
    /\ content = [m \in Msgs |-> "empty"]
    /\ spin = [m \in Msgs |-> FALSE]
    /\ isStreaming = FALSE
    /\ session = 0
    /\ active = [s \in Streams |-> "o"]
    /\ lost = [s \in Streams |-> FALSE]

-----------------------------------------------------------------------------
(* Server helpers *)
Emit(s, e) ==
    /\ chan' = [chan EXCEPT ![s] = Append(@, e)]
    /\ terms' = [terms EXCEPT ![s] = @ + (IF e \in {"done", "error"} THEN 1 ELSE 0)]
NoEmit == UNCHANGED <<chan, terms>>
SetSrv(s, v) == srv' = [srv EXCEPT ![s] = v]
FixGo(s) == FIXS => ~gone[s]   \* FIXS: req.on('close') -> AbortSignal stops further work
Waste(s) == wasted' = [wasted EXCEPT ![s] = @ \/ gone[s]]
NewChat(s) == IF reqChat[s] # 0 THEN reqChat[s] ELSE s   \* findOneOrFail(chat_id) else create

(* ---------- private: backend/src/api/chat.ts ---------- *)
\* :623 createChatWithUserMessage (outside the try that starts at :685), then :626 accepted.
\* On throw (orig): Express 5 error chain expressServer.ts:149-159 calls res.json after the
\* SSE headers -> ERR_HTTP_HEADERS_SENT -> finalhandler destroys the socket; keepAlive
\* (:614-620) is cleared only in finally (:777), which is never reached.
PPersistUser(s) ==
    /\ MODE = "private" /\ srv[s] = "persistUser" /\ FixGo(s)
    /\ \/ /\ chatOf' = [chatOf EXCEPT ![s] = NewChat(s)]
          /\ Emit(s, "accepted") /\ SetSrv(s, "preview")
          /\ UNCHANGED <<net, leak>>
       \/ /\ DBFail
          /\ UNCHANGED chatOf
          /\ IF FIXS
               THEN Emit(s, "error") /\ SetSrv(s, "end") /\ UNCHANGED <<net, leak>>
               ELSE /\ NoEmit /\ SetSrv(s, "dead")
                    /\ net' = [net EXCEPT ![s] = "reset"]
                    /\ leak' = [leak EXCEPT ![s] = TRUE]
    /\ UNCHANGED <<deep, crashed, persisted, genDone, wasted>>
    /\ UNCHANGED cliVars /\ UNCHANGED UIvars

\* :631-687 cache lookup / fastRetrieve+generatePreview (never rejects: :662-665), then preview.
PPreview(s) ==
    /\ MODE = "private" /\ srv[s] = "preview" /\ FixGo(s)
    /\ Emit(s, "preview") /\ SetSrv(s, "deep")
    /\ UNCHANGED <<deep, net, leak, crashed, chatOf, persisted, genDone, wasted>>
    /\ UNCHANGED cliVars /\ UNCHANGED UIvars

\* :668 deepStagePromise is created before the try and awaited only at :691, after
\* await fastPreviewPromise (:686).  A rejection in between has no handler; Node 24
\* (backend/Dockerfile:25) defaults to --unhandled-rejections=throw and the express
\* server never runs Sentry.init (backend/src/sentry.ts is imported only by
\* memoProcessingServer.ts:17), so the process exits and every open stream is cut.
PEarlyReject(s) ==
    /\ MODE = "private" /\ EarlyReject /\ srv[s] = "preview" /\ deep[s] = "pending"
    /\ deep' = [deep EXCEPT ![s] = "fail"]
    /\ IF FIXS
         THEN UNCHANGED <<srv, net, crashed>>
         ELSE /\ crashed' = TRUE
              /\ srv' = [t \in Streams |-> IF srv[t] \in Running THEN "dead" ELSE srv[t]]
              /\ net' = [t \in Streams |-> IF srv[t] \in Running /\ net[t] = "open"
                                             THEN CutNet ELSE net[t]]
    /\ UNCHANGED <<chan, terms, leak, chatOf, persisted, genDone, wasted>>
    /\ UNCHANGED cliVars /\ UNCHANGED UIvars

\* :691 await deepStagePromise; rejection -> catch :749-775 writes error.
PDeep(s) ==
    /\ MODE = "private" /\ srv[s] = "deep" /\ FixGo(s)
    /\ \/ deep[s] # "fail" /\ SetSrv(s, "gen") /\ NoEmit
       \/ (deep[s] = "fail" \/ DeepFail) /\ Emit(s, "error") /\ SetSrv(s, "end")
    /\ UNCHANGED <<deep, net, leak, crashed, chatOf, persisted, genDone, wasted>>
    /\ UNCHANGED cliVars /\ UNCHANGED UIvars

\* :703-726 tokens from streamChatAgent (abstracted to one token = full answer).
PGen(s) ==
    /\ MODE = "private" /\ srv[s] = "gen" /\ FixGo(s)
    /\ Waste(s)
    /\ \/ Emit(s, "token") /\ genDone' = [genDone EXCEPT ![s] = TRUE] /\ SetSrv(s, "persist")
       \/ DeepFail /\ Emit(s, "error") /\ SetSrv(s, "end") /\ UNCHANGED genDone
    /\ UNCHANGED <<deep, net, leak, crashed, chatOf, persisted>>
    /\ UNCHANGED cliVars /\ UNCHANGED UIvars

\* :747 persistAssistantMessage then :748 done; a throw goes to catch :775 error.
PPersist(s) ==
    /\ MODE = "private" /\ srv[s] = "persist" /\ FixGo(s)
    /\ Waste(s)
    /\ \/ persisted' = [persisted EXCEPT ![s] = TRUE] /\ Emit(s, "done") /\ SetSrv(s, "end")
       \/ DBFail /\ Emit(s, "error") /\ SetSrv(s, "end") /\ UNCHANGED persisted
    /\ UNCHANGED <<deep, net, leak, crashed, chatOf, genDone>>
    /\ UNCHANGED cliVars /\ UNCHANGED UIvars

(* ---------- public: ee/src/api/publicChat.ts ---------- *)
\* :68 ragGraph.invoke before any header; a throw -> 503 JSON (expressServer.ts:149-159),
\* fetch sees !response.ok (api.ts:239-253).  Success -> headers + ping (:126-129).
QRag(s) ==
    /\ MODE = "public" /\ srv[s] = "rag" /\ FixGo(s)
    /\ \/ net' = [net EXCEPT ![s] = "open"] /\ SetSrv(s, "gen")
       \/ DeepFail /\ net' = [net EXCEPT ![s] = "httpErr"] /\ SetSrv(s, "closed")
    /\ NoEmit
    /\ UNCHANGED <<deep, leak, crashed, chatOf, persisted, genDone, wasted>>
    /\ UNCHANGED cliVars /\ UNCHANGED UIvars

\* :135-158 tokens; a throw writes error (:157) and RETURNS fullResponse, so :88-89 still
\* persist the (empty/partial) answer and write done.
QGen(s) ==
    /\ MODE = "public" /\ srv[s] = "gen" /\ FixGo(s)
    /\ Waste(s)
    /\ \/ Emit(s, "token") /\ genDone' = [genDone EXCEPT ![s] = TRUE] /\ SetSrv(s, "persist")
       \/ DeepFail /\ Emit(s, "error") /\ SetSrv(s, IF FIXS THEN "end" ELSE "persist")
          /\ UNCHANGED genDone
    /\ UNCHANGED <<deep, net, leak, crashed, chatOf, persisted>>
    /\ UNCHANGED cliVars /\ UNCHANGED UIvars

\* :88 createChatMessagePair, :89 done, :90 end.  A throw -> catch :91-93 res.status(503).json
\* after headers -> ERR_HTTP_HEADERS_SENT -> Express error chain -> socket destroyed.
QPersist(s) ==
    /\ MODE = "public" /\ srv[s] = "persist" /\ FixGo(s)
    /\ Waste(s)
    /\ \/ /\ chatOf' = [chatOf EXCEPT ![s] = NewChat(s)]
          /\ persisted' = [persisted EXCEPT ![s] = TRUE]
          /\ Emit(s, "done") /\ SetSrv(s, "end") /\ UNCHANGED net
       \/ /\ DBFail /\ UNCHANGED <<chatOf, persisted>>
          /\ IF FIXS
               THEN Emit(s, "error") /\ SetSrv(s, "end") /\ UNCHANGED net
               ELSE NoEmit /\ SetSrv(s, "closed") /\ net' = [net EXCEPT ![s] = "reset"]
    /\ UNCHANGED <<deep, leak, crashed, genDone>>
    /\ UNCHANGED cliVars /\ UNCHANGED UIvars

(* ---------- both modes ---------- *)
\* chat.ts:776-779 finally clearInterval + res.end; publicChat.ts:90 res.end.
EndStep(s) ==
    /\ srv[s] = "end"
    /\ SetSrv(s, "closed")
    /\ net' = [net EXCEPT ![s] = IF @ = "open" THEN "ended" ELSE @]
    /\ NoEmit
    /\ UNCHANGED <<deep, leak, crashed, chatOf, persisted, genDone, wasted>>
    /\ UNCHANGED cliVars /\ UNCHANGED UIvars

\* FIXS: on req 'close' abort ragGraph/LLM and finish without persisting.
Abort(s) ==
    /\ FIXS /\ gone[s] /\ srv[s] \in Working
    /\ SetSrv(s, "end") /\ NoEmit
    /\ UNCHANGED <<deep, net, leak, crashed, chatOf, persisted, genDone, wasted>>
    /\ UNCHANGED cliVars /\ UNCHANGED UIvars

\* Pod termination (expressServer.ts:180-183 forces exit after 30s) or network cut.
Cut(s) ==
    /\ CutOn /\ net[s] = "open" /\ srv[s] \in Running
    /\ SetSrv(s, "dead") /\ net' = [net EXCEPT ![s] = CutNet]
    /\ NoEmit
    /\ UNCHANGED <<deep, leak, crashed, chatOf, persisted, genDone, wasted>>
    /\ UNCHANGED cliVars /\ UNCHANGED UIvars

\* Any await may never settle: no timeout/AbortSignal on DB, ragGraph or LLM calls;
\* the keepAlive ping (chat.ts:614-620) keeps the private connection open forever.
HangStep(s) ==
    /\ Hang /\ srv[s] \in Working
    /\ SetSrv(s, "hung") /\ NoEmit
    /\ UNCHANGED <<deep, net, leak, crashed, chatOf, persisted, genDone, wasted>>
    /\ UNCHANGED cliVars /\ UNCHANGED UIvars

ServerStep(s) ==
    \/ PPersistUser(s) \/ PPreview(s) \/ PEarlyReject(s) \/ PDeep(s) \/ PGen(s) \/ PPersist(s)
    \/ QRag(s) \/ QGen(s) \/ QPersist(s)
    \/ EndStep(s) \/ Abort(s) \/ Cut(s) \/ HangStep(s)

-----------------------------------------------------------------------------
(* Client: store handlers (chatStore.ts:236-333 == publicChatStore.ts:118-207) *)

\* FIXC: per-stream token; events of a stream that is aborted, already finished
\* (first done/error wins; the reader is cancelled) or belongs to an older
\* conversation (before clearMessages) are dropped.
Ignore(s) == FIXC /\ (aborted[s] \/ sawTerm[s] \/ sendEpoch[s] # epoch)

AppendTok(k) == CASE k = "empty"   -> "answer"
                  [] k = "answer"  -> "answer"
                  [] k = "preview" -> "garbled"
                  [] k = "error"   -> "garbled"
                  [] k = "garbled" -> "garbled"

\* accepted: chatStore.ts:237-239 set chatSessionId unconditionally.
HAccepted(s) ==
    IF Ignore(s) THEN UNCHANGED UIvars
    ELSE /\ session' = chatOf[s]
         /\ UNCHANGED <<present, content, spin, isStreaming, active, lost>>

\* preview: chatStore.ts:246-276. Applied only if the first message is still active and empty.
HPreview(s) ==
    LET o == <<s, "o">>
        a == <<s, "a">>
    IN IF ~Ignore(s) /\ active[s] = "o" /\ present[o] /\ content[o] = "empty"
       THEN /\ content' = [content EXCEPT ![o] = "preview", ![a] = "empty"]
            /\ spin' = [spin EXCEPT ![o] = FALSE, ![a] = TRUE]
            /\ present' = [present EXCEPT ![a] = TRUE]
            /\ active' = [active EXCEPT ![s] = "a"]
            /\ isStreaming' = TRUE
            /\ UNCHANGED <<session, lost>>
       ELSE UNCHANGED UIvars

\* token: chatStore.ts:279-282, keyed by the closure's activeAssistantMessageId.
HToken(s) ==
    LET m == <<s, active[s]>>
    IN IF Ignore(s) \/ ~present[m] THEN UNCHANGED UIvars
       ELSE /\ content' = [content EXCEPT ![m] = AppendTok(@)]
            /\ UNCHANGED <<present, spin, isStreaming, session, active, lost>>

\* done: chatStore.ts:290-314. finishStreaming resets the GLOBAL isStreaming.
HDone(s) ==
    LET m == <<s, active[s]>>
    IN IF Ignore(s) THEN UNCHANGED UIvars
       ELSE /\ IF active[s] = "a" /\ present[m] /\ content[m] = "empty"
                 THEN /\ present' = [present EXCEPT ![m] = FALSE]
                      /\ spin' = [spin EXCEPT ![m] = FALSE]
                 ELSE /\ present' = present
                      /\ spin' = IF present[m] THEN [spin EXCEPT ![m] = FALSE] ELSE spin
            /\ isStreaming' = FALSE
            /\ session' = chatOf[s]
            /\ UNCHANGED <<content, active, lost>>

\* error event (chatStore.ts:315-321) and onError (:323-333): finishStreaming + replace the
\* message text with "Error: ...".  FIXC keeps an already shown answer and adds a notice.
OnErrorUI(s) ==
    LET m == <<s, active[s]>>
        newc == IF FIXC /\ content[m] = "answer" THEN "answer" ELSE "error"
    IN IF Ignore(s) THEN UNCHANGED UIvars
       ELSE /\ spin' = IF present[m] THEN [spin EXCEPT ![m] = FALSE] ELSE spin
            /\ content' = IF present[m] THEN [content EXCEPT ![m] = newc] ELSE content
            /\ lost' = IF present[m] /\ content[m] = "answer" /\ newc = "error" /\ genDone[s]
                         THEN [lost EXCEPT ![s] = TRUE] ELSE lost
            /\ isStreaming' = FALSE
            /\ UNCHANGED <<present, session, active>>

Handle(s, e) ==
    CASE e = "accepted" -> HAccepted(s)
      [] e = "preview"  -> HPreview(s)
      [] e = "token"    -> HToken(s)
      [] e = "done"     -> HDone(s)
      [] e = "error"    -> OnErrorUI(s)

(* Client: transport (api.ts:231-308) *)
\* api.ts:264-291 read -> split lines -> onMessage per data: line.
Deliver(s) ==
    /\ reader[s] = "reading" /\ chan[s] # <<>>
    /\ LET e == Head(chan[s]) IN
         /\ chan' = [chan EXCEPT ![s] = Tail(@)]
         /\ sawTerm' = [sawTerm EXCEPT ![s] = @ \/ e \in {"done", "error"}]
         /\ Handle(s, e)
         \* FIXC: reader.cancel() after the first terminal event
         /\ reader' = IF FIXC /\ e \in {"done", "error"}
                        THEN [reader EXCEPT ![s] = "done"] ELSE reader
    /\ UNCHANGED srvVars
    /\ UNCHANGED <<sent, epoch, sendEpoch, reqChat, aborted, gone, tabClosed>>

\* api.ts:283-286 JSON.parse failure -> onError, but the read loop continues (:291).
ParseFail(s) ==
    /\ ParseErr /\ reader[s] = "reading" /\ chan[s] # <<>>
    /\ chan' = [chan EXCEPT ![s] = Tail(@)]
    /\ OnErrorUI(s)
    /\ IF FIXC
         THEN /\ reader' = [reader EXCEPT ![s] = "failed"]
              /\ gone' = [gone EXCEPT ![s] = TRUE]
         ELSE UNCHANGED <<reader, gone>>
    /\ UNCHANGED srvVars
    /\ UNCHANGED <<sent, epoch, sendEpoch, reqChat, aborted, sawTerm, tabClosed>>

\* api.ts:268-270 `if (done) return` - neither onMessage nor onError is called.
EOF(s) ==
    /\ reader[s] = "reading" /\ chan[s] = <<>> /\ net[s] \in {"ended", "cut_eof"}
    /\ reader' = [reader EXCEPT ![s] = "done"]
    /\ IF FIXC /\ ~sawTerm[s] THEN OnErrorUI(s) ELSE UNCHANGED UIvars
    /\ UNCHANGED srvVars /\ UNCHANGED chan
    /\ UNCHANGED <<sent, epoch, sendEpoch, reqChat, aborted, gone, sawTerm, tabClosed>>

\* api.ts:239-253 (!response.ok), :293-297 (read rejected), :303-307 (fetch rejected).
Fail(s) ==
    /\ Live(s) /\ net[s] \in {"reset", "httpErr"}
    /\ reader' = [reader EXCEPT ![s] = "failed"]
    /\ chan' = [chan EXCEPT ![s] = <<>>]
    /\ OnErrorUI(s)
    /\ UNCHANGED srvVars
    /\ UNCHANGED <<sent, epoch, sendEpoch, reqChat, aborted, gone, sawTerm, tabClosed>>

\* fetch(...).then(response) once headers arrive (public: only after ragGraph).
HeadersArrive(s) ==
    /\ reader[s] = "pending" /\ net[s] \in {"open", "ended", "cut_eof"}
    /\ reader' = [reader EXCEPT ![s] = "reading"]
    /\ UNCHANGED srvVars /\ UNCHANGED chan /\ UNCHANGED UIvars
    /\ UNCHANGED <<sent, epoch, sendEpoch, reqChat, aborted, gone, sawTerm, tabClosed>>

\* FIXC: idle timeout / stop button (abort via the function api.stream returns, api.ts:310-312).
ClientTimeout(s) ==
    /\ FIXC /\ Live(s) /\ srv[s] = "hung"
    /\ reader' = [reader EXCEPT ![s] = "failed"]
    /\ gone' = [gone EXCEPT ![s] = TRUE]
    /\ OnErrorUI(s)
    /\ UNCHANGED srvVars /\ UNCHANGED chan
    /\ UNCHANGED <<sent, epoch, sendEpoch, reqChat, aborted, sawTerm, tabClosed>>

ClientStep(s) ==
    \/ Deliver(s) \/ ParseFail(s) \/ EOF(s) \/ Fail(s) \/ HeadersArrive(s) \/ ClientTimeout(s)

(* Client: user actions *)
\* ChatInput.tsx:20,45 / PublicChatInput.tsx:29,46,56: input disabled while isStreaming.
\* chatStore.ts:168-185,198-201 / publicChatStore.ts:82-113.
Send ==
    /\ ~tabClosed /\ sent < N /\ ~isStreaming
    /\ LET s == sent + 1
           o == <<s, "o">>
       IN /\ sent' = s
          /\ sendEpoch' = [sendEpoch EXCEPT ![s] = epoch]
          /\ reqChat' = [reqChat EXCEPT ![s] = session]
          /\ reader' = [reader EXCEPT ![s] = IF MODE = "private" THEN "reading" ELSE "pending"]
          /\ srv' = [srv EXCEPT ![s] = IF MODE = "private" THEN "persistUser" ELSE "rag"]
          /\ net' = [net EXCEPT ![s] = IF MODE = "private" THEN "open" ELSE "pending"]
          /\ isStreaming' = TRUE
          /\ present' = [present EXCEPT ![o] = TRUE]
          /\ content' = [content EXCEPT ![o] = "empty"]
          /\ spin' = [spin EXCEPT ![o] = TRUE]
          /\ active' = [active EXCEPT ![s] = "o"]
    /\ UNCHANGED <<deep, leak, crashed, chatOf, persisted, terms, genDone, wasted, chan>>
    /\ UNCHANGED <<epoch, aborted, gone, sawTerm, tabClosed, session, lost>>

\* clearMessages (chatStore.ts:339-341, publicChatStore.ts:213-215): messages=[], chatSessionId=null,
\* no abort, isStreaming untouched.  Private caller ChatWithSuggestionsStep.tsx:44-48 is only
\* rendered when !isStreaming (:42,:92); public caller PublicChatPage.tsx:22-25 runs on every
\* mount / slug change, i.e. also mid-stream.
Clear ==
    /\ ~tabClosed /\ epoch < MaxEpoch
    /\ MODE = "public" \/ ~isStreaming
    /\ epoch' = epoch + 1
    /\ present' = [m \in Msgs |-> FALSE]
    /\ spin' = [m \in Msgs |-> FALSE]
    /\ session' = 0
    /\ IF FIXC
         THEN /\ aborted' = [s \in Streams |-> aborted[s] \/ Live(s)]
              /\ gone' = [s \in Streams |-> gone[s] \/ Live(s)]
              /\ reader' = [s \in Streams |-> IF Live(s) THEN "aborted" ELSE reader[s]]
              /\ isStreaming' = FALSE
         ELSE UNCHANGED <<aborted, gone, reader, isStreaming>>
    /\ UNCHANGED srvVars /\ UNCHANGED chan
    /\ UNCHANGED <<sent, sendEpoch, reqChat, sawTerm, tabClosed, content, active, lost>>

\* The user closes the tab: the server is never told (no req.on('close') in either handler).
TabClose ==
    /\ TabCloseOn /\ ~tabClosed /\ \E s \in Streams : Live(s)
    /\ tabClosed' = TRUE
    /\ gone' = [s \in Streams |-> gone[s] \/ Live(s)]
    /\ reader' = [s \in Streams |-> IF Live(s) THEN "gone" ELSE reader[s]]
    /\ UNCHANGED srvVars /\ UNCHANGED chan /\ UNCHANGED UIvars
    /\ UNCHANGED <<sent, epoch, sendEpoch, reqChat, aborted, sawTerm>>

Next ==
    \/ Send \/ Clear \/ TabClose
    \/ \E s \in Streams : ServerStep(s) \/ ClientStep(s)

Fairness == \A s \in Streams : WF_vars(ServerStep(s)) /\ WF_vars(ClientStep(s))

Spec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------
(* Properties *)

\* Q1: a preview never replaces an answer (or anything other than an empty message).
PreviewNeverOverwrites ==
    [][\A m \in Msgs : content'[m] = "preview" => content[m] \in {"empty", "preview"}]_vars

\* Q2: events of an older conversation do not leak into the current one.
SessionFresh == tabClosed \/ session = 0 \/ sendEpoch[session] = epoch
NoStaleChatReuse == \A s \in 1..sent : reqChat[s] # 0 => sendEpoch[reqChat[s]] = sendEpoch[s]

\* Q3: the UI shows "streaming" only while a stream is really live, and vice versa.
StreamingFlagSound == tabClosed \/ (isStreaming => \E s \in Streams : Live(s))
SpinnerSound == tabClosed \/ \A m \in Msgs : (present[m] /\ spin[m]) => Live(m[1])
IdleConsistent == tabClosed \/ (~isStreaming => \A m \in Msgs : present[m] => ~spin[m])
BusyVisible == tabClosed \/ (isStreaming => \E m \in Msgs : present[m] /\ spin[m])
EventuallyIdle == [](isStreaming => <>(~isStreaming \/ tabClosed))

\* Additional server-side properties.
NoLostAnswer == \A s \in Streams : ~lost[s]          \* a fully generated, shown answer is not replaced by "Error"
SingleTerminal == \A s \in Streams : terms[s] <= 1   \* exactly one of done/error per stream
NoLeakedKeepAlive == \A s \in Streams : ~leak[s]
NoCrash == ~crashed
NoWastedGeneration == \A s \in Streams : ~wasted[s]
=============================================================================
