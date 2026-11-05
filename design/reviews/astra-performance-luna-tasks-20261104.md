# Remaining performance work — Astra review, 2026-11-04

Implementors and subsequent research: OpenAI `gpt-6-luna`, effort `max`.
Architect: OpenAI Sol High. Root operates Desktop and visual/quiet CPU checks.
These are proposals for Architect to reconcile with existing tasks and dispatch;
they are not submitted task records or acceptance receipts.

## Current evidence

Comparable service CPU fell73.05%→22.52% after the earlier repairs. Tasks grouping
now uses an actual16ms current-topology read. Its later settled view still measured
26.59% service/7.48% renderer/8.56% GPU-process CPU. The no-op SQLite insert repair
is integrated; model work resumed before a fair post-repair idle comparison.
See [measurements and validation](astra-task-topology-repair-20261104.md).

## Reduce unchanged progress recovery work

Goal: lower repeated projection/deduplication cost while retaining complete recovery.

Source: `src/progress/recorder.ts` and reconstruction tests. The retained profile
contains58/125 reconstruction stacks,27 including message reconciliation; fresh
counters recorded eight full-context recoveries in42 seconds. The already-landed
ignored-insert repair must be reused.

Done when: representative unchanged history costs measurably less; new/revised
facts retain equivalent durable results. Verify recorder/reconstruction tests,
replay/reopen and second-connection updates, then Root's quiet native comparison.

Pitfalls: native `time.updated` is not a guaranteed context revision. Preserve
late terminal history, reconnect recovery and existing data projection semantics.

## Inspect the retained Architect journal progressively

Goal: expose predecessor input/result records through existing plan inspection,
fulfilling the existing LZ28/LZ30 compact-handoff contract.

Source: `src/runner/inspection.ts`, supporting store reads/tests. Renewal delivered
233 source notices containing651171 characters; the inspector currently lacks a
dedicated journal view.

Done when: scoped progressive reads expose original references, revisions,
dispositions and unresolved work without placing the journal in the handoff.
Verify pagination, concurrent updates, access boundaries and honest unknown coverage.

Pitfall: inspection does not imply consumption or retrospective checkpoint coverage.

## Coalesce prospective renewal source notifications

Depends on journal inspection. Goal: replace per-ID historical push batches with
compact source-change notifications that point to progressive inspection.

Source: notification writes in `src/runner/store.ts` and runtime delivery paths.
Current delivery explicitly excludes source-reference notices from supersession.

Done when: a large journal yields a compact initial handoff and coalesced pending
notices; new/revised actionable input and outcomes remain discoverable and signalled.
Verify updates during admission, retries, owner transfer and restart.

Pitfalls: preserve delivery receipts, input blockers and separate worker outcomes.
Reconcile already-admitted notices explicitly; do not silently delete/rewrite them.

## Finish retained LZ129 and connect the bounded read path

Reuse LZ129's current worker, attempt and draft; no duplicate reader task.
Goal: finish its bounded live/history contract and connect affected panel reads.

Source: retained observability changes; full historical readers still reject the
project above10000 transitions. Selected Trajectory can then display misleading
empty-state text.

Done when: current information remains available at actual history volume,
history is progressively accessible and failures cannot masquerade as empty data.
Verify large histories, scope isolation, cursor/coverage semantics and Root's
actual selected-trajectory navigation.

Pitfall: retain full snapshot promises and the new topology endpoint; raising a
lifetime ceiling or returning empty history is not the solution.

## Attribute Tasks busy-indicator rendering cost

Goal: establish or rule out indicator animation as a material renderer cost, then
make a focused correction if confirmed.

Source: continuous running/verifying animation in `src/tasks/panel.css`; measured
Tasks renderer7.48% and GPU-process8.56% CPU. Causation is unproven.

Done when: Root's controlled, fixed-view comparison attributes or rules out the
cost; any resulting candidate preserves readable state, visible activity and
reduced-motion behavior with measured improvement. Keep DevTools closed and
confirm the actual animation state.

Pitfalls: no blanket animation disable, inference-setting change or claim that
GPU-process CPU measures GPU utilization.

## Ordering and retained work

Recovery projection work and journal inspection can start in parallel in isolated
native worktrees with non-overlapping source scopes. Notification coalescing
follows inspection and serializes shared store/runtime changes. Preserve LZ129's
observability ownership and LZ132's independent advice work. Architect should
reconcile task boundaries against those current assignments before submission.

Models remains unfinished: the approved graph/UI, editable assignments and live
persona-to-dispatch mapping must remain explicit roadmap work. Current saved
assignment views are read-only and do not control dispatch. Do not count route
configuration receipts as delivery of that feature.
