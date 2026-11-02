# Desktop service stall and inference recovery

2026-11-02, approximately 16:00–16:11 UTC. Repair: `fbfddf2`.

## Defect and repair

LAZERS was registered and eventually displayed its panels, but inference settings requests failed. Direct default/project authority reads returned all six flags enabled in about 5.16 seconds; forwarded reads timed out at 12 seconds. Desktop displayed disabled fallback settings and later a GPU error with no resident model. The saved configuration had not been turned off.

A three-second OS stack sample of native service PID 7793 showed synchronous SQLite sorting and temporary-file I/O on its main thread. ObservationChangeTracker reread, serialized and HMACed every scoped historical payload once per second in each loaded location. Progress payloads alone totaled about 17 MB. A direct history-stamp read took 187.6 ms; adding a sort index to an isolated copy only reduced a comparable 170.5 ms read to 126.2 ms.

The repair replaces full-history polling with a transactional per-project revision counter maintained by SQLite triggers. Inserts, updates and deletes invalidate observers; no-op writes and rolled-back transactions do not. Reads retain the opaque change token and existing scope/security checks. Historical payloads are read only when the requested projection needs them. This counter is UI invalidation, not acceptance evidence.

## Native observations

- Same service PID 7793 throughout; no service restart, flag changes, profiler arming, worker replacements or model-cache deletion.
- After automatic source reload settled, default/project direct settings reads took 2 ms; forwarded reads took 4–5 ms. All six values remained enabled.
- Tasks returned to “Task updates connected.” Native inventory still contained Architect and all five original worker sessions at Unix ms 1793635824198. The two new workers had no pending permissions or inbox messages at 1793635833314.
- GPU runtime initially showed Error and no resident model. Used the native Reload model control once. Desktop then showed Ready, apple, resident chat, idle Never.
- Native Run locally returned `local GPU ready.`: 19 input tokens, 4 output tokens. Main-process trace request/job `05aa594a-f565-4055-a115-92af8cdf2494` completed at 16:07:52.139 UTC in 310 ms with configuredEP webgpu. Trace observedEP remains unknown, so this report does not infer more backend telemetry than the app supplies.
- Service CPU snapshot fell from the pre-repair roughly 97% to 10.9%; this is a point observation, not a controlled resource benchmark.

## Checks and remaining work

- Runner/recovery suite: 186 tests, 2,726 assertions, passing.
- Observation/progress/store suites: 59 tests, 472 assertions, passing; includes transaction rollback, unrelated project, no-op update, insertion, deletion and repeat schema setup.
- Formatter, lint, typecheck and diff checks pass. Legacy outbox migration fixture now reconstructs its actual historical schema before reopening.
- Automatic GPU cold-start recovery was not retested; the recovery above required one manual native reload. The original GPU error displayed `[object Object]`, so its exact cause remains unknown.
- Radar responds with real data, but its existing oversized map and strict paired-boundary freshness can still yield an offscreen/stale presentation during active work. Compact Radar worker LZ-62 remains active; visual acceptance is open. LZ-56 live-connection relay remains active and is separate from this repaired history polling bottleneck.
