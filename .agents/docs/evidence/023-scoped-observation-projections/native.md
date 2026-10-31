# Native projection activation and execution release

## Canonical result and registered native read

Accepted backend `bb2c78d` and driver correction `bf5a8b0` were normally merged
into canonical main as `d3030f55dd6ff1e0096e63237e70e1bb6e5a4871`. The canonical
focused suite passed **28 tests / 211 expectations**, and its GUI build passed.
Root subsequently committed the separate cancelled-plan Open filter as
`9ab588fd1e022474be381ac1bbea1346a1fa8ead`, reporting the current full suite
**264 pass / 0 fail / 2,492 expectations** and verification passing. The driver
did not edit Root's filter, speech repairs or debugger diagnostics.

At **1793482640301**, the public client called the actual registered
`lazers.observability.snapshot` RPC at canonical location, with Session scope
`ses_e6e0e6239ffdtzIePMeJ1sHA4l`. It returned native project
`b5da4cadd97e51f2f6c88ff71daa1006f6a5b7df`, machine `lazers-task/1`, all five b50
nodes with exact task revision/objective and all five dependency edges. Projection
and speech were accepted; Radar and Trajectory were running; assembly was queued.
Its snapshot boundary was repository version 776, source revision 4, native
revision 22, projection event sequence 26, transition sequence 570.

The same response returned four actual b50 attempts and six verification
intervals. Examples:

- Projection dispatch reservation: 1793478049892; recorded worker activity
  1793478050539–1793481991654, transition sequences 485/531. Attempt end remains
  null; it was not inferred from idle or acceptance.
- Projection focused check: 1793481991721–1793481995461, exit 0; full and quality
  checks likewise had recorded endpoints and exit 0.
- Radar and Trajectory worker activity began at 1793482036771 and
  1793482036770 respectively; recorded stops remain null while running.

This is a live registered snapshot, not the design JSON or a new mock runner.
The snapshot path does not call the native trajectory/history adapter; a throwing
adapter regression protects that property. Selected rich trajectory/native-token
reads and actual panel captures remain separate observations, not implied here.
Root subsequently reported successful rich trajectory RPC reads for running
Trajectory and accepted speech, with native context and five-event pages in
95/106 ms; see the [incoming Trajectory review](../026-trajectory-panel/incoming-review.md).
That evidence does not stand in for native panel captures or legacy comparisons.

## Supported maintenance, including retained failure

The first maintenance reload failed while trying to rebuild the already removed
Qwen worker location `e7f473db-3716-49fa-8075-c81be5b924ad`. Public
`debug.location.list()` subsequently contained only existing directories and no
removed Qwen/review entry; no eviction or worktree recreation was needed.

Pinned `location.reload` accepts RequestOptions only and reloads **all** loaded
locations, not a caller-selected location. At **1793482887071**, one bounded
retry used `location.reload()` after checking all eight loaded directories
existed and the running plans had no pending native effects. It succeeded.
Server PID remained **16786** before and after: no service restart occurred.
An immediate registered snapshot returned 21 project-associated attempts and 94
check records. The original Radar/Trajectory sessions remained busy, with exact
Luna Max routes, original directories and empty inboxes. No interruption, retry,
duplicate Run or replacement worker was issued.

## Re-evaluated artificial visual barriers

The user requested earlier features not wait for unrelated renderer acceptance.
Existing reference/grouping plan `58146c54` and progress plan `b9e55d09` had no
attempts. Their whole-b50 `afterPlans` barriers were removed through versioned
runtime schedule commands, retaining priorities 10 and 5 and selecting reviewed
canonical `9ab588f` as baseline. The already merged Tasks/Go fixes and complete
projection satisfy the references/grouping interface prerequisite; progress hooks
need the existing runner/native/privacy contracts, not renderer UI acceptance.

Task IDs are unchanged. The real references → grouping task dependency and
progress → lifecycle plan prerequisite remain. Runtime scope serialization still
protects references/assembly `src/gui.tsx`, progress/context `src/index.ts`, and
progress/wake-repair runner overlap. Existing active workers are not preempted.
Cancelled responses during source reload were retried with the exact same
request IDs/content; no duplicate admission was requested. Schedule command IDs:
`references-unblock-on-reviewed-projection-20261031-v1` and
`progress-unblock-independent-of-renderers-20261031-v1`.

Whole b50 integration remains unrecorded until its complete acceptance boundary
is met. Source landing and released scheduling do not certify unreturned
renderers, native visuals, speech auto observation or other legacy audit gates.
