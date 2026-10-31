# Implementation notes

Attach only relevant lessons to a task. These are reusable code findings, not a
mandatory task checklist. New lessons should come from observed work.

## Native child workspace routing

Pinned OpenCode 2.2.5 child creation inherits its parent's location even when
another location is supplied. For isolated execution, move the child, await the
queued native operation and check its actual directory before prompting.
Reuse `src/runner/native.ts`; see its location-routing behavior tests. This trap
was observed in the first worker trajectory linked from
[execution report](spikes/011-runner-execution.md).

## Concurrent SQLite first open

Configuring WAL can return `SQLITE_BUSY` immediately during concurrent first
opens despite the normal busy timeout. The existing connection setup in
`src/storage.ts` retries that configuration failure. Reuse it; do not turn this
into automatic replay of task writes after an uncertain commit. The accepted
submission worker exposed the race and verified the repair with independent
process tests; see [submission result](spikes/007-retry-safe-submission.md).
