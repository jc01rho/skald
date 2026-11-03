---------------------------- MODULE CircuitBreaker ----------------------------
(***************************************************************************)
(* Model of worker/src/skald_worker/circuit_breaker.py as used by          *)
(* clients/skald.py (one shared "skald-api" breaker, skald.py:195-203)     *)
(* under concurrent asyncio callers, plus the release collector's          *)
(* "wait out the open circuit" loop (release_collector.py:517-559).        *)
(*                                                                         *)
(* asyncio is single-threaded: every code segment between two awaits is    *)
(* one atomic TLA+ step.                                                   *)
(*   Enter(c)  = __aenter__ (circuit_breaker.py:211-225). The `state`      *)
(*               property (104-112) may move OPEN->HALF_OPEN. Lock acquire *)
(*               on a free asyncio.Lock does not yield, so check+acquire   *)
(*               (220-223) is atomic.                                      *)
(*   (await)   = the wrapped request incl. tenacity retries                *)
(*               (skald.py:243-255, retry.py:91-131).                      *)
(*   Exit(c,o) = __aexit__ (227-239): release lock if *anyone* holds it    *)
(*               (230-231), then record_success (174-182) /                *)
(*               record_failure (184-209). o = "cancel" models             *)
(*               CancelledError (BaseException: lock released, nothing     *)
(*               recorded, 235).                                           *)
(*   Tick      = recovery_timeout elapses since last_failure_time          *)
(*               (133-136); record_failure resets it (195).                *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS Callers,            \* generic concurrent callers (docs/userdata/API routes)
          FailureThreshold,   \* config.py:219 (default 5)
          SuccessThreshold,   \* config.py:227 (default 2)
          MaxWaits,           \* release_sync_circuit_max_waits, config.py:145 (default 5)
          WITH_RELEASE,       \* include the release collector task R
          FIX_LOCK,           \* fix: only the probe owner releases the lock, only probe outcomes count in HALF_OPEN
          FIX_RELEASE_WAIT    \* fix: release collector never sleeps 0 s after a rejection

VARIABLES cb, failCount, succCount, pending, cooled, locked,
          pc, holds, admitted,
          rpc, rholds, radmitted, rwaits, rticks, rtick

vars == <<cb, failCount, succCount, pending, cooled, locked,
          pc, holds, admitted, rpc, rholds, radmitted, rwaits, rticks, rtick>>

Min(a, b) == IF a < b THEN a ELSE b

TypeOK ==
    /\ cb \in {"CLOSED", "OPEN", "HALF_OPEN"}
    /\ failCount \in 0..FailureThreshold
    /\ succCount \in 0..SuccessThreshold
    /\ pending \in BOOLEAN /\ cooled \in BOOLEAN /\ locked \in BOOLEAN
    /\ pc \in [Callers -> {"idle", "req"}]
    /\ holds \in [Callers -> BOOLEAN]
    /\ admitted \in [Callers -> {"none", "CLOSED", "HALF_OPEN"}]
    /\ rpc \in {"try", "req", "sleep", "ok", "failCircuit", "failOther", "off"}
    /\ rwaits \in 0..MaxWaits /\ rticks \in 0..1 /\ rtick \in BOOLEAN

Init ==
    /\ cb = "CLOSED" /\ failCount = 0 /\ succCount = 0
    /\ pending = FALSE /\ cooled = FALSE /\ locked = FALSE
    /\ pc = [c \in Callers |-> "idle"]
    /\ holds = [c \in Callers |-> FALSE]
    /\ admitted = [c \in Callers |-> "none"]
    /\ rpc = IF WITH_RELEASE THEN "try" ELSE "off"
    /\ rholds = FALSE /\ radmitted = "none"
    /\ rwaits = 0 /\ rticks = 0 /\ rtick = FALSE

(* `state` property, circuit_breaker.py:104-112 (+ _transition_to 138-152) *)
Read ==
    IF cb = "OPEN"
    THEN IF pending THEN [s |-> "OPEN", p |-> FALSE, sc |-> succCount]          \* 107-109
         ELSE IF cooled THEN [s |-> "HALF_OPEN", p |-> FALSE, sc |-> 0]         \* 110-111, 150-152
         ELSE [s |-> "OPEN", p |-> pending, sc |-> succCount]
    ELSE [s |-> cb, p |-> pending, sc |-> succCount]

(* Outcome recording, circuit_breaker.py:174-209. `probe` = this call      *)
(* acquired the half-open lock. Returns the new breaker fields.            *)
Record(o, probe) ==
    LET ignore == FIX_LOCK /\ cb = "HALF_OPEN" /\ ~probe
        same   == [cb |-> cb, fc |-> failCount, sc |-> succCount, p |-> pending, co |-> cooled]
    IN
    IF o = "cancel" \/ ignore THEN same
    ELSE IF o = "ok" THEN
        IF cb = "HALF_OPEN"
        THEN IF succCount + 1 >= SuccessThreshold
             THEN [cb |-> "CLOSED", fc |-> 0, sc |-> 0, p |-> FALSE, co |-> cooled]   \* 178-179, 144-147
             ELSE [same EXCEPT !.sc = succCount + 1]                                \* 177
        ELSE IF cb = "CLOSED" THEN [same EXCEPT !.fc = 0]                          \* 180-182
        ELSE same
    ELSE \* failure (all non-4xx exceptions count, skald.py:201)
        LET fc == Min(failCount + 1, FailureThreshold) IN                          \* 194
        IF cb = "HALF_OPEN"
        THEN [cb |-> "OPEN", fc |-> fc, sc |-> succCount, p |-> TRUE, co |-> FALSE] \* 197-199, 149
        ELSE IF cb = "CLOSED" /\ fc >= FailureThreshold
        THEN [cb |-> "OPEN", fc |-> fc, sc |-> succCount, p |-> FALSE, co |-> FALSE]\* 200-201
        ELSE [cb |-> cb, fc |-> fc, sc |-> succCount, p |-> pending, co |-> FALSE]  \* 195

ApplyRead(r) == cb' = r.s /\ pending' = r.p /\ succCount' = r.sc
ApplyRec(n) == cb' = n.cb /\ failCount' = n.fc /\ succCount' = n.sc /\ pending' = n.p /\ cooled' = n.co

AnyHolder == (\E c \in Callers : holds[c]) \/ rholds

(* __aenter__, circuit_breaker.py:211-225 *)
Enter(c) ==
    /\ pc[c] = "idle"
    /\ LET r == Read IN
       /\ ApplyRead(r)
       /\ IF r.s = "OPEN" \/ (r.s = "HALF_OPEN" /\ locked)            \* 215-216, 220-222: reject
          THEN UNCHANGED <<locked, pc, holds, admitted>>
          ELSE /\ pc' = [pc EXCEPT ![c] = "req"]
               /\ admitted' = [admitted EXCEPT ![c] = r.s]
               /\ IF r.s = "HALF_OPEN"                               \* 223
                  THEN locked' = TRUE /\ holds' = [holds EXCEPT ![c] = TRUE]
                  ELSE UNCHANGED <<locked, holds>>
    /\ UNCHANGED <<failCount, cooled, rpc, rholds, radmitted, rwaits, rticks, rtick>>

(* __aexit__, circuit_breaker.py:227-239 *)
Exit(c, o) ==
    /\ pc[c] = "req"
    /\ locked' = IF FIX_LOCK THEN (IF holds[c] THEN FALSE ELSE locked)
                 ELSE FALSE                                         \* 230-231: releases whoever holds it
    /\ ApplyRec(Record(o, holds[c]))
    /\ pc' = [pc EXCEPT ![c] = "idle"]
    /\ holds' = [holds EXCEPT ![c] = FALSE]
    /\ admitted' = [admitted EXCEPT ![c] = "none"]
    /\ UNCHANGED <<rpc, rholds, radmitted, rwaits, rticks, rtick>>

(* Release collector: release_collector.py:530-559 around sync_release -> skald client *)
REnter ==
    /\ rpc = "try"
    /\ LET r == Read IN
       /\ ApplyRead(r)
       /\ IF r.s = "OPEN" \/ (r.s = "HALF_OPEN" /\ locked)
          THEN \* CircuitBreakerError(name, time_until_recovery) (216/222); time_until_recovery
               \* is 0 unless _state.state = OPEN and timeout not elapsed (124-131)
               LET rt0 == ~FIX_RELEASE_WAIT /\ (r.s # "OPEN" \/ cooled) IN
               /\ IF rwaits >= MaxWaits                              \* 535-542
                  THEN rpc' = "failCircuit" /\ UNCHANGED <<rwaits, rtick>>
                  ELSE /\ rwaits' = rwaits + 1
                       /\ rpc' = IF rt0 THEN "try" ELSE "sleep"     \* 549 asyncio.sleep(recovery_time)
                       /\ rtick' = FALSE
               /\ UNCHANGED <<locked, rholds, radmitted>>
          ELSE /\ rpc' = "req" /\ radmitted' = r.s
               /\ IF r.s = "HALF_OPEN" THEN locked' = TRUE /\ rholds' = TRUE
                  ELSE UNCHANGED <<locked, rholds>>
               /\ UNCHANGED <<rwaits, rtick>>
    /\ UNCHANGED <<failCount, cooled, pc, holds, admitted, rticks>>

RWake ==
    /\ rpc = "sleep" /\ rtick
    /\ rpc' = "try"
    /\ UNCHANGED <<cb, failCount, succCount, pending, cooled, locked, pc, holds, admitted,
                   rholds, radmitted, rwaits, rticks, rtick>>

RExit(o) ==
    /\ rpc = "req"
    /\ locked' = IF FIX_LOCK THEN (IF rholds THEN FALSE ELSE locked) ELSE FALSE
    /\ ApplyRec(Record(o, rholds))
    /\ rpc' = IF o = "ok" THEN "ok" ELSE "failOther"                 \* 533 / 550-556
    /\ rholds' = FALSE /\ radmitted' = "none"
    /\ UNCHANGED <<pc, holds, admitted, rwaits, rticks, rtick>>

(* Wall-clock time passes (>= recovery_timeout, and >= any positive sleep). *)
Tick ==
    /\ (~cooled \/ (rpc = "sleep" /\ ~rtick))
    /\ cooled' = TRUE
    /\ IF rpc = "sleep" THEN rtick' = TRUE /\ rticks' = 1 ELSE UNCHANGED <<rtick, rticks>>
    /\ UNCHANGED <<cb, failCount, succCount, pending, locked, pc, holds, admitted,
                   rpc, rholds, radmitted, rwaits>>

Outcomes == {"ok", "fail", "cancel"}

Next ==
    \/ \E c \in Callers : Enter(c) \/ \E o \in Outcomes : Exit(c, o)
    \/ REnter \/ RWake \/ \E o \in Outcomes : RExit(o)
    \/ Tick

Fairness ==
    /\ WF_vars(Tick)
    /\ \A c \in Callers : WF_vars(Enter(c)) /\ WF_vars(\E o \in Outcomes : Exit(c, o))
    /\ WF_vars(REnter) /\ WF_vars(RWake) /\ WF_vars(\E o \in Outcomes : RExit(o))

Spec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------
(* Safety *)

\* "HALF_OPEN: Testing if service recovered, one request allowed" (circuit_breaker.py:11, 219)
ProbeBound ==
    Cardinality({c \in Callers : pc[c] = "req" /\ admitted[c] = "HALF_OPEN"})
      + (IF rpc = "req" /\ radmitted = "HALF_OPEN" THEN 1 ELSE 0) <= 1

\* The half-open lock is held iff the caller that acquired it is still in flight.
LockOwned == locked <=> AnyHolder

\* A release version is only given up on after real time has been waited
\* (docstring release_collector.py:522-527: "waiting out an open Skald circuit").
RelNoInstantBurn == rpc = "failCircuit" => rticks = 1

(* Liveness *)
NotStuckOpen == [](cb = "OPEN" => <>(cb # "OPEN"))
LockEventuallyFree == [](locked => <>(~locked))
=============================================================================
