# Native driver verification — 2026-10-31

The repaired Tasks panel fits the narrow Desktop side pane and can start an
existing planned task. This is observed app behavior, separate from runtime
acceptance of the original worker artifact.

## Browser-only repair

After `4c5eb55`, Desktop rendered an empty Tasks tab. The current renderer log
recorded `[plugin] lazers TypeError: Illegal invocation`. `ScrollRestoration`
stored the browser `queueMicrotask` function directly, then invoked it as an
instance method, giving it an invalid WebIDL receiver. Bun did not enforce that
browser receiver contract.

Commit `a53dba3` forwards the default scheduler through an arrow function. A
receiver-enforcing regression failed before this change and passed afterward.
Rebuilding the GUI restored the actual Desktop panel without restarting the app.
The full suite passed **166 tests / 1,462 assertions**, quality checks passed,
and the GUI build passed. Existing upstream bundle warnings remained.

## Observed Desktop checks

- At approximately 330 CSS pixels, Search, scope and close controls fit; row
  excerpts end inside their rows and inspector text wraps. Terra 6.1 High
  reviewed the [before](narrow-search-before.png) and
  [after](narrow-search-after.png) captures and passed the repaired layout.
- The running `2958fa32` row has a real green running glyph and a matching Running
  inspector. Its native subagent entry opens actual Luna Max tool activity in
  the assigned OpenCode worktree. This does not prove parallel overlap yet.
- Pointer resizing changed the list split from 38 to 49. Closing and reopening
  Tasks retained 49, the Repomix selection, search, and the lower inspector's
  final assertion/closed Details and Activity. See
  [restored inspector](restored-inspector.png). A later keyboard Down/Up changed
  39 → 44 → 39. Upper-list and lower-inspector scrolling were exercised separately.
- The supported `location.reload` refreshed local server services. The
  project-specific native implementor registry resolves
  `openai/gpt-6-luna#max`; Architect remains Sol High. An unscoped lookup of the
  home directory is not the project configuration.

## Real manual Start

Through Desktop, the driver selected existing task
`f55e7013-630e-4b3e-ab3c-407e61c75ccc` and pressed Start. Its existing plan
`aa71e2c0-3f4c-4cff-82f2-b3afc8b661a8` changed from draft/version 1 to
running/version 2 with the selected Luna Max route. A repeated press retained
that one plan and version. See [manual Start](manual-start.png).

The task remains queued with no worker attempt while the active parallel-runner
implementation occupies the current scheduler slot. Admission is verified;
Repomix execution and completion are not claimed here. The retained production
reproductions also pass successful Run replay, foreign-caller rejection before
native effects, and retry after a failed owner-continuation response.

## Remaining work

Linked-worker Session Tasks discovery remains under existing task `efd8459f`.
The all-nodes-accepted plan finishing delay behind another active plan, and
verification/integration against the reviewed result, remain part of runner
review. No current-theme capture proves all light/dark/font changes, and no
screenshot proves native restart recovery or real parallel worker overlap.
