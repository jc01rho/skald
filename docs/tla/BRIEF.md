# TLA+ review brief (shared by all area workers)

Project: /home/whrho/git/skald (production RAG platform; read-only for you).
Work directory for your output: /home/whrho/git/skald-wt/tla-review/docs/tla/<area>/ (a git worktree; write ONLY inside your area folder).
Read source code from the worktree (/home/whrho/git/skald-wt/tla-review), which is origin/main.

## Goal
Find real logic defects (races, lost updates, stuck states, double processing, wrong state transitions,
non-atomic multi-step writes, liveness failures) in your AREA by modeling it in TLA+ (or PlusCal) and
model-checking it with TLC. The model must follow what the code actually does (cite file:line for every
action), not what it is supposed to do. Model only the parts that matter for concurrency/state; abstract
payloads away. Include the realistic environment: multiple pods/consumers, message redelivery, crashes
between steps, process restarts, timeouts, concurrent user actions, as the code and k8s setup allow.

## Tools
- TLC: `/usr/lib/jvm/java-21/bin/java -XX:+UseParallelGC -cp /home/whrho/.local/share/tla/tla2tools.jar tlc2.TLC -workers 4 -cleanup -deadlock <Spec>.tla -config <Spec>.cfg`
  (drop `-deadlock` only if termination is expected and you check deadlock separately; keep constants small so each run finishes in < 5 minutes).
- PlusCal translation: `/usr/lib/jvm/java-21/bin/java -cp /home/whrho/.local/share/tla/tla2tools.jar pcal.trans <Spec>.tla`
- Use -metadir under /tmp to keep the worktree clean of states/ dirs. Do not leave TLC `states/` or `*_TTrace_*` files in the worktree.

## Method
1. Read the code; list the state variables, actors and atomic steps (each DB statement / transaction / queue op / await boundary is a step).
2. Write invariants (safety) and, where meaningful, temporal properties (liveness with explicit fairness) that express what correct behavior means for users.
3. Run TLC. For every violation: read the trace, then go back to the code and confirm the interleaving is actually possible (cite lines). Classify each as CONFIRMED (code permits it), MODEL-ONLY (artifact of abstraction; fix the model), or NEEDS-RUNTIME (depends on infra behavior you cannot confirm from code).
4. For confirmed defects, add a minimal "fixed" variant (constant flag or separate spec) showing the proposed fix makes TLC pass.
5. Do NOT modify application source code. Do NOT commit or push. Do not touch other areas' folders.

## Deliverables in your area folder
- `*.tla` + `*.cfg` files (they must run with the command above).
- `README.md` written in Korean: what is modeled (with code mapping file:line), properties, TLC results per run (spec, cfg, distinct states, pass/fail, time), each finding with severity (high/medium/low), the trace in plain words, code evidence, classification, and the proposed fix. Also list what was deliberately NOT modeled.

## Final answer (English is fine)
A compact list: files written; for each finding: title, severity, classification, file:line evidence, one-line fix; TLC run results table; anything you could not check.
