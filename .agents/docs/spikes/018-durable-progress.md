# Spike 018: Durable worker progress

## Outcome

Worker commentary and automatically observed execution facts are stored in one
project SQLite log, ordered per project by sequence and attached to the exact
runner plan, task, attempt, and native session. `lazers_report_progress` accepts
only a concise message; caller identity and the active attempt are resolved from
native tool context and runner rows. Progress and observed facts remain
annotations, not evidence or lifecycle authority.

## Implementation

- `src/progress/recorder.ts` owns transactional append, native/runtime identity,
  logical deduplication, recovery reconciliation, and reminder admission state.
- `src/progress/native.ts` registers the permission-checked tool, post-tool hook,
  public native-event listener, startup reconciliation, and bounded idle handoff.
- `src/runner/store.ts` creates the progress fact and reminder identity tables;
  `src/runner/runtime.ts` records artifact, check, and attempt-outcome facts.
- `src/progress/projection.ts` allowlists the progress fields exposed by
  `lazers_inspect_trajectory`; `src/trajectory/read.ts` includes them in ordered
  pages and reports coverage counts.
- `src/implementor.md` and `src/architect.md` state the annotation/authority
  boundary.

The registered tool rejects extra task/token fields and checks native permission
before writing. Hook, event, and retained public-message observations coalesce
by stable native call/message identity. Tool inputs and hidden context are not
persisted. Measured step usage is marked additive; session snapshots are kept
separate and non-additive. Failed checks and incomplete recovery are represented
as observations or explicit gaps, not acceptance decisions.

Reminder admission stores an exact synthetic message ID and ownership metadata
before sending. Completion is conditional on that claim's attempt/session/
message identity. Confirmed rejection can retry once with the same ID; ambiguous
admission remains unknown until a matching native event or retained synthetic
message proves it was admitted. An unknown claim is never blindly resent. A
reentrant or repeated idle hook cannot create another synthetic turn for the
same attempt. A final assistant handoff requires terminal visible prose after
the latest prompt and after any later tool work; early commentary alone does not
suppress the reminder.

## Verification

Focused coverage exercises the registered tool against the real SQLite
repository, hook/event/recovery coalescing, denied/foreign callers, duplicate
native delivery, reopen and two-connection concurrent appends, measured step
usage and cumulative snapshots, failure/interruption recovery, exact reminder
identity, synthetic admission recovery, rejection retry bounds, and early
commentary/tool/final handoff cases. Runtime integration tests assert that
artifacts and successful checks are recorded without changing acceptance rules.

The native tool/event paths are covered through registered-tool tests and
simulated host events. A manual OpenCode Desktop worker lifecycle observation
was not performed for this spike; live native stream availability and complete
session history therefore remain explicit runtime recovery boundaries.

Verification results:

```text
bun test src/progress test/progress src/trajectory test/trajectory src/runner/runtime.test.ts  # 123 passed
bun test                                                                                    # 357 passed
bun run verify                                                                              # passed
```

The full suite required `bun scripts/prepare-engine.ts` first because this clean
worktree did not contain the ignored pinned WebGPU engine cache used by the GUI
setup test. The checksum-pinned generator completed before the passing run.
