# Many Projects In One OpenCode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Projects are told apart by a short code, can be paused and limited individually and globally, can be viewed together in every panel, and share the machine fairly.

**Architecture:** Everything hangs off the existing project key (`src/project-key.ts`, table `lazers_projects`); no table is re-keyed. Stage 1 adds a stored code per project and uses it in references and session titles. Stage 2 adds project and global dispatch pause plus a database-backed settings store with two levels. Stage 3 adds an `all` observation scope to the panels. Stage 4 adds a leased slot allocator with least-served-first scoring. Stages 1 and 2 start now and are independent of each other; stages 3 and 4 are gated on work in flight.

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

## Stage 3: all-projects scope (gated)

Starts after LZ-227 to LZ-230 (panel streaming) are integrated or re-planned, because both rewrite the same read paths. Tasks, to be detailed against the code as it then stands:

### Task 8: `all` scope in the observation contract and reads

`src/observability/contract.ts` (`ObservationScope` gains `{ kind: "all", sessionID }`), `src/observability/read.ts`, `src/observability/task-reads.ts`, `src/tasks/read.ts`. Every row carries `project: { key, code, name, loaded: boolean }`. Reads page by project. Tests: three projects in one temporary database; `all` returns rows from each with the right code; a project with no live location is `loaded: false`.

### Task 9: Tasks, Radar, Trajectory and Models grouped by project

Scope control gains `All projects`; rows group under a project heading (code, name, counts, pause switch from Task 7's RPC). Live controls are not rendered for `loaded: false`.

### Task 10: Needs you, across projects

One list of Architect questions, holds with owner actions and recovery bundles with no live Architect, each naming its project and opening it.

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
