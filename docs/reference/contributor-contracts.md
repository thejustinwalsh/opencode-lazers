# Contributor contracts

Use this reference when you change LAZERS. It describes the current package contracts for v0.1.0. Read the linked source and design records before changing a contract.

## Package boundary

LAZERS is one reusable OpenCode plugin package. The server plugin registers Architect, task tools, the scheduler, and model or context tools in [`src/index.ts`](../../src/index.ts). The Desktop bundle registers Tasks, Radar, Models, Trajectory, local inference, and settings in [`src/gui.tsx`](../../src/gui.tsx).

The v0.1.0 release was tested with OpenCode Desktop 2.2.6. The current plugin SDK and API baseline is 2.3.0, the version pinned in `package.json`. These facts do not define compatibility with other host versions.

## Task specifications and plans

[`TaskSubmissionSchema`](../../src/task.ts), [`TaskSpecSchema`](../../src/task.ts), and [`PlanInput`](../../src/runner/schema.ts) define task and plan inputs. Keep these task fields explicit:

| Field        | Required content                                                                      |
| ------------ | ------------------------------------------------------------------------------------- |
| Identity     | Stable task ID, specification revision, repository, and starting revision.            |
| Intent       | Observable objective, exclusions, constraints, and assumptions.                       |
| Scope        | Relevant context references and permitted write paths.                                |
| Acceptance   | Behavioral assertions linked to evidence or an explicit human decision.               |
| Requirements | Required capabilities, optional skill suggestions, verification procedures, and risk. |

Plan `priority` is an integer of at least 0: 1 is the top priority, larger integers are lower, up to 2147483647, and 0 or omitted means none, which sorts after every prioritized plan. Scheduling, the Tasks list and observation reads order through `comparePriority` and `planPrioritySortSQL` in [`priority.ts`](../../src/runner/priority.ts); ties keep plan submission order, then node ordinal. The `priority` schema-module migration converted legacy higher-is-first values into dense ranks and recorded each legacy value in `runner_priority_migration`.

The Tasks panel lists tasks as flat rows sorted by that order. A task with dependencies is a collapsed accordion whose expansion lists its dependency tree beneath it; priority, order, plan, reasons and prerequisites appear in the inspector, not on the row.

Keep optional implementation guidance separate from required acceptance. Guidance can name reuse points, known pitfalls, and source references.

The runtime keeps versioned task specifications and plan dependency edges. Reject duplicate task IDs, missing dependencies, cycles, and undefined integration order. Serialize overlapping write scopes. Use a single task for one coherent result unless independent value, useful parallelism, or material risk justifies a split.

[`TaskRepository`](../../src/storage.ts) stores tasks in plugin-owned SQLite storage, separate from OpenCode's private tables. It partitions records by canonical project directory and preserves the original worktree and session. The optional `dataDirectory` setting must be absolute. Task specifications stay immutable; append-only dispositions record reviewed fulfillment, supersession, rejection, or duplication.

## Runtime authority

[`lifecycleMachines`](../../src/runner/lifecycle-machines.ts) defines the XState lifecycle registry. Use those machines for workflow transitions. Do not add SQL-only transitions or implicit states.

The runtime owns plan admission, dispatch, dependencies, verification, configured retry behavior, usage accounting, outcome delivery, and cleanup. A worker report does not accept a task. Architect reviews returned evidence and decides integration.

`lz-submit-task` saves a task but does not dispatch it. A submission needs a caller-chosen `idempotencyKey` with 1–200 characters and at least one non-whitespace character. Key comparison does not trim, fold case, or normalize Unicode. Reuse the exact key and validated content after an ambiguous result to recover the original task. A different valid payload with the same key conflicts. Object key order does not change content identity; array order and values do. Keys are unique within a canonical repository; a new key creates a new logical task. Permission checks run before replay or conflict lookup. See [`src/tools.ts`](../../src/tools.ts) and [`src/submission.ts`](../../src/submission.ts).

`lz-submit-plan` admits a plan: the scheduler runs its tasks with no separate Architect `run`. Base-commit and model-route preflight remain. Pass `draft: true` only to save a plan without admitting it; `lz-plan-command` `run` admits an explicit draft. The Tasks panel's **Start** action uses the same runtime path.

## Routes and workers

[`ModelMappingResolver.resolve()`](../../src/models/mapping-resolver.ts) resolves task, project, then shared mappings. [`TaskRuntime.resolveTaskDispatchRoute()`](../../src/runner/runtime.ts) selects the task route. An explicit plan `workerModel` overrides mappings. Otherwise, the runtime uses the selected persona route, then the configured implementor route.

Preserve the exact provider, model, and variant. Catalog metadata does not veto a configured route. Keep native route failures visible; do not substitute another model or effort. Running attempts keep their recorded route.

Workers keep normal native OpenCode tools and user or project permissions. Context packets guide source reads; they do not limit permitted reads. The runtime enforces the task scope: `protectedScope` changes hold the task; a change outside `writeScope`/`createScope` is a reviewed divergence the Architect decides before acceptance (see [runtime state machines](../../design/runtime-state-machines.md)). [`registerWorker`](../../src/runner/roles.ts) blocks worker delegation and plan-dispatch tools.

Each task can use one model-independent persona: `ui`, `systems`, or `small-refactoring`. Persona choice does not select a provider or model. Runtime-managed investigator and researcher roles are not implemented in v0.1.0.

For audit and refactor tasks, `workerAgent: "auditor"` selects Auditor. [`src/runner/roles.ts`](../../src/runner/roles.ts) sets its default route to OpenCode Go `muse-spark-1.3-contributor`. Agent configuration or an explicit plan model can override that route. The runtime runs `fallow audit` on every worker attempt as the verify step `verify:fallow-audit`, after the mechanical fix and the authored checks, journaled like any check effect (history recorded as `verify:lazers-fallow` stays readable). Every project needs a Fallow config (a repository config file, else the stored LAZERS project config); with `fallowReview` on, `lz-submit-task` and `lz-submit-plan` refuse a project without one with `FALLOW_CONFIG_REQUIRED` and queue nothing, and work queued earlier holds with the same code and resumes when a config exists. The audit's whole result is one typed package (`FallowPackage`, [`src/audit/contract.ts`](../../src/audit/contract.ts)): verdict, findings with severity and attribution (introduced, worsened, inherited), classes not checked. When the verdict is `warn` or `fail` and a repair is available, the one repair carries that package with every failing check: errors are fix-these, warnings are consider-fixing (fix, or say in one line why not), inherited findings are context. After the repair the runtime audits again and reports each finding as fixed, remaining or suppressed (with the suppression comment's reason) to the Architect, then accepts whatever remains. Fallow alone never fails or holds a task; an unavailable analyzer is recorded once and the task is accepted. Scores never block.

## Verification and acceptance

[`src/runner/verification-timeout.ts`](../../src/runner/verification-timeout.ts) sets the default 15-minute inactivity allowance and 60-minute hard backstop. Project and per-check settings can override both. Real standard output or standard error resets the inactivity allowance.

The runtime records check commands, outcomes, timestamps, and observed environment. A failed check may trigger one configured repair attempt. Resume and retry keep earlier attempts and usage. Acceptance records required checks and the Architect's reviewed decision. There is no human-evidence gate; `kind: "human"` evidence in stored tasks is ignored. Integration remains a separate action.

## Ownership, routing and holds

- The plan owner is advisory. Any live Architect session of the project may issue commands and is adopted as owner. Do not add owner-equality or owner-epoch authorizations.
- The Trajectory history cache is a least-recently-used cache bounded by the `historyCacheMB` plugin option (default 128, measured against the largest task on the owner's data, about 22 MB). It evicts and never refuses a read; a capture larger than the whole budget is served in one page without being cached ([`history.ts`](../../src/trajectory/history.ts)). No ceiling on events or bytes may make a trajectory unreadable.
- Work that needs judgement routes through `routeArchitect()` ([`architect-routing.ts`](../../src/runner/architect-routing.ts)). Reuse the owner while its prompt cache is likely warm (`architectCacheWindowMs`, default five minutes) or its context is small (`architectReuseMaxContextTokens`, default 32,000 tokens); otherwise create a fresh Architect seeded by the continuity checkpoint. Record the decision as `ARCHITECT_ROUTED` with reason `warm`, `small-context`, `cold-large` or `missing`.
- A hold exists only for real, unrecoverable loss that is directly observable, and it advertises an action that unblocks it. Register its reason family in [`hold-actions.ts`](../../src/runner/hold-actions.ts).
- The Architect's request carries superseded notices and obsolete reads as one-line stubs ([`context-stubs.ts`](../../src/runner/context-stubs.ts), hooked in [`roles.ts`](../../src/runner/roles.ts)). It changes only the messages of one model request: storage and the UI transcript are never changed, and the model reads the current truth through the tool named in the stub. Off by default (`architectContextStubs: "off"`): the hook cannot see prompt-cache state, so a stub applied on a guessed-cold cache turns a possible hit into a certain miss. Plugin option `architectContextStubs`: `"off"`, `"results"` (default: text of user-role notices and tool results) or `"all"` (also the input of a successful `lz-submit-plan` / `lz-submit-task` call, or a Code Mode program's `code`; off by default until verified against a live provider session, because it rewrites an earlier assistant turn). Every notice carries a `[lz-notice kind=… plan=… v=…]` line; keep it when changing notice text. Supersession, always inside the window up to the horizon and never the newest of a key: `blocked`, `cancelled`, `cleanup-blocked`, `dispatch-resumed`, `dependency-resolved`, `accepted`, `integrated` and unknown statuses yield to any later notice of the plan except handoff, queue review, retained-verification-failed and recovery bundle; `task-accepted` yields to a later one for the same task or to `accepted`/`integrated`; a recovery bundle yields to a later bundle; handoff, queue review and retained-verification-failed never yield; a read result (`lz-inspect-plan`, `lz-get-task`, `lz-query-tasks`, …) yields to a later successful result of the same call (a Code Mode failure shown as plain text does not count). The first copy of a runbook stays whole while it is the only whole copy. The horizon advances only at a first request, after a gap longer than `architectCacheWindowMs`, or after compaction, so the prompt-cache prefix is stable between those points. Add no state, hold or gate here.
- A hold or failure left unresolved is not left to rot: stale items are handed to an Architect as one recovery bundle ([`recovery-bundle.ts`](../../src/runner/recovery-bundle.ts), see "Recovery bundle" in [runtime state machines](../../design/runtime-state-machines.md)). Add no per-hold reminder, flag or state; a new hold family is covered once it has `HOLD_FAMILIES` actions.
- A verification effect (`verify:`, `graph-verify:`, `mechanical-fix`) with no receipt is superseded and re-run. Keep the effect journal for prompt, session and worktree effects.
- A cancelled prerequisite drops its edge and notifies the Architect; it does not hold dependents.
- A running task whose trajectory matches a detector rule raises a worker concern to the Architect; detection never holds or stops the worker. The Architect continues, steers, takes over (`lz-request-handoff`, then `lz-plan-command takeover-submit`), splits or cancels. A takeover's steps are `lifecycleMachines.takeover` transitions; see "Worker concerns and Architect takeover" in [runtime state machines](../../design/runtime-state-machines.md).
- Classify every new machine state and event in [`lifecycle-dead-ends.test.ts`](../../src/runner/lifecycle-dead-ends.test.ts). A non-terminal state needs an observable or Architect-action exit.

Architect decides whether later changes need another check. Metadata drift alone does not revoke a passing result. Cleanup failures stay visible and retryable; they do not erase accepted work or its evidence.

Treat legacy `timeoutMs` as historical metadata, not an execution cutoff. A timed-out or interrupted check is a failed check: fix the cause, then re-run it. `resume` without a task re-runs a blocked plan's combined check on the current candidate; no earlier receipt, fingerprint or deadline has to match.

`verify-retained` is one call: it verifies a given commit in a temporary worktree with the task's declared checks and records pass or fail. It does not prompt or restart the implementation worker, certify that worker idle, settle its source, or authorize cleanup. It binds the project, plan revision, task revision, latest attempt and exact commit, not a plan version, generation or authorization. A failure notifies the Architect, who runs the call again. Do not add a held state, a resume or continue command, or a per-operation binding; a retained call that cannot finish fails.

Use the shared [runtime state machines](../../design/runtime-state-machines.md) for task, plan, attempt, and verification lifecycles.

## Workspaces

Create new isolated runner, adoption, retained-verification, and combined-check worktrees through OpenCode's native API under the canonical project root's `.worktrees` directory. Record and reuse the API's returned directory, including a collision-adjusted name.

Keep existing recorded paths authoritative. Do not relocate them. Shared serial execution stays in its current checkout. Remove an owned worktree through native APIs, never forced, when its change is contained in the checkout, `git status` is clean, and the host reports the worker idle now: session not busy, no pending input, permission or form, no running shell with a cwd inside the worktree, and no active child session. There is no `experimental.idle` report to wait for, and no cleanup authorization or `recover-cleanup` command: a blocker clears on its own and cleanup retries only when an observed fact changed. Preserve dirty trees and unmerged commits, and keep the reason visible.

## Context and access

Local orientation is one repository map: file paths plus exported names only, over the project's own source files, in plain path order with no ranking and no entry cut ([`src/context/repo-map.ts`](../../src/context/repo-map.ts)). The source definition is a per-project stored setting; the default is derived from the checkout in one function (`deriveSourceDefinition`). The same tree yields identical bytes. Workers read it in `lz-get-task`, frozen per plan ([`src/context/repo-map-store.ts`](../../src/context/repo-map-store.ts)); the first capture wins, so all workers of a plan carry the same bytes. The Architect receives it once per session as a keyed session instruction ([`src/context/architect-map.ts`](../../src/context/architect-map.ts)), including renewed sessions. The map is as of plan or session start; agents use the host's read and grep for current content. Each delivery records the map hash and token size, and the size of the injected source context, in `repo_map_deliveries`, joinable to attempts by session id.

Check native OpenCode permission before access to project data or remote repositories. Do not treat the map or a named-source outline as live source.

The remote repository snapshot tool in [`src/context/repository-snapshots.ts`](../../src/context/repository-snapshots.ts) fetches a selected repository and ref through Repomix. It retains source selection, filters, version, and compression basis with the saved source. An unknown resolved revision stays unknown. It complements normal source access; it does not replace it.

Each worker attempt has one ordered progress record in [`src/progress/recorder.ts`](../../src/progress/recorder.ts). `lz-report-progress`, native session and tool events, recovery, and check observations converge by durable identity. Worker commentary is not verification evidence or permission to accept work.

The permission-checked [`lz-inspect-trajectory`](../../src/trajectory/tools.ts) tool returns bounded visible content and project-owned task or attempt records. It omits reasoning, system or skill instructions, attachments, and unsupported content. It redacts common credentials and credential-bearing URLs. It reports missing context, compaction, usage, and record history as gaps. Pattern checks cannot find arbitrary secrets in prose.

The pinned OpenCode API exposes `session.context`, not `client.message.list`. Do not claim that trajectory data contains a complete transcript.

## Retention

[`src/retention/`](../../src/retention/retention.ts) retires recorded detail of finished work. It is one typed command, `lz.retention` (`status`, `preview`, `retire`, `setAuto`), not a workflow: no XState state, and every batch is its own transaction that re-selects what is still retirable, so an interrupted purge continues and a repeated one finds nothing. `preview` is the dry run; `retire` requires `confirmed: true` and runs a time-boxed slice, called again with its `runID` until `done`. Every purge is one `retention_runs` row.

A plan is retired only when it is `integrated` or `cancelled`, its last activity is older than the chosen age, and nothing waits on it: no pending notice, open takeover, adoption, handoff or worker concern, no held, uncertain or unfinished effect, and none of its tasks also belongs to an unfinished plan. For such plans it removes activity detail (tool, step and observation progress records), the progress facts every consumer has already read, native tool call records, delivery and renewal transition events (each plan and task keeps its latest transition), and delivered or superseded notices. Independent of plans it removes conflict scan history older than the age, superseded model and price snapshots older than the age that are not the latest, bulky read-only audit receipts beyond the newest five per project, and superseded task change counters (only `MAX(id)` per project is read).

It never removes tasks, references, titles, states, dispositions, check, verification, artifact, outcome and usage records, integration and acceptance transitions, commit identity, effects, evidence, attempts, git notes, settings or model assignments. A retired plan's panels show what remains and omit the rest.

Worktrees: a recorded workspace of a retired plan is removed only through the native API, never forced, and only when it is a registered native worktree under `<project>.worktrees` or the plugin's `runner/worktrees`, no unfinished work records it, `git status` is clean and its HEAD is contained in the project checkout. Any other is listed with its reason. Freed pages stay inside the SQLite file for reuse; `auto_vacuum` is off, so shrinking the file is a separate, explicit `VACUUM` that a purge never runs. Automatic retention (`retention_settings.auto_days`, off by default) runs one slice from the scheduler tick when no attempt is preparing, running or verifying, at most every six hours, continuing an unfinished run on the next tick.

## Cost and measurement

Use configured ordered price sources independently of execution provider or subscription. The initial order is OpenRouter, then OpenCode, reusing access configured in OpenCode. Skip unavailable sources. Preserve chosen-source provenance, exact provider, model and effort, and measured tokens.

Keep a cost unknown when an applicable price is missing. Publish zero only when the source supports zero. Treat session-reported charges as diagnostics, not market rates. Refreshing prices can reprice unchanged usage. A price lookup does not authorize inference.

Record provider and model versions, measured tokens, elapsed time, tool calls, verification time, retries, and human interventions. Keep missing measurements distinct from zero.

Compare matched work from the same starting revision with the same acceptance criteria and quality gates. Include failed attempts and repairs. Report acceptance, cost per accepted task, and accepted tasks per hour together. One successful run shows feasibility; it does not establish an optimization.

## Development checks

Use strict TypeScript and Bun's native formatter, linter, and typechecker. Keep their command names unshadowed by package scripts. Run `bun run verify` for formatting, automatic lint fixes, and type checking. Run `bun test --timeout 120000 <files>` (or `bun run test <files>`) when you add behavior tests; Bun's 5 s per-test default is not a budget here.

Before you start a project development, preview, documentation, Storybook, application, or networked verification server, follow `$portless-dev-servers`. Route project servers through Portless. One-shot tests without a listening socket are exempt. Use OpenCode Desktop and its service through their supported developer-tool lifecycle.

When you create stacked pull requests, use the real `gh stack` workflow. Root the stack on the remote default branch. Submit with `gh stack submit --auto`. Inspect with `gh stack view --json`. Merge with `gh stack merge`.

Keep source and docs in this one plugin package. Read [DESIGN.md](../../DESIGN.md) for panel design work. Read the [OpenCode v2 plugin API docs](https://opencode.ai/v2/docs/build/plugins/) before changing host integration.

## Historical records

The [roadmap](../../design/roadmap.md) and dated review files record plans and observations. Treat proposed work and environment-specific results as historical, not as release guarantees.

- There is no source quarantine or source guard. Never add a host call scoped to a worktree location from an observation path: it boots the location. Read a location-scoped inventory only after `debug.location.list` shows it loaded, and identify a recorded workspace by path.
