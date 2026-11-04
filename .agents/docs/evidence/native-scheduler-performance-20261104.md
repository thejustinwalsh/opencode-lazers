# Scheduler performance repair — 2026-11-04

Root implemented the user-assigned repair while native Architect and its
reconstruction worker continued. Native OpenCode created the repair worktree.
Source `bfdc6e1` was integrated as `cba6ab2`; no runtime reload or inference-setting
change was performed. Source inclusion does not prove effective activation.

## Measured baseline

At roughly 07:13 ET, ten two-second CPU intervals averaged **63.5% service**,
**25.2% renderer**, **32.5% GPU helper**. Architect and the reconstruction worker
were active. This confirms sustained CPU use in that window, not the reported
earlier 2,000% peak or its cause. Raw bounded capture:
`/private/tmp/lazers-energy-before-scheduler-20261104.txt`.

The earlier five-second service sample retained mostly unsymbolized Bun/JIT
stacks and SQLite work. It cannot attribute CPU to a specific JavaScript
function. Do not claim ONNX causation from that sample. A native review separately
reported an actual GPU device-loss/mapAsync error; it is not proof of CPU causation.

## Implemented and tested

- One process-shared deadline timer, coalesced project reconciliation, independent
  project deadlines, no overlapping drain for one project, explicit wake requests.
- Location tools/hooks remain registered. Disposal waits for owned work before
  storage closes; replacement work does not overlap the retiring drain.
- Manual Start uses the elected runtime, avoiding a second location lease owner.
- Lease heartbeats use the same timer. A failed lease claim releases the runtime's
  running flag so the next reconciliation can retry.
- Read-only `sharedScheduler.snapshot()` reports aggregate timer/group/participant,
  running, run, error and wake counts for the pending native diagnostics seam.

Bun 1.4.4 native-environment checks: **138 runtime tests / 2,544 assertions**
(74.54 seconds); **15 coordinator tests / 50 assertions**. Formatting, lint,
typecheck and diff checks pass. Main repeats of coordinator tests, lint and
typecheck pass after integration. An earlier sandboxed broader run hit short
adoption-test timeouts before the runtime edits and was stopped; that is not a
full-suite pass, and its timeout cause was not established.

## Remaining proof

Coordinate activation with native work, verify the effective scheduler, then
measure sustained CPU, actual reconciliation counts and errors during matched
no-worker and working windows. Compare against the recorded activity conditions;
do not infer improvement from timer arithmetic or passing tests. Continue the
reconstruction correction/diagnostics and investigate residual CPU independently.
Computer Use explicitly reported locked before Root could deliver its commit
handoff prompt. Native Architect and worker were still confirmed active.

## Inference-settings follow-up

Source `39ea888`, merge `bae990e`, removes the additional one-second interval
created by each location's inference registration. Those jobs use the same shared
timer, and their authority reads share an in-flight request/value for one polling
interval. Feature authority, GPU jobs, enabled settings and scope-local tool/agent
updates remain intact. Separate injected authorities remain separate.

Merged verification: **30 tests / 145 assertions** across coordinator, settings
read, feature-server and task-review suites; typecheck and diff checks pass.
Independent 54-reader tests show one request per interval, retry after failure
without presenting expired data as refreshed, and sharing across loader copies.
This remains source/component proof. Native activation and CPU comparison are
still pending; Computer Use again explicitly reported locked.
