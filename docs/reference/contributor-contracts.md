# Contributor contracts

Use this reference when you change LAZERS. It describes the current package contracts for v0.1.0. Read the linked source and design records before changing a contract.

## Package boundary

LAZERS is one reusable OpenCode plugin package. The server plugin registers Architect, task tools, the scheduler, and model or context tools in [`src/index.ts`](../../src/index.ts). The Desktop bundle registers Tasks, Radar, Models, Trajectory, local inference, and settings in [`src/gui.tsx`](../../src/gui.tsx).

The release was tested with OpenCode Desktop 2.2.6. The plugin SDK and API baseline is 2.2.5. These facts do not define compatibility with other host versions.

## Task specifications and plans

[`TaskSubmissionSchema`](../../src/task.ts), [`TaskSpecSchema`](../../src/task.ts), and [`PlanInput`](../../src/runner/schema.ts) define task and plan inputs. Keep these task fields explicit:

| Field        | Required content                                                                      |
| ------------ | ------------------------------------------------------------------------------------- |
| Identity     | Stable task ID, specification revision, repository, and starting revision.            |
| Intent       | Observable objective, exclusions, constraints, and assumptions.                       |
| Scope        | Relevant context references and permitted write paths.                                |
| Acceptance   | Behavioral assertions linked to evidence or an explicit human decision.               |
| Requirements | Required capabilities, optional skill suggestions, verification procedures, and risk. |

Keep optional implementation guidance separate from required acceptance. Guidance can name reuse points, known pitfalls, and source references.

The runtime keeps versioned task specifications and plan dependency edges. Reject duplicate task IDs, missing dependencies, cycles, and undefined integration order. Serialize overlapping write scopes. Use a single task for one coherent result unless independent value, useful parallelism, or material risk justifies a split.

[`TaskRepository`](../../src/storage.ts) stores tasks in plugin-owned SQLite storage, separate from OpenCode's private tables. It partitions records by canonical project directory and preserves the original worktree and session. The optional `dataDirectory` setting must be absolute. Task specifications stay immutable; append-only dispositions record reviewed fulfillment, supersession, rejection, or duplication.

## Runtime authority

[`lifecycleMachines`](../../src/runner/lifecycle-machines.ts) defines the XState lifecycle registry. Use those machines for workflow transitions. Do not add SQL-only transitions or implicit states.

The runtime owns plan admission, dispatch, dependencies, verification, configured retry behavior, usage accounting, outcome delivery, and cleanup. A worker report does not accept a task. Architect reviews returned evidence and decides integration.

`lz-submit-task` saves a task but does not dispatch it. A submission needs a caller-chosen `idempotencyKey` with 1–200 characters and at least one non-whitespace character. Key comparison does not trim, fold case, or normalize Unicode. Reuse the exact key and validated content after an ambiguous result to recover the original task. A different valid payload with the same key conflicts. Object key order does not change content identity; array order and values do. Keys are unique within a canonical repository; a new key creates a new logical task. Permission checks run before replay or conflict lookup. See [`src/tools.ts`](../../src/tools.ts) and [`src/submission.ts`](../../src/submission.ts).

`lz-submit-plan` saves a plan. `lz-plan-command` requests `run` separately. The runtime admits and dispatches that plan only after authorization and validation. The Tasks panel's **Start** action uses the same runtime path.

## Routes and workers

[`ModelMappingResolver.resolve()`](../../src/models/mapping-resolver.ts) resolves task, project, then shared mappings. [`TaskRuntime.resolveTaskDispatchRoute()`](../../src/runner/runtime.ts) selects the task route. An explicit plan `workerModel` overrides mappings. Otherwise, the runtime uses the selected persona route, then the configured implementor route.

Preserve the exact provider, model, and variant. Catalog metadata does not veto a configured route. Keep native route failures visible; do not substitute another model or effort. Running attempts keep their recorded route.

Workers keep normal native OpenCode tools and user or project permissions. Context packets guide source reads; they do not limit permitted reads. The runtime enforces task write scope. [`registerWorker`](../../src/runner/roles.ts) blocks worker delegation and plan-dispatch tools.

Each task can use one model-independent persona: `ui`, `systems`, or `small-refactoring`. Persona choice does not select a provider or model. Runtime-managed investigator and researcher roles are not implemented in v0.1.0.

For audit and refactor tasks, `workerAgent: "auditor"` selects Auditor. [`src/runner/roles.ts`](../../src/runner/roles.ts) sets its default route to OpenCode Go `muse-spark-1.3-contributor`. Agent configuration or an explicit plan model can override that route. Fallow reports inform review; they do not gate task completion. Architect reviews the diff and behavior before integration.

## Verification and acceptance

[`src/runner/verification-timeout.ts`](../../src/runner/verification-timeout.ts) sets the default 15-minute inactivity allowance and 60-minute hard backstop. Project and per-check settings can override both. Real standard output or standard error resets the inactivity allowance.

The runtime records check commands, outcomes, timestamps, and observed environment. A failed check may trigger one configured repair attempt. Resume and retry keep earlier attempts and usage. Acceptance records required checks and reviewed decisions. Integration remains a separate action.

Architect decides whether later changes need another check. Metadata drift alone does not revoke a passing result. Cleanup failures stay visible and retryable; they do not erase accepted work or its evidence.

Treat legacy `timeoutMs` as historical metadata, not an execution cutoff. An exact owner command can extend a settled check. Then resume the same attempt or candidate. Retained verification can continue only when its operation, generation, check, command, artifact, receipt, owner, and settled resources still match. A timing change does not start work or grant acceptance.

Use the shared [runtime state machines](../../design/runtime-state-machines.md) for task, plan, attempt, and verification lifecycles.

## Workspaces

Create new isolated runner, adoption, retained-verification, and combined-check worktrees through OpenCode's native API under the canonical project root's `.worktrees` directory. Record and reuse the API's returned directory, including a collision-adjusted name.

Keep existing recorded paths authoritative. Do not relocate them. Shared serial execution stays in its current checkout. Remove only owned, idle, clean, merged worktrees through native APIs. Preserve unmerged work.

## Context and access

[`src/context/tools.ts`](../../src/context/tools.ts) exposes project indexing and focused reads. Architect publishes a Repomix snapshot. Readers use that snapshot until Architect refreshes it. Responses identify the snapshot and its as-of-refresh freshness.

Check native OpenCode permission before access to project data or remote repositories. A missing snapshot does not block normal live source access. Do not treat a cached snapshot as live source.

The remote repository snapshot tool in [`src/context/repository-snapshots.ts`](../../src/context/repository-snapshots.ts) fetches a selected repository and ref through Repomix. It retains source selection, filters, version, and compression basis with the saved source. An unknown resolved revision stays unknown. It complements normal source access; it does not replace it.

Each worker attempt has one ordered progress record in [`src/progress/recorder.ts`](../../src/progress/recorder.ts). `lz-report-progress`, native session and tool events, recovery, and check observations converge by durable identity. Worker commentary is not verification evidence or permission to accept work.

The permission-checked [`lz-inspect-trajectory`](../../src/trajectory/tools.ts) tool returns bounded visible content and project-owned task or attempt records. It omits reasoning, system or skill instructions, attachments, and unsupported content. It redacts common credentials and credential-bearing URLs. It reports missing context, compaction, usage, and record history as gaps. Pattern checks cannot find arbitrary secrets in prose.

The pinned OpenCode API exposes `session.context`, not `client.message.list`. Do not claim that trajectory data contains a complete transcript.

## Cost and measurement

Use configured ordered price sources independently of execution provider or subscription. The initial order is OpenRouter, then OpenCode, reusing access configured in OpenCode. Skip unavailable sources. Preserve chosen-source provenance, exact provider, model and effort, and measured tokens.

Keep a cost unknown when an applicable price is missing. Publish zero only when the source supports zero. Treat session-reported charges as diagnostics, not market rates. Refreshing prices can reprice unchanged usage. A price lookup does not authorize inference.

Record provider and model versions, measured tokens, elapsed time, tool calls, verification time, retries, and human interventions. Keep missing measurements distinct from zero.

Compare matched work from the same starting revision with the same acceptance criteria and quality gates. Include failed attempts and repairs. Report acceptance, cost per accepted task, and accepted tasks per hour together. One successful run shows feasibility; it does not establish an optimization.

## Development checks

Use strict TypeScript and Bun's native formatter, linter, and typechecker. Keep their command names unshadowed by package scripts. Run `bun run verify` for formatting, automatic lint fixes, and type checking. Run `bun test` when you add behavior tests.

Before you start a project development, preview, documentation, Storybook, application, or networked verification server, follow `$portless-dev-servers`. Route project servers through Portless. One-shot tests without a listening socket are exempt. Use OpenCode Desktop and its service through their supported developer-tool lifecycle.

When you create stacked pull requests, use the real `gh stack` workflow. Root the stack on the remote default branch. Submit with `gh stack submit --auto`. Inspect with `gh stack view --json`. Merge with `gh stack merge`.

Keep source and docs in this one plugin package. Read [DESIGN.md](../../DESIGN.md) for panel design work. Read the [OpenCode v2 plugin API docs](https://opencode.ai/v2/docs/build/plugins/) before changing host integration.

## Historical records

The [roadmap](../../design/roadmap.md) and dated review files record plans and observations. Treat proposed work and environment-specific results as historical, not as release guarantees.
