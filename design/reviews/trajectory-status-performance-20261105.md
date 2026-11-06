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

## Incremental delivery and shared reads

Integrated `3a60370` and `b4c6e4b` add opt-in event patches. Immutable delivery
baselines allow retries after lost responses; expiry, eviction or process loss
causes a full reset. Same-ID payload updates and removals are included. Scope
authorization precedes cache access; the panel checks the baseline before
applying a patch. Complete captured history keeps its existing pagination.
Legacy status callers continue receiving full responses.

Native Luna source review found one unrelated malformed-JSON edge in session
association lookups. The focused correction guards those extractions and tests
that targeted status/history work while the requested task and full topology
remain validated. Delivery tokens use UUIDs. Targeted reads also avoid parsing
every project task specification.

Actual native delivery after integration:

- Reset: 4,127,977 bytes, 955 events, 131 ms.
- Three unchanged patches: 455,266 bytes each, 81/91/95 ms. The local merged
  view retained all 955 events: about 89% fewer response bytes.
- A subsequent native change notification produced two upserts, including one
  replacement under the same event ID. The merged view had 965 events, matching
  the server's total; that patch was 476,913 bytes.
- The mounted Desktop remained connected and continued advancing tool/activity
  counts after the production GUI build. No service restart or worker stop was
  used. The GUI build verifies evaluation without a renderer process global.

Integrated `7c758ba` shares expensive session-membership queries across loaded
locations within a synchronous notification stack. Each reader still checks the
durable revision; revision/project changes invalidate reuse, and a microtask
drops it before asynchronous work. Each caller receives an independent Set.
Tests demonstrate fourteen readers sharing one task-membership query, including
an independently loaded module, while ownership changes and later reads refresh.
This adds no timer, schema migration or long-lived membership cache.

Final integrated checks: 201 tests / 1,568 assertions, full formatting, lint,
typecheck and production GUI build. OpenCode's native API removed the clean,
merged Root worktree; the response confirmed its directory was absent.

## Remaining qualification and findings

Ten-second active-work service CPU windows measured 55.9% of one core after
incremental delivery and 53.4% after shared reads. The active workers differed
from earlier windows. These observations do not establish causal CPU savings,
a quiet baseline or battery recovery. Status still transfers about 455 KB of
summary data and projects historical progress server-side; further profiling
must establish which remaining work matters.

LZ-147's delivered commit `de71b6b` introduced a five-second activity poller.
Root identified this before integration and asked Architect to correct it in
the same worker, preserving its metadata-only reads. The original worker is
active on that repair. Do not merge the poller as delivered.

LZ-150 also reproduced the known idle-correlation failure described in
`lz142-native-idle-mismatch-20261105.md`: a real zero-background hook could not
be correlated after listener replacement. Native log probes again returned
only a synced marker, with or without `after:0`. This does not establish the
API's general retention policy. Later quality failures for artifact `f032327`
were solely inherited formatting files already fixed on main. Architect owns
review/integration and was directed toward existing descendant verification,
preserving failed checks and resource obligations. No SQL repair or fabricated
idle report was performed.

Durable evidence is in `.agents/docs/evidence/trajectory-live-20261105/`:
native delivery/change JSONL, source review, Desktop capture, CPU windows,
integrated tests and GUI build output.

Temporary measurement artifacts:

- `/private/tmp/lz-active-service-profile-20261105.txt`
- `/private/tmp/lz-active-trajectory-visible-window-20261105.json`
- `/private/tmp/lz-active-panel-hidden-window-20261105.json`
- `/private/tmp/lz-active-trajectory-restored-window-20261105.json`
- `/private/tmp/lz-trajectory-status-latency-20261105.log`
- `/private/tmp/lz-trajectory-pagination-benchmark.ts`
- `/private/tmp/lz-trajectory-pagination-tests.log`
- `/private/tmp/lz-trajectory-pagination-consumers.log`
