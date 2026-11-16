# Follow-up verification — 2026-11-15

## Native trial boundary

No additional Desktop instance was launched during this follow-up. The retained
[`worker trial`](worker-trial.md) records the admitted worker's native interaction
with the owned OpenCode Desktop:
the stale action was denied, a fresh observation preceded the corrected action,
Architect submitted one greeting-helper task, the isolated task database matched
the requested scope, and the owned app/service/profile were cleaned up while the
driver PID, endpoint, and protocol handler remained unchanged. The scenario stopped
at `submitted`; it did not dispatch a worker or claim a greeting implementation or
test run. This is the native observation for candidate activation and task
submission, not a live fault-injection test of the follow-up cleanup correction.

## Startup ownership correction

Source review found a failure gap between spawning the isolated service and
confirming its process identity: if that observation failed, cleanup could lack a
durable process identity and remove the root while a spawned service might still
use it. The current launcher now:

- persists service-start intent before spawning;
- persists the spawned PID, command, and timestamp before fallible process-identity
  discovery;
- clears startup intent only for an explicit pre-spawn failure, after confirmed
  process identity is transferred to the service record, or after a pending
  spawned process is authoritatively absent;
- blocks cleanup without side effects when a live/unknown spawned PID or startup
  intent without a durable PID remains; and
- retains the launch reservation even if persisting the blocked manifest fails.

Focused tests exercise the pre-spawn path, failed post-spawn ownership persistence,
live and unavailable process observations, retry after authoritative exit, and
the unresolved-intent restart case. These are test observations; this correction
was not fault-injected in a running Desktop. The runbook requires Architect review
for unresolved startup intent rather than manual marker or root removal.

## Checks

- `bun fmt`, `bun lint --fix`, then `bun fmt` completed; the formatter made the
  touched TypeScript and Markdown conform to repository formatting.
- `bun run verify` passed formatting, lint, and strict typechecking.
- `bun test test/product-verification` passed: 45 tests across three files.

The native trial is the retained end-to-end interaction evidence. The later
startup-recovery correction is covered by source review and focused automated
tests only; no additional Desktop launch was performed during this follow-up. The
qualified trial and its earlier launch attempts remain in `worker-trial.md`.
