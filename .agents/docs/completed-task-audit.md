# Completed-task audit and recovery plan

2026-10-31. Audited every accepted task against its contract, current source,
recorded checks and native observations. Twelve accepted tasks now belong to ten
integrated plans. Integration records do not erase missing acceptance observations.
Two further accepted nodes belong to the active product plan; speech source is merged
and the observation API is under review. See the [live audit](evidence/033-completed-task-audit/live-update.md)
and [durable snapshot](evidence/033-completed-task-audit/live-state.json) for current work.
The historical [full matrix](evidence/033-completed-task-audit/matrix.json) retains task IDs,
acceptance assertions, verification commands, artifacts, findings and sources.

## Delivered work

| Task                                         | Delivered and checked                                                                                                 | Remaining observation or limitation                                                                                   |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `5f5743c3` Retry-safe submission             | Durable logical identity, fresh-process replay, concurrency, validation, rollback, isolation; native worker and merge | Equivalent cost does not establish an efficiency comparison                                                           |
| `71e53745` Trajectory inspection             | Redaction, usage categories, pagination, project/permission boundaries; native report                                 | Legacy target identity mismatch still needs an authorized native read of a valid target                               |
| `8a2c9ed1` Readable task fetch               | Prose instructions plus typed structured reads; native Code Mode smoke                                                | No scoped functional gap identified                                                                                   |
| `970b0feb` Progressive worker guidance       | Optional skills, focused source discovery, no eager skill bodies; repair history retained                             | Live worker use of nonempty optional skill guidance remains unobserved                                                |
| `b9d649d7` Permission-based trajectory reads | Removed agent-name veto; permission-first private reads and regression coverage                                       | Live authorized implementor trajectory read after reload remains to be recorded                                       |
| `f55e7013` Shared Repomix snapshot           | Durable refresh/reuse, permission rechecks, rollback and cross-process races; integrated                              | Production Desktop refresh/index/read reuse needs an explicit observation                                             |
| `6edcc32f` Retry baseline                    | Explicit baseline survives reopen; old attempts, usage and checks retained                                            | No comparative cost or model-quality conclusion                                                                       |
| `fc88ccc0` Native model routes and personas  | Exact route forwarding, no fallback/veto, three optional overlays                                                     | Current native Go/Qwen and OpenAI/Luna workers demonstrate route use; persona quality is not established              |
| `2958fa32` Parallel dispatch                 | Real-Git tests cover conflicts, dependencies, combined checks, recovery, cancellation and cleanup                     | Three native workers now overlap; actual returned artifacts, combined UI acceptance and cleanup still need completion |
| `08e3d569` Tasks Start and continuation      | Native Start, running child, narrow layout, split resize, scroll and restoration; reconciled and integrated           | Full theme/font and broader recovery matrix remains partial                                                           |
| `7548e7f8` Tasks menu/tab affordances        | Native menu order, themed tab icon, close/reopen, canonical merge, Terra screenshot review and native cleanup passed  | First Qwen Go sample; cost/category attribution is incomplete, no comparative quality/cost claim                      |
| `1532ce08` Authored plan title               | Optional verbatim title, persistence, replay and legacy omission                                                      | UI title consumers belong to the grouping increment                                                                   |

Delivered means code and checks exist. Observed means the relevant native or real
runtime behavior was exercised. A fixture cannot substitute for a native criterion.
No repository hashing or model approval is completion evidence.

## State machine assessment

XState 5.33.3 genuinely computes task-node transitions and persisted snapshots.
`RunnerStore.move` enforces the machine version, updates the node transactionally,
and journals the transition. The runtime and SQLite own graph readiness, effects,
leases, verification, native sessions, integration and cleanup. The whole scheduler
is not an XState actor system. This separation is sufficient for the current product;
a rewrite would not close the observed operational gaps.

The small maintenance repair uses the supported pure `initialTransition` and
`transition` APIs and directly checks lifecycle edges, terminal rejection, snapshots
and version propagation. A future machine-definition change still needs an explicit
compatibility/migration decision for existing records.

This follows the distinction between deterministic transitions, persisted state and
external effects in [Stately's transition](https://stately.ai/docs/transitions) and
[persistence guidance](https://stately.ai/docs/persistence), and the determinism
boundary in [Temporal's workflow contract](https://docs.temporal.io/workflow-definition).
The installed XState version, not the current v6-alpha documentation surface,
determines the APIs used here.

## Repairs landed during the audit

- Added durable, project-scoped retirement for superseded, duplicate, rejected or
  reviewed fulfilled legacy tasks. Immutable specifications and history remain.
- Added versioned `schedule` commands, explicit priority and cross-plan integration
  prerequisites. Higher priority wins the next conflicting dispatch; active work
  continues. Dependent plans start from the integrated code.
- Scope overlap now informs serialization rather than rejecting admission. Exact
  duplicate candidates still require a recorded disposition.
- Reload cleanup waits for an in-flight scheduler operation before database close.
- Shortened Architect and implementor definitions while preserving research,
  source findings, focused questions, self-review, readable tasks and normal tools.
  Task submission precedes plan submission; users receive a compact task summary.
- Reconciled the permission, Repomix and Tasks plans through production commands;
  all three now record integration and native cleanup.

`9b0ab5e` contains the recovery/scheduling/prompt repairs. The reviewed tree including
machine API maintenance passes **222 tests / 2,276 assertions**, formatting, lint
and strict typecheck. These checks do not complete the native observations above.

## Executable order and remaining holes

All five product plans are admitted. The [persisted schedule](evidence/033-completed-task-audit/schedule.json)
records their priority, models and dependencies; no prose HOLD controls execution.

| Order                      | Existing work                                                                        | How the findings compound                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Now                        | Go Tasks menu/tab plus Luna observation API and speech, in separate native worktrees | Complete actual parallel return/review/merge/cleanup proof using requested product changes                                   |
| After observation API      | Radar and Trajectory panels, then GUI assembly                                       | Use approved mockups and Terra screenshot review; check live state and narrow-panel behavior                                 |
| After product integration  | Task references/grouping and durable progress                                        | Copy usable task references; expose waiting/running state; hook automatic facts and concise progress into one log            |
| After progress integration | Architect renewal                                                                    | Preserve decisions/questions/model, use provider/model/options cache policy, transfer ownership durably, archive predecessor |

Two further audit repairs are implemented and checked: native heartbeat now reads
session metadata, requesting history for final usage or message reconciliation;
plan inspection returns compact state by default with explicit `full: true` retrieval.
A real sample was 678 bytes of metadata versus 2,304,994 bytes / 184 transcript
messages. Lost-response, final-count and busy-again race regressions pass. These
changes were activated through supported location reload with the same worker
sessions and attempts. Active tools observed the reload boundary; no live performance
gain is claimed yet. A subsequent renderer hang and added diagnostics are recorded
in [renderer trace evidence](evidence/034-renderer-trace/report.md).

Cross-worktree Repomix delivery remains a concrete hole: native location moves
create separate context roots, and the three current worker roots have no published
cache. They have used ordinary source tools. Architect has a queued narrow repair
request to make a selected project snapshot readable in isolated worktrees, preserve
permission/project checks and as-of-refresh attribution, and demonstrate one refresh
plus isolated read without recollection. Unavailable optional context falls back to
normal reads/LSP. This supplements workspace-local reuse rather than repeating it.

Close the trajectory permission, Repomix reuse and optional-guidance observations
while these real workers run. Keep missing observations in this matrix; create a
small repair only when an actual failure needs code. Do not rerun broad historical
specifications or turn every observation into another approval gate.

Durable progress and small handoffs are consistent with
[Anthropic's long-running harness findings](https://www.anthropic.com/research/effective-harnesses-for-long-running-agents).
We apply those findings to current failures rather than copying a large prompt or
adding another orchestration layer. Completed work per hour and accepted-task cost
remain the product measures; this run does not yet prove a cost improvement.

## Observed wake churn

The completed Tasks affordance generated separate resumable task-accepted and
plan-accepted outcomes. Architect subsequently answered obsolete notices with
“already handled” even after integration. [The outbox/inbox audit](evidence/033-completed-task-audit/wake-churn.md)
identifies exact outcomes and the public native inbox APIs. A narrow repair must
retain durable history and lost-response recovery while suppressing obsolete
queued outcomes and waking Architect only for actionable orchestration. This is
not covered by the progress or session-renewal tasks.
