# Trajectory timing diagnosis

User reported unknown trajectory values and plan-check point markers. Root used
SELECT-only DB inspection and source reads; no capture/acceptance data was changed.

All **658 completed verification receipts** inspected have numeric Unix-millisecond
`check.startedAt`/`check.endedAt`, with nonnegative duration. The screenshot's four
plan checks match LZ112, plan `2eb074d5-bfbc-4a09-9ba8-a346f098b26c`:

| Check   | Started Unix ms | Ended Unix ms | Duration ms |
| ------- | --------------: | ------------: | ----------: |
| sources |   1793792603400 | 1793792603688 |         288 |
| models  |   1793792603707 | 1793792604783 |        1076 |
| quality |   1793792604802 | 1793792605042 |         240 |
| build   |   1793792605061 | 1793792607233 |        2172 |

`runner/artifacts.ts:runCheck` already stamps both with `Date.now()`. The readers
preserve them. `trajectory-panel/projection.ts` computes `pointOnly`, but the panel
renders every check using the same fixed marker at its start; it never renders
the known check interval. Short checks also need a readable selected duration.

A separate gap exists for attempts: `observability/read.ts` and
`trajectory/read.ts:attemptView` explicitly set the attempt end to null, and the
attempt table has no end column. LZ112 nevertheless has durable typed progress:
worker started1793790533400, succeeded1793792598479, accepted1793792603366.
Acceptance is distinct from worker/model completion. These facts can explain
known phases without inventing native endpoints. Existing outcome dedupe is by
attempt/outcome; a resumed same attempt must not reuse a prior terminal time as
its current end. Terminal capture/projection needs that case covered.

Follow through in the native Architect workflow: expose known timing clearly,
draw check intervals and persist any genuinely missing attempt/phase endpoints
at the runtime/hook that observes them. Keep Unix ms and timing meaning distinct;
use specific unavailable reasons only where data is actually absent. Exercise
accepted, failed, cancelled, resumed and still-running work. Validate with the
real LZ112 data and a new run. This is not evidence hashing or a new acceptance
gate. Do not fabricate old timestamps or alter old outcomes to fill the UI.

Astra owns live performance work in observability read/projection; coordinate
source ownership before timing edits. Root's separate Trajectory refresh candidate
`a86a6e1` is awaiting review and is not this timing repair.
