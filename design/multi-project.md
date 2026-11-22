# Many projects in one OpenCode

Status: draft for owner approval, 2026-11-20. Nothing here is built.

## Why

The owner will load many projects (OpenCode locations) at once. Today each
project runs by itself and can only be seen from inside its own location. With
many projects open that means: no one place shows what is running or waiting,
task references collide (`LZ-12` exists in every project), sessions cannot be
told apart, and N projects each running their own limit of agents and check
suites will saturate the machine.

## Goals

1. Every task, session and notice says which project it belongs to, at a glance.
2. Every panel can show all projects together, grouped by project.
3. One place lists what needs the owner across all projects.
4. Parallel work is bounded per project and across the machine, with tunable
   counts.
5. When the machine limit is reached, projects share it fairly and none starves.
6. Dispatch can be paused per plan, per project and globally, from the UI.

## Not goals

- Cross-project task dependencies. A task never waits on another project's task.
- One database per project. The shared database stays; heavy detail is handled
  by paging and the retention purge.
- Automatic back-off from CPU or memory pressure. Limits are counts tuned by hand.
- Pre-empting running work to rebalance. Fairness applies when a slot frees.
- Scheduled (timed) tasks. The global scheduler is where they would later live.

## What exists today

| Area                    | Today                                                                                                                                                                                                                                                                                                                                                                                                                    | Source                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| Process                 | OpenCode boots the plugin once per location; one core per project (runtime, recorder, scheduler participant) in one process                                                                                                                                                                                                                                                                                              | `src/index.ts`, `src/core/core.ts`                                    |
| Database                | One file; 61 of 94 tables carry `project_directory`                                                                                                                                                                                                                                                                                                                                                                      | `src/storage.ts`, `src/database-schema.ts`                            |
| Project identity        | A stable project key already exists: the normalised default remote, else `root:<root commit>`, else `path:<dir>`. Tables `lazers_projects`, `lazers_project_aliases` (OpenCode project ids, remotes) and `lazers_project_paths` (checkout directories) map to it. Live rows: `github.com/thejustinwalsh/opencode-lazers`, `github.com/anomalyco/opencode` (the `opencode-native-settlement` checkout), `path:/Users/tjw` | `src/project-key.ts`                                                  |
| Scheduler               | One process timer; each project registers its `runtime.tick()` as an independent, non-overlapping drain group. Each tick decides only its own project's dispatch; nothing is shared between groups                                                                                                                                                                                                                       | `src/runner/scheduler-coordinator.ts`, `src/core/core.ts`             |
| References              | `LZ-<n>`, numbered per project                                                                                                                                                                                                                                                                                                                                                                                           | `src/storage.ts` (`task_references`)                                  |
| Session titles          | `LAZERS · <objective>`                                                                                                                                                                                                                                                                                                                                                                                                   | `src/runner/runtime.ts` (three call sites)                            |
| Panel scope             | Session or Project; both carry the asking session's id, and Project means that session's project                                                                                                                                                                                                                                                                                                                         | `src/observability/contract.ts` `ObservationScope`                    |
| Pause                   | Per-plan dispatch pause; per-project Architect-contact pause (stops notices, not workers); neither has a UI                                                                                                                                                                                                                                                                                                              | `runner_dispatch_controls`, `src/runner/architect-contact-machine.ts` |
| Per-project agent limit | In progress as LZ-200                                                                                                                                                                                                                                                                                                                                                                                                    | —                                                                     |
| Settings                | Plugin options read in `src/core/core.ts`; a LAZERS settings page exists                                                                                                                                                                                                                                                                                                                                                 | `src/gui.tsx`                                                         |

## Approaches considered

| Approach              | Order                                                                   | Why not / why                                                                                                                    |
| --------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| A. Identity first     | Codes → pause and limits model → all-projects views → global scheduling | Chosen. Views and scheduling both need to name projects; scheduling builds on LZ-200's limit, which has not landed               |
| B. Scheduler first    | Global limit and fairness → codes → views                               | Protects the machine earliest, but the owner would steer with no cross-project view, and it builds on LZ-200 before it is stable |
| C. Thin slice of each | Minimal codes, one list, one global limit, then deepen                  | Usable soonest, but each piece is revisited                                                                                      |

For fairness, plain round robin was rejected by the owner: it must account for
how long a project has been starved. See stage 4.

## Stage 1: project identity

**Project.** A project is the existing project key (`src/project-key.ts`,
`lazers_projects`). The code, pause, limit, weight and fair-share accounting all
hang off that key; nothing new is keyed by directory. Worktrees and checkouts
of one repository are one project. Owner decision (2026-11-20): follow OpenCode.
OpenCode identifies a git project from its history, not its disk location (its
`project.id` for this repository is the root commit `b5da4cad…`; the same
directory has carried two ids and its worktrees others, all of which
`lazers_project_aliases` already maps to one key). So two separate clones of
the same repository are one project: one code, one reference sequence, shown as
two checkouts under one heading.

Existing rows stay keyed by `project_directory`; reads resolve a directory to
its project through `lazers_project_paths`. The reference sequence becomes per
project key. No table is re-keyed.

**Code.** Each project has a stored code of 2 to 4 uppercase letters, a column
on `lazers_projects`.

- Generated once, when the project is first seen, from the project's name (the
  folder name of its first-seen checkout, which is the name the owner sees in
  OpenCode, not the remote's repository name): initials of its words
  (`opencode-native-settlement` → `ONS`), or the first letters of a one-word
  name (`runntime` → `RUN`). Leading generic words may be dropped when the
  result is still 2 or more letters (builder's call; record the rule).
- Unique across all projects in the database. On a clash, a number is appended
  (`ONS2`).
- Stored, never recomputed. Renaming or moving the folder does not change it.
- The owner can change it in Settings. A changed code applies to new references
  and titles; existing references keep resolving (see below).
- Migration: the existing project that owns the most references keeps `LZ`
  (today that is `opencode-lazers`, 251 of 255), so every existing `LZ-n` there
  stays valid. Other existing projects get generated codes.

**References.** `<CODE>-<n>`, numbered per project as today. A reference is
unique across projects because the code is. Existing rows are untouched for the
`LZ` project; for other existing projects the migration rewrites their
references to their new code and keeps the old `LZ-n` as an alias that resolves
only inside that project.

**Session titles.** `<CODE> · <text>` in place of `LAZERS · <text>`, for worker,
Architect continuation and renewal sessions. Notices to Architects name the
project code.

**Where it shows.** Tool results that print references, panel rows, bars,
branch and worktree names created from now on. Existing branches, commits, git
notes and documents are not rewritten.

## Stage 2: pause and limits model

**Pause.** One meaning at every level: no new work is dispatched; work already
running finishes; nothing is cancelled.

| Level   | Stops                                 | Exists today |
| ------- | ------------------------------------- | ------------ |
| Plan    | Dispatch of that plan's tasks         | Yes          |
| Project | Dispatch of every plan in the project | No (new)     |
| Global  | Dispatch in every project             | No (new)     |

The effective state is the strictest of the three. Each pause records who set
it, when and why, and optionally what lifts it. Project and global pause are
states in an XState machine alongside the existing dispatch-control machine; no
SQL-only transitions. The existing Architect-contact pause stays a separate
switch with its own label ("Architect contact"), because it stops notices, not
work.

**Controls.** A project row (in the all-projects view and in Settings) has a
pause toggle and shows why it is paused. A global pause sits in Settings and in
the all-projects header. Architects keep the per-plan pause tool; project and
global pause are owner controls.

**Settings levels.** Every setting has exactly one level.

| Global                                                                   | Project                                                                                                         |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Global slots, aging rate, history cache budget, price sources, retention | Project code, project limit, project weight, model assignments, Fallow config, spend ceiling, Architect contact |

## Stage 3: all-projects scope

**Scope.** `ObservationScope` gains `all`. Every panel offers Session, Project,
All projects.

| Panel      | In All projects                                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------------------ |
| Tasks      | Rows grouped under a project heading (code, name, state counts, pause control); filters and search apply across projects |
| Radar      | Every project's workers and queues; Flow and Map group nodes by project                                                  |
| Trajectory | Task picker grouped by project; a trajectory is still one task                                                           |
| Models     | Runs and costs across projects, with a project column and filter                                                         |

**Needs you.** One list across projects of everything waiting on the owner:
Architect questions, holds with owner actions, recovery bundles with no live
Architect. Each item names its project and opens it.

**Projects that are not loaded.** The shared database can show any project. A
project with no live location is marked as not loaded: it is readable, and
controls that need a live location (start, pause, answer) are not offered for
it. Opening the project in OpenCode makes them available.

**Reads.** All-projects reads page from the database by project and never
capture everything before the first row (same rule as the panel streaming
work, LZ-227 to LZ-230). Privacy and authorisation checks that are per session
today must hold per project in the combined view.

## Stage 4: global scheduling

**Slots.** One global pool of slots, counted. A slot is held by anything that
uses the machine heavily: a worker, a verification run (task or plan checks,
Fallow audit), an Architect takeover. A project also has its own limit (LZ-200).
Work starts only when the project is under its limit and a global slot is free.

**Choosing the project** when a global slot frees, among projects that have
ready work, are not paused and are under their own limit:

```ts
// lower score is served first
score(p) = slotsHeld(p) / weight(p) - waitingMs(p) / AGING_MS
waitingMs(p) = now - max(lastSlotGrantedAt(p), oldestReadySince(p))
```

- A project holding few slots for its weight goes before one holding many.
- Every minute a project waits with ready work moves it forward, so its wait is
  bounded.
- `weight` is a project setting, default 1.
- Within the chosen project the existing priority and dependency order pick the
  task.
- No pre-emption: running work is never stopped to rebalance.

**Tunables.**

| Setting                 | Level   | Default                                                               |
| ----------------------- | ------- | --------------------------------------------------------------------- |
| Global slots            | Global  | Measured on the owner's machine before a default is set               |
| Project limit           | Project | LZ-200's setting                                                      |
| Project weight          | Project | 1                                                                     |
| Aging rate (`AGING_MS`) | Global  | 10 minutes per slot of advantage; validated by replay before it ships |

**Visible reasons.** Each grant and each wait is recorded with its reason
(project limit reached, global limit reached, paused, next in line and for how
long). Tasks and Radar show it in place of a silent queue.

**Where it lives.** In the shared scheduler coordinator, which already runs
every project's tick in one process. Slot accounting is durable (in the shared
database) so a restart or a second OpenCode process sees the same counts. States
and transitions for slot grants follow the repository rule: XState, every
non-terminal state has an exit, a slot held by work that has ended is released
by reconciliation.

## Calls made by the author (owner to check)

1. **Settings store.** Project and global settings named above are stored in
   the database and edited in Settings. Plugin options remain as the defaults
   for a value that has never been set in the UI; a UI value wins.
2. **Who may view All projects.** Any session in any project may view every
   project's tasks, workers and waiting items. This is a single-owner tool on
   one machine; there is no per-project access control.
3. **Projects that are not loaded** are left out of scheduling entirely. They
   hold no slots and accrue no waiting time, so they cannot starve loaded
   projects. Project and global pause are stored in the database, so they apply
   to a project the moment it is loaded.
4. **What a slot is.** One task holds one slot from dispatch until its
   verification ends (worker, repair, checks and Fallow audit in turn, never two
   at once). A plan-level check holds one slot. An Architect takeover holds the
   task's slot. The project limit counts the same slots.
5. **How slots are granted.** Every start asks a slot allocator to acquire and
   every end releases; the allocator applies the scoring rule. Slots are leased
   rows in the shared database with a heartbeat, modelled on the runtime's
   existing claim, so a crash or a second OpenCode process cannot leak or
   double-count them.
6. **LZ-200.** Stage 4 may change LZ-200's limit to count slots as defined
   here once LZ-200 is integrated; its contract is read from the integrated
   code, not assumed.
7. **Old references in free text** (commits, git notes, Architect journals,
   documents) are not rewritten. An old `LZ-n` for a re-coded project resolves
   only through the reference lookup inside that project.

## Dependencies on work in flight

- LZ-200 (per-project concurrency limit) must be integrated before stage 4.
- LZ-227 to LZ-230 (panel streaming) and stage 3 touch the same read paths;
  stage 3 follows them or is planned with them.
- The retention purge and the storage section in Settings should be per project
  and all projects.

## Left to the builder

- The exact name-to-code rule and its test table.
- The storage shape for codes, aliases, project and global pause, and slot
  accounting.
- How panels lay out project headings within the existing kit and the
  details-pane rules (noun labels, theme-derived colours, omit what is absent).
- How the global slot default is measured.

## Acceptance, per stage

1. Two projects open: their references and session titles differ by code; a
   clash produces a numbered code; a renamed folder keeps its code; every
   existing `LZ-n` still resolves.
2. Pausing a project stops new dispatch there and nowhere else; running work
   finishes; the UI shows who paused it and why; global pause stops all.
3. With three projects, every panel in All projects shows all three grouped;
   Needs you lists items from each; a project that is not loaded is readable
   and offers no live controls.
4. With a global limit below total demand, no project waits longer than a
   bounded time while another holds more than its share; a replay over recorded
   history and a simulated ten-project load shows it; Radar shows why each
   queued task waits.
