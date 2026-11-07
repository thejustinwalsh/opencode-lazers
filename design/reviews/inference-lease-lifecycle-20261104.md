# Local inference lease observation

## Current repair — 2026-11-07

`setupMain` now tags durable leases with the owning Desktop process PID and
Node performance time origin. A replacement plugin provider in that process
retains the existing exact handoff rules. A new Desktop process ignores the
exited process's allocation reservation; downloaded cache files remain intact.
An untagged legacy lease is retained and tagged first, so upgrading a live
renderer cannot allocate a second model. Its next Desktop restart recovers it.

The registered main/renderer fixture covers restart from active, retired and
unproven reservations, reused window IDs, conservative legacy migration, and
exclusion of other windows after recovery. Existing abort-order, failed-disposal,
lost-response and same-process provider handoff cases remain passing.

Validation: 11 tests passed across `main-lease.test.ts`, `lease.test.ts` and
`runtime.test.ts`; formatter, lint, typecheck, diff checks and GUI build/bundle
evaluation passed. Desktop was fully quit (process absence checked) and reopened.
All six switches remained on and the cached 3.19 GB remained. Actual native
local inference returned `local GPU ready.` (19 input / 4 output tokens), then
the d1 typed decision returned `{"ok":true,"kind":"boolean","value":true}`.
The original Architect and both original repair workers were observed running.
A second full quit/reopen with d1 resident again reached chat-ready automatically;
the same local chat probe succeeded (19 input / 4 output tokens). No cache
deletion or inference toggle was needed for either restart.

The original abort-path observation below remains relevant to same-process
handoffs; this repair addresses the separate durable reservation surviving a
Desktop process. It does not erase model files or relax failed-disposal checks
inside the same process.

## Original observation

Root inspected native Desktop Settings on 2026-11-04. The runtime displayed
**“The model cache is owned or being cleaned up”**, with all six switches enabled
and idle timeout Never. No setting, reload, release or inference was requested.
The Window menu listed the main window; that is not a complete internal ownership
inventory. The current API exposes occupancy but not the owner identity.

There is a concrete source-level lifecycle conflict to investigate:

- `src/webgpu/runtime.ts` registers disposal on `ctx.signal.abort`; disposal
  releases model resources and then calls `ctx.main(ModelFiles).release`.
- Pinned OpenCode host `createInstance.dispose()` aborts its controller before
  returned cleanups. Its `mainClient.ready()` rejects calls after that abort,
  even while the main provider remains available.
- `src/webgpu/main.ts` associates the lease with a window, retiring it on close,
  renderer loss or navigation. GUI-only plugin disposal need not cause those
  events. If its release cannot reach main, replacement runtime acquisition can
  keep failing against the retained lease.

Primary source: [pinned native window plugin host](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/app/src/runtime/plugin/host.tsx),
`mainClient.ready` lines 597–603 and `dispose` lines 833–846. Source was already
cached from the native API investigation; no new host code was installed.

This establishes an incompatible cleanup path, not the exact current owner's
identity or the sole live cause. It is not a new ONNX/device-loss observation.
Investigate supported native IPC/provider lifecycle semantics and add a focused
regression before choosing a repair. Do not blindly clear/take over a lease:
failed model disposal and genuinely active other owners remain relevant.
Verify actual inference after coordinated activation, rather than inferring it
from bundle success. Root queued this finding to the native Architect.

Timestamped inspection record: Unix **1793821413563**, retained in
`/private/tmp/lazers-driver-observations-20261104.jsonl` under
`desktop-local-inference-status`. The native UI read occurred before that row.
