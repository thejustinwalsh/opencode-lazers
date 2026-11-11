# LZ-187 independent integration review

Reviewed candidate: `815930024c6e8b5cc3b222e6b5451a72d4b5bc20`.
Independent composition with canonical `28870cd`: `271a69f6c8dd10270c1da903bd52f6051c5d665b`.

## Behavior and checks

The complete production diff only consolidates the inference tool permission
pipeline, assistant speech text filtering, and shared RPC method definitions,
and removes unused review constant re-exports. Reviewed callers and the repaired
native permission context typing preserve the public contract. No runner/native
producer, schema, or LZ-154 implementation is consumed or changed.

On the independent composition: `bun run verify` passed; the focused command
`bun test src/webgpu src/review test/speech src/recovery/handoff/review.test.ts`
passed 149 tests and 1,026 assertions across 29 files; `git diff --check` passed.

## Activation research and decision

Pinned OpenCode revision: `9bbb8ce18c80f099e0e448775f59d965ead40a21`.
Upstream paths below are in <https://github.com/anomalyco/opencode/tree/9bbb8ce18c80f099e0e448775f59d965ead40a21>.

- `packages/core/src/config/plugin/source.ts` watches configured absolute local
  plugin directories. `packages/plugin/src/source.ts` fingerprints and watches
  the actual local import graph; `source.node.ts` versions local imports.
- `packages/core/src/plugin/module.ts` forwards watched graph changes.
  `supervisor.ts` serializes activation with a 100 ms source-change debounce and
  a readiness hold. Source integration cannot honestly be called activation-free.
- `packages/core/src/plugin.ts` replaces changed plugin registrations/scopes;
  this is not the server-wide `location.reload()` operation. Session entry
  points await activation. There is no reason to restart the service or send a
  replacement worker input for this change.
- Our `src/index.ts` stops/drains its scheduler on disposal. `TaskRuntime.stop()`
  aborts owned verification activities, not implementation sessions. Current
  inspected LZ-154 is still implementing in its original isolated workspace,
  with no runner verification receipts. Its latest inspected native shell
  verification completed, and its next observed step was model generation.

Proceed with the reviewed independent source composition; do not require
LZ-154 integration or unrelated historical cleanup. Preserve the original worker
and verify its identity/progress after landing. Do not invoke explicit location
reload, restart, or rebuild the GUI bundle. Readiness/source-watch evidence is
not cleanup quiescence evidence and must not discharge historical holds.

## Remaining admission condition

LZ-203 has no after-plan dependency or dispatch pause and still has zero attempts.
`src/runner/runtime.ts` lines 8144–8188 select isolated tasks only when their
effective scopes do not conflict with active project attempts. LZ-154 is active
and shares runtime/native/schema/store/tools write paths with LZ-203. Preserve
that real reservation; no additional integration gate is needed.

## Observed landing and cleanup

Main was fast-forwarded to `db2d84354bd5b80360c51902886f10d115db7ddb`.
The original LZ-154 attempt remained running and subsequently completed native
patch work; no replacement attempt, reload command, or worker prompt was sent.
LZ-187 integration was recorded against its accepted candidate and main landing
HEAD. Its original attempt checkout was removed with a completed native receipt
(`native: true`, `cacheRetirement: evicted`), and its plan reached integrated.
The clean, merged Architect review checkout was also removed natively with
`force: false`. Native inventory retained both Root-owned review resources.
LZ-188 was then observed running; its real prerequisite no longer stalls it.
LZ-203 remained queued with zero attempts behind the overlapping active writer.
