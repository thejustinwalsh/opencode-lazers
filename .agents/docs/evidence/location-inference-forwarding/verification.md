# Location inference forwarding evidence

Verified 2026-11-02 in the assigned workspace. Relay records and this note contain no service credentials.

## Checks

- `bun fmt --check` — passed (445 files).
- `bun check` — passed (208 files).
- `bun lint` — passed (216 files).
- `bun test src/webgpu/feature-server.test.ts src/webgpu/relay src/webgpu/task-review.test.ts src/webgpu/main-trace.test.ts` — passed (29 tests, 185 assertions).
- `bun test src/webgpu/inference-trace.test.ts src/webgpu/renderer-debug.test.ts src/webgpu/renderer-armed-capture.test.ts` — passed (21 tests, 102 assertions).

## Observed behavior

- The project-location integration test forwards through the live Desktop client, routes relay RPCs to `/project`, and calls the default renderer without a location override.
- Relay tests cover missed-event resync, single delivery, cancellation and teardown uncertainty, disconnect/replacement recovery without replay, stale-result rejection, payload-free request discovery, and event progress during deferred discovery.
- Eight pre-delivery disconnect/cancel cycles leave capacity for a later valid request, while canceled delivered work retains its slot until its renderer operation settles.
- A ready renderer accepts a 1,000 ms request after handoff overhead without changing its timeout input, and a reply after its absolute deadline is rejected.
- Task-review and inference-trace/renderer-debug profiling tests remain green.
