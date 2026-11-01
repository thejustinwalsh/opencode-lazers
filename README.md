# opencode-lazers intent and contracts

**Turn developer intent into accepted software changes with the least necessary reasoning, orchestration, human intervention, and compute.**

`opencode-lazers` is an OpenCode plugin for architects who know what they want built and need consistent, affordable execution. LAZERS means specifying the target, compiling the work, and executing with precision. Success is completed work per dollar and hour, subject to the repository's quality standards.

The user owns intent. Architect turns it into a verified plan and makes orchestration decisions when judgment is needed. The runtime owns execution policy and task state. Workers implement the change.

LAZERS ships as one plugin package. Its scheduler and storage run inside OpenCode’s service; panels and local inference run inside OpenCode Desktop. Workers are native OpenCode sessions. There is no separate LAZERS daemon, scheduler service or inference server to install. Git, verification and builds use ordinary subprocesses through the host.

## Architect experience and authority

The user selects **Architect** from the Desktop agent dropdown before starting a session and describes the feature they want. Architect carries that request through planning, dispatch requests, and any decisions needed to reach acceptance:

1. **Understand the feature.** Determine what information is needed to specify successful work. Inspect the relevant codebase and research current, relevant external information. Use the host's structured question tool when missing information changes the requirements, scope, acceptance, or verification. A clear request proceeds without an unnecessary interview.
2. **Gather evidence.** Repository investigation and web research may be delegated to separate investigator and researcher subagents, each with a model selected for its cost and fit. Their assignments have focused questions and expected evidence. Repository findings identify paths/revisions; web findings cite primary sources and distinguish current facts from assumptions. Architect reconciles the findings into one coherent plan. Research delegation is optional; it must earn its cost.
3. **Define done before dispatch.** Produce the series of tasks the feature requires, with dependencies, permitted write scopes, explicit acceptance assertions, verification procedures, and overall feature acceptance. One task is sufficient when the work is self-contained. A feature that needs several tasks must have a clear integration and verification order.
4. **Request execution.** Once material questions are resolved, Architect submits the plan and requests dispatch through runtime tools. The runtime validates and admits it, resolves models/permissions/resources, and dispatches eligible work. Sufficiently specified and authorized work needs no extra approval ceremony.
5. **Return for decisions.** The runtime records completion and failure messages durably and delivers them to Architect with the relevant task/revision, evidence, failure reason, and measured usage. Architect can request repair, rescheduling, or replanning when those choices need reasoning. It can ask the user a focused question when new ambiguity or authorization is required. Revised scope or acceptance produces a revised specification.

Architect does not run or maintain the task state machine. Deterministic runtime rules handle state transitions, dependencies, concurrency, verification, configured repair/retry behavior, cancellation, and usage accounting. Routine progress and completions that merely unblock an already-defined task do not require a model call. Wake Architect when a decision is needed, a task group needs synthesis, or the feature needs its final user-facing result. Architect's decisions return through validated runtime commands; it cannot directly mark a task accepted or erase attempt history.

This is the required product flow. The durable graph runner, dispatch, outcome delivery, resume/retry, scheduling and cleanup are implemented. Real product work has exercised native parallel return, combined checks, review/merge and non-forced cleanup. The [completed-task audit](.agents/docs/completed-task-audit.md) records current delivery, active work and remaining observation gaps without treating source landing as whole-plan acceptance.

## Operating principles

- **One entry point.** Select Architect, describe a feature, and let it gather evidence, resolve material ambiguity, define done, and request execution. A sufficiently specified request needs no interview or additional approval ceremony.
- **Reason where it helps.** Architect specifies work and resolves orchestration decisions; specialists investigate/research and workers implement. Deterministic code admits tasks, selects resources, dispatches workers, schedules verification, and stops execution. Progress events do not trigger supervisor model calls.
- **Match execution mode to the work.** Shared serial tasks use native child sessions. Independent tasks may run in parallel through OpenCode-managed worktrees when their scopes and integration order allow it; conflicting scopes serialize. Multiple files alone do not justify fan-out. Optional investigator/researcher subagents have separate bounded assignments and model choices.
- **Knowledge, policy, and procedure have different owners.** Skills supply knowledge; runtime rules enforce policy; executable checks produce evidence. Required behavior must not depend on the model remembering prose.
- **Verify at meaningful boundaries.** Complete the scoped implementation, then run the necessary checks. Earlier targeted checks are appropriate when they inform implementation or protect a risky operation.
- **Track trajectories and actual usage.** Provider/model limits govern model capacity. LAZERS does not invent token, time, tool-call or spend budgets. Verification and self-review retain their specific procedures.
- **Make additions earn their cost.** Keep a capability only when evidence supports its benefit. Preserve useful decisions, checks, and tooling without imposing a retrospective on every task.

## Core contracts

These are the target contracts from the design brief. Current implementation status is stated with each contract; remaining native observations are kept explicit instead of being treated as complete.

### 1 Task specification

**Status:** Implemented and used by the Architect; task dispositions preserve the immutable specification while recording reviewed legacy outcomes.

The compiler returns either a valid `TaskSpec` or focused questions identifying what prevents execution.

| Field        | Required meaning                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------ |
| Identity     | Stable task ID, specification revision, repository, and starting revision                        |
| Intent       | Observable objective, explicit exclusions, constraints, and assumptions                          |
| Scope        | Relevant context references and permitted write paths                                            |
| Acceptance   | Identified behavioral assertions, each mapped to required evidence or an explicit human decision |
| Requirements | Required capabilities, optional skill suggestions, verification procedures, and risk             |

Optional `guidance` carries scoped implementation advice: existing code to reuse,
known pitfalls and useful practices with source references. It is distinct from
mandatory constraints and acceptance. Workers see the goal and done conditions
first. Keep repository policy in repository guidance; do not repeat it in each
task. See the [task authoring template](.agents/docs/task-authoring.md).

Unresolved material ambiguity prevents admission. A worker cannot silently expand scope or redefine acceptance. New evidence that changes the work produces a revised specification.

### 2 Work decomposition

**Status:** Implemented through versioned plans, dependency edges, priority, integrated plan prerequisites, shared serial execution, and compatible isolated fan-out.

A `TaskGraph` contains versioned specifications and dependency edges. Every task contributes to the overall objective. Reject duplicate IDs, missing dependencies, cycles, and undefined integration order. Schedule compatible work in parallel, serialize conflicting write scopes, and use `priority` and `afterPlans` when ordering or integrated prerequisites matter. Isolated worktrees do not eliminate integration conflicts.

Use one task for self-contained work and a series of tasks when the requested feature requires it. Add parallelism when tasks have compatible interfaces and independent write scopes. Accept the graph only after its combined result meets overall acceptance.

### 3 Execution policy

**Status:** Implemented in the runtime and native adapters; exact route failures remain visible and are never replaced by fallback selection.

Admission resolves each `TaskSpec` into a recorded execution plan: agent, exact native model route when selected, tools and permissions, context, workspace and verification schedule. Task skill entries are optional suggestions and do not gate admission or dispatch. Workers may load a useful native skill progressively under OpenCode's normal permission check; LAZERS does not resolve or inject skill bodies.

Measure tokens, time, tool calls and retries, and report unavailable equivalent cost honestly. Continuation and repair preserve prior usage and trajectory records.

The worker returns an artifact reference, changed files, evidence references, and unresolved issues. It cannot certify its own completion or launch subagents. Implementors retain normal OpenCode coding capabilities, including Code Mode, shell, editing and available native LSP/diagnostics, under user/project policy. Their ContextPacket focuses the work; it does not limit permitted reads to writeScope. Runtime enforces actual write scope, verification and acceptance and owns all task dispatch and implementation parallelism.

Architect can request bounded code investigation or current-web research from internal specialist roles. Runtime dispatches the selected agent/model/variant through the native child boundary. Specialists are subagent profiles, not extra human-facing primary agents. They do not recursively delegate. Research and implementation use the same admitted-dispatch boundary; unrestricted native child spawning is not a cost-control substitute.

### Worker route and persona choice

Plans may carry an explicit `workerModel` (`providerID`, `id`, and optional native `variant`/effort); otherwise they inherit the native implementor selection. LAZERS forwards that route unchanged through native OpenCode session creation. Catalog `enabled` or tool-capability metadata never vetoes a route, and native failures do not trigger fallback or effort changes. The Architect can consult `lazers_worker_catalog` for the live catalog, prices, variants, capability metadata and current implementor selection. This is advice for a focused user preference question, not a ranking; missing prices remain unknown and the lookup launches no inference.

Each plan node may independently select one optional persona: `ui`, `systems`, or `small-refactoring`. A persona contributes one short overlay to the shared implementor core and is independent of provider/model/effort. It does not remove normal coding tools or permit worker delegation. Existing plans without a persona or explicit `workerModel` keep their prior behavior; there is no separate persona/model settings engine.

### 4 Verification and completion

**Status:** Runtime verification, evidence, repair, retry, delivery, integration and cleanup are implemented. The product-panel plan demonstrated native multi-task acceptance and removal of all five owned worktrees; each further feature still needs its own relevant checks and observations.

The runtime owns this lifecycle:

```text
draft → ready → running → verifying → accepted
                             ↓
                          repairing → verifying
```

`ready` requires a valid specification and admitted plan. Verification failure permits one repair by default. Cancellation, execution failure, or a missing prerequisite stop work with evidence and a concrete next action. Explicit resume/retry commands retain prior attempts and usage.

`accepted` means all acceptance evidence exists, required checks pass, the diff respects scope, and required human decisions are resolved. Tests passing and a worker saying “done” are insufficient. Acceptance identifies the exact resulting revision or artifact; merging or publishing remains a separate action.

Reuse a verification result only for the same relevant code, inputs, command, and environment. Edits or integration that invalidate those inputs invalidate the result. Repair receives the specific failure; repeat checks whose evidence became invalid.

Completion/failure delivery and Architect decisions are separate from lifecycle transitions. Persist the outcome and evidence before notification, and prevent duplicate or stale notifications/commands from dispatching work twice. Apply configured repair or retry rules without a model call when the response is already defined. Re-enter Architect when the failure requires a new approach, changed dependencies or scope, or a user decision. A reschedule or revised plan must pass admission and retain prior attempts and usage; it does not silently restart a loop.

Serial tasks default to native child sessions in the shared checkout; parallel work uses OpenCode-managed worktrees. Review and integrate accepted commits, then reconcile and remove only owned, idle, clean, merged worktrees through native APIs. Cleanup failures remain visible and retryable. Preserve unmerged work and attempt history. See [workspace policy](.agents/docs/workspace-policy.md).

### 5 Context and memory

**Status:** The reusable Repomix workspace index and focused read tools are implemented. Native publication reuse across an isolated worker is observed in the [context evidence](.agents/docs/evidence/isolated-context-reuse/native.md); comparative token/cost savings are not yet established.

A `ContextPacket` supplies concise repository rules, the specification and its optional skill suggestions, relevant interfaces and findings, and their source references. Reuse useful findings. Workers can progressively load a useful native skill when needed and permitted; skill bodies are not eagerly attached to task context.

Persistent memory retrieval is bounded and relevant. Durable decisions retain provenance. Stable prompt prefixes may improve provider caching, but reported cache usage must demonstrate the benefit; separate sessions do not imply shared caches.

The [Repomix strategy](.agents/docs/repomix-strategy.md) applies this contract mechanically: reuse a workspace-sensitive index, filter relevant implementations/interfaces/tests/rules, bound the packet, and deliver it at dispatch. Full source, compressed outlines and structure-only entries serve different needs; workers retain their normal tools and can request more evidence. Architect establishes repository facts before asking avoidable questions. Indexing and focused retrieval should reduce repeated exploration, rather than add a research ceremony.

The context tools use one persisted snapshot per worktree. Architect explicitly refreshes it with `lazers_project_refresh`; path/search/outline/full reads only project that snapshot and re-check each reader's native file permissions. Responses identify the snapshot and say freshness is as-of-refresh, not live. An absent snapshot is reported rather than built implicitly. See [spike 017](.agents/docs/spikes/017-reusable-workspace-index.md).

### 6 Measurement and learning

**Status:** Trajectory and usage records are available; comparative model conclusions require matched real work and external acceptance.

A `RunRecord` links specification, policy, context, model/provider versions, attempts, state transitions, artifacts, and evidence. Record tokens, reported cache usage, cost, elapsed time, tool calls, verification time, retries, and human interventions. Distinguish missing measurements from zero.

Compare fixed tasks from the same starting revisions with the same acceptance criteria, tools, and quality gates. Include failed attempts and repairs in total cost and time. Report acceptance rate, cost per accepted task, and accepted tasks per hour together. Repeated trials establish whether an optimization helps; one successful run establishes feasibility only.

## Platform boundary

Build on OpenCode and its native provider access. Use the user's ChatGPT subscription for current dogfooding; OpenRouter supplies equivalent API price estimates and can supply an execution route when configured by the user. Reuse native sessions, structured questions, tools, skills, permissions, persistence, and worktrees where validated. Keep policy and lifecycle logic separate from thin host and desktop adapters.

The transcript's API examples, model prices, and performance targets are research leads. Pin and test the actual host and SDK before depending on specific hooks or desktop extension points. Unsupported enforcement paths must be exposed before enabling them.

## Read-only worker trajectory

Any caller allowed by native permission can call `lazers_inspect_trajectory`
with one project-owned `taskID` or `attemptID`. The tool checks permission before
input validation or project/session access. It then combines LAZERS attempt/check
records with the native `session.get` and `session.context` APIs, and opens its
project database read-only;
it does not use `detail()` because that method writes an audit row. A bounded,
stable cursor pages ordered visible prose,
tool inputs/results/status, runner events, and checks. Changing underlying runner
or returned session context invalidates continuation. Each task report includes
all attempts, even failures, cancellations, retries and resumes.

Read access is controlled by OpenCode's native permission decision, not an
Architect-name restriction. Project/task/attempt/session ownership, redaction,
bounded pagination, and read-only database access remain enforced. See [spike
015](.agents/docs/spikes/015-trajectory-read-access.md) for the correction and
verification evidence.

Exports are allowlisted and redacted before truncation: reasoning, system/skill
instructions, native/encrypted/replay data, metadata, attachments/file bodies,
authorization material and raw response bodies are excluded. Common credentials,
credential-bearing URLs, and nested sensitive keys are redacted from visible
strings, tool data, and errors. Pattern detection cannot guarantee discovery of
arbitrary secrets embedded in prose. The pinned plugin context exposes
`session.context` but not `client.message.list`; reports therefore identify
context coverage, compaction, missing/ongoing records, and unknown data instead
of claiming a complete transcript.

Token totals use one cumulative session snapshot per unique worker session and
separate uncached input, cache read/write, output, and reasoning. Legacy scalar
counts are not added again; pages and individual messages never contribute to
totals. Recorded costs retain worker-attempt scope and available provenance. If
any contribution or pricing basis is missing, the API-equivalent total remains
unknown; a subscription-reported zero is not an API cost estimate. See
[spike 012](.agents/docs/spikes/012-worker-inspection.md) and its [native read
evidence](.agents/docs/evidence/012-worker-inspection/native-report.json).

## Durable worker progress

Each worker attempt has one ordered SQLite progress log shared by the
`lazers_report_progress` tool, native tool/session events, retained-session
recovery, and runtime verification/artifact observations. The tool accepts only
concise commentary; identity is resolved from the assigned native worker
session. Commentary is visibly distinct from automatic facts and is never
verification evidence or permission to accept, schedule, or otherwise change
task state.

Visible results/errors, measured additive step usage, cumulative session usage
snapshots, provider retries, execution outcomes, checks and artifacts are
deduplicated by native/runtime identity. Cumulative snapshots remain separate
from additive measurements. Recovery reconciles only retained public session
facts; unavailable event history or compacted/incomplete context is recorded as
a gap rather than replaying execution. Idle handoffs use one persisted synthetic
message identity per attempt, reconcile ambiguous admission, and do not create
recursive turns. Privacy filtering excludes tool inputs, hidden reasoning,
credentials, transport data and raw contexts. See [spike
018](.agents/docs/spikes/018-durable-progress.md) for implementation and
verification evidence.

## Development scaffold

An optional parallel [WebGPU experiment](.agents/docs/webgpu-api.md) adds a Desktop model cache, queued local questions and typed decisions, and native agent tools in this same package. Settings → LAZERS covers the whole plugin and provides a local-inference master switch plus independent capability switches; `options.webgpu: true` seeds the initial master preference. The core task workflow works with local inference off. This experiment is independent of the main Architect dogfooding sequence. Build its Desktop entry with `bun run build:gui`. The API document records the native voice integration gap in OpenCode 2.2.5; the experiment does not replace the built-in voice controls.

The optional [task-hardening tool](.agents/docs/task-hardening.md), `lazers_verify_task`, checks task JSON and returns one targeted correction at a time. Architect uses it before ordinary submission when local task review is enabled. It reviews task structure and intent; it does not approve implementation or acceptance.

```text
src/index.ts                         Effect server plugin adapter
src/architect.md                     Packaged Architect definition
src/architect.ts                     Validated definition and native agent registration
src/runner/catalog.ts                Read-only native model-selection advice
src/personas/                         Short model-independent worker overlays
src/task.ts                          Zod proposal/specification and generated JSON Schema
src/storage.ts                       Plugin-owned SQLite repository
src/submission.ts                    Validation and runtime-owned task identity/provenance
src/tools.ts                         Native submit/get/list tools with permission checks
.opencode/plugins/lazers/index.ts    Project-local loader
opencode.json                       Default agent for new sessions
.agents/docs/opencode-api.md         Verified host API reference
package.json and bun.lock            Package entry point and pinned dependencies
tsconfig.json                       Strict typechecking
```

The scaffold targets the installed OpenCode CLI and Desktop 2.2.5 with `@opencode/plugin` 2.2.5. It exports TypeScript source directly; the server plugin needs no bundle step. Effect setup opens the task repository, registers native tools and Architect, writes a persistent `loaded` marker, and logs the host version/database path. The package includes its agent definition and registers it through `agent.transform().update()`, which creates missing agents in the pinned host. A packed artifact loaded and registered Architect in a clean project without an agent file. Desktop trials verify structured interviewing and persisted task submission; see the [capability and definition audit](.agents/docs/architect-validation.md) and [evaluation evidence](.agents/docs/spikes/006-architect-interview.md). Task execution and scheduling have since been added incrementally; current worker selection is described in [spike 016](.agents/docs/spikes/016-native-worker-selection.md).

Use the Bun version pinned in `package.json`, then run `bun install --frozen-lockfile`. The selected canary package is `1.4.4-canary.20261030.1`, verified as binary revision `1.4.4-canary.1+da867c60b`. Run native `bun fmt` to format, `bun fmt --check` to check formatting, `bun lint` to lint, and `bun check` to typecheck. `bun run verify` runs the non-mutating checks together.

Open this repository in OpenCode Desktop to discover the local plugin. LAZERS is one reusable package, dogfooded through the project-local loader. It stays private until a release is prepared. Run `bun test` for contract, persistence, and tool behavior tests.

| Tooling                                   | Status                                                                                 |
| ----------------------------------------- | -------------------------------------------------------------------------------------- |
| OpenCode and its V2 plugin SDK            | Required host and plugin API                                                           |
| Strict TypeScript                         | Checked by native `bun check`; matching TypeScript package retained for editor tooling |
| Bun                                       | Selected runtime, package manager, and test runner                                     |
| Formatter and linter                      | Native Bun tooling; no separate Biome, ESLint, Prettier, or Oxlint dependencies        |
| Task schema validator                     | Zod 4.6.7, generating JSON Schema for the submission tool                              |
| Vite, Solid, and a GUI bundle             | Used by the native Tasks panel and optional WebGPU Desktop surface                     |
| Orchestration framework or memory service | Add only when a dogfood spike establishes the need                                     |

The server uses OpenCode's Effect-native SDK. `@opencode/plugin` and `effect` are pinned peer/dev dependencies because OpenCode supplies them at runtime. Tasks use Bun's native SQLite adapter in a plugin-owned database, separate from OpenCode's private tables. The default file is `${XDG_DATA_HOME:-~/.local/share}/opencode/plugins/lazers/tasks.sqlite`; a plugin `dataDirectory` option can supply an absolute override. Canonical project directories partition tasks and share them across that project's worktrees; each task records its original worktree and session. The native task tools validate input and explicitly check their permission actions. A successful submission records `submitted`; it does not admit or start execution. Task specifications remain immutable, while durable dispositions can mark superseded, rejected, duplicate or reviewed fulfillment. Actual usage and attempt history are retained.

Idle Architect renewal uses the plugin option `architectIdleWindowMs` (a positive integer in milliseconds; default **30 minutes**). Busy or recently active sessions are reused. The prompt hook records native prompt IDs, but it does not observe every queued synthetic inbox admission: OpenCode 2.2.5's public API has no atomic inbox-admission/archive barrier. The native adapter therefore marks renewal input safety unsupported and automatic idle renewal remains disabled on this host; inbox snapshots alone are not treated as a guarantee. A host may renew only when it explicitly guarantees that all native input admissions are fenced. The Architect can record exact current decisions and unresolved questions with `lazers_record_architect_continuity`; that durable checkpoint accompanies a labelled successor handoff without replaying or summarizing the old transcript. Renewal preserves predecessor linkage and selected model/effort, transfers ownership before archival, and leaves existing worker sessions unchanged.

### Retry-safe direct task submission

Choose a caller-owned `idempotencyKey` **before the first** `lazers_submit_task`
call. It is a required top-level transport field alongside proposal fields, not
part of the stored proposal or `TaskSpec`. Use 1–200 characters (runtime length is
measured in UTF-16 code units), containing non-whitespace text. Keys are compared
exactly: whitespace, case and Unicode normalization are significant; nothing is
trimmed or normalized.

Reuse the same key and validated proposal after an ambiguous/lost response or host
restart. Within the same canonical repository this returns the original
`{status: "submitted", taskID, revision}` receipt, without recollecting Git
provenance or changing the original content, timestamp, session or worktree.
Object property order is irrelevant; array order and field values are significant.
Sessions, worktrees, tool-call IDs and HEAD do not redefine submission identity.
The same key in another canonical repository is independent. A new key creates a
new task even for identical content: use it only for a new logical submission.

Reusing a key with different valid content returns
`{status: "conflict", message: "idempotencyKey already identifies different validated content"}`,
without modifying the original task or returning its content. Resolve that intent
mismatch rather than blindly changing keys. Missing/invalid keys or proposals
return `{status: "invalid", errors: [{path, message}]}` before provenance or writes.
Every invocation checks permission before lookup/write, including replay/conflict.

SQLite enforces repository/key uniqueness and persists the task and association in
one transaction. Associations last for the lifetime of stored tasks; no expiration
or automatic retry orchestration is added. Existing keyless tasks remain readable
and are not retroactively recoverable by key. Version-1 databases migrate
transactionally through the existing version-3 schema without changing task bodies;
future versions are rejected. See [spike 007](.agents/docs/spikes/007-retry-safe-submission.md)
for deterministic fresh-process and concurrency evidence. Submission records work;
it does not execute it.

### Desktop tryout

1. Open this folder in OpenCode Desktop and start a new session. It should select **architect**; existing sessions keep their previous agent and need manual selection. Use your connected **Sign in with ChatGPT** subscription and select the model/reasoning setting in Desktop. The project deliberately does not pin a model or switch an existing session's provider.
2. Give Architect a clear real request. Expect inspection and focused questions where needed, followed by a scoped task with acceptance evidence. For direct `lazers_submit_task`, choose an idempotencyKey before the first call. Retry the exact key and content after a lost response, including after restart; expect the original durable task UUID, not another task.
3. Ask “Retrieve task <UUID>.” Restart Desktop/the connected host, reopen the repository, and retrieve that UUID again. Expect the same stored specification, without a new submission.
4. Try a materially ambiguous request, such as “Add task export for our external system,” without naming the system or interface. Expect focused questions before submission. Architect retains normal OpenCode tools, including Code Mode, research, shell, editing and Git, under host/user/project permissions. It reviews and integrates completed work; runtime owns task dispatch and state transitions.

Record the Desktop/host versions, selected subscription model and reasoning setting, task UUID, restart/retrieval result, and any tool/permission failures. This is the acceptance evidence for [spike 004](.agents/docs/spikes/004-desktop-architect.md); CLI discovery alone does not complete it. No paid OpenRouter verification is authorized. Equivalent API costs can later be estimated from measured tokens and dated OpenRouter prices for the same model; distinguish cached/uncached input, output, and unknown usage. A displayed subscription charge of zero is not an equivalent cost estimate.

## Tasks panel — runtime-backed

Open **Tasks** from the session's extra-panel list or `/tasks`. It is an optional,
closable native tab. The default view shows tasks submitted from that session;
the quiet scope menu switches to the current canonical project's tasks. Search
and selection use the same bounded project-scoped read service as task tools.
An unstarted submitted task can be explicitly started from its inspector. The
RPC checks native permission and the runtime validates project ownership,
revision, and a committed baseline before creating an idempotent plan. Once
admitted, the scheduler dispatches without another manual click and resumes an
interrupted Start plan after restart.

The inspector renders the complete Markdown objective and acceptance criteria
once, real record-backed task states/reasons, and recorded plan/attempt/activity
data. Done when remains visible; Details, Activity, and the full JSON
specification start closed. The split uses current pane geometry and persists
explicit resize choices. See [spike 021](.agents/docs/spikes/021-tasks-start-continuation.md)
and its [native observation record](.agents/docs/evidence/021-tasks-start-continuation/native.md)
for implementation checks and the still-pending Desktop/Terra review.

## How we build each spike

Use these contracts to build LAZERS itself. Until automation exists, apply them manually. Start each spike with a small task record in its change description:

```text
Question:       One uncertainty this spike resolves.
Increment:      Smallest usable behavior added to the previous retained spike.
Scope:          Starting revision, allowed writes, dependencies, and exclusions.
Acceptance:     Observable result and the evidence required to prove it.
Execution:      Native worker route, optional persona/skill suggestions, dependencies, and context references.
Usage:          Actual usage, trajectory records, provider/model limits and unknown costs.
Verification:   Checks at the completion boundary and invalidation conditions.
Outcome:        Artifact, measurements, unresolved issues, retain/revise/discard.
```

Do not generate arbitrary caps to fill out a task. Ask only questions that change scope, acceptance, or authorization. Implement one increment and verify it at the completion boundary. A discarded experiment still delivers evidence answering its question.

Retain a small working increment or a useful finding before starting dependent work. Extend the previous retained slice; avoid speculative scaffolding. Record reusable knowledge only when it will reduce later work. Route any development or verification server through Portless, following repository guidance.

## Build order for progressive dogfooding

The first useful slice is an Architect we can use inside OpenCode Desktop to specify the remaining plugin work. Continue from the [next phase handoff](.agents/docs/handoff.md). Follow this order:

| Stage                          | Build                                                                                                                                                                                         | Exit evidence                                                                                                                       |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 1 API reference                | Maintain a single-page lookup of the entire public API surface in [.agents/docs/opencode-api.md](.agents/docs/opencode-api.md), with concise summaries and direct authoritative source links. | Every server/Desktop/TUI/RPC/client/SDK/HTTP surface indexed; experimental APIs and platform boundaries identified.                 |
| 2 Scaffold and stack decisions | Create the smallest loadable plugin and useful directory structure. Separate required tooling from optional additions. Review concrete choices with the architect before fixing the stack.    | The plugin typechecks and loads; the local workflow is documented; consequential stack choices are answered.                        |
| 3 Task format and Architect    | Define the minimal structured task format, its validation, and the Architect agent. It inspects relevant code, asks material questions, and produces scoped tasks with acceptance evidence.   | A clear request yields a valid task; an ambiguous request yields focused questions. The Architect is available in OpenCode Desktop. |
| 4 Build through the Architect  | Use our own Architect inside OpenCode Desktop to specify and dogfood each remaining increment. Apply the spike record and completion boundary above.                                          | Real plugin changes are specified with our task format, implemented, verified, and used to improve the next spike.                  |

During stage 4, choose the next increment from observed friction: trajectory instrumentation, verification, repair, measurement, recovery, dependency scheduling, or desktop controls. The Architect specifies that increment before implementation and the scheduler runs admitted work.

The target Architect flow above guides these increments: enable current web research and, where useful, bounded investigation/research specialists; support feature plans with task dependencies and overall acceptance; add admitted dispatch; then deliver durable outcomes and validated repair/reschedule/replan decisions. Keep each addition independently usable and verified in Desktop. Use current native catalog and user preferences as route-selection advice; do not hard-code model assignments to task personas or infer a global ranking.

Cache affinity, bounded memory, hashline editing, and selective compound learning remain separate experiments. Each needs a stated hypothesis, a fixed comparison, and a retention criterion.

Source: [Agent Harness Solutions conversation](https://chatgpt.com/share/6ae566ed-4b30-83ea-9d5d-23d85c7c4ae4). The [original design brief](.agents/docs/sources/original-design-brief.md) and [visible source transcript](.agents/docs/sources/agent-harness-solutions.json) are retained locally with fetch provenance. The contracts operationalize its final mission; the spike sequence is the proposed implementation path. Current user decisions take precedence over historical examples.
