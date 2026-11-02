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
actual window input rather than model API prompting. That answer is pending.

Still unproven: keyboard save/remove, reopen, stale conflict, registered Architect
tool↔panel readback, narrow/wide visual review, and feature behavior. Neither
this setup nor its cleanup counts as an implementer verification walkthrough.
