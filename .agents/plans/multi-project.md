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
- Modify: `src/observability/contract.ts`, `src/observability/read.ts`, `src/observability/changes.ts` (a boundary that does not observe), `src/observability/rpc.ts`, `src/observability/task-reads.ts`, `src/tasks/read.ts`, `src/tasks/contract.ts`, `src/tasks/rpc.ts`, `src/projects/rpc.ts` (use the shared `loaded` test). `src/index.ts` needs no change: both RPCs default their `loaded` source to `loadedProjectDirectories`.
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
export function projectUnits(
  repository: TaskRepository,
  loaded: () => Iterable<string>,
): ProjectUnit[]
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
  - Every other read takes `all` as Task 8b lists; internals that read one project take `SingleScope = Exclude<ObservationScope, { kind: "all" }>` and `singleScope()` refuses `all` for any read that has no all-projects form.
- Produces, in `src/tasks/contract.ts`: `QueryInput` gains `allProjects: z.literal(true).optional()`; with it `sessionID` names the caller for authorisation and is not a filter, and `cursor` is a `UnitCursor`. `QueryOutput` gains `project: ProjectRef.optional()` (the page's project); `TaskSummary` gains `project: ProjectRef.optional()`; `projectDirectory` is the unit's checkout.
- Produces, in `src/projects/read-access.ts`:

```ts
/** Session checks only: the session exists, belongs to this OpenCode project and has an agent.
 *  No permission is asserted. Returns every registered checkout in registry order. */
export async function allProjectsAccess(ctx, input): Promise<UnitAccess> // UnitAccess = { units }
```

**Who is calling (checked in the code, 2026-11-20).** The two callers are told apart by how a read is registered, not by `sessionID`:

- A **GUI read** arrives through a typed RPC registered with `ctx.rpc` (`lazers.observability`, `lazers.tasks`, `lazers.models.decision.v2`, `lz.projects`). It is the Desktop panel of the person who installed the plugin, reading their own machine's database. `sessionID` there is the session whose panel is open; it is a scope and a malformed-call guard, not an identity.
- An **agent read** arrives through a tool registered with `ctx.tool` (`lz-query-tasks`, `lz-get-task`, `lz-list-tasks`, the `lz-inspect-*` trajectory tools and the Models tools); each asserts `permission.assert` with the model's `context.sessionID` and `context.agent` and its own action name. `sessionID` there identifies the asking agent session.
- Today's `project`-scope GUI reads: the observability RPC calls `permission.assert` (`read` on the project directory, or `lz-inspect-trajectory` on `*`) and Models calls its own `lz-*` actions; `Tasks.query`, `Tasks.get`, `currentActivity` start no permission check beyond the session check. I did not observe whether any of these prompts in practice; the typings (`@opencode/plugin` 2.3.0, `dist/effect/permission.d.ts`) say `assert` "prompts the user and waits for the reply" when a rule requires approval, and a plain rejection ends the caller's step.

**Authorisation (decided).** The owner is never prompted for looking at their own projects in a panel. A GUI `all` read covers every registered project and asserts no permission: no prompt is possible, and no project is dropped. It keeps the session-existence checks (session exists, belongs to this OpenCode project, has an agent) as a guard against malformed calls, and Models additionally keeps its not-archived check. The `project` and `session` scopes keep today's assertions unchanged.

**Agent tools do not get `all` (not built, by decision).** Tools use `AgentQueryInput` and `AgentGetInput` (the old query and get schemas without `allProjects`), so the schema offers no all-projects field and `TaskReads.query` / `get` also throw if one is smuggled in. The trajectory, Radar and Models tools take no scope. Cross-project reads by agents are a separate product decision (which agent may see which project, and whether that needs a permission and a prompt); nothing here pre-empts it. If it is built later it is a new gate on a new path, not a change to the GUI path.

**Paging.** A page is one checkout of one project, in registry order. The cursor names the next unit by a hash of its checkout path (never the path itself) and, for tasks, the inside cursor of that unit's own paged read, so a long project continues across pages and a short one ends its page. The first page has no cursor and never waits for later projects. Every registered checkout is read; a task page skips a checkout with no matching tasks, and topology and the other page reads return every checkout, empty or not. The last page has `nextCursor: null`. There is no limit on the number of projects or checkouts and no truncation: the page size per project is the existing `limit` (tasks) or one checkout. A cursor whose unit is no longer registered fails with `Invalid project cursor`; the panel restarts from the first page.

**Reads do not write.** Another checkout is opened through `ReadOnlyTaskRepository` (every transaction is a deferred read) and `RunnerStore.readOnly(repository)`, which skips the constructor's lifecycle registration and index build; the caller's own checkout uses the existing read-only trajectory store. A test holds a write lock (`BEGIN IMMEDIATE`) in another connection and shows every all-projects read still returns; the same test fails with `database is locked` when the other checkout is opened through the writable `RunnerStore` constructor.

- [x] **Step 1: Write the failing tests** (`test/projects/three-projects.ts`: temporary database, three projects registered with `registerProject`, codes `AAA`, `BBB`, `CCC`, one task and one plan in each; `loaded` returns the directories of `AAA` and `BBB` only):
  - `projectUnits` lists the units in registry order with the right codes; `AAA` and `BBB` are `loaded: true`, `CCC` is `loaded: false`; a project with two checkouts yields two units that share one `ProjectRef`.
  - `topology({ kind: "all" })` first page is `AAA`'s plans with `project.code` `AAA` on the page, each plan and each unplanned task; following `nextCursor` reaches `BBB` then `CCC` (`loaded: false`) and ends with `null`.
  - The pages of the three projects together hold every plan exactly once; no plan of one project appears under another's `project`.
  - `queryAll` over the three projects returns each project's tasks with the right `reference` prefix and `project`; paging with `limit: 1` over a project with three tasks returns them across three pages, then moves to the next project.
  - `session` and `project` topology reads carry no `project` and no `nextCursor` (the existing read tests stay unmodified and green); `all` is project-wide, so it does not filter by the caller's session.
  - Every project is listed and no permission is asserted (the fake permission service fails the test if called); a cursor holds no path; a cursor for a checkout that is gone is refused.
  - An all-projects page takes no write lock (see "Reads do not write").
  - Agent tool schemas have no `allProjects`; `TaskReads.query` and `get` refuse it.
  - Every other observation method called with `all` throws `All-projects scope is not available for this read`.
  - `loaded` is not a snapshot: a project whose location registers between two pages is `loaded: true` on the later page.
- [x] **Step 2: Run** the new files — expect FAIL.
- [x] **Step 3: Implement** `scope.ts` first (pure, tested alone), then the contract, then `ObservationReads.forUnit` / `atUnit` / `allPage` and `topologyAll` over them (a unit read is the checkout's own project-scope read, no second query path), then `TaskReads.queryAll` (opens the unit's directory read-only, closed in `finally`, runs today's `query`, stamps `project`), then `allProjectsAccess` and the RPC handlers. The two RPCs default their `loaded` source to `loadedProjectDirectories`.
- [x] **Step 4: Run** the new tests plus `bun test src/observability src/tasks src/projects` (only after `bun scripts/reload-safe.ts` prints `safe to reload: yes`) — expect PASS with no existing test edited, except where a row legitimately gains `project`.
- [x] **Step 5: Commit** `feat(projects): read plans and tasks across all projects, a page per checkout`.

### Task 8b: the remaining reads under `all` (built)

Same stamp (`project` on the page, and on plan and unplanned-task rows where the contract has them), the same session guard, the same unit cursor. GUI RPC only.

| Read                                                     | Under `all`                                                                                                                                                                               | Where                                                                                                                                                                                              |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `topology`, `snapshot`                                   | A page per checkout; plans and unplanned tasks carry `project`                                                                                                                            | `ObservationReads.topologyAll`, `snapshotAll`                                                                                                                                                      |
| `radar`, `liveRadar`, `liveGroup`, `progressDiagnostics` | A page per checkout                                                                                                                                                                       | `radarAll`, `liveRadarAll`, `liveGroupAll`, the `progressDiagnostics` handler                                                                                                                      |
| `trajectory`, `trajectoryHistory`, `trajectoryStatus`    | One task: `taskID`, `attemptID` or `reference` (`<CODE>-<n>`, an old code resolves only where it was and only when one project holds it) of any registered project; no cross-project list | `trajectoryAll` and the `*All` siblings; `src/projects/resolve.ts` `findOwner`                                                                                                                     |
| `liveAttempt`, `liveHistory`                             | Resolve the attempt by worker session of any registered project                                                                                                                           | `liveAttemptAll`, `liveHistoryAll`                                                                                                                                                                 |
| `Tasks.query`, `Tasks.get`, `currentActivity`            | `allProjects: true` (query, get) or `scope: "all"` (currentActivity); `project` on pages and rows                                                                                         | `TaskReads.queryAll`, `getAll`, `currentActivityTargetsAll`                                                                                                                                        |
| Models decision                                          | `overviewAll` (a page per checkout) and `rowsAll` (rows of the checkout a page named by `unit`) with `project`                                                                            | `registerModelsServer`; one threaded decision reader per other checkout, started on first use and closed with the scope; price sources are global, so every project is priced with this location's |

How a project that is not loaded (or belongs to another OpenCode location) reads: its recorded rows are returned and `loaded: false`; native sessions are unreachable from this location, so the reads of another checkout run with a native host whose every call fails. Radar and live radar then report `nativeInventory: "unavailable"` and sessions with `availability: "unavailable"`, `freshness: "unknown"`, `state: "unknown"`; trajectories report their native messages as unavailable; `currentActivity` reports `foreground: "unknown"`. Tests also call the trajectory (by reference), `liveAttempt`, `liveHistory`, `Tasks.get` and `currentActivity` handlers over the RPC. No error, and no live state is invented.

One unit read is built by `ObservationReads.forUnit(unit, ownTracker)`: the caller's own checkout is the same object; another checkout gets reads of its own on a short-lived repository with a fresh tracker that never touches this project's change state, sharing the trajectory caches so a continuation cursor survives. `ObservationReads.atUnit` and `allPage` are the two entry points every `*All` read uses.

Task 10 seam (built here so Tasks 9 and 10 are GUI-only): `src/projects/needs-you.ts` has one read function per source that takes a checkout, `ownerHolds(db, directory)` (the `blocked` filter's tasks, every one, from recorded rows), `openRecoveryBundle(db, directory)` (the latest bundle whose outbox notice is still `pending`, so no live Architect has it), and `architectQuestions(sessions)` (native `pendingForms`, readable only for the caller's own location's sessions); `needsYouPage` pages them by checkout; `lz.projects.needsYou({ sessionID, cursor })` serves it with the same session guard and no permission.

### Task 9: Tasks, Radar, Trajectory and Models grouped by project

**Files:**

- Create: `src/projects/group-view.ts`, `src/projects/group-view.test.ts`, `src/projects/group-heading.tsx`
- Modify: `src/tasks/panel.tsx` (scope type at `PanelPrefs.scope`, the menu near line 1767, the query and topology calls near 420 to 500), `src/tasks/panel-state.ts`, `src/tasks/panel-view.ts`, `src/gui.tsx` (the per-project scope maps used by `openTask` and `openTaskTrajectory`), `src/radar/monitor-transport.ts`, `src/radar/monitor-model.ts`, `src/radar/monitor-view.tsx`, `src/trajectory-panel/*` (another agent owns those files at the moment; coordinate before editing), `src/models/*`
- Test: `src/projects/group-view.test.ts`, DOM tests beside each panel

**Interfaces:**

- Consumes: `ProjectRef`, the `all` reads of Tasks 8 and 8b, `lz.projects` `setPause` and `list` from Task 7. Every read it needs exists; this task writes no server code.
- Produces:

```ts
export type ProjectGroup<Row> = { project: ProjectRef; rows: Row[]; counts: Record<string, number> }
/** Appends a page to the groups, in page order; a project appears once however many pages carry it. */
export function appendPage<Row>(
  groups: ProjectGroup<Row>[],
  page: { project?: ProjectRef; rows: Row[]; counts?: Record<string, number> },
): ProjectGroup<Row>[]
```

- Scope menu: `Session`, `Project`, `All projects`. The stored preference per panel becomes `"session" | "project" | "all"`; an old stored value keeps its meaning. `all` is global, not per project, so `PanelPrefs` for it is stored once (key `all`), not under a project directory.

- [ ] **Step 1: Write the failing tests:** `appendPage` merges a second page of one project into its group and keeps first-seen order; a group carries code, name and counts from the first page that has them; the heading shows `CODE`, name, the counts as one- or two-word nouns, and `Paused` when the project's pause record is set; a `loaded: false` group shows no start, pause, answer or steer control and its rows are read-only; filters and search apply to every project (the search string is sent with every page); the Tasks panel in `all` requests pages until the list is full and continues on scroll, never fetching every project before the first row; switching scope away from `all` and back keeps the filter.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** the pure helper first, then the Tasks panel (grouped list; the pause switch on a heading calls `lz.projects` `setPause` for that key), then Radar (Flow and Map nodes grouped by project, queue counts per project), Trajectory (picker grouped by project), Models (a project column and a project filter). Every `loaded: false` group omits live controls; opening a row of another project opens its detail from that project's checkout (`Tasks.get` with the owning directory). Labels are the nouns in `Global Constraints`; no row says `unknown`.
- [ ] **Step 4: Run** the DOM tests and `bun run build:gui` — expect PASS.
- [ ] **Step 5: Commit** one panel per commit, `feat(tasks): group the Tasks panel by project in All projects`, and likewise for radar, trajectory and models.

**Lead's calls, owner may override:**

- The `All projects` scope choice is remembered globally, not per Desktop session or per project: one stored key `all`, shared by all four panels.
- A group of a project that is not loaded starts collapsed and shows no live controls (no start, pause, steer or answer); its rows are read-only.
- Models defaults to the current project, with `All projects` selectable in its scope control; in `All projects` it pages `overviewAll` and reads `rowsAll` for the group a person opens.
- Trajectory has no cross-project list: in `All projects` its picker takes a task by `<CODE>-<n>` reference (or opens from a task row), and the read resolves the owning project.

### Task 10: Needs you, across projects

**Files:**

- Create: `src/projects/needs-you.tsx` (the list), `src/projects/needs-you.dom.test.tsx`
- Modify: `src/tasks/panel.tsx` (the header count), `src/gui.tsx` (open the list)
- Built in Task 8b, not here: `src/projects/needs-you.ts`, `src/projects/needs-you.test.ts`, the `lz.projects.needsYou` method.

**Interfaces:**

- Consumes `lz.projects.needsYou({ sessionID, cursor? })` returning `{ project?: ProjectRef, items: NeedsYouItem[], nextCursor: string | null }`, one checkout per page:

```ts
type NeedsYouItem = {
  project: ProjectRef
  kind: "owner-hold" | "recovery-bundle" | "architect-question"
  id: string // task id, outbox id or session id
  title: string
  reference?: string // `<CODE>-<n>`
  reason?: string
  since?: number // epoch ms
  count?: number
}
```

- [ ] **Step 1: Write the failing DOM tests:** the header shows the count of items across projects and says nothing when there are none; opening it lists the items grouped under their project heading in registry order, oldest first; an item of a project that is not loaded offers only `Open project`; a project under Architect-contact pause shows its questions marked `Paused`; the list is read page by page and the first page renders before the last is fetched; a resolved item is gone on the next read.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** the count and the list; `Open project` opens that project's location (the panel's existing open-project action); an item with a `reference` also opens its task in the Tasks panel through the `openTask` path in `src/gui.tsx`; answering stays in the project's own Architect-contact path, never through this read.
- [ ] **Step 4: Run** the DOM tests and `bun run build:gui` — expect PASS.
- [ ] **Step 5: Commit** `feat(projects): a Needs you count and list across projects`.

**Lead's calls, owner may override:**

- Needs you is a count in the Tasks panel header that opens one list across projects.
- An item of a project that is not loaded can only be opened (opening the project's location), not answered in place.
- A project under Architect-contact pause shows its questions marked `Paused`; they are not hidden.
- Native questions come only from this location's own project: another loaded project's questions are readable only from its own location, so in this list they show as holds and bundles only, and the list says which project's questions it cannot read (`Open project`).

## Stage 4: global scheduling (gated)

Starts after LZ-200 is integrated; its limit contract is read from the integrated code.

**LZ-200 as integrated (2026-11-20, `src/runner/delegated-agent-capacity.ts`).** Build stage 4 on it, not beside it.

| Concern      | LZ-200 delivers                                                                                                                   | Stage 4 adds                                                |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Unit counted | Admitted runner attempt while `preparing`/`running`; admitted native subagent (LAZERS parent, not `architect`)                    | Slot from dispatch until verification ends (checks, Fallow) |
| Rows         | `delegated_agent_admissions`, one per request, state in `lifecycleMachines.capacity` (`queued`/`admitted`/`released`/`cancelled`) | Leased rows with heartbeat (Task 11); can extend this table |
| Limit        | Projects `limit` (`projectSettingsIn`), read in the admitting transaction; `null` = no wait                                       | `globalSlots` across projects                               |
| Order        | Per project: plan priority, plan order, task order; native helpers FIFO behind tasks                                              | Project chosen by `nextProject` (weight, aging)             |
| Release      | Reconciled when the attempt leaves `preparing`/`running`; native on observed child completion or dead queue owner                 | Verification runs and plan checks hold and release slots    |
| Takeover     | `holdTaskSlotInTransaction` moves the worker's admission to the Architect's attempt (counts once, never refused)                  | Same slot kept through the takeover's verification          |
| Pause        | A paused plan/project selects nothing, so it queues nothing; running work is untouched                                            | Paused or unloaded projects excluded from `nextProject`     |
| Reasons      | Tasks scheduling read and `lz-inspect-plan` (`delegatedAgentCapacity`) show limit, active, queued and the wait reason             | Global-limit and next-in-line reasons in Tasks and Radar    |
| Held run     | A held (`blocked`) plan's queued requests are cancelled; its running attempt keeps its admission until it stops                   | A held run releases its slot                                |

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
- Stage 3 is built through Task 8b and Tasks 9 and 10 are GUI-only on the read contract; stage 4 remains an outline by design, its code will have changed before it starts.
