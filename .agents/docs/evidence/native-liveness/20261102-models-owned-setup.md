# Models owned Desktop setup blockage

2026-11-02. This is setup/recovery evidence, not Models feature acceptance.

Candidate d0e0045a6564e6417a677080beab6f24d34d703d was clean, with its built
45,763,776-byte GUI. The supported launcher returned ready for owned root
`lazers-full-instance-LP3NFn` beneath the per-user system temporary verification
base. Owned service PID 75494 used loopback 57712; owned Desktop PID 75501 and
renderer PID 75517 reported adapter readiness, window 1, generation 1. The driving
service remained PID 7793 on its original endpoint. No provider credentials were
copied, and no authentication, prompt, fixture or Models interaction occurred.

A later GUI rebuild at the same clean commit retained the same bundle length,
but changed `guiEntryModifiedAt` from 2026-11-02T19:37:03.575Z to 19:45:54. The
read-only native snapshot request then failed before interaction with:
`Candidate source or built GUI identity changed after owned setup (fields: guiEntryModifiedAt)`.
This does not show a product failure or invalidate legitimate implementation.

The correction retains modification time as provenance, excludes it from
candidate qualification, and makes pre-Desktop startup use the same comparison
as subsequent sidecar verification. Current source/entry/size and authenticated
service/process/root ownership checks remain. The regression first failed on
the timestamp-only difference and now passes; actual revision or bundle-size
changes still fail the comparison. No file hashes were added.

Checks: 36 passing tests/190 assertions across owned-launch and native-interaction;
Bun formatter, linter, typechecker and diff check pass. Independent review and a
fresh observed setup after the correction remain open.

Supported cleanup returned cleaned. The exact temporary root was then checked
absent, and the original PID 7793 service plus its actual running work were read
back. No task or candidate worktree was removed; no implementation was replayed.
Cleanup was separate from the unavailable feature scenario.

Computer Use repeatedly addressed the main process for the shared OpenCode app
ID; its documented Mac API exposes no process/window selector here. A Dock
lookup timed out after 903.0949 seconds. That was driver/tool overhead, not proof
of an OpenCode freeze or worker failure. Native work continued during that wait:
LZ-61 returned b9b7ad2 and LZ-71 was dispatched. Root asked the human for a specific
exception to use the owned native Desktop interaction bridge, which performs
actual window input rather than model API prompting. The human explicitly approved it, including prompt entry.

Still unproven: keyboard save/remove, reopen, stale conflict, registered Architect
tool↔panel readback, narrow/wide visual review, and feature behavior. Neither
this setup nor its cleanup counts as an implementer verification walkthrough.

Follow-up trials and driver assistance (20:24UTC):

- 7cmXMg, same d0e0045 candidate, service83536/59848/Desktop83543. Actual
  snapshot and picker/provider clicks worked. Observing Chrome removed focus;
  broker rejected click d9a7f855-1a8d-48ba-9ab5-9c3d08988df6 before request
  insertion, while CLI marked enqueue failure ambiguous. Same service/adapter
  still returned unknown for that never-inserted request. Root manually audited
  source/runtime negative delivery and used supported recovery helper once;
  this was driver assistance, not automatic recovery. No replay or model call.
- gIG0Vk, candidate94604d6 adds timestamp/bridge corrections, service87365/60600,
  Desktop87372. Actual unfocused click returned actionable preflight error;
  explicit focus returned not-delivered rather than ambiguous. macOS application
  activation was missing. No sign-in or model call; setup is not feature proof.
- Both cleaned by supported identity-checked cleanup. Desktop exit initially
  timed out/changed process observation; subsequent fresh observation and retry
  cleaned normally. No manual kill/removal, MainPID7793 preserved.
- User saw a JavaScript error in the second/third isolated instance. Existing
  host logs retained no exception: crash.log only reporter-start, renderer.log
  onboarding/autofocus, main.log a startup netlog insufficient-resources warning.
  That warning is not enough to attribute the reported dialog. Old launcher
  discarded stdout/stderr. 6f7b679 captures future owned-process output in a
  private0600 log inside the disposable root; do not publish raw logs.
- Current Root corrections:67ae256,8a50a02,6f7b679,600ef12. Independent native
  reviewer found the post-DOM ownership race and repeat-resolution defect;
  fixes preserve actual transport ambiguity and never replay input. Final
  native macOS activation observation and Models feature scenario remain open.

User screenshot resolved the exception (20:29UTC):

`TypeError: Object has been destroyed`, at `In.forget` in the evaluated GUI
plugin, through BrowserWindow closed and process.exit. This identifies our
native bridge listener teardown; the netlog startup warning was unrelated.
A regression with an Electron-like destroyed `webContents` getter reproduced
that exact TypeError before7191d7f. The fix retains the original contents and
window ID, so destroy/invalidate/forget never fetch contents from a destroyed
BrowserWindow. Destruction→closed→repeatedstop is covered:19tests90assertions,
quality clear. No WebGPU configuration or driving-service restart.

Owned native observation: corrected clean candidatea6223ad, rootryHCJa,
service95315/62110, Desktop95322, renderer95336. Explicit focus returned delivered,
window1/generation1 focusedtrue, snapshotad3e44a5-3938-4831-8247-ca41ad840e84.
The bounded OS focus acknowledgement0a39277 resolved prior premature negative
focus results. Supported cleanup returned cleaned on its first invocation in
0.778s; no exception dialog was observed. This is one successful real shutdown,
not evidence that every future lifecycle variant is proven. Root and process
removal were handled by supported cleanup; Models feature gate is still open.
