# LZ-36 mounted observations — acceptance remains open

Observed 2026-11-01 in OpenCode Desktop, main session
`ses_e68a9ed37ffeVqzPWRXN5SB7Uw`, OpenAI GPT-6.1 Sol High.
The mounted GUI was built from `214adcb` at a local-inference Ready/quiet boundary.
Retained workers were not restarted and inference settings were not changed.

## Actual native report decoding

The preceding combined candidate could not render LZ-38: recorded execution
outcomes carry `basis: null`, while the panel decoder accepted only an optional
string. `214adcb` accepts that actual unknown basis without accepting objects.
The regression runs real ProgressRecorder events through ObservationReads history
and status into the panel parser. Twenty-seven focused tests / 189 assertions and
Bun formatter/linter/typechecker passed; the GUI build passed. After activation,
Desktop rendered LZ-38 with its two attempts and 414 captured events.

## Historical reading and expiry

Tasks Project/Completed search selected the exact LZ-9 task
`970b0feb-1fd3-40bb-a61d-f8decccb8a9f`; Open Trajectory navigated the existing tab.
All four attempts appeared, including their original failed checks and final
accepted attempt. Its capture reported 725 events. Loaded historical activity
remained while ordinary live refreshes occurred. Offscreen accessibility rows are
not a reliable DOM count, so no exact page-union/count assertion is made here.

The capture was created at 12:14:12 EST and expired at 12:19:12 EST. Clicking the
visible Load more activity button after expiry produced the following native
accessibility content:

```text
image Trajectory data may be stale
text [object Object]
button Retry
```

A subsequent healthy status refresh erased this error. Already loaded rows
remained; this is an error/recovery defect, not evidence of data reset. Source
inspection shows Retry refreshes status when a report exists, rather than
recovering the expired capture. `refreshStatus` clears the shared error, and
`String(error)` renders the native plain error object unhelpfully.

A read-only supported SDK probe using the actual LZ-9 UUID and an invalid history
cursor independently returned only:

```text
_tag: RpcInternalError
type: rpc.internal
message: RPC call failed
```

The history RPC currently turns expected history errors into Effect defects.
The pinned native RPC contract supports declared method errors and the handler
context.error factory; a new transport is unnecessary.

Architect received these observations through Desktop and acknowledged repair in
the retained LZ-36 work. No mounted acceptance was recorded. Outstanding proof
includes meaningful expiry recovery, selected live-tool completion with an open
payload, historical reading continuity, and explicit recapture. The full native
checklist remains the acceptance procedure.

## Reviewed candidate 81660d3 — real expiry and recapture observed

Root built reviewed source and used native Reload Webview on 2026-11-01.
The retained LZ-9 target displayed all four attempts. Another history page loaded;
the 10:01:41 read-error event was selected and its payload opened. Offscreen AX
rows do not establish an exact loaded-page union. Both source reviewers passed
14 panel-state tests / 143 assertions for the earlier recovery fixes.

The first capture displayed 14:52:53–14:57:53 EST. Settings navigation retained the
target and event selection but recaptured at 14:53:54. A later capture reset to
14:56:12 initially looked like an ordinary-chat continuity failure. That conclusion
was premature: Root saved its task-schema metadata edit at 14:55:59; the installed
Desktop main.log records the setupMain-only “LAZERS WebGPU cache available” message
at 14:56:11.995, immediately before the replacement capture. The GUI bundle was last
built at 14:52:18. Plugin replacement is an evidenced confound, not an established
ordinary-progress bug. Architect received the correction before commissioning a
repair. Raw logs remain local.

With no later canonical source edit/activation, several ordinary chat updates
retained that exact 14:56:12 capture and its open activity disclosure past the
15:01:12 expiry. Actual Load more activity then displayed:

```text
Captured history has expired. Recapture history to continue.
```

The error persisted through subsequent refreshes; no object-string error or silent
clearing occurred. Explicit Recapture succeeded at 15:07:54, returned Connected and
cleared the error. The selected second-page 10:01:41 read-error row stayed selected;
its expanded payload remained open with the same path, error and completion facts.
This is actual native expiry/recapture/selection evidence, not just a unit test.
Screenshots remain local:

- `/private/tmp/lazers-trajectory-81660d3-expiry-confirmed.png`
- `/private/tmp/lazers-trajectory-81660d3-recaptured.png`

All six local inference switches remained ON and idle Never. A post-reload abort
error with no resident model recovered through native Reload model to Ready.
No profiler was armed, service restarted or inference setting changed. This does
not establish the wider LZ-39 compatibility gate.

A genuinely active selected live-tool completion with its payload open is still
unobserved. Root switched to the testing LZ-28 worker, but it returned before this
interaction could be captured. Do not claim that branch or full LZ-36 acceptance.
The temporary canonical-source hold for this clean observation has been released.
