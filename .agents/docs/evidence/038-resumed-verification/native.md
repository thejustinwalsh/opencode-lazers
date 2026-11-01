# Resumed worker verification receipt reuse

Observed 2026-11-01 during the native roadmap dogfood. LZ-28 original attempt
`33e6b86d-edda-41dc-9ac4-93d195f537ea` resumed after review and committed
`8c8f86c`, replacing its earlier `e127d1a` candidate. The task-level verifier
selected its first completed `verify:focused` effect by attempt/check ID alone.
That receipt still described `e127d1a`. The later artifact comparison correctly
rejected that receipt, but the scheduler misclassified stale receipt selection
as a failed implementation and automatically spent a repair attempt. Attempt 2
`941526b0-62de-4578-b82e-f2a458c95358`, native session
`ses_0837d798635a4b10a58e1fdc9175854f`, started from retained work. This was not an
Architect-requested retry or proof that the repaired implementation failed its
current tests. The separate feature gap remains: 8c8f86c disables renewal on the
pinned host and does not establish the requested native lifecycle behavior.

The fix reuses a completed task receipt only for the current artifact, workspace
and check definition, matching the existing graph-verifier behavior. A changed
artifact gets a new check effect and receipt file; prior records/files remain.
This uses existing Git commit identities, with no source-file fingerprinting or
new evidence requirement. No task state or live receipt was edited manually.

A real Git/disposable database regression runs a worker to a human-evidence wait,
cancels/resumes that same attempt, adds a different valid commit, and checks that
fresh verification retains the worker, old receipt and outstanding human gate.
Against the pre-fix runtime the test fails because a second attempt is created.
Against the fix it passes, including distinct retained receipt files and no
repeated checks on unchanged subsequent ticks.

Validation: 115 runner/recovery tests passed, 1,790 assertions; Bun formatter,
linter and strict typechecker passed. Native activation is pending the next
supported reload alongside reviewed UI work, avoiding interruption of active
Architect/reviewer generation. This source fix does not retroactively erase the
historical false failure or certify lifecycle feature acceptance.
