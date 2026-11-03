# Native local inference recovery — 2026-11-03

## Observed

The main Desktop session and workers stayed on service PID59460. No service
restart, worker cancellation, feature disable or alternate execution provider
was used for this recovery.

- Native review messages `msg_1a37aadc5001OOmS2fIVVqXN1k` and
  `msg_1a37c3004001g6dd0Dlv73evtj` each ran for approximately60 seconds and
  returned unavailable with `All fibers interrupted without error` and zero
  reported usage. This does not establish a semantic review pass.
- The Desktop indicator showed an error. LAZERS Settings reported
  `The model cache is owned or being cleaned up`.
- Main log at Unix ms1793743641654 records device loss during request
  `4b46faa2-dfcf-461f-a061-ecdc74d44504`. It had2 questions and1,984 input tokens
  against an8,192-token capacity. That particular failure was within capacity;
  no context-overflow event was recorded for it. OOM or a driver cause is unproven.
- The decision session reloaded at1793743648598, followed by another main
  cache setup at1793743670011. Subsequent failing reviews had no newer GPU
  execution traces before the driver recovery. This is correlation, not proof
  of which lifecycle transition orphaned ownership.
- Driver used native View → Reload at1793744558881. GPU session creation
  resumed, but automatic recovery also encountered service-signal timeouts.
  The first native typed-decision probe returned `Model loading cancelled`.
- At1793744805949, the retry on the actual chart denominator case returned
  `{"ok":true,"kind":"boolean","value":false}` in the native Settings UI.
  Context: zero accepted tasks, recorded usage/cost, no accepted-task denominator.
  Request `304f44c6-0c5c-42e8-9460-4ea2b43dc325` completed in225ms with65 input
  tokens, one question and zero generated output tokens. D1 was resident.
- Read-only SDK probes at1793744786733 returned default worker, default public
  and project public inference settings in9–14ms. All six feature flags were
  true. Native active-session inventory returned in9ms.

Source log: `~/Library/Application Support/ai.opencode.desktop/logs/20261103T155913/main.log`.
The native UI result and content-free GPU trace prove this individual operation,
not a permanent lifecycle fix or successful full task review.

## Follow-up

Keep the ordinary review policy and model settings. Investigate main/renderer
ownership across plugin reload, cancellation and automatic retries using the
existing content-free trace path. Expose enough owner/lifecycle diagnostics to
explain an occupied cache instead of repeatedly guessing or reloading. Exercise
an actual multi-question task review after repair, not only a one-question probe.

A separate pinned API check confirms that native session interruption is accepted
before cleanup settles and is a no-op for idle sessions. It cannot alone certify
background quiescence. Sources: [execution contract](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/session/execution.ts#L27),
[session handle](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/session/session.ts#L328).
This investigation issued no interrupt, session deletion or cleanup operation.

## Observed review batching deadline — 17:51 ET

Read-only inspection at Unix ms1793746414455 reproduced batching for native
`lz-verify-task` message `msg_1a39a2786001cKkct6qJAlOp0g`, review
`81a96902-9758-49a1-8265-7503f93f6fd7`. Its shared state was7,026 characters;
14 questions became7 sequential requests with question counts6,2,1,2,1,1,1.
Each passed the8,000-character JSON limit in `system-one.ts`. One combined
request would be11,545 characters. This is not a measured combined token count;
`decision-runtime.ts` already enforces the real8,192-token capacity after
actual tokenization without truncation.

Native main-process trace showed all seven jobs complete. The first, request
`cafe80ae-362b-4d27-a572-2d4c6a34dfcd`, took13,592ms including model loading;
the remaining six took5,113–5,844ms each plus inter-request transport time.
Measured inputs were1,965–2,031tokens per job. The final request
`505b14ef-beca-438a-b25f-0e74c1374857` completed at2026-11-03T22:51:45.727Z,
after the review's60-second window beginning22:50:45.344Z. The review returned
unavailable at22:51:46.398Z. These traces support a batching/global-deadline
failure for this review, not context overflow or a new device-loss event.

Root relayed the reproduction through Desktop and requested a proportional
native task: honor actual model capacity and bounded lifecycle, preserve checks,
three-round policy and truthful failure, avoid truncation. No inference settings,
service, model runtime or source were changed during this inspection. This is a
new scoped defect; it does not establish the prior device-loss cause or qualify
its recovery.
