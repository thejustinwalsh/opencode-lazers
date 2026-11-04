# Local inference lease observation

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

Timestamped inspection record: Unix 1793821417393 approximately; authoritative
driver row carries its precise `at` in
`/private/tmp/lazers-driver-observations-20261104.jsonl` under
`desktop-local-inference-status`. The native UI read occurred before that row.
