# Renderer load and project-event amplification

Observed in the running OpenCode2.2.5 Desktop/service. Source changes below remain
isolated pending integration and native qualification.

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
