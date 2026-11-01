# Grouped Tasks integration source review

2026-10-31. Existing task `f09ad402-f70b-4cde-a531-958fec8bfa1a` (`LZ-26`),
original attempt `f0eee1ec-7ec3-489d-aadf-77443df8d7a8`, artifact `dcba900`.

The combined references/grouping artifact was merged normally for source review
and native mounting. Root's startup recovery `b4fcd61`, association-aware task
reference correction `1f9fb6a`, cancelled-plan filtering, native observation
panels, speech and outcome/scope repairs remain in the merged ancestry. Root owns
the handoff/audit refresh; its concurrent files were not edited here. No worker
was retried, replaced or interrupted.

Root's independent review (`/private/tmp/lazers-grouping-review.md` and the
conversation) identified three repairs, now applied during integration:

- The real b50 shape, projection → Radar/Trajectory → assembly plus speech →
  assembly, preserves its two disjoint branches. Assembly remains on the root
  lane; speech remains a join prerequisite reference, not a fabricated branch.
  Regression uses the actual five task IDs. Extra incoming edges to heads or
  interiors, cross-connected/nonlinear branches and overlaps still stay flat.
- Untitled groups display `Plan <short actual ID>`, not indistinguishable repeated
  “Recorded plan” labels. Authored titles remain verbatim.
- The native menu test compiles the real panel through the Solid/Vite boundary,
  with the real plugin context and registry tokens. It renders the themed label
  through Solid SSR rather than mocking JSX runtimes. Middleware mode disables
  websockets and opens no listening socket. This is a registration/SSR test, not
  native interaction proof.

Fresh checks after these repairs:

- Isolated `bun test test/task-panel/menu-tab.test.ts`: 5 passed, 19 assertions.
- Isolated `bun test src/tasks/execution-list.test.ts`: 7 passed, 39 assertions.
- Grouping/reference/observation focused suite: 48 passed, 353 assertions.
- `bun lint` and `bun check`: passed.
- Full `bun test`: 349 passed, 0 failed, 3,298 assertions across 71 files.
- `bun run build:gui`: passed; existing ONNX import-meta/CJS and Vite
  inlineDynamicImports warnings remain, with no new build failure.

The first whole-repository formatting check encountered Root's then-in-progress
audit JSON. That file was left untouched; it is not a grouping source failure or
a formatter pass. The later full command again stopped at that same JSON under
`bun run verify`, after all 349 behavior tests passed. Root must settle its audit
formatting before whole-repository quality can be reported green.

`native.md` remains explicitly pending. Source landing and passing automated
checks do not establish real Desktop copy/paste/rendered-link navigation, mounted
chain/fork/join/cross-edge interaction, persisted search/disclosure, paging,
filters, keyboard or narrow layout. Whole-plan integration and cleanup must not
silently substitute for those observations.

Source merge is `0b880a8`; review repairs are `d974597`. Normal task-level command
`grouping-reviewed-source-landed-dcba900-d974597-v1` recorded the accepted task's
landing at references/grouping plan v17 → v18, observed HEAD `d974597`. It did not
finalize the plan or clean its owned worktrees. The local GUI rebuild uses the
documented bundle watcher reload boundary; actual mounted observation belongs to
the subsequent Root/Terra report, not this build receipt.

## Additional independent review repairs

Read-only review of the immutable candidate found five further correctness
issues, repaired on the merged source before any whole-plan finalization:

- A deferred successful topology response could publish old tasks under a newly
  connected view key. Response generation/request/abort identity is now checked
  immediately after that await and again before publication. A deferred old-scope
  regression proves current tasks, selection, project and topology stay intact.
- Selecting an already visible planless task could concatenate its summary and
  reveal identity into two rows. Canonical emitted IDs are now retained for
  planless rows too; the regression asserts one row after selection reveal.
- Search disclosure captured a nonreactive Boolean. Its chevron, accessible
  expansion state and branch visibility now read a live accessor, so temporary
  search expansion/collapse does not wait for an unrelated snapshot refresh.
  Native disclosure/search observation remains required; the state tests do not
  claim a mounted browser test for this change.
- Grouped rows discarded the effective blocked status supplied by the task read
  boundary. Summarized rows now retain that status/reason; context-only rows apply
  the same blocked-plan overlay for queued/ready nodes. Regression covers both.
- Restored/native-link inspector reads were waiting on optional topology or list
  success. Initial selected detail loads independently again; deferred-topology
  and failed-list regressions verify the read starts and settles without either.

Fresh targeted state/graph checks: 17 passed, 79 assertions. The isolated menu
test still passes (5 tests / 19 assertions), lint and strict types pass, and the
production GUI rebuild passes with the same existing warnings. Full checks were
launched in the background; their result is not implied by this source record.
Native observations must identify the repaired build rather than pristine
`dcba900`. Progress remains on original `d543a0f7`; no edits were made in that
active workspace and its newer-main preservation entry was read back natively.

The background command subsequently completed: **353 passed, 0 failed, 3,315
assertions across 71 files**, followed by passing `bun run verify` (354 formatted
files, lint and strict types). Root's audit-only formatting change was preserved;
no remaining formatting failure is claimed for this checkpoint. The additional
repairs are committed as `53ba06f`.

At Root's request the GUI was rebuilt again from that committed source for the
next native pass. The build passed, retaining the existing warning boundary
above. Root's request
to close Tasks/select Radar and click the emitted LZ-23 link is not itself proof
of navigation; the actual click result remains pending Root's report.

## Repair from Root's actual native report

Root subsequently verified rendered LZ-23 click reopening closed Tasks, LZ-21
search revealing root/child and hidden LZ-19 prerequisite navigation clearing the
filter on `53ba06f`. Root committed that partial observation and the outstanding
full-history disclosure/scroll defect in `a245e0e`; `bdc9137` adjusts dependency
spacing. Both remain preserved.

Freshly allocated execution-list objects were being used as Solid `For` keys.
Mounted groups, root rows, branches and children now use canonical plan/task/
branch IDs, with live accessors for current data rather than captured snapshots.
The same render owners survive disclosure/scroll preference saves and refresh;
status, relationship count and expansion remain reactive. Dependency labels no
longer capture a one-time label before linked detail resolves.

A separate client-side Solid identity regression uses the production keyed
mapping without a DOM/server: five fresh-model updates preserve owners and target
identity, live state updates remain visible, reorder retains owners, and actual
removal disposes exactly once. It is not proof of mounted Desktop scroll/focus.
Focused grouping/observation/reference checks pass 53 tests / 373 assertions;
whole-repository formatter/lint/types and the GUI rebuild pass. Root's removal of
the bundle-hash sentence and its audit snapshot formatting are preserved. Native
scroll/focus/accessibility retest and Terra completion remain pending.

Identity repair `f2beb81` was rebuilt from committed source including Terra's
dependency-spacing `bdc9137`. Its full background checks completed: **354 passed,
0 failed, 3,318 assertions across 72 files**, followed by passing whole-repository
formatter, lint and strict types (358 files formatted). Native review is still a
separate pending boundary; these results do not close Root's reported scroll or
accessibility behavior.

## Native acceptance and normal integration closure

Root completed the actual repaired-build observations and committed them in
`23df5d3`: `native.md` records stable scrolled b50 pointer/Space disclosure across
refresh, branch/join selection, 330/450 px wrapping, Details/Activity disclosure,
hidden prerequisites and close/reopen preserving Project history, expansion,
scroll, LZ-23 selection and 39% split. Terra 6.1 High passed the final shown
screenshots, including `bdc9137` spacing. The linked spike 029 native report
establishes actual copied/pasted rendered-message navigation. Coverage remains
limited to those observations and the separately recorded regressions.

Normal runtime command
`references-grouping-native-reviewed-integrated-dcba900-v1` recorded that review
against accepted combined `dcba900` and its repaired merged lineage. The plan
advanced v18 → cleanup-requested v19 → **integrated v20**, retaining every task,
attempt and check receipt; all 22 effects are complete with none pending.

Native non-forced cleanup removed the original references (`e461cae9`), accepted
references (`1aa93ea5`) and grouping (`f0eee1ec`) worktrees. Read-only native
registry and filesystem checks confirmed all three absent. Original progress
`d543a0f7` remains registered, present and busy on Luna Max with unchanged native
busy/idle timestamps. Lifecycle remains queued behind progress integration; no
UI replacement task, worker or further native test plan was created.
