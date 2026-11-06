# Renderer load and project-event amplification

Observed in the running OpenCode2.2.5 Desktop/service. The reviewed repair is integrated at7e80cac; native post-activation observations follow below.

## Observed behavior

- Renderer PID43368 sustained roughly506–587%CPU; service PID71027 ranged11–46%.
- Native DevTools recording, without reload or breakpoints, retained1,134,742
  events. It shows heavy concurrent/incremental GC and timer creation/cancellation.
  Main-thread self samples include GC18765, clearTimeout8839 and setTimeout7895;
  these samples do not account for all concurrent-thread CPU or establish its cause.
- Timer stacks resolve to the native event-stream activity callback. A separate
  model-read stack includes `readRangeInto` and `Response` construction. Console
  showed inference-worker attach/detach500 responses and native request-queue
  thrashing warnings. These are correlated leads, not proof of one root cause.
- A three-second public SDK event sample received224 Tasks invalidations for16
  distinct versions: **14 copies of every version**. It also received280
  observability invalidations. The SDK RPC subscriber filters event type, not
  location. Each loaded Tasks registration watched the same physical database
  and published the same canonical project/version independently.
  -32GiB host; about23.7GiB swap occupied. This snapshot alone does not prove active
  swapping caused the test timeouts. Data volume retained21GiB free.

## Operational recovery

Root used native CmdR to reload the Desktop window, leaving backend PID71027 and
source unchanged. Initial inference error settled to chat/speech readiness.
All six inference switches remained on and idle unload remained Never. Renderer
CPU subsequently measured0.6%. This proves window recovery, not source-fix
causation, long-term idle behavior, or LZ-159's full-plugin reload acceptance.

The low-load window also improved focused verification: the retained suite
completed in13.67s and an adoption phase case in6.54s. Earlier loaded runs had
five-second fixture timeouts followed by asynchronous cleanup errors; they remain
failed runs, not passing evidence.

## Staged repair

Commit20d9736 in `/private/tmp/lz-native-log-contract-review` shares Tasks revision
publication per physical database and project topic. The existing process-shared
SQLite invalidation feed remains intact; a separate publisher registry supports
location disposal, pending delivery, retry and latest-revision catch-up. It avoids
adding methods to an already-loaded older singleton during a plugin update.

The registered14-location regression produced14 emissions before the fix and one
afterward. Nine focused database/RPC tests,67assertions, formatter/linter/typecheck
pass. Tests include failed pending delivery, successor publisher and distinct
project topics. No polling loop, daemon, inference-setting change or model budget
was added. LZ-129 retains broader observability-producer work.

Native post-activation event counts, responsiveness and comparable CPU samples
remain required. Do not infer that this repair explains or eliminates all GC/load.

Private diagnostic artifacts:

- `/private/tmp/lz-renderer-hot-20261106.json.gz`
- `/private/tmp/lz-renderer-hot-20261106.sample.txt`
- `/private/tmp/lz-tasks-publisher-before.log`
- `/private/tmp/lz-tasks-publisher-final-tests.log`

The raw trace and extracted installed sources stay outside the repository.

## Post-activation observation

Canonical7e80cac integrates the reviewed combined candidate, including native
2610e9f and3ea8b5d ancestry. All native sessions were confirmed inactive before
activation. Desktop quit/reopened; native service PID71027 survived. Canonical
GUI build and bundle evaluation passed. A subsequent ordinary Extensions →
Plugins → Reload completed, and the settings local question returned exactly
“local GPU ready.” (19 input/4 output tokens). Six inference flags stayed on;
idle unload stayed Never. This observes normal reload and actual inference;
not every cancellation, lost-response or cross-window race.

A three-second event sample during resumed Architect work received21 Tasks
invalidations for21 distinct versions: **one copy per version**, compared with
14 copies previously. Renderer PID78667 measured2.0%CPU, service71027 15.5%.
This is a short observation after cold Desktop initialization, not proof that
all sustained performance defects are solved. Observability still emitted520
invalidations in that interval and remains a separate LZ-129 investigation.

The exact required retained suite, without a timeout override, passed562tests /
7497assertions across30files in155.78s on the source-equivalent backend candidate.
Boundary suite116tests/855assertions passed; corrected WebGPU22tests/122assertions
passed; combined formatter/linter/typechecker and GUI build passed. These checks
do not substitute for the real retained156 native walkthrough now requested.

Logs: `/private/tmp/lz-canonical-activation-build.log`,
`/private/tmp/lz-clean-backend-required-native-command.log`,
`/private/tmp/lz-clean-backend-boundary-tests.log`,
`/private/tmp/lz-final-backend-gpu-combined-tests.log`.

### Remaining observability producer amplification

A second three-second sample at1793962552504 received368observability events /
69distinct complete change identities. Exact project, sequence, repository,
source/native revision and cause records repeat14times across14locations; two
other location trackers carry different sequence baselines. Source
`src/observability/rpc.ts:95` creates a tracker per registration; its publication
and source/native subscriptions are also per registration. This directly supports
a remaining duplicate-publication finding, not a claim that all368 are duplicates.
Tracker-local sequence/session/live-event state means blindly deduplicating only
sequence numbers would be unsound. Root queued this measured finding to Main for
existing129 or appropriately linked scope, without making it a Models prerequisite.
Read-only reproduction: `/private/tmp/lz-observability-amplification.ts`.

### Follow-up during original LZ-129 repair

At Unix milliseconds 1793992152999, the same read-only three-second subscription
received 435 observability events and 319 distinct complete identities. The
printed sample includes identity `(project b5da4cad…, sequence 9916, repository
658728, source 9339, native 577, cause native)` repeated five times across five
locations; sequence 9917/source 9339/native 578 also repeats five times across
five locations. Other sampled identities differ. This confirms duplicate
publication remains present before the original LZ-129 repair lands. It does
not mean all 435 events are redundant, establish a sustained event rate, or
isolate their CPU cost; subscription initialization and current activity differ
from the earlier sample.

A separate process snapshot during the locked Desktop interval showed Desktop
PID 64668 at 0.0% CPU / 141,760 KiB RSS, renderer 64689 at 0.0% / 372,480 KiB,
and service 71027 at 1.9% / 1,649,104 KiB. This is a point observation, not an
interactive performance acceptance. OpenAI Luna Max original LZ-129 session
`ses_aeff3e9ac5d24c6c944d35e31b050963` remained active; Root did not interrupt it
or reload runtime source under it.

### Retained-repair trajectory observation

At Unix milliseconds 1793993432827, the original LZ-129 attempt/session remained
natively active and its worktree had no source diff. The repair busy timestamp
was 1793991643800, about 29m49s earlier; this interval includes the native scope
question, Architect review/answer, model generation and investigation, not just
coding. Architect resolved the exact scope form through supported tools without
replacing the worker. Subsequent public calls inspected runner states, tracker
sequence usage and source-query metadata, then refreshed task instructions and
the source index. Model-part timestamps advanced during the intervening turns.
There was no observed failed tool or terminal worker outcome at this boundary.

This is an observed long investigation phase, not proof of a renderer freeze,
model failure, or the cause of the delay. Retain it for the requested later
trajectory/task-quality review alongside final implementation, verification,
usage and intervention outcomes. Do not turn the elapsed interval into a new
arbitrary execution budget or interrupt the worker solely on that basis.
