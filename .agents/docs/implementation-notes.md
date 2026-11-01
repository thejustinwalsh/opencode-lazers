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

## Isolated WebGPU test prerequisite

The runtime fixture mocks `.cache/lfm3-engine.js`, but Bun still needs that ignored
path to resolve. In a fresh worktree, prepare the pinned engine JavaScript with
`bun scripts/prepare-engine.ts` before the full suite; `bun run build:gui` includes
that preflight too. Reuse the child-process fixture isolation for runtime tests.
This setup gap recurred in LZ-37 after earlier isolated workers encountered it;
see [execution observations](evidence/037-roadmap-planning/native.md). Keep this
pitfall scoped to relevant WebGPU work rather than repeating it in every task.
