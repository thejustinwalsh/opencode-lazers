# Trajectory status performance — November 5

The active Desktop trajectory is live, but its status refresh is too large.
Root measured the actual native RPC for LZ-138: three responses of 2,484,116
bytes took 105, 83 and 87 ms. Most bytes were historical worker events; the
client retains these as live progress. Dropping them would lose functionality.

Ten-second CPU-time windows for service PID71027 measured 64.7% of one core
with Trajectory visible, 45.3% with the side panel hidden, then 86.6% after
restoring Trajectory. Workers continued throughout. Their changing activity
prevents attributing the difference to the panel or claiming a quiet baseline.
The native sample contains SQLite work but does not identify exact JavaScript
functions or establish a SQLite percentage.

## Tested candidate

Commit `29e3b32`, isolated native worktree
`/private/tmp/lz-trajectory-status-performance`, removes unused pagination
identity calculations from complete history captures and status reads. These
reads never issue continuation tokens. Normal paged reads retain the same
source-bound cursor checks. This concerns internal pagination, not source
hashing as acceptance evidence.

Validation: 42 trajectory tests / 292 assertions; 86 observability and panel
tests / 748 assertions; lint and full typecheck. The added regression compares
all captured events with the full paged stream and checks status uses session
metadata without loading transcript context. Existing cursor invalidation
tests remain passing.

Thirty alternating paired fixture measurements with 350 recorded worker steps
returned identical complete status output (946,176 characters). Median read
time was 10.74 ms before versus 9.61 ms after; means were 11.12 and 9.88 ms.
This measures a modest computation improvement. It does not measure live
battery improvement, transport reduction or the final large-status solution.
Native Luna source review approved the candidate, and Main integrated it as
`7fe152b`. Root's concurrent duplicate cherry-pick was empty and skipped;
subsequent integration mutations have one named integrator. Current-main
integration checks passed: 128 tests / 1,040 assertions, lint and full types.
The clean temporary worktree was removed through OpenCode's native API.

After integration, the mounted Desktop trajectory continued advancing and
three real status RPCs succeeded. The response had grown to 3,137,297 bytes
and took 200, 214 and 198 ms. This is not a controlled before/after comparison:
the worker history and concurrent activity grew. There is no demonstrated live
latency or CPU improvement yet; repeated history transfer remains unresolved.

## Remaining performance work

Avoid resending historical progress on every status refresh while preserving
full history, tool lifecycle updates and reconnection. An `afterSeq` cursor
alone is insufficient: progress rows are updated in place under the same
sequence, including changes to payload, sources and recorded timestamp.
Any incremental contract must carry such updates and recover from lost state.

Re-measure the actual native response, visible panel behavior and quiet CPU
after activation. Keep the active workers, event subscription and roadmap;
do not replace live updates with polling or hide data to improve the number.

Temporary measurement artifacts:

- `/private/tmp/lz-active-service-profile-20261105.txt`
- `/private/tmp/lz-active-trajectory-visible-window-20261105.json`
- `/private/tmp/lz-active-panel-hidden-window-20261105.json`
- `/private/tmp/lz-active-trajectory-restored-window-20261105.json`
- `/private/tmp/lz-trajectory-status-latency-20261105.log`
- `/private/tmp/lz-trajectory-pagination-benchmark.ts`
- `/private/tmp/lz-trajectory-pagination-tests.log`
- `/private/tmp/lz-trajectory-pagination-consumers.log`
