# Lost worker ownership blocks renderer cleanup

Root observed the real Desktop inference error on Nov7: `Local inference worker
detach failed; cache ownership is retained: rpc.internal: RPC call failed`.
The service log at21:15:28–30Z records repeated webgpu-worker `poll` and `detach`
failures with `Renderer ownership was lost`, approximately twice per second.

The worker mailbox expires its owner after a missed heartbeat. `detach` then
called assertOwner, which expires/clears ownership and rejects that same already
disconnected worker. Renderer unload cannot reach the separate main-process GPU
lease retirement after the failed detach. The next tick repeats poll/unload.
Root changed detach to acknowledge an already ownerless mailbox. An active
replacement still rejects stale detach; undelivered queued requests survive.
This changes no model, inference switch, GPU backend, files or cache policy.

The regression exercises expiry, failed old poll, repeated cleanup, replacement
ownership and one-time queued delivery. It fails against the original broker
with `Renderer ownership was lost` at the first detach, then passes the fix.
Broker suite:9 passed/66assertions. Broker, renderer lifecycle and feature-server
suite:11 passed/89assertions. `bun run verify` passed automatic formatting/lint
and strict typechecking. Native activation/recovery remains to be observed.

Five12-second process-counter windows are saved in
[inference-detach-cpu-windows-20261107.json](inference-detach-cpu-windows-20261107.json).
The initial Trajectory window measured renderer1.66%/GPU-helper0%; subsequent
Models loading, Models settled, return-to-Trajectory and Models-tab-closed windows
measured renderer14.87–15.37% and GPU-helper35.39–35.98%. Service49–59% in the
latter windows. The difference did not reverse when switching or closing Models.
This is an active changing workload, not a controlled CPU or battery comparison.
The chart is not established as the cause, and neither are the ownership errors
established as the cause of all CPU use. Reobserve after supported activation.
