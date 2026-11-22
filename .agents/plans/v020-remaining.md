# v0.2.0: remaining work

Written 2026-11-21, when the session that drove the release push ran low on budget. Read
[the report](../reviews/2026-11-21-release-push-report.md) first; it says what is done and
where each branch is. This file is the ordered list of what is left.

**Owner decisions that bind all of it** (recorded in
`.agents/plans/panel-streams.md`, "Owner decisions"):

- v0.2.0 is a public release through `.github/workflows/release.yml`. The driver stops with a
  release report; the owner says go; only then is the tag cut.
- Every panel reads through streams (`design/data-streams.md`). No second read path.
- OpenCode owns message text. LAZERS stores every piece of transcript metadata it requires and
  no text.
- Fallow is at zero findings, duplicate threshold 100 tokens.
- The product (Architect and workers) builds product tasks; the driver fixes the product when a
  run stalls.

## Step 0: land the panel branch — DONE

Update, later the same evening: the merge round finished and its full gate passed at `812265ea`
(Fallow 0; runtime 439, runner 644, audit 171, src 1,798, test and scripts 412, website 60; 0
failures). It is merged into `main` and pushed. Start at step 1. The text below records what
was merged.

### What step 0 merged

Agent `panels-integrate` was merging, in worktree `.claude/worktrees/panels-all`, branch
`feat/panels-all`:

1. `main` at `c373a885` (LZ-216, the multi-state Tasks filter, integrated by the product).
2. `fix/meta-followups` (`43381247`): Trajectory regressions, tool output, host paging, busy and
   idle times, compaction, effort wait.
3. `chore/final-deletion` (`3d0a9691`): old reads deleted, the show-read guard.
4. `fix/load-busy` (`e771a835`): plugin load waits for the write lock.

Then: one-read tail open in `src/streams/sources/trajectory-host.ts`, delete
`progressDiagnostics`, Fallow added to `scripts/gate.sh`, full gate.

**Done when:** `bash scripts/gate.sh` exits 0 on the tip and `bun scripts/fallow-health.ts`
prints `total findings: 0`. If the agent did not finish, redo the merges in that order; the
conflicts to expect are in `src/tasks/` (LZ-216 against the stream-backed panel),
`src/trajectory/` and `src/core/core.ts`.

**Then promote:** in the main checkout `git merge --no-ff feat/panels-all`, confirm the tree
equals the gated tip (`git diff <tip> main --stat` is empty), `git fetch github`, check for
foreign commits, `git push github <sha>:refs/heads/main`, then
`git push github refs/notes/lazers:refs/notes/lazers`.

## Step 1: restart on the panel build — DONE except the window reload

Update: restarted 2026-11-22 01:50 UTC on `e8a00d97` (pid 67880). Verified read-only: every
module at its new generation, every `projection_state` row `ready` with no error, 0 plugin load
failures in the host log, the stream probe opens (109 ms) and slides, dispatch unpaused. The
transcript metadata backfill was still draining a minute later (377 sessions queued, falling).
NOT done: the Desktop window was not reloaded, so it still shows the old GUI bundle. Reload it
before step 2. The steps below record the procedure.

### Procedure used

One restart installs every schema change: `projects` 3, `model-mappings` 2, `task-schedule` 5,
and the new modules (projections, task-events, native-call-display, scheduler-status,
host-sessions, project-overview, model-candidates, model-decision-views, transcript-meta 3,
trajectory-effort 2).

1. `bun install` (root and `website/`), `bun run build`.
2. `bun .cache/driver/claude-pause-all.ts on "<reason>"`, answer any open Architect form
   (`bun .cache/driver/claude-forms.ts`), then restart. No safety check gates a restart (owner, 2026-11-22; the check is deleted).
3. `opencode service restart`.
4. Verify read-only: schema generations, `projection_state` rows reach `ready`, the dirty
   queues drain, `bun .cache/driver/claude-stream-probe.ts` opens and slides, the host log has
   no `failed to load plugin`.
5. Reload the Desktop window (the GUI bundle changed), then
   `bun .cache/driver/claude-pause-all.ts off`.

Expected first-run cost: transcript metadata backfill about 3,500 host pages and 7 s of writer
time; task events 2.6 s; native call display 1.3 s; schedule rebuild of 260 tasks.

## Step 2: verify on screen (nothing has been checked on screen yet)

Use computer use on OpenCode Desktop with a running worker. Per panel, the list each lane left:

| Panel      | Look at                                                                                                                                                                                                                                 |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tasks      | Attempts, lane and model on a selected task; History rows load their payload; a running worker shows active and pending counts; Concern tooltip reads "Recommended: …"; a task link in chat opens the task; LZ-216's multi-state filter |
| Radar      | A running worker's current and last call; Flow model cards and "Reading model steps"; the Architect row's Messages; Map groups never show zero while indexing; concern action and reason                                                |
| Models     | First open shows "building it from your runs"; contributors lift for a selected task; an unpriced entry shows no price; Benchmark view and score picker; Assignments source labels and pickers                                          |
| Projects   | Pause and resume; code, limit, weight, spend ceiling; "Not loaded"; Verification group; a saved profile appears without reopening Settings                                                                                              |
| Trajectory | Pan and zoom load earlier events; check intervals without selection; hold reason in the header; transcript loads while scrolling back through a long session; tool rows show route and status                                           |

Also: the website demo in a browser (`website/`, through Portless), and one read-only check
that a growing session's new messages arrive through the stored transcript cursor
(`.cache/driver/claude-meta-resume.ts`).

A walkthrough defect goes to a fix agent with the reproduction, then the same walkthrough is
rerun.

## Step 3: remaining build work

| #   | Item                                      | Size | Notes                                                                                                                                                                                                                                                        |
| --- | ----------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Planning panel on streams                 | M    | `src/planning/panel.tsx` polls `list` then `get` every 3 s. An agent was started and stopped; branch `feat/planning-streams` may hold a partial start: inspect before reuse. Remove `PlanningRpc.get`/`list` from `ALLOWED` in `scripts/check-show-reads.ts` |
| 2   | Retention status scans all history        | S    | `previewRetention` (`src/retention/retention.ts` ~660-690) runs `COUNT(*)` over transitions, progress and tasks, once per preset. Use stored counters or a paged estimate                                                                                    |
| 4   | Stale `running` attempts on blocked plans | S    | Plans `b6686170` and `e6d9a7a7` kept `running` attempt rows with idle sessions. Find why the attempt never left `running`                                                                                                                                    |
| 5   | Two write RPCs with no control            | S    | `Models.configurePriceSources` (no reorder UI; the cost-basis rule says the order is configurable) and `Projects.resumeSetupNotice`. Add the control or delete the RPC                                                                                       |
| 6   | LZ-228 to LZ-231                          | —    | Paused product tasks that the panel work superseded. Ask the owning Architect to cancel them as superseded once the panel branch is on `main`                                                                                                                |
| 7   | D1 task-review rework                     | L    | Not started. Needs its own brainstorm with the owner                                                                                                                                                                                                         |
| 8   | Planning walkthrough, profile walkthrough | M    | Drive each flow in the app; fix what breaks                                                                                                                                                                                                                  |
| 9   | Model-scale GPU run                       | S    | D1 on ruNNtime `lazers-omni-625c05e` with the 604 MB buffer                                                                                                                                                                                                  |
| 10  | Product does not run Fallow               | S    | LZ-216 landed an unused export. After step 0 the gate script runs Fallow; decide whether worker verification should too                                                                                                                                      |

## Step 4: release

1. Final `bun scripts/fallow-health.ts` and `bash scripts/gate.sh` on `main`.
2. Update `README.md` (tested OpenCode version) and `docs/how-to/install.md`.
3. Release report to the owner: what changed, what was verified on screen, what is known-open.
4. On the owner's go: `package:release`, tag `v0.2.0`, publish through the release workflow.

## Housekeeping

- Worktrees under `.claude/worktrees/`: every lane's worktree can go once `feat/panels-all` is
  on `main` (`panels-events`, `panels-host`, `panels-models`, `panels-models-gui`,
  `panels-tasks`, `panels-trajectory`, `transcript-meta`, `trajectory-gui`, `trajectory-fix`,
  `meta-followups`, `radar-monitor`, `final-deletion`, `load-busy`, `runner-exits`,
  `integration`, `fallow-clean`, `renewal-recovery`, `audit-retention`, `integer-keys-land`,
  `runntime-bump`, `planning-streams`). Keep `gate-fixed`. Fifteen older ones are locked by
  other processes.
- `.cache/parked/git-hardening-9337fab3.patch`: the dropped git-hardening work. Delete on the
  owner's word.
- `.cache/driver/claude-state-20261117.ts` calls a deleted RPC; it is a dated one-off.

## On-screen check, first pass (2026-11-22 02:05 UTC, build `e8a00d97`, window reloaded)

Driven with computer use on OpenCode Desktop. No worker was running, so every "running" state
is still unchecked.

| Panel                                  | Seen                                                                                                   | Result                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| Tasks, session scope                   | "No open tasks in this session" after a short loading state                                            | Renders                                              |
| Tasks, project scope                   | 4 rows (LZ-228 to LZ-231), inspector with title, plan step, pause note, progress steps, age, done-when | Renders                                              |
| Tasks, state filter (LZ-216)           | Menu with counts; "All" lists 204 rows                                                                 | Renders; counts disagree with the stored rows, below |
| Radar Monitor, Map, Flow               | Empty states: "Nothing is running", "You · session", "Nothing is flowing"                              | Renders                                              |
| Models, Projects, Trajectory, Planning | Not opened                                                                                             | Unchecked                                            |

**Defect to investigate first: the Tasks state counts do not match `task_schedule`.** For
project `opencode-lazers` the stored buckets are open 9, paused 4, accepted 162, cancelled 81
(256 rows). The panel's menu shows Open 4, Queued 0, Paused 4, Completed 162, Accepted 162,
Integrated 0, Cancelled 38, All 204. So 52 rows are missing from the panel: all 9 `open` rows
and 43 `cancelled` rows. Also "Integrated 0" although 160 of the 162 accepted tasks sit on
plans in state `integrated`. Start in `bucketsForSelection` (`src/tasks/state-selection.ts`,
from LZ-216), the stored bucket counters behind `tasks.bucketCounts`, and how a task with no
plan is bucketed. Before LZ-216 landed, project scope showed "8 open" with 8 rows.

Minor: a background click on a task row did not change the selected row; not confirmed as a
product defect (it may be the automation's background click).
