# Trajectory event-driven refresh

Root performance repair in native OpenCode worktree
`/private/tmp/lazers-trajectory-events`; production not changed or reloaded.

The visible Trajectory panel used a four-second lifecycle/status refresh alongside
its change subscription. Healthy reads now follow native observation changes and
`server.connected`, including reconnects hidden by the RPC-specific event wrapper.
A reconnect during a read forces one catch-up. Versioned changes already covered
by the arriving snapshot avoid a redundant read; newer ones still catch up.

Snapshot/status failures retry with 1/2/4-second exponential backoff capped at
30 seconds. Successful recovery resets backoff. Closing or replacing the view
cancels recovery; retired callbacks cannot disown a new view's timer. Stream
failure recovery remains. Captured history is retained: ordinary live updates do
not recapture it or replace paged/selected historical activity. Explicit expired
or unavailable history continues to require the existing recapture action.

Validation: 37 tests / 692 assertions across Trajectory panel, registered tool and
GUI-root tests; lint seven changed TypeScript files; typecheck 338 files; formatter
and diff checks. Four discriminating regressions fail against the old controller:
healthy quiet interval, failed snapshot recovery, failed status recovery and
already-covered in-flight event. Old run retained at
`/private/tmp/lazers-trajectory-events-regression-old.log`.

Actual public native adapter observed `server.connected` at Unix
1793821098915 with `resnapshotRequired:true`, then aborted and closed normally.
This proves that announcement path, not a full installed reconnect walkthrough.
GUI build and process-free renderer bundle smoke pass; existing ORT CommonJS
import.meta and deprecated inlineDynamicImports warnings remain.

Independent source review, quiet-boundary integration, merged build, Desktop
updates/reconnect/hidden-panel checks and comparative runtime measurement remain.
No model settings, inference, provider routes, ONNX execution settings, scheduler
state or acceptance policy changed. No claim that this alone fixes battery drain.
