# LZ-174 `6622ebf`: retained recovery review

Independent Luna read-only source review found a concrete final-admission race
and insufficient recovery-command regression coverage. Do not integrate this
candidate before same-worker correction and re-review.

## Findings

- **P1: disposed task can be recovered after native awaits.** In candidate
  `6622ebfc4fd51007b94090aab73d3177b1318586`, `prepareRetainedRepairRecovery`
  checks task revision, project and disposition at `runtime.ts:1143–1164`, then
  awaits native observations. Later checks at `:1459–1465, 1491–1541` revalidate
  plan/attempt state but omit fresh task identity/revision/project/disposition.
  A cancelled node can be disposed during that await without changing the plan
  version, and recovery can reserve/prompt obsolete work. Final admission must
  revalidate the current task and reject that race without a new reservation,
  input or native prompt. Preserve the committed candidate and prior receipts.
- **P2: required recovery fences lack runtime-path regressions.** New registered
  recovery tests at `runtime.test.ts:9156–9272` cover the positive path and later
  owner cancellation; helper negatives at `interrupted-continuation.test.ts:80–152`
  do not prove the actual recovery command rejects stale task/disposition, wrong
  route/artifact/owner, uncertain effects, pending controls or deferred
  reassignment/new-input changes. Exercise these at the public/runtime admission
  boundary, with exact original-attempt/input/history and prompt-count assertions.

## Evidence and preserved limits

The exact committed candidate passed isolated retained task checks `continuation`,
`runner` and `quality`, exit zero, unchanged, without timeout. Their per-check
verification contexts reported cleanup complete; that is not full operation or
original-worker resource cleanup. The reviewer did not run tests or edit files.

Original worker current input completed, but native idle entry ended in
`idle-lineage-unavailable`: no formal matching background report exists. Candidate
acceptance came from isolated retained verification, not fabricated native idle.
Preserve unknown original background/resources and the real original LZ-172
recovery gate. A substantive correction should use the same original LZ-174
attempt/session/tree/route after stopping only its obsolete verification
operation. Root WebGPU files and unrelated workers must remain untouched.
