# Native service interruptions — 2026-11-03

Status: diagnosis open. Models and the preflight repair resumed in native workers.
No crash cause or WebGPU fix is claimed.

## Observed

- Service54033 disappeared around20:26:49 UTC; Desktop started47672 at20:27:16.
  Root had used native View → Reload, not a service stop or location reload.
- Service47672 disappeared around20:40 UTC; Desktop started59460 at20:41:00.
  Root issued no restart or renderer reload during this second interval. A
  read-only SDK request ended with ECONNRESET when that service disappeared.
- At Unix ms1793739070565,59460 reported Main and both Luna workers active.
  At1793739081928 neither worker location had pending permissions or forms.
  Main recovered LZ97 in its original session/attempt/tree using supported
  cancel/resume; no unknown old background observation was fabricated idle.
- Each new service loaded LAZERS in roughly54 retained locations. For run
  a835e183,226 loading-plugin entries but54 actual LAZERS-loaded setups were
  counted by20:52 UTC. Cached load attempts are not setup/reload counts.
- Read-only process sampling showed elevated CPU/memory during location boot.
  The three-second sample is `/private/tmp/lazers-service-59460-20261103.sample.txt`;
  unresolved Bun/JIT frames prevent causal attribution. No retained fatal/OOM
  record or explicit background-unresponsive termination warning was found.

## Source findings

Pinned OpenCode2.2.5 source at9bbb8ce:

- [Plugin module](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/plugin/module.ts)
  subscribes per location to imported local files and the GUI bundle. Our
  imported Markdown agent prompts participate in that local source graph.
- [Supervisor](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/plugin/supervisor.ts)
  serializes/debounces change requests. The installed plugin source loader
  reuses unchanged graphs, including failed-load cache entries. Its internal
  digests are host reload-cache implementation, not LAZERS evidence policy.
- The explicit location-map reload API invalidates/reboots all held locations
  concurrently. This inspection does not establish that file edits invoke it.
- LAZERS starts a timer per loaded location but claims a database lease before
  reconciliation;54 setups do not establish54 concurrent schedulers.
- The installed SDK service manager can terminate a host after repeated failed
  health checks. No retained log proves that path caused these interruptions.

## Follow-up

Review startup/location ownership and retained-resource cleanup with native
APIs, correlate the next interruption with service-manager and process-exit
records, and keep recovery distinct from proof of old worker idleness. An
immutable release/upgrade boundary may reduce development reload exposure;
no packaging or lifecycle change is justified from these counts alone.

No inference setting was changed and no profiler or service restart was armed.
