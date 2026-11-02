# Compaction must preserve worker input identity

2026-11-02, native service PID 7793. No restart or replacement worker.

## Observed failure

LZ-56 and LZ-62 finished with native `outcome=succeeded`, idle timestamps,
empty inbox and permissions, and no intended/uncertain runner effects. Both
plans remained cancelling. `session.context()` contained a completed compaction,
assistant responses and idle, but no user/synthetic input. The adapter derived
`turn.inputID=null`; cancellation therefore never recognized the assigned turn.
The idle hook and its terminal confirmation used the same incomplete source.

The pinned host store distinguishes `context` (latest compaction window) from
retained message history. Message queries order by durable sequence, not message
IDs or wall-clock timestamps:
https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/session/store.ts

## Repair

Retain the inexpensive context path. When a completed compaction hides every
input, query the newest user and synthetic records through the public filtered
message API. If both exist, use the public ordering cursor to identify the newer
one. This is two or three bounded record queries, not a full-history scan or a
clock/ID ordering guess. Share that resolver between native turn observation,
experimental.idle and success confirmation. Transport errors remain errors;
missing input remains unknown. Existing inventory, interaction, current-input,
listener and event-order checks remain in force.

## Qualification

Two adapter regressions failed before the repair. Coverage includes either input
type winning despite reverse-ordered IDs, no response remaining pending, no
retained input remaining unknown, and registered idle/success confirmation after
compaction rejecting a changed input. Final runner/progress/native-liveness checks passed: 213 tests, 2,811
assertions; Bun formatter, linter, typechecker and git diff checks passed.

Live DB read at Unix ms 1793637900157 showed both original plans cancelled:
LZ-56 v27 and LZ-62 v21. Native CANCEL transitions were recorded at
1793637896615 and 1793637896560, with outcomes admitted to Architect. No task
completion was fabricated. This qualifies cancellation recovery; the subsequent
same-worker corrections and new post-compaction completion remain separate live
gates. Original attempts, sessions, commits and worktrees were retained.

Independent native review `ses_e65f2f689ffeyogHdgkRNj0WpY` cleared
`70179aa61d88ca466b6ad10ec4556bdb27175180` with no material blocker.
It confirmed durable cursor ordering, bounded fallback, shared authenticated
resolver, unchanged observation fences, and preservation of earlier repairs.
The reviewer performed source review only; it did not claim additional tests or
live acceptance. Subsequent correction/completion gates remain open.
