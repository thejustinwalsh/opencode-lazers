# LZ-36 expiry research — optional source findings and test ideas

This is supporting research, not an implementation prescription or new gate.
Use the concise `expiry-repair-brief.md` handoff. The worker should choose the
smallest useful regressions; actual native RPC and mounted checks establish the
host/UI boundary without requiring an elaborate embedded host fixture.

Root's actual mounted `214adcb` observations are committed at `5dd5d17` in
`native-observations.md`. Loaded LZ-9 history survives ordinary refreshes. After
the five-minute capture expires, Load more shows stale / [object Object] / Retry;
the next successful status poll hides the error, and Retry only polls status.
This is **not a history-reset finding** and no native acceptance was recorded.
The mounted pass has ended; next GUI activation requires Ready/quiet coordination.

Native research `ses_e67d3e819ffeqKzPw8ydhRl1AY` confirmed the chain at the retained
`214adcb` source without edits or task commands. It passed 16 targeted cache/RPC/
panel-state tests, the actual null-basis regression and isolated wire/client/state
probes. Those results reproduce the defect and establish API facts, not a mounted
repair pass.

## Pinned API facts

- `observability/rpc.ts:108–121` converts expected history errors into Effect
  defects. `observability/contract.ts:191–198` declares no method errors. The
  native core masks defects as HTTP 500 RpcInternalError / rpc.internal / RPC call
  failed. Do not invent another transport.
- `@opencode/schema/dist/rpc.d.ts:93–98` exposes the method-specific ErrorFactory;
  Effect `@opencode/plugin/dist/effect/rpc.d.ts:6–10` gives handlers context.error.
  Effect context has error, not signal; Promise context additionally has signal.
- Declare a narrow method error schema, then fail using the **native supplied
  context.error factory**. Native core requires its DeclaredError instance, a
  declared name and valid data; arbitrary plain objects are not a substitute.
- A declared example is HTTP 400 with `_tag: RpcError`, type history_unavailable,
  safe message and data `{reason: expired, recovery: recapture}`. Names are an
  implementation choice; stable recognized reason/recovery behavior is required.
- The installed Promise subclient strips `_tag` and throws a plain
  `{type,message,data?}` object (`@opencode/client/dist/chunks/rpc-runtime-xqwq6bgr.js:43–58`).
  Even correct typed errors still render [object Object] through String(error).

## Behavior and source observations

Give expected expiry/eviction/invalid-cursor failures stable domain identity in
`trajectory/history.ts`, preserving authorization, binding, TTL and size bounds.
Translate only recognized domain failures through declared RPC errors. Unexpected
defects and permission denial must not become fabricated expiry or leak raw state.
Use narrow safe UI messages for known decoded native failures and a bounded safe
fallback, never stringify whole error/data objects.

Separate persistent captured-history failure from live-status health. Healthy
status must update current facts and clear only its own failure; it cannot clear
history error/staleness or silently recapture. Keep old rows, cursor, capture
metadata, selection and payload while history continuation/recapture fails.
Expose **Recapture history** for that error, using existing recaptureActivity(),
and a distinct live-status retry action. Only successful explicit recapture or
task/scope replacement clears the history recovery obligation.

Recapture already stages replacement and loads enough pages to retain valid old
selection (`panel-state.ts:424–515,637–646`). Preserve that atomic path rather than
beginTask/reset/reconnect. Prevent Load more racing recapture and guard its loop
against replayed/non-advancing cursors. A failed mid-recapture keeps the old capture;
removed IDs cannot dishonestly become members of a new capture. Preserve valid
selection/disclosure/anchor and keep fallback/as-of semantics explicit.

## Optional verification ideas

One optional approach crosses the registered handler/context.error path, protocol
encoding, Promise-client decoding and panel state in a socket-free fixture. This
is not required: focused regressions plus actual native RPC and mounted checks
can prove the boundary. Do not call a synthetic Error a native wire observation.

Capture page size two, load several pages and select an earlier event. Expire or
evict the real cache deterministically; assert declared HTTP/error data and decoded
plain-object shape, not rpc.internal. Keep rows/cursor/selection/payload intact.
Deliver a healthy status response: live health recovers while meaningful history
error/recovery remains visible and no capture call occurs. Explicit recapture must
make a cursorless request, load sufficient pages, atomically replace and clear the
history error. Fail recapture midway and preserve all old content. Exercise invalid/
tampered cursors, permission denial, unexpected defects and late task/scope responses.

The mounted selection/recovery action must preserve open disclosures/reading
anchor through failure → healthy status → explicit recapture. Source/state tests
alone do not complete native DOM proof. Keep `214adcb` null-as-unknown decoding and
the selected-live precedence correction; no permissive parser or checksum proof.

Use the same latest attempt/session/workspace with existing task acceptance and
history. No new attempt, inference feature/provider change, live diagnostic
inference, forced acceptance or GUI activation without the next Ready/quiet
boundary. LZ-41/42 and the approved LZ-28 pause are independent harness work.
