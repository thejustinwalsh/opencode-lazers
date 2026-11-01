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

## Reviewed candidate 81660d3 — further native continuity failure

Root built the reviewed source and used native Reload Webview on 2026-11-01.
The retained LZ-9 target displayed all four attempts. A second history page loaded;
the 10:01:41 read-error event was selected and its payload opened. Offscreen AX
rows do not establish an exact loaded-page union. Source reviewers independently
passed the corrected panel-state tests (14 tests / 143 assertions); the two prior
recapture reachability/unchanged-cursor blockers are fixed in source.

The first capture displayed 14:52:53–14:57:53 EST. Settings navigation retained the
target and event selection, but the capture then displayed 14:53:54–14:58:54.
Root reopened Captured activity, continued normal Architect chat and sent its
activation observation. No later task/scope change, explicit Recapture history or
GUI reload occurred. The disclosure later appeared closed. Reopening it displayed
another capture, 14:56:12–15:01:12. Therefore the expiry deadline reset without an
explicit recapture during ordinary work. This is a native continuity failure;
its reactive/session-connection cause is not yet established. Root returned these
facts through Desktop. Do not accept LZ-36 or claim expiry recovery from this pass.
Local screenshot: `/private/tmp/lazers-trajectory-81660d3-before-expiry.png`.

All six local inference switches remained ON and idle Never. A post-reload abort
error with no resident model recovered through native Reload model to Ready.
No profiler was armed, service restarted or inference setting changed. This
recovery does not establish the wider LZ-39 compatibility gate.
