# LZ-181 recovery disposition — 2026-11-09

## Decision

Continue the same original worker, attempt and useful draft. The adoption failure
episode shows concrete post-intervention progress; do not request surrender,
replace its writer, add another implementation tip or infer completion yet.

This is an Architect disposition, not a worker-authored handoff or proof of
quiescence. Runtime execution/acceptance and resource holds remain unchanged.

## Evidence and incident boundary

- Task: LZ-181 (`75c838e3-d292-46aa-968f-8cc5417a1ee7`).
- Attempt: `4d691f62-10c6-456f-b862-72cf665c4bb6`.
- Original worker: `ses_12ba163aca2a4703a19aa82430adb1ab`.
- Advice 1–3 supplied context/policy, not three failed recovery rounds.
- Advice 4–5 reconciled the reviewed retained-repair implementation; the retained
  suite reached 62/62. Preserve that evidence separately.
- Advice 6 is one focused adoption/restart/candidate-mutation episode. Its earlier
  repeated 4-pass/2-fail run is the pre-intervention baseline, not today's result.
- Post-advice message `msg_1be11ebfc001uN1wPmaZ3yftLx` runs both receipt-cut cases:
  **2 pass, 0 fail, 24 assertions**, then the candidate-index mutation case:
  **1 pass, 0 fail, 12 assertions**. The command does not raise test timeouts.
  An earlier filter matched zero cases; that is not counted as a test pass.
- Source inspection confirms the receipt-cut phases remain separately exercised,
  with exact receipt/no-replay/history checks. The mutation test observes a running
  combined activity before mutation and checks retained exact subprocess receipt
  evidence while acceptance remains held. This is useful progress, not final
  approval of every changed test or runtime path.
- The worker next introduced a focused stop/admission regression. Message
  `msg_1be1425f5001ySHKdvmkRU8BiT` reports a subprocess-start barrier failure for
  `runtime stop aborts checks admitted by its draining tick before storage
disposal`. This is new concrete investigation evidence, not another unchanged
  adoption timeout. Its correction and discriminating coverage remain unverified.

## Next observable reassessment condition

Reassess at the **next completed result of that focused stop/admission regression,
or the full adopted-descendant suite, whichever occurs first**. Also reassess on a
terminal/blocked worker outcome or an explicit inability to produce that result.
Use the actual native result, not merely delivery/consumption of this decision.

- A useful correction with discriminating checks permits continuation to full
  adoption, retained/runner quality and candidate review under the existing task.
- The same unresolved failure with no concrete changed approach requires
  Architect investigation and an explicit handoff/takeover disposition **before
  another steering round**. Do not default to more tips or a larger timeout.
- A different failure is classified on its evidence. A new red regression can be
  justified investigation, but does not itself establish a repaired product.
- If handoff/takeover is chosen, preserve dirty work and original history. Reconcile
  the old writer, native/background work and uncertain effects through supported
  controls before allowing another actor to edit overlapping source. A report or
  an empty inbox is not proof that ownership is released.

There is no new elapsed-time, token, tool-call or advice-count quota. One focused
steering round is the default for an incident; another needs a recorded concrete
new approach or useful progress. The external driver observes outcomes rather
than debugging the worker's implementation.

## Existing roadmap reconciliation

`design/proactive-worker-recovery.md:151–186` already defines this loop. Current
`src/architect.md` does not explicitly teach post-steering reassessment, while
`src/recovery/handoff/index.ts` exports the existing store/schema without public
registration in `src/index.ts`. Existing LZ-55/69 persistence/review work is a reuse
point, not evidence that the complete native flow is delivered.

These missing producer/consumer and guidance pieces remain with **existing
LZ-192's owned-investigation/autonomous-recovery outcome**. Its scope now includes
`src/recovery/**` and `test/recovery/**`; advice 5 records the required registration,
durable disposition/follow-up association, improving-versus-persistent-failure
fixtures, safe handoff ownership and real delivery/reassessment proof. Its LZ-181
and LZ-182 source-integration prerequisites are unchanged. No new task, watchdog,
retry scheduler, generic task-versioning system or quota was created.

Until that runtime follow-up path is delivered, this record and Architect
continuity retain the manual reassessment obligation. Do not misrepresent the
documentation as a scheduled runtime concern or functioning handoff tool.
