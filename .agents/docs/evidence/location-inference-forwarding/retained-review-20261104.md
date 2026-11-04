# LZ56 retained forwarding qualification review — 2026-11-04

This is source review of the existing LZ56 candidate, not activation or native
forwarding proof. No inference, reload, restart, model toggle, profiler or benchmark
was performed. All existing inference settings remain on.

## Exact retained boundary

- Task `b605fff6-0655-4602-9b8e-8dd5e545dbb6`, original attempt
  `ad12b78c-f5ec-43e8-ad16-d46aefc39eb4`.
- Plan `d1bc1882-be6e-42a2-9626-ab018c595227`, last inspected v34, still lacks
  `enabled-native-review:human`.
- Retained chain: `97141fc → 4535c6c → b1646436fbed2188a132da5ce6b6368ee0a71915`.
  Its candidate-side delta from the shared ancestor with main `bce7362` is eight
  files, 1,597 insertions and 23 deletions. The parent supplies the relay; taking
  only the lifecycle tip omits the implementation. Preserve the complete work.
- Default D1 success does not prove this candidate is installed or forwards an
  enabled review from the actual non-default location. Existing exact-candidate
  native qualification remains required; this review adds no approval condition.

## Source-derived scheduling, not measured CPU

References are to `b164643:src/webgpu/relay/desktop.ts`.

| Mechanism                                  | Behavior                                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Client identity, lines 119–129 and 228–254 | Every 250ms; an unchanged identity returns without any RPC.                                      |
| Global resync, lines 162–186               | Every 2,000ms, even when idle: one `debug.location.list`, then discovery for up to 32 locations. |
| Discovery queue, lines 282–335             | Eight concurrent discoveries, 32 queued directories, same-directory follow-up coalescing.        |
| Relay events, lines 136–150                | Available/cancelled events schedule discovery; known cancellation also aborts active work.       |
| Stream recovery, lines 256–279             | Retry subscription after 500ms following end/failure.                                            |

Startup, replacement and `server.connected` also request resync. The periodic batch
size is not a global traffic ceiling; event/recovery traffic can add requests.
The eight active inference-request limit is likewise not a cap on control RPCs.
Two-second abort signals configure cancellation, not a measured completion bound.

With 66 stable enumerated locations and responsive calls, the periodic path alone
nominally schedules 16 discovery calls/s plus 0.5 list calls/s, about 990 calls/min.
Three batches cover 66 locations; a location is revisited every two or three ticks
(4–6s). Empty discovery results do not end the sweeps. These are scheduling
arithmetic under stated assumptions, not measured throughput, CPU or guarantees.

## Preserve transport, repair scheduling within existing LZ56

The candidate usefully replaces stale `Service.discover` credentials with Desktop's
current authenticated client, targets the source location, and uses the existing
default renderer authority. Retain IDs/claim tokens, cancellation tombstones,
source deadlines, teardown uncertainty, late-result rejection and no deliberate
replay of delivered inference.

The proportionate source correction is within the existing relay boundary:

1. Events drive the normal bounded claim/delivery path; known cancellation is direct.
2. Coalesced discovery recovers startup, client replacement, reconnect, stream gaps
   and unresolved pending work. Stop continuing global recovery after it completes
   and no unresolved work remains.
3. A completely missed first notification is invisible to Desktop. Preserve a
   pending-only producer reannouncement or equivalent request/recovery handshake
   until claim, cancellation, deadline or teardown. Reannounce identity, never
   replay delivered inference.
4. Preserve dirty follow-up and carry unfinished recovery batches forward.

Pinned OpenCode `9bbb8ce` has live-only events without historical replay or automatic
reconnect. Filtering event subscriptions can avoid unrelated local consumption,
but does not replace missed-event recovery. Merely moving the unconditional sweep
onto the shared scheduler would retain the RPC churn.

## Current-main compatibility and remaining evidence

Do not replace current files wholesale with retained versions. Main's
`src/webgpu/server.ts:248–287` uses `sharedScheduler` and `readFeatureSettings`
coalescing, whereas the retained server still has the older one-second timer and
separate per-location settings forwarding. Preserve current tool names/guidance
and newer renderer capture lifecycle/status changes in `src/webgpu/main.ts`.

Existing fixtures cover important lifecycle/deadline/backpressure cases but do not
prove healthy-idle silence, actual 66-location behavior or authenticated native
forwarding. The missed-notification fixture invokes resync directly. Future checks
must discriminate idle scheduling and pending-only missed-event recovery within
this qualification; do not invent an arbitrary performance target or a new feature.

Source-grounded guidance was read back on the original retained session at
**1793807896405**. No prompt/resume or activation was requested. This establishes
delivery of review findings only, not consumption, source correction or native
qualification. Original accepted-source repair controls and real reservations
remain authoritative.
