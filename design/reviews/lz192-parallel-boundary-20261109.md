# Recovery dependency reassessment — 2026-11-09

## Decision

The original LZ-192 plan over-serialized recovery by putting public controls,
automatic supervision and Tasks integration behind the same LZ-181/LZ-182 gate.
Preserve the original task and its complete acceptance, but supply its independent
producers through linked feature tasks. Do not replace either running worker.

| Outcome                                                                                                                                                                           | Owner and execution boundary                                    | Why                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Usable recovery controls, tracked same-worker checkpoints, disposition/follow-up records, reviewed handoff and focused correction retrieval                                       | **LZ-195**, dispatched now, no 181/182 prerequisite             | Existing handoff persistence/review is substantial but unregistered. This is an independently useful public workflow, not another store-only increment. Its recovery/bootstrap/Architect-guidance scope is disjoint from active runner/Tasks edits.                      |
| Automatic concern detection, incident-specific current-Architect notification and durable follow-up/reassessment                                                                  | **LZ-196**, scheduled after integrated 195 and 181, **not 182** | Runtime owns private outbox delivery and supersession policy. Existing coalescing can erase a concern or an unrelated outcome. Integration must preserve the same delivery machinery and shared runtime writer rather than bypassing reservations with another notifier. |
| Visible Tasks reasons, Ask Architect, downstream recovery briefing, safe writer reconciliation and full recovery→verification→review→integration/cleanup→dependent-dispatch proof | **Existing LZ-192**, scheduled after 196 and 182                | Tasks consumer edits need 182's foundation; 196 supplies the recovery backend and transitively 181/195. Original acceptance remains, with producers consumed rather than rebuilt.                                                                                        |

The native scheduler confirmed LZ-195 has a real dispatched attempt and worker
tool activity. LZ-196 and LZ-192 remain queued on the recorded source prerequisites.
No running attempt was cancelled, replaced or given a competing writer.

## Source versus ownership dependencies

Research used main `106c45ca8a7a2638b635b4083c1d1f011b280201` and snapshot
`1f6383ae-d138-48b9-a9ca-2cf5c91546b2` as-of-refresh.

- `src/recovery/journal.ts:239–325,366–498` and `producer.test.ts` already provide
  real material-update capture and bounded durable consumption. A new journal
  foundation is unnecessary.
- `src/recovery/handoff/{store,review}.ts` already provide source attachment,
  drafts/reports, review and disposition. `src/index.ts` does not register the
  public workflow. Focused handoff retrieval is explicitly allowed by
  `design/recovery-handoff-contract.md:65–79`; Tasks detail edits need not block it.
- `src/index.ts:151–169` can compose bounded recovery observation into the existing
  project participant. `scheduler-coordinator.ts:150–164` selects one participant,
  so adding another same-key callback is not a delivery solution.
- `runtime.ts:6288–6359,12731–13066` owns delivery and ordinary coalescing.
  LZ-181 is a **shared-file ownership/source dependency** for changing that policy,
  plus a functional prerequisite for ordinary check responsiveness. It is not a
  prerequisite for public recovery controls or handoff review.
- LZ-182 supplies Tasks scheduling/Attention and integrated-prerequisite dispatch.
  It is **not** a source dependency for recovery detection, controls or automatic
  Architect notification.

General failed-check inference is not promised from arbitrary successful shell
tool output. LZ-196 starts with explicit terminal edit/patch failures and recorded
follow-up expectations; distinct calls and material updates are discriminated.
Long duration, usage or repeated reads alone do not establish struggle. A concern
does not cancel or take over a worker.

## Verification and remaining limits

LZ-195 must exercise production registration and public request/read/checkpoint/
handoff/review/disposition callbacks with disposable SQLite and captured native
delivery. It must distinguish admission/consumption/response, reject stale/foreign
commands, and survive lost replies/reopen without duplicate prompts. Existing
store tests alone do not close it.

LZ-196 must test the actual journal→concern→existing-outbox path, including
unrelated outcome preservation, ownership races, due follow-up without a new
event, and delivery while a real ordinary asynchronous check is barrier-blocked.
Its local semantic self-review was unavailable after a GPU device loss; no review
pass or product correctness was inferred, and inference settings were untouched.

New implementation checks are pending. LZ-192 retains the combined native
acceptance, including actual downstream context, writer/resource safety and
integration/dependent dispatch. The retained Desktop's exact route and loaded
source qualification remain separate live-evidence limits, not a reason to stop
backend implementation.

## LZ-181 reassessment remains owned

Independent investigation now observes focused lineage **6 pass / 78 assertions**
and two full adoption runs at **20 pass / 4 fail** with the same failures. The
promised reassessment condition has occurred. The lineage correction is useful,
but does not justify indefinite continuation of the unresolved adoption episode.
Deletion of the failed/READY completed-check restart/no-replay segment is an
explicit review issue; the resulting pass does not prove the removed scenario.

Architect requested a concise evidence/ownership handoff checkpoint from the same
worker before further adoption guidance. This is not cancellation, completion,
surrender or release of its reservation. Preserve dirty work and native effects;
no overlapping takeover is authorized. The next decision is based on that actual
checkpoint and investigation, not another unchanged broad-suite rerun or an
elapsed-time quota.
