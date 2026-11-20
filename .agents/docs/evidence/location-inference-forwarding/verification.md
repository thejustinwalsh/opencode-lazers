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

## Retained lifecycle repair (2026-11-19)

- `bun run verify` passed; the repository linter reported existing warnings outside this change.
- `bun test src/webgpu/feature-server.test.ts src/webgpu/relay src/webgpu/task-review.test.ts src/webgpu/main-trace.test.ts src/webgpu/main-lease.test.ts src/webgpu/settings-read.test.ts src/core` passed (59 tests, 392 assertions).
- `src/webgpu/relay/retained-lifecycle.test.ts` additionally covers source-side deadline enforcement before timer callbacks, eight pre-delivery disconnect cycles, competing live Desktop relays, bounded shutdown recovery, and failed setup without relay subscriptions.
- `src/webgpu/main-lease.test.ts` timed out at 30 seconds before the setup-order repair; it passes after relay startup moved past fallible main initialization. Shutdown recovery RPCs are bounded so a stalled relay cannot block current lease cleanup.
- Native-enabled `lz-verify-task` forwarding was not exercised: this requires reviewed activation, and no restart or settings change was authorized. Test fixtures are not used as a substitute.

## Cross-module ownership repair

- `bun run verify` passed; lint reports existing warnings in unrelated repository files.
- `bun test src/webgpu/feature-server.test.ts src/webgpu/relay src/webgpu/task-review.test.ts src/webgpu/main-trace.test.ts src/webgpu/main-lease.test.ts src/webgpu/settings-read.test.ts src/core` passed (61 tests, 402 assertions); `git diff --check` passed.
- `src/webgpu/relay/source-ownership.test.ts` loads two cache-isolated Desktop relay modules against one source, pauses the owner before `begin`, and verifies the second module does not recover the live claim and the renderer is called exactly once. It also verifies that only the source-stored claim token can recover a request.
- Native-enabled `lz-verify-task` forwarding remains unverified; reviewed activation, restart and settings changes were not authorized.
