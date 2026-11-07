# Independent roadmap eligibility — 2026-11-07

Latest user authorization keeps compatible implementation moving while original
LZ-174 repairs. Models → Tasks/Trajectory → Radar priority remains; human Models
gates are not a project-wide implementation freeze.

## Actual dependency and reservation findings

| Existing work              | Grounded wait or decision                                                                                                                                                                                                                          |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LZ-148 → LZ-149 Tasks      | Plan waits on retained-verification LZ-138, check-duration plan and LZ-88 approval fencing; LZ-149 also needs LZ-148. LZ-148's runtime/store write scope overlaps LZ-174. Priority alone cannot admit it.                                          |
| LZ-131 timestamps          | Already execution-authorized; runtime/schema/recorder scope overlaps the active runtime repair.                                                                                                                                                    |
| LZ-164 inspection          | No plan prerequisites, but tools/test scope overlaps LZ-174. Not a Models prerequisite; its draft state and write reservation are distinct waits.                                                                                                  |
| LZ-170 → LZ-171            | Already run-authorized. Recorded Models/Trajectory/ownership prerequisites remain; overlapping runtime writes still serialize. No extra approval requested or gate fabricated.                                                                     |
| LZ-160 → LZ-161            | Draft plan has Models/Trajectory prerequisites; capture/report scopes also overlap runtime/Architect/price paths. No reservation bypass.                                                                                                           |
| LZ-165 renderer navigation | LZ-159 prerequisite is integrated. New user instruction supersedes the earlier draft-only coordination hold for isolated implementation, not watched-source activation. WebGPU paths are disjoint from current LZ-174/LZ-173 implementation paths. |

Old `running` rows alone are not proof of active source reservation: read-only
inspection found LZ-57 and other old writers have sealed quarantines with matching
assignment IDs and no hold. Memory-installed guards cannot be inferred solely
from SQL. Native dispatch was therefore left to evaluate the actual live guards
and reservation exclusions; no historical worker was cancelled or retasked.

## Actual independent admission

The original, previously unstarted LZ-165 plan was run-admitted and dispatched
its **first** original implementation attempt `05373e97-01c3-4aa0-bf13-5f112957a10f`
with the live Systems project route **OpenAI Luna Max**. Runtime readback confirms
running session `ses_58c9c1c8cff845d68439017dd53e335b`, baseline `a168be6`.
This is independent roadmap progress, not a replacement for any retained worker.

Attached task advice requires preserving Root's completed `8975516` process
ownership fix and keeping `src/webgpu/main.ts`, the existing
`test/webgpu-main-lease.fixture.ts` and Root's main-lease test read-only. Use the
existing host `did-navigate → lost` seam, other authorized implementation paths
and a separate registered fixture if feasible. A real need to change reserved
source is a concrete boundary question, not permission to edit it silently.

LZ-165 concerns **same-process renderer-window navigation**, fresh page memory and
reset generation sequence while main/broker survive. Root's completed fix and
live chat/d1/loaded-model Desktop restart proofs concern **new Desktop processes**;
they are not reopened or mislabeled as incomplete. No implementation worker may
restart Desktop/service/other workers, change switches/cache, merge watched
source or claim actual navigation acceptance from fixtures. Root owns later
quiet activation and live qualification.

## Performance lane

See `live-progress-performance-20261107.md` and
`residual-cpu-attribution-20261107.md`. The new active window measured service
63.9%, renderer 21.6% and GPU helper 37.8% of one CPU core. One bounded service
sample supplies a SQLite schema/prepare lead, **not** a symbolized JS caller or
database attribution. There is no quiet baseline or causal before/after.
Continue attribution in the existing performance/LZ-129 lane; do not create a
duplicate profiler/fix/task or clear residual CPU acceptance from event dedup.
The CPU evidence neither clears nor blocks this independent dispatch.
