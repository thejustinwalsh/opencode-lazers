# Many Projects In One OpenCode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Projects are told apart by a short code, can be paused and limited individually and globally, can be viewed together in every panel, and share the machine fairly.

**Architecture:** Everything hangs off the existing project key (`src/project-key.ts`, table `lazers_projects`); no table is re-keyed. Stage 1 adds a stored code per project and uses it in references and session titles. Stage 2 adds project and global dispatch pause plus a database-backed settings store with two levels. Stage 3 adds an `all` observation scope to the panels. Stage 4 adds a leased slot allocator with least-served-first scoring. Stages 1 to 3 are independent of the panel-streaming work; stage 4 is gated on work in flight.

**Tech Stack:** Strict TypeScript, Bun (`bun:sqlite`, `bun test`), XState `lifecycleMachines`, zod, SolidJS panels, OpenCode plugin API (pinned V2).

**Spec:** `design/multi-project.md`

## Global Constraints

- A project is the existing project key. Two clones of one repository are one project (owner decision, 2026-11-20).
- Code: 2 to 4 uppercase letters, stored on `lazers_projects`, generated once from the folder name of the first-seen checkout, unique across the database, a number appended on a clash, never recomputed, owner-editable.
- The existing project that owns the most references keeps `LZ`.
- Reference format `<CODE>-<n>`; sequence per project key. Session titles `<CODE> · <text>`.
- Pause means: no new dispatch; running work finishes; nothing is cancelled. Effective state is the strictest of plan, project, global.
- Workflow states and transitions only in XState; no SQL-only transitions; every non-terminal state has an exit.
- Global slot count and fairness are counts tuned by hand; no pre-emption; no CPU or memory back-off.
- No cross-project task dependencies. No per-project database. No reload-safety feature.
- Labels are one- or two-word nouns; theme-derived colours only; omit what is absent; never the word "unknown".
- Commits: atomic Conventional Commits, plain `git commit`, no identity overrides, no AI or `Co-Authored-By` trailers, signing as configured. Never rebase; merge only.
- Gates for every task: `bun run verify`, the task's tests, `bun run build`. Never run a suite while the product has a verification running (`bun scripts/reload-safe.ts`).
- Never touch the running OpenCode service or write to its database; tests use temporary databases.

## Review Focus

1. Two existing projects generate the same code (for example two folders named `app`): the second gets `APP2`, and neither changes on restart.
2. A project whose folder name has no letters, one letter, or non-ASCII characters still gets a valid 2 to 4 letter code.
3. An old `LZ-n` typed for a project that was re-coded resolves inside that project and does not resolve to another project's task.
4. A project paused while it has running workers: the workers finish and are verified; nothing new starts; unpausing dispatches again without a restart.
5. Global pause set while one project is not loaded: that project is paused the moment it loads.

---

## File Structure

| File                                                | Responsibility                                                                 |
| --------------------------------------------------- | ------------------------------------------------------------------------------ |
| `src/projects/code.ts` (new)                        | Pure code generation from a name, clash resolution                             |
| `src/projects/registry.ts` (new)                    | Read and write project rows: code, name, set-code; resolve directory → project |
| `src/projects/settings.ts` (new)                    | Two-level settings store (global, project) with plugin-option defaults         |
| `src/projects/pause-machine.ts` (new)               | XState machine for project and global dispatch pause                           |
| `src/projects/rpc.ts`, `src/projects/gui.tsx` (new) | `lz.projects` RPC; Projects section in LAZERS Settings                         |
| `src/project-key.ts`                                | Schema generation 2: `code`, `name` columns; migration                         |
| `src/storage.ts`                                    | Reference allocation and lookup use the project code                           |
| `src/runner/runtime.ts`                             | Three session-title sites; dispatch consults effective pause                   |
| `src/runner/store.ts`                               | Effective-pause read joins project and global pause                            |

Stage 3 and 4 files are named in their tasks.

---

## Stage 1: project identity

### Task 1: Code generation

**Files:**

- Create: `src/projects/code.ts`
- Test: `src/projects/code.test.ts`

**Interfaces:**

- Produces: `projectCodeFrom(name: string): string` (2 to 4 uppercase A–Z); `uniqueProjectCode(base: string, taken: ReadonlySet<string>): string`.

- [ ] **Step 1: Write the failing tests**

```ts
test.each([
  ["opencode-native-settlement", "ONS"],
  ["opencode-lazers", "OL"],
  ["runntime", "RUN"],
  ["three-flatland", "TF"],
  ["thejustinwalsh.github.io", "TGI"],
  ["a", "AX"],
  ["42", "PX"],
  ["héllo wörld", "HW"],
  ["one two three four five", "OTTF"],
])("projectCodeFrom(%s) is %s", (name, code) => expect(projectCodeFrom(name)).toBe(code))

test("a clash appends the lowest free number", () => {
  expect(uniqueProjectCode("APP", new Set())).toBe("APP")
  expect(uniqueProjectCode("APP", new Set(["APP"]))).toBe("APP2")
  expect(uniqueProjectCode("APP", new Set(["APP", "APP2"]))).toBe("APP3")
})
```

- [ ] **Step 2: Run** `bun test src/projects/code.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement both functions.** Rule: split the name on any run of non-letters after folding diacritics to ASCII; with two or more words take each word's first letter, at most four; with one word take its first three letters; pad a one-letter result with `X`; a name with no letters yields `PX`.
- [ ] **Step 4: Run** the test — expect PASS.
- [ ] **Step 5: Commit** `feat(projects): generate a short code from a project name`.

### Task 2: Store the code on the project

**Files:**

- Modify: `src/project-key.ts` (`installProjectSchema`, `registerProject`), `src/database-schema.ts` (`projects.generation` 1 → 2)
- Create: `src/projects/registry.ts`
- Test: `src/projects/registry.test.ts`, `src/project-key.test.ts`

**Interfaces:**

- Consumes: `projectCodeFrom`, `uniqueProjectCode`.
- Produces:
  - `type ProjectRow = { key: string; code: string; name: string; paths: string[] }`
  - `projectForDirectory(repository: TaskRepository, directory: string): ProjectRow | undefined`
  - `projects(repository: TaskRepository): ProjectRow[]`
  - `setProjectCode(repository: TaskRepository, key: string, code: string): void` (throws `PROJECT_CODE_INVALID` unless `/^[A-Z]{2,4}\d*$/`; throws `PROJECT_CODE_TAKEN` on a clash)

- [ ] **Step 1: Write the failing tests** (temporary database):
  - A newly registered project at `/tmp/x/opencode-native-settlement` has code `ONS` and name `opencode-native-settlement`.
  - A second project whose folder is also `opencode-native-settlement` (different remote) gets `ONS2`.
  - Reopening the database and registering again keeps both codes.
  - Registering the first project from a second path (a clone of the same remote) keeps one row, one code, two `paths`.
  - Migration from generation 1 with three existing projects, one owning 251 references and the others 2 each: the first gets `LZ`; the others get generated codes.
  - `setProjectCode` rejects `"lz"`, `"TOOLONG"`, and a code another project holds.
- [ ] **Step 2: Run** the tests — expect FAIL.
- [ ] **Step 3: Implement.** Add `code TEXT` and `name TEXT` to `lazers_projects` with a unique index on `code`; the generation-2 migration assigns `LZ` to the project with the most rows in `task_references` (joined through `lazers_project_paths`), then generates the rest in `created_at` order. `registerProject` assigns a code only when the row has none.
- [ ] **Step 4: Run** the tests — expect PASS.
- [ ] **Step 5: Commit** `feat(projects): store a unique code and name per project`.

### Task 3: References carry the code

**Files:**

- Modify: `src/storage.ts` (reference allocation near the `task_references` insert; the legacy backfill near line 179; reference lookup), `src/tasks/panel.tsx`, `src/radar/monitor-model.ts`, `src/radar/flow-model.ts`, `src/trajectory-panel/details-body.tsx`, `src/runner/recovery-bundle.ts` (each has a literal `LZ-` pattern)
- Test: `src/storage.test.ts`, `src/projects/references.test.ts` (new)

**Interfaces:**

- Consumes: `projectForDirectory`.
- Produces: `TaskRepository.reference(taskID)` returns `<CODE>-<n>`; `TaskRepository.resolveReference(text: string): string | undefined` returns a task id for the project's current code, for an alias, case-insensitively; `REFERENCE_PATTERN: RegExp` (`/\b[A-Z]{2,4}\d*-\d+\b/`) exported from `src/projects/code.ts` and used by every former literal `LZ-` match.

- [ ] **Step 1: Write the failing tests:**
  - A new task in a project coded `ONS` is `ONS-1`; the next is `ONS-2`.
  - Two checkouts of one project share one sequence: a task from the second path is `ONS-3`.
  - In the `LZ` project, existing `LZ-200` still resolves and the next new task continues its sequence.
  - After `setProjectCode(key, "NS")`, new tasks are `NS-n`, `resolveReference("ONS-1")` and `resolveReference("ons-1")` still return the first task, and in another project `resolveReference("ONS-1")` is `undefined`.
  - For a migrated non-`LZ` project, `resolveReference("LZ-1")` returns its first task inside that project only.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement.** Add `task_reference_aliases(project_key, alias, task_id)`; on code change and on migration, insert the old reference as an alias. Sequence is `MAX(sequence)+1` over every path of the project key. Replace literal `LZ-` matching in the listed files with `REFERENCE_PATTERN`.
- [ ] **Step 4: Run** the new tests plus `bun test src/storage.test.ts src/tasks src/radar src/trajectory-panel` — expect PASS.
- [ ] **Step 5: Commit** `feat(projects): task references use the project code`.

### Task 4: Session titles and notices carry the code

**Files:**

- Modify: `src/runner/runtime.ts` (title sites near lines 5858, 6535, 9840), `src/runner/outcome.ts` (notice heading)
- Create: `src/runner/session-title.ts`
- Test: `src/runner/session-title.test.ts`, one assertion each in the existing runtime tests that check a title

**Interfaces:**

- Produces: `sessionTitle(code: string, text: string): string` → `` `${code} · ${text}` `` cut to 120 characters.

- [ ] **Step 1: Write the failing tests:** `sessionTitle("ONS", "Fix the parser")` is `"ONS · Fix the parser"`; a 300-character text yields 120 characters; a worker session, an Architect continuation and a renewal created by a runtime whose project is coded `ONS` have titles starting `ONS · `; an Architect notice names `ONS`.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** and replace the three `LAZERS · ` literals.
- [ ] **Step 4: Run** `bun test src/runner/session-title.test.ts src/runner/runtime.test.ts` — expect PASS.
- [ ] **Step 5: Commit** `feat(projects): session titles and notices start with the project code`.

---

## Stage 2: pause and limits model

### Task 5: Two-level settings store

**Files:**

- Create: `src/projects/settings.ts`
- Modify: `src/database-schema.ts` (new module `projectSettings`), `src/core/core.ts` (read through the store)
- Test: `src/projects/settings.test.ts`

**Interfaces:**

- Produces:
  - `type GlobalSettings = { globalSlots: number | null; agingMs: number; historyCacheMB: number }`
  - `type ProjectSettings = { limit: number | null; weight: number; spendCeilingTokens: number | null }`
  - `globalSettings(repository, defaults: Partial<GlobalSettings>): GlobalSettings`
  - `projectSettings(repository, key: string, defaults: Partial<ProjectSettings>): ProjectSettings`
  - `setGlobalSetting<K extends keyof GlobalSettings>(repository, name: K, value: GlobalSettings[K] | undefined): void` and `setProjectSetting` likewise; `undefined` clears the stored value.
- Defaults when neither stored nor passed: `agingMs` 600_000, `weight` 1, `historyCacheMB` 128, the rest `null`.

- [ ] **Step 1: Write the failing tests:** a stored value wins over a passed default; a cleared value falls back to the default; project settings of one key do not leak to another; `weight` rejects 0 and negatives; `globalSlots` rejects 0.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** with one table `lazers_settings(scope TEXT, name TEXT, value TEXT, updated_at, PRIMARY KEY(scope, name))` where `scope` is `global` or the project key, values JSON-encoded and zod-validated on read and write. `core.ts` passes plugin options as defaults for `historyCacheMB` and `workerSpendCeilingTokens`.
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `feat(projects): database-backed global and project settings with option defaults`.

### Task 6: Project and global pause

**Files:**

- Create: `src/projects/pause-machine.ts`
- Modify: `src/runner/lifecycle-machines.ts` (register), `src/runner/store.ts` (table, effective-pause read near the `runner_dispatch_controls` reads at ~1164 and ~3565), `src/runner/runtime.ts` (dispatch gate), `design/runtime-state-machines.md`
- Test: `src/projects/pause.test.ts`, `src/runner/runtime.test.ts`

**Interfaces:**

- Produces:
  - `type PauseScope = { kind: "global" } | { kind: "project"; key: string }`
  - `setPause(store, scope: PauseScope, input: { paused: boolean; reason: string; by: string }): void`
  - `effectivePause(store, planID: string): { level: "plan" | "project" | "global"; reason: string; by: string; at: number } | undefined` — the strictest that applies, global before project before plan.
  - Transition events `PROJECT_DISPATCH_PAUSED`, `PROJECT_DISPATCH_UNPAUSED`, `GLOBAL_DISPATCH_PAUSED`, `GLOBAL_DISPATCH_UNPAUSED`.

- [ ] **Step 1: Write the failing tests:**
  - With a project paused, a ready task in it is not dispatched over five ticks; a ready task in a second project is.
  - A worker already running in the paused project finishes, is verified and accepted.
  - Unpausing dispatches the ready task on the next tick.
  - Global pause stops dispatch in both projects; `effectivePause` reports `global`.
  - A plan paused, in a project paused, under global pause, reports `global`; clearing global reports `project`; clearing project reports `plan`.
  - Global pause set, then a project registered afterwards: its first tick dispatches nothing.
  - The machine rejects `UNPAUSE` from `enabled`; the dead-ends test lists the machine.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement.** One machine `dispatch-pause` (`enabled` ⇄ `paused`) used for both scopes; table `lazers_dispatch_pause(scope TEXT PRIMARY KEY, state, reason, by, updated_at)` with `scope` `global` or the project key. The dispatch gate asks `effectivePause` where it reads the plan pause today; the held reason shown for a task names the level.
- [ ] **Step 4: Run** the new tests and `bun test src/runner/runtime.test.ts src/runner/recovery-bundle.test.ts` — expect PASS.
- [ ] **Step 5: Commit** `feat(projects): pause dispatch for one project or for all`.

### Task 7: Projects in Settings

**Files:**

- Create: `src/projects/rpc.ts`, `src/projects/gui.tsx`, `test/projects-settings/settings.test.tsx`
- Modify: `src/index.ts` (register `lz.projects`), `src/gui.tsx` (add the section to the LAZERS settings page)

**Interfaces:**

- Consumes: `projects`, `setProjectCode`, `projectSettings`, `setProjectSetting`, `globalSettings`, `setGlobalSetting`, `setPause`, `effectivePause`.
- Produces: RPC `lz.projects` with `list()`, `setCode({ key, code })`, `setPause({ scope, paused, reason })`, `setSetting({ scope, name, value })`.

- [ ] **Step 1: Write the failing DOM tests:** the section lists each project by code and name with its checkouts; the row for a paused project shows who paused it and the reason; toggling a row's pause calls `setPause` for that key only; a global pause switch calls `setPause` with `{ kind: "global" }`; editing a code to one already taken shows the refusal and keeps the old code; limit and weight fields save on change.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** with the existing settings kit. Section label `Projects`. Row: code, name, state label (`Paused` when paused), pause switch, limit, weight. Header: `Pause all` switch.
- [ ] **Step 4: Run** the DOM tests and `bun run build:gui` — expect PASS.
- [ ] **Step 5: Commit** `feat(projects): manage codes, pause and limits in Settings`.

---

## Stage 3: all-projects scope

The owner lifted the gate on panel streaming (LZ-227 to LZ-230): stage 3 builds on the current read path and does not wait for or depend on streaming. Pages here are small enough that a streaming transport can carry them later unchanged.

### Task 8: `all` scope in the observation contract and reads

**Files:**

- Create: `src/projects/scope.ts`, `src/projects/scope.test.ts`, `src/projects/read-access.ts`
- Modify: `src/observability/contract.ts`, `src/observability/read.ts`, `src/observability/changes.ts` (a boundary that does not observe), `src/observability/rpc.ts`, `src/observability/task-reads.ts`, `src/tasks/read.ts`, `src/tasks/contract.ts`, `src/tasks/rpc.ts`, `src/projects/rpc.ts` (use the shared `loaded` test), `src/index.ts` and `src/core/core.ts` (pass `loadedProjectDirectories` to the reads)
- Test: `src/projects/scope.test.ts`, `src/observability/all-projects.test.ts`, `src/observability/task-reads.test.ts` (additions), `src/observability/rpc.test.ts` (additions)

**How the code works today (checked 2026-11-20):**

- Every table is partitioned by `project_directory` (a checkout path). `TaskRepository(path, projectDirectory)` is one checkout's view of the shared database; `ObservationReads` and `TaskReads` are bound to the repository of the location that loaded them. A project (key) owns one or more checkouts in `lazers_project_paths`.
- Observation RPCs authorise through `authorize()` in `src/observability/rpc.ts`: the session must exist, belong to this process's OpenCode project and have an agent, then `permission.assert({ action: "read", resources: [projectDirectory] })`. `Tasks.query` and `Tasks.get` do no authorisation today; they trust the Desktop caller of this process's own project.
- Live locations: `loadedProjectDirectories()` in `src/core/registry.ts` lists the project roots with a live core in this process (the registry lives on `globalThis`, so it covers every location the OpenCode server loaded). `listProjects` in `src/projects/rpc.ts` already sets `loaded` as "any checkout path equals a live directory after `realpath`". Task 8 extracts that test and reuses it; it adds no second definition.

**Interfaces:**

- Produces, in `src/projects/scope.ts`:

```ts
export const ProjectRef = z.strictObject({
  key: z.string().min(1),
  code: z.string().min(2).max(6),
  name: z.string(),
  loaded: z.boolean(),
})
export type ProjectRef = z.infer<typeof ProjectRef>
/** One checkout of one project: the unit a page reads. */
export type ProjectUnit = { project: ProjectRef; directory: string }
export function isLoaded(paths: readonly string[], live: ReadonlySet<string>): boolean
export function liveDirectories(loaded: () => Iterable<string>): Set<string> // canonical paths
/** Registry order (created_at, key), then checkout order; a project with no checkout has no unit. */
export function projectUnits(repository: TaskRepository, loaded: () => Iterable<string>): ProjectUnit[]
/** Cursor of the NEXT page: the unit to read and, inside it, that read's own cursor. */
export type UnitCursor = { directory: string; inner?: string }
export function encodeUnitCursor(cursor: UnitCursor): string // base64url JSON, version-tagged
export function decodeUnitCursor(value: string): UnitCursor // throws `Invalid project cursor`
export function unitIndex(units: readonly ProjectUnit[], cursor?: UnitCursor): number
```

- Produces, in `src/observability/contract.ts`:
  - `ObservationScope` gains `{ kind: "all"; sessionID }`; `ObservationScopeView` gains `{ kind: "all" }`.
  - `ObservationPlan` and `UnplannedTask` gain `project: ProjectRef.optional()`; `TopologyOutput` gains `project: ProjectRef.optional()` and `nextCursor: z.string().nullable().optional()`; `TopologyInput` gains `cursor: z.string().min(1).max(2048).optional()`, valid only with `kind: "all"`.
  - Under `all`, `project` is set on the page, on every plan and on every unplanned task. Under `session` and `project` it is absent, so those outputs are byte-for-byte what they were.
  - Every other observation method (`snapshot`, `radar`, `liveRadar`, `liveGroup`, `liveAttempt`, `liveHistory`, `trajectory`, `trajectoryHistory`, `trajectoryStatus`, `progressDiagnostics`) refuses `all` with `All-projects scope is not available for this read` until its own task lands (see "Not in this task"). Internals take `SingleScope = Exclude<ObservationScope, { kind: "all" }>`, so the compiler finds every place that would have mistaken `all` for a session.
- Produces, in `src/tasks/contract.ts`: `QueryInput` gains `allProjects: z.literal(true).optional()`; with it `sessionID` names the caller for authorisation and is not a filter, and `cursor` is a `UnitCursor`. `QueryOutput` gains `project: ProjectRef.optional()` (the page's project); `TaskSummary` gains `project: ProjectRef.optional()`; `projectDirectory` is the unit's checkout.
- Produces, in `src/projects/read-access.ts`:

```ts
/** Units the caller may read: its own project always (after the existing session checks), another
 *  project only when `permission.assert({ action, resources: that project's checkouts })` passes. */
export async function readableUnits(
  assertRead: (resources: string[]) => Promise<boolean>,
  units: readonly ProjectUnit[],
): Promise<ProjectUnit[]>
```

**Authorisation (decided; conservative).** `all` is the union of what the caller could already read, never more. The RPC first runs today's session checks unchanged (session exists, belongs to this process's OpenCode project, has an agent). It then asks `permission.assert` once per project with that project's checkouts as `resources`, the same `read` action the `project` scope uses; a project whose assertion fails is left out of every page and of every cursor, with no error and no hint that it exists. The caller's own project is always asserted exactly as `project` scope asserts it, and a failure there fails the read as it does today. `Tasks.query` under `all` gets the same session and permission checks (the plain `Tasks.query` stays as it is). The assertion repeats on every page, so a revoked permission takes effect at the next page. The permission service may turn an assertion into a prompt; if it does, the owner sees one prompt per project the first time `all` is opened, and that is the cost of not widening access silently.

**Paging.** A page is one checkout of one project, in registry order. The cursor names the next unit and, for tasks, the inside cursor of that unit's own paged read, so a long project continues across pages and a short one ends its page. The first page has no cursor and never waits for later projects. A task page skips a checkout with no matching tasks instead of returning an empty page; the last page has `nextCursor: null`. There is no limit on the number of projects or checkouts and no truncation: the page size per project is the existing `limit` (tasks) or one checkout (topology). A cursor that names a checkout no longer allowed or registered fails with `Invalid project cursor`; the panel restarts from the first page.

- [ ] **Step 1: Write the failing tests** (temporary database, three projects registered with `registerProject`, codes `AAA`, `BBB`, `CCC`, one task and one plan in each; `loaded` returns the directories of `AAA` and `BBB` only):
  - `projectUnits` lists the units in registry order with the right codes; `AAA` and `BBB` are `loaded: true`, `CCC` is `loaded: false`; a project with two checkouts yields two units that share one `ProjectRef`.
  - `topology({ kind: "all" })` first page is `AAA`'s plans with `project.code` `AAA` on the page, each plan and each unplanned task; following `nextCursor` reaches `BBB` then `CCC` (`loaded: false`) and ends with `null`.
  - The pages of the three projects together hold every plan exactly once; no plan of one project appears under another's `project`.
  - `queryAll` over the three projects returns each project's tasks with the right `reference` prefix and `project`; paging with `limit: 1` over a project with three tasks returns them across three pages, then moves to the next project.
  - A project with a plan owned by another session appears under `all` regardless of the caller's session (all means project-wide, never session-filtered), and `session` and `project` scopes return the same JSON as before for the same database (compare against a recorded copy of today's output).
  - A project the permission check refuses is absent from the pages and from cursors; a cursor naming it is refused; the caller's own project failing fails the read.
  - A cursor edited to another unit's directory is refused when that unit is not allowed.
  - Every other observation method called with `all` throws `All-projects scope is not available for this read`.
  - `loaded` is not a snapshot: a project whose location registers between two pages is `loaded: true` on the later page.
- [ ] **Step 2: Run** the new files — expect FAIL.
- [ ] **Step 3: Implement** `scope.ts` first (pure, tested alone), then the contract, then `ObservationReads.topologyAll(input, tracker, units)` which reads one unit through the existing `loadTopologySource` and `projectTopology` with `{ kind: "project", sessionID }` over that unit's directory (same connection, no second code path), stamps rows with the project, and builds the boundary with a new `tracker.boundaryFor(stamp)` that does not observe a foreign stamp. Then `AssociationTaskReads.queryAll(input, units)` which opens a `TaskRepository` for the unit's directory (closed in `finally`), runs today's `query` on it, and stamps `project`. Then `readableUnits` and the two RPC handlers. Core wires `loadedProjectDirectories` in as the `loaded` source of the reads.
- [ ] **Step 4: Run** the new tests plus `bun test src/observability src/tasks src/projects` (only after `bun scripts/reload-safe.ts` prints `safe to reload: yes`) — expect PASS with no existing test edited, except where a row legitimately gains `project`.
- [ ] **Step 5: Commit** `feat(projects): read plans and tasks across all projects, a page per checkout`.

**Not in this task (read paths that follow, each with the same `project` stamp, the same `readableUnits` gate and the same unit cursor):**

- `liveRadar` and `liveGroup` for Radar and Map: workload counts, queued and held groups per project, using `workload` per unit; native session inventory is per OpenCode project, so a project that is not loaded contributes its recorded runner rows and no native sessions, and the response says so with `loaded: false`.
- Trajectory picker: a read that lists tasks (reference, title, state) per project for the picker; a trajectory itself stays one task, opened by `taskID` with the owning project's directory.
- Models: its own scope (`{ projectDirectory }` in `src/models/server.ts`) gains `all`, with a project column on runs and costs.
- `Tasks.get` and `currentActivity` for a task of another project: the panel opens them with the owning project's checkout.

### Task 9: Tasks, Radar, Trajectory and Models grouped by project

**Files:**

- Create: `src/projects/group-view.ts`, `src/projects/group-view.test.ts`, `src/projects/group-heading.tsx`
- Modify: `src/tasks/panel.tsx` (scope type at `PanelPrefs.scope`, the menu near line 1767, the query and topology calls near 420 to 500), `src/tasks/panel-state.ts`, `src/tasks/panel-view.ts`, `src/gui.tsx` (the per-project scope maps used by `openTask` and `openTaskTrajectory`), `src/radar/monitor-transport.ts`, `src/radar/monitor-model.ts`, `src/radar/monitor-view.tsx`, `src/trajectory-panel/*` (another agent owns those files at the moment; coordinate before editing), `src/models/*`
- Test: `src/projects/group-view.test.ts`, DOM tests beside each panel

**Interfaces:**

- Consumes: `ProjectRef`, the `all` read contract of Task 8 and the reads listed under "Not in this task", `lz.projects` `setPause` and `list` from Task 7.
- Produces:

```ts
export type ProjectGroup<Row> = { project: ProjectRef; rows: Row[]; counts: Record<string, number> }
/** Appends a page to the groups, in page order; a project appears once however many pages carry it. */
export function appendPage<Row>(groups: ProjectGroup<Row>[], page: { project?: ProjectRef; rows: Row[]; counts?: Record<string, number> }): ProjectGroup<Row>[]
```

- Scope menu: `Session`, `Project`, `All projects`. The stored preference per panel becomes `"session" | "project" | "all"`; an old stored value keeps its meaning. `all` is global, not per project, so `PanelPrefs` for it is stored once (key `all`), not under a project directory.

- [ ] **Step 1: Write the failing tests:** `appendPage` merges a second page of one project into its group and keeps first-seen order; a group carries code, name and counts from the first page that has them; the heading shows `CODE`, name, the counts as one- or two-word nouns, and `Paused` when the project's pause record is set; a `loaded: false` group shows no start, pause, answer or steer control and its rows are read-only; filters and search apply to every project (the search string is sent with every page); the Tasks panel in `all` requests pages until the list is full and continues on scroll, never fetching every project before the first row; switching scope away from `all` and back keeps the filter.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** the pure helper first, then the Tasks panel (grouped list; the pause switch on a heading calls `lz.projects` `setPause` for that key), then Radar (Flow and Map nodes grouped by project, queue counts per project), Trajectory (picker grouped by project), Models (a project column and a project filter). Every `loaded: false` group omits live controls; opening a row of another project opens its detail from that project's checkout (`Tasks.get` with the owning directory). Labels are the nouns in `Global Constraints`; no row says `unknown`.
- [ ] **Step 4: Run** the DOM tests and `bun run build:gui` — expect PASS.
- [ ] **Step 5: Commit** one panel per commit, `feat(tasks): group the Tasks panel by project in All projects`, and likewise for radar, trajectory and models.

**Owner decisions needed before Task 9:** whether the `all` scope preference is remembered per Desktop session or globally; whether a group of a project that is not loaded starts collapsed; whether Models' project filter defaults to every project or to the current one.

### Task 10: Needs you, across projects

**Files:**

- Create: `src/projects/needs-you.ts`, `src/projects/needs-you.test.ts`
- Modify: `src/projects/contract.ts` (`needsYou` method), `src/projects/rpc.ts`, `src/projects/gui.tsx` or a new `src/projects/needs-you.tsx` (the list), `src/gui.tsx` (entry point), `src/radar/monitor-model.ts` (the `needs you` count reads the same function)
- Test: `src/projects/needs-you.test.ts`, a DOM test for the list

**Interfaces:**

- Consumes: `projectUnits`, `readableUnits`, `ProjectRef`, `unit cursor`.
- Produces:

```ts
export type NeedsYouItem = {
  project: ProjectRef
  kind: "architect-question" | "owner-hold" | "recovery-bundle"
  id: string // question id, plan or task id, bundle id
  title: string
  since: number // epoch ms
  taskReference?: string // `<CODE>-<n>`
  action?: "answer" | "steer" | "resume"
}
export function needsYou(repository, units: readonly ProjectUnit[], cursor?: UnitCursor): { items: NeedsYouItem[]; nextCursor: string | null }
```

- A page is one unit; the list the panel shows is the concatenation of pages, sorted by `since` within a project and projects in registry order. Items of a `loaded: false` project carry no `action`; the row says `Open project` and nothing more.
- Sources, each a read of recorded rows: open Architect forms and questions recorded for the checkout; plan and task nodes held for an owner action (the rows `LiveWorkload.needsYou` counts); recovery bundles whose Architect session is gone (`src/recovery/handoff`). Each source function already exists for one checkout; Task 10 calls them per unit and adds no new state or transition.

- [ ] **Step 1: Write the failing tests:** three projects, one item of each kind in different projects, one project not loaded: the pages together hold every item once with the right project and code; the item of the unloaded project has no `action`; an item answered or resolved disappears on the next read; a project the caller may not read contributes nothing; opening an item names the project and the checkout to open (the answer path is unchanged: it goes through the project's own Architect-contact RPC, not through the combined read).
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** the three sources per unit, the RPC `lz.projects.needsYou({ sessionID, cursor })` behind `readableUnits`, and the list in the GUI.
- [ ] **Step 4: Run** the tests and `bun run build:gui` — expect PASS.
- [ ] **Step 5: Commit** `feat(projects): one Needs you list across projects`.

**Owner decisions needed before Task 10:** where the list lives (a Projects tab, the Tasks panel header, or a status bar count); whether an item of an unloaded project can be answered in place by starting its location, or only opened; whether an Architect-contact pause hides that project's questions or shows them marked `Paused`.

## Stage 4: global scheduling (gated)

Starts after LZ-200 is integrated; its limit contract is read from the integrated code.

### Task 11: Leased slots

New `src/runner/slots.ts`: `acquire(store, { projectKey, holder, kind: "task" | "plan-check" | "takeover" }): boolean`, `release(store, holder)`, `reconcile(store, now)` releasing leases whose heartbeat is older than the runtime's claim window. Table `lazers_slots`. A task holds one slot from dispatch until its verification ends.

### Task 12: Least-served-first selection

New `src/runner/fair-share.ts`, pure:

```ts
export function nextProject(
  candidates: readonly {
    key: string
    slotsHeld: number
    weight: number
    waitingMs: number
  }[],
  agingMs: number,
): string | undefined
// lowest slotsHeld / weight - waitingMs / agingMs; ties by longest waitingMs, then key
```

Tests: the worked example in the spec (A holds 3, B waiting 20 minutes, C just ready → B, then C); a project never waits longer than `agingMs * (totalSlots + 1)` in a simulated ten-project load; weight 2 receives about twice the grants of weight 1 over 1,000 grants; projects that are paused, not loaded, or at their own limit are never returned.

### Task 13: Wire the allocator into dispatch, verification and takeover; record and show reasons

Every start acquires and every end releases; each grant and wait is recorded with its reason and shown in Tasks and Radar.

### Task 14: Replay and default

A read-only replay script measures peak concurrent slots and check-suite duration on recorded history, and proposes the `globalSlots` default; the default ships only with that measurement written beside it.

---

## Self-review

- Spec coverage: stage 1 → Tasks 1–4; pause, levels and controls → Tasks 5–7; all-projects scope, not-loaded projects, Needs you → Tasks 8–10; slots, scoring, tunables, reasons → Tasks 11–14. Retention per project is noted in the spec as a dependency and belongs to the retention branch.
- Review Focus lines 1–3 are pinned in Tasks 1–3, line 4 and 5 in Task 6.
- Stages 3 and 4 are outlines by design: their code will have changed before they start.
