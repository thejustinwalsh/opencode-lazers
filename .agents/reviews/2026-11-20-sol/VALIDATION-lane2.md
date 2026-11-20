# Validation: lane 2 (fix/review-lane2)

Base: local main 6acd6175. Every `confirmed` row has a test that failed before the fix. Only single test files and `-t` targets were run (machine under load); `bun check` is clean.

| Finding | Verdict | Evidence | Fix commit | Notes |
| --- | --- | --- | --- | --- |
| 1add0595-1 | confirmed | `src/projects/registry.test.ts` "1add0595-1: ..." | a2bfb240 | `ProjectRef.code` lost its `.max(6)`; the setter's grammar is now 2-4 letters and at most 12 digits, the longest a 40-character task reference can carry. The edit is refused for anything longer, so no accepted code can fail a read. |
| 49f6a84a-1 | confirmed | `test/projects-settings/settings.test.tsx` "49f6a84a-1: ..." (row node and typed draft survive a poll) | 501e6751 | The listing is a Solid store reconciled by project `key`; rows keep identity, focus and drafts. |
| a963208e-1 | partly | `src/projects/needs-you.test.ts` "a963208e-1: ..." | 432a1b86 | Omission confirmed and intentional in code (other checkouts have no session reader; own-checkout questions come from open-plan owners only). Done: each page now carries `questionsRead` so a consumer can say "not read" instead of showing an empty list. Not done: routing through other loaded locations and discovering Architect sessions without a plan; see needs-design. |
| aa3c498c-1 | confirmed | `website/demo/test/commands.test.ts` | 5facb8fc | Command listener is installed before the settled return (`commands.ts`); a settled frame handles `seek` and ignores play/pause. |
| aa3c498c-2 | confirmed | `website/demo/test/commands.test.ts` (paused clock schedules no frames, parks and resumes) | 5facb8fc | `Clock.nextFrame()` parks while paused; pointer travel and scroll loops use it. |
| aa3c498c-3 | confirmed (patch only) | `website/src/Demo.tsx:234-240` | none, by instruction | Patch below. |
| c20db866-1 | confirmed | `src/radar/pulse-loop.test.ts` (uses `takeRecords()`, with a positive control) | 10376656 | Test-only. |
| 70a0f10e-1 | confirmed | `src/radar/pulse-loop.test.ts` "70a0f10e-1: ..." | 7b0401ef | Host gained `onReducedMotionChange`; the loop cancels every pulse at once on reduced and restores on opt-out; `flow-view.tsx` follows the preference with a signal. |
| 9261988a-1 | confirmed, deferred | `src/audit/wasm/terminate-probe.ts:9-12` | none | See below. |
| 8d153eaf-1 | confirmed (patch only) | `website/src/Sections.tsx:796-799` vs `docs/reference/contributor-contracts.md:53` | none, by instruction | Patch below. |
| 581cf7e8-1 | confirmed | `src/audit/suppression-flow.test.ts` "581cf7e8-1: ..." | 41d002a9 | `withExtraFindings` numbers repeated ids (`#2`...) like the package's own findings. |
| 8c276019-1 | confirmed | `src/runner/runtime.test.ts` "8c276019-1: ..." | b4ad1892 | `scopeOwners` reads the nodes of every unfinished plan of the project, not only this plan's. |
| 8a10ed88-1 | confirmed | `test/trajectory-panel/targeted-render.test.ts` (new assertions in the expand step) | c8fde05e | With a selection, the expanded timeline shows "Inspect" which collapses it and focuses the details. The inspector is not duplicated inside the modal. |
| d93f6681-1 | confirmed; design only | see Design | none | Larger than a focused change. |

## Files for sequencing against `website-verify`

Only these website files changed (commit 5facb8fc): `website/demo/src/engine.ts` (Clock export, `nextFrame`, two loop lines), `website/demo/src/main.tsx` (listener moved above the settled return, uses `handleCommand`), new `website/demo/src/commands.ts`, new `website/demo/test/commands.test.ts`. No layout, CSS, `website/src` or iframe sizing code was touched.

## Patches described, not applied

- **aa3c498c-3** (`website/src/Demo.tsx`, visibility observer): `live.current.visible = Boolean(entry?.isIntersecting && entry.intersectionRatio >= 0.35)`. Test: feed observer entries with ratio 0.4, 0.2 and 0 and assert play, pause, pause.
- **8d153eaf-1** (`website/src/Sections.tsx:796-799`): replace the paragraph with "LAZERS runs your executable verification commands and a Fallow static-analysis audit (dead code, duplication, complexity) on every task. A failing command stops the task before review. Fallow findings go back to the worker once for a repair, and what remains is reported to the Architect, who reviews the diff and integrates it into your branch under your normal OpenCode permissions." The contract (line 53) says Fallow alone never fails or holds a task and an unavailable analyzer is accepted, so the current "gates every task ... only after ... pass" overstates it.

## 9261988a-1: deferred

True: a 150 ms timer stands in for "helpers started"; on a slow start the cancel lands before any helper exists and the test still passes. A real handshake needs a worker-side signal when the first helper enters the analysis (the worker already sends `{ready:true}`, which only says the module loaded, and `WorkerClient` swallows it). Option: expose a test-only `onWorkerEvent` from `wasm-analyzer.ts`, post a `helpers-started` message from `fallow-worker.ts`, and have the probe abort on it with the 150 ms kept as a failure backstop. Not done: it adds worker protocol for a test, and it is a coverage defect, not a runtime leak.

## needs-design: a963208e-1 (routing)

A location's plugin context only reaches its own OpenCode project's sessions, so a page for project B read through A cannot see B's sessions. Options: (1) a process-wide registry of loaded locations' session readers, registered at location start and read by `needsYouPage` (no booting); (2) each location pushes a "questions waiting" count into the shared database (a table the page reads for every project, loaded or not); (3) keep the flag only. Option 2 also answers "Architect question without a plan" if the writer is the session-forms observer rather than plan owners. Needs an owner decision on a new shared table. Interim: the `questionsRead` flag from commit 432a1b86.

## Design: d93f6681-1, bounded ledger paging (no code written)

Measured by reading the code (`src/models/observation-ledger-read.ts`): the first page and every continuation call `readCapture`, which loads all tasks, references, dispositions, classifications, plans, nodes, attempts, transitions, adoptions and progress, and fingerprints the lot. Then `outputFromCapture` builds every task row and slices.

The approved option (keyset by task, change token, only the page's detail rows) hits global values that the page output depends on, which is why it is not a focused change:

| Output value | Today | What a paged read must do |
| --- | --- | --- |
| `page.totalTaskCount`, `classificationCoverage.*` | counted over all task rows | needs classification of every task (reads task bodies / classification snapshots, not progress); keep, it is O(tasks) not O(progress) |
| `totalSessionContributionCount`, session anchors (first task in order owning a session), `sharedSessions` | from all attempts | `SELECT session_id, MIN(task order)`, `COUNT(DISTINCT session_id)` over attempts joined to filtered tasks, and shared-session detection by `session_id IN (page sessions)` over all attempts |
| per-session usage, route occurrences | from all progress facts | read progress for the page's attempts and for other attempts in the same sessions (shared sessions), by `session_id IN (...)` |
| `completeness.reasons` | `noteProgressProblems` scans every progress row for unreadable payloads/lineage | becomes page-scoped (notes for the facts actually read), or a cheap SQL aggregate for the global count; this changes what "partial" means and needs the owner's call |
| `pin.sourceFingerprint`, cursor | hash of the whole capture | a change token: `observation_revisions.revision` already bumps on tasks, task_changes, dispositions, plans, progress, nodes, attempts, transitions, but NOT on task_references, adoptions or the classification tables, so the token must add `max(rowid)`/count of those three |
| `readDecision` | shares `readCapture` | unchanged; keep the full capture for decision reads |

Cursor semantics (required statement): keyset position `(created_at, id)` plus token, taskKind and limit. Task order is stable under inserts and deletes after the position, so when the token has moved the cursor can **continue correctly** from the key under the new token; the page reports `pin.changedSinceFirstPage: true` and carries its own totals, so no page is wrong, but pages no longer share one snapshot. The alternative is **restart cleanly** (return page one of the new snapshot flagged `restarted`), which keeps one-snapshot coherence but can restart forever under steady writes. Recommendation: continue by key and flag it. Today's behavior (throwing "stale") is neither and should go.

Test to add with the change: seed one task plus a large unrelated backlog (thousands of tasks with progress), instrument source rows read (a counting `Database` wrapper or `PRAGMA`-level statement hook), request page one of 10, and assert rows visited are bounded by the page's detail plus the O(tasks) index scan, not by progress volume; then mutate between pages and assert the continuation returns the next keyed page with the flag, and that a deleted anchor task does not produce a wrong page.

Estimate: a new `readPage` path beside `readCapture` (about 400 lines of SQL and projection reuse), a contract field, and migration of the fingerprint. Owner decisions: page-scoped completeness notes, and the continue-versus-restart rule above.

## Reviewer's top ten and cross-cutting problems: status

| # | Item | Status |
| --- | --- | --- |
| 1 | 3bb090ac-1 cache symlink | fixed (lane 1, 5a4db22b) |
| 2 | 81b1d6ba-1 purge eligibility | fixed (lane 1) |
| 3 | 81b1d6ba-2 worktree live checks | fixed (lane 1) |
| 4 | 84e85b0f-1 takeover claim | fixed (lane 1) |
| 5 | 7abe4acd-2 stale payload | fixed (lane 1) |
| 6 | a963208e-1 Needs you questions | this lane: signalled (432a1b86); routing is needs-design above |
| 7 | 1add0595-1 code vs read schemas | fixed here (a2bfb240) |
| 8 | d93f6681-1 ledger paging | this lane: design written, awaiting two owner decisions |
| 9 | 93bb4046-1 recovery notice | fixed (lane 1) |
| 10 | 49f6a84a-1 polling remount | fixed here (501e6751) |

Cross-cutting: (a) payload-dependent liveness and lost updates: takeover fixed in lane 1; **unassigned**: no sweep of other `payload=?` writers that merge a stale copy (lane 1 only covered takeover). (b) safety reimplemented per subsystem: retention and cache copy fixed; **unassigned**: no general audit of other host-side writes outside WASI confinement. (c) no-truncation without end-to-end paging: handoff and recovery notice fixed (lane 1), ledger designed here. (d) identity across layers: project codes, row identity and supplemental ids fixed here. (e) tests that do not establish their premise: observer positive control fixed here; helper-readiness handshake (9261988a) deferred with a design; mocked-helper-ordering vs persisted evidence **unassigned**. (f) owner-facing guarantees: expanded timeline fixed here; all-projects questions partial; website copy 8d153eaf patch written for the website agent.
