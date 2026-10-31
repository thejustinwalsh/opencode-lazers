# Isolated worker context reuse repair

## Boundary and source findings (2026-10-31)

This supplements completed task `f55e7013-630e-4b3e-ab3c-407e61c75ccc`;
it does not repeat workspace-local caching. Source inspection started at
`73ad40c5db27293a9ea88317c75484d32498c2b0`. Architect snapshot
`649d7c8e-92d0-4e82-a1b3-630fd9f7ce48` was explicitly refreshed at
1793478712341 in `/Users/tjw/Documents/ChatGPT/opencode-lazers`. It describes
that workspace as of refresh, including concurrent uncommitted runner edits;
it is not a clean-commit or current-worker-source claim.

- `src/index.ts:27-63` shares the task database using
  `ctx.location.project.canonical`, but constructs each `ProjectIndex` with
  `ctx.location.directory`. Its file-permission callback also joins paths to
  that instance directory. Changing just the cache lookup would therefore check
  the wrong source path when serving another workspace's bytes.
- `src/context/index.ts:115-155,365-476` keys identity and `$workspace` pointers
  by the real workspace root and validates loaded bytes against that root.
  Reads acquire pointer and immutable bytes under the existing transaction,
  recheck each reader's permissions, and never collect/repack. Preserve those
  protections. Separate isolated roots cannot currently select the Architect's
  published snapshot. Do not replace this with a global latest-snapshot lookup.
- `src/context/tools.ts` registers permission-first index/read tools and an
  Architect-only refresh. Index identifies `workspace`; read currently does not.
  Cross-workspace reads must clearly identify their source workspace, snapshot
  and as-of-refresh time, not imply that cached source is the worker's live tree.
- `src/runner/runtime.ts` currently dispatches a readable-task-tool reference,
  not `ProjectIndex.packet()`. `src/implementor.md` already permits ordinary
  tools when no snapshot exists. Wiring the legacy packet's mandatory context
  or token reservation into dispatch would be unrelated scope, not this repair.
- Existing coverage in `src/context/index.test.ts`, `src/context/tools.test.ts`
  and spike 017 proves local reopen/read reuse, permission revocation and
  cross-process eviction safety. It does not prove cross-location worker reuse.

## Pinned host facts

Read `.agents/docs/opencode-api.md` before integration work. Installed plugin,
schema and client are **2.2.5**; source authority is OpenCode commit
`9bbb8ce18c80f099e0e448775f59d965ead40a21`.

- [Plugin host](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/plugin/host.ts):
  `ctx.location` is captured from the plugin instance's Location service, not
  dynamically from the calling session. `ctx.session.get` resolves the session;
  native `permission.assert` retains the caller identity. `session.create`
  forwards parentID instead of location when a parent is supplied.
- [Session creation](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/session.ts):
  children inherit their parent's location at creation and keep parentID;
  projectID is resolved from location. [Move](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/session/move.ts)
  resolves the destination/project and loads its location services. LAZERS'
  `nativeHost.prompt` explicitly moves/waits/verifies before prompting workers.
- [Current V2 documentation](https://opencode.ai/v2/docs/build/plugins/server/#context)
  independently distinguishes plugin-instance location from session/event
  locations. Do not infer context sharing from a shared project or parent alone.

A context-layer association between a publishing Architect and an owned worker,
validated against public native session/project identity, can avoid changes to
the concurrent runner files. Keep selection explicit and durable enough to work
across separately loaded location instances; do not trust arbitrary caller paths
or session metadata as authorization. Source permission checks must use the
worker principal and the actual source workspace paths. No source hashes,
live-freshness gates, implicit refresh, new required context ceremony or worker
delegation are needed. Missing/unavailable optional context must leave ordinary
reads/LSP usable.

## Verification boundary

Add a discriminating regression using two real Git worktree roots and separately
registered location contexts: one Architect refresh, then an isolated implementor
index/read of a chosen source. Require the same snapshot/refresh identity and
source bytes even when the worker file differs, correctly labelled source root,
zero read-side collection/Repomix rebuild and unchanged publication/cache state.
Exercise reopen/separate connections, denied/revoked source permissions, foreign
project or unrelated source attempts, and absent optional context with ordinary
read fallback. Preserve existing workspace-local and eviction regressions.

Before claiming native closure, Architect must also observe the repaired path
on the pinned native host: publishing Architect session, owned isolated worker
session/directory/project, one refresh identity and the worker's actual tool read.
Record exact artifact, output/provenance and any missing native observation in
`.agents/docs/evidence/isolated-context-reuse/native.md`; fixture tests alone do
not establish that observation. Workers must not spawn sessions to bypass their
delegation boundary. No service restart or existing worker interruption.

Polling, compact plan inspection, scheduler/storage/prompt repairs, the five
admitted product schedules and canceled inference work are outside this repair.
