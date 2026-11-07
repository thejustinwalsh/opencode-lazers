# LZ-172: interrupted continuation loses retained-repair authority

Observed after the reported server restart, 2026-11-06; source research uses
canonical `3a116f145dbd7bbb6369cb5ffd9cf5275717a39d`. Preserve the original
worktree, patch, attempt, session, usage and all control receipts.

## Observed sequence

- Original LZ-172 attempt: `14b02650-aea7-43fa-a7dd-3e60228f00b5`, session
  `ses_83bd7a96b951462e9aa31f80043e8940`; retained-repair input
  `msg_0a5931b0e1ec4e4885e926c437e90ceb`, based on delivered `0da6681`.
- After restart, exact native inventories had no active worker, input, approvals
  or forms. Runtime separately recorded an interrupted turn on that exact input
  in both `WORKER_STOPPED` and the blocked observation. Background remained
  unknown; the raw native session's older success was not treated as completion.
- Registered `resume`, with exact task/attempt/version, admitted one tracked
  continuation input `msg_40dbde5028f14acea08dd8bfcd270760`. The recorded resume
  retained attempt/session/workspace/baseline/usage and interrupted-input lineage.
- Dispatch then failed with **“Retained repair is missing a valid owner/control
  authorization fence.”** Runtime subsequently marked that same attempt cancelled
  as an unprompted reservation. No replacement worker was created. LZ-173's
  ordinary same-attempt interrupted continuation succeeded independently.

## Confirmed source interaction

Native Luna source research found that ordinary resume updates `message_id`
(`runtime.ts:3311–3398, 3531–3563`), but `retainedRepairForAttempt` still requires
the original `RETAINED_REPAIR_REQUESTED.messageID` to equal the current assignment
(`:6886–6927`). The existing repair record therefore fails lookup after the
authorized input transition. `prepareWorker` rejects it (`:7027–7034`); later
unprompted-reservation handling cancels the attempt (`:5951–5957, 6219–6227`).

Unknown background continuation is already supported with exact interrupted
input and owner/native/effect fences (`interrupted-continuation.ts:87–213`);
this is not permission to invent zero background or weaken completion gates.
LZ-163's owner-transfer support does not reauthorize a later repair input.

## Recovery boundary

Current source has no safe control to repair the now-stale authorization:
`retry` creates a later attempt; `reconcile` does not rebind repair authority;
review-input reconciliation has different eligibility; new retained-repair
admission requires an accepted original attempt/node. Do not loop these commands,
manually alter the database, send an untracked/proof-only prompt, or fabricate
idle evidence.

A narrow runtime correction must preserve the retained-repair authority across
an authorized interrupted continuation and safely recover the already-held
original attempt only when durable and fresh native evidence establishes that
exact runtime-created, unprompted fence failure. Generic cancellation, different
owner/epoch/input/route/artifact, pending or uncertain effects and ambiguous
delivery remain protected. Use existing control/effect machinery and idempotent
input association; do not replace the original implementation worker.
