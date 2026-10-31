# opencode-lazers intent and contracts

**Turn developer intent into accepted software changes with the least necessary reasoning, orchestration, human intervention, and compute.**

`opencode-lazers` is an OpenCode plugin for architects who know what they want built and need consistent, affordable execution. LAZERS means specifying the target, compiling the work, and executing with precision. Success is completed work per dollar and hour, subject to the repository's quality standards.

The user owns intent. Architect turns it into a verified plan and makes orchestration decisions when judgment is needed. The runtime owns execution policy and task state. Workers implement the change.

## Architect experience and authority

The user selects **Architect** from the Desktop agent dropdown before starting a session and describes the feature they want. Architect carries that request through planning, dispatch requests, and any decisions needed to reach acceptance:

1. **Understand the feature.** Determine what information is needed to specify successful work. Inspect the relevant codebase and research current, relevant external information. Use the host's structured question tool when missing information changes the requirements, scope, acceptance, or verification. A clear request proceeds without an unnecessary interview.
2. **Gather evidence.** Repository investigation and web research may be delegated to separate investigator and researcher subagents, each with a model selected for its cost and fit. Their assignments are bounded questions with budgets and expected evidence. Repository findings identify paths/revisions; web findings cite primary sources and distinguish current facts from assumptions. Architect reconciles the findings into one coherent plan. Research delegation is optional; it must earn its cost.
3. **Define done before dispatch.** Produce the series of tasks the feature requires, with dependencies, permitted write scopes, explicit acceptance assertions, verification procedures, and overall feature acceptance. One task is sufficient when the work is self-contained. A feature that needs several tasks must have a clear integration and verification order.
4. **Request execution.** Once material questions are resolved, Architect submits the plan and requests dispatch through runtime tools. The runtime validates and admits it, resolves models/permissions/resources, reserves budgets, and dispatches eligible work. Sufficiently specified and authorized work needs no extra approval ceremony.
5. **Return for decisions.** The runtime records completion and failure messages durably and delivers them to Architect with the relevant task/revision, evidence, failure reason, and remaining budgets. Architect can request repair, rescheduling, or replanning when those choices need reasoning. It can ask the user a focused question when new ambiguity or authorization is required. Revised scope or acceptance produces a revised specification.

Architect does not run or maintain the task state machine. Deterministic runtime rules handle state transitions, dependencies, concurrency, verification, configured repair/retry behavior, cancellation, and budget accounting. Routine progress and completions that merely unblock an already-defined task do not require a model call. Wake Architect when a decision is needed, a task group needs synthesis, or the feature needs its final user-facing result. Architect's decisions return through validated runtime commands; it cannot directly mark a task accepted or reset attempts/budgets.

This is the required product flow. Architect resolves requirements and submits work for scheduler execution; proposal-only and persist-only handoff modes are not product alternatives. The current Desktop slice supports repository inspection, focused questions, and submission/retrieval of one task, so end-to-end dogfooding is blocked on the execution runtime. Web research, specialist subagents, task graphs, dispatch, completion/failure delivery, and repair/reschedule/replan commands remain implementation gaps. Its current permission restrictions describe incomplete implementation, not a fallback workflow or the final product's authority.

## Operating principles

- **One entry point.** Select Architect, describe a feature, and let it gather evidence, resolve material ambiguity, define done, and request execution. A sufficiently specified request needs no interview or additional approval ceremony.
- **Reason where it helps.** Architect specifies work and resolves orchestration decisions; specialists investigate/research and workers implement. Deterministic code admits tasks, selects resources, dispatches workers, schedules verification, and stops execution. Progress events do not trigger supervisor model calls.
- **One implementation worker by default.** Split work only when independently verifiable increments or real dependencies justify it. Multiple files alone do not justify multiple workers. Optional investigator/researcher subagents have separate bounded assignments and model choices.
- **Knowledge, policy, and procedure have different owners.** Skills supply knowledge; runtime rules enforce policy; executable checks produce evidence. Required behavior must not depend on the model remembering prose.
- **Verify at meaningful boundaries.** Complete the scoped implementation, then run the necessary checks. Earlier targeted checks are appropriate when they inform implementation or protect a risky operation.
- **Use model-based execution policy.** Record actual usage. Budget decisions come from resolved model policy; do not invent token, time, tool-call or spend caps. No execution budget is currently configured. Verification and self-review retain their specific bounded procedures.
- **Make additions earn their cost.** Keep a capability only when evidence supports its benefit. Preserve useful decisions, checks, and tooling without imposing a retrospective on every task.

## Core contracts

These are target contracts, implemented progressively rather than prerequisites for first use. The first Architect can produce tasks while a human applies execution policy. Each dogfood spike moves a proven responsibility into the runtime.

### 1 Task specification

The compiler returns either a valid `TaskSpec` or focused questions identifying what prevents execution.

| Field        | Required meaning                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------ |
| Identity     | Stable task ID, specification revision, repository, and starting revision                        |
| Intent       | Observable objective, explicit exclusions, constraints, and assumptions                          |
| Scope        | Relevant context references and permitted write paths                                            |
| Acceptance   | Identified behavioral assertions, each mapped to required evidence or an explicit human decision |
| Requirements | Required capabilities and skills, verification procedures, risk, and policy reference            |

Unresolved material ambiguity prevents admission. A worker cannot silently expand scope or redefine acceptance. New evidence that changes the work produces a revised specification.

### 2 Work decomposition

A `TaskGraph` contains versioned specifications and dependency edges. Every task contributes to the overall objective. Reject duplicate IDs, missing dependencies, cycles, and undefined integration order. Serialize conflicting write scopes; isolated worktrees do not eliminate integration conflicts.

Use one task for self-contained work and a series of tasks when the requested feature requires it. Add parallelism only when tasks have compatible interfaces, independent write scopes, and a measured advantage. Accept the graph only after its combined result meets overall acceptance. The initial implementation stores individual tasks; graph support is a later increment.

### 3 Execution policy

Admission resolves a `TaskSpec` and versioned policy into a recorded `ExecutionPlan`: agent, model and provider, skills, tools and permissions, context, workspace, verification schedule, and budgets. Given the same inputs and capability snapshot, policy resolution produces the same plan. Architect recommendations are inputs; runtime policy makes the final selection.

Required skills must resolve to the intended source and version and reach the worker before implementation. Record selection provenance. Missing or denied requirements stop admission. Apply this guarantee to delegated, synthetic, resumed, and compacted sessions as those paths become supported.

Budget policy belongs to model selection and resource planning. No model-based budget policy is configured yet; historical Architect-generated limits do not stop execution. Measure tokens, time, tool calls and retries, and report unavailable equivalent cost honestly. Future model-based policy must preserve consumed usage across continuation and repair.

The worker returns an artifact reference, changed files, evidence references, and unresolved issues. It cannot certify its own completion or launch subagents. Implementors retain normal OpenCode coding capabilities, including Code Mode, shell, editing and available native LSP/diagnostics, under user/project policy. Their ContextPacket focuses the work; it does not limit permitted reads to writeScope. Runtime enforces actual write scope, budgets, verification and acceptance and owns all task dispatch and implementation parallelism.

Architect can request bounded code investigation or current-web research from internal specialist roles. Runtime admission resolves the approved agent/model/variant and reserves resources before dispatching the native child. Specialists are subagent profiles, not extra human-facing primary agents. They do not recursively delegate. Research and implementation use the same admitted-dispatch boundary; unrestricted native child spawning is not a cost-control substitute.

### 4 Verification and completion

The runtime owns this lifecycle:

```text
draft → ready → running → verifying → accepted
                             ↓
                          repairing → verifying
```

`ready` requires a valid specification and admitted plan. Verification failure permits one repair by default, within the remaining budget. Cancellation, exhausted budgets, execution failure, or a missing prerequisite end the attempt as `cancelled`, `exhausted`, `failed`, or `blocked`, with evidence and a concrete next action. Continuing requires an explicit new attempt; counters do not silently reset.

`accepted` means all acceptance evidence exists, required checks pass, the diff respects scope, and required human decisions are resolved. Tests passing and a worker saying “done” are insufficient. Acceptance identifies the exact resulting revision or artifact; merging or publishing remains a separate action.

Reuse a verification result only for the same relevant code, inputs, command, and environment. Edits or integration that invalidate those inputs invalidate the result. Repair receives the specific failure; repeat checks whose evidence became invalid.

Completion/failure delivery and Architect decisions are separate from lifecycle transitions. Persist the outcome and evidence before notification, and prevent duplicate or stale notifications/commands from dispatching work twice. Apply configured repair or retry rules without a model call when the response is already defined. Re-enter Architect when the failure requires a new approach, changed dependencies or scope, or a user decision. A reschedule or revised plan must pass admission and retain prior attempts and consumed budgets; it does not silently restart a loop.

### 5 Context and memory

A `ContextPacket` supplies concise repository rules, the specification, selected skills, relevant interfaces and findings, and their source revisions. Reuse valid findings; invalidate stale ones. Deliver required guidance without repeatedly appending duplicate instructions.

Persistent memory retrieval is bounded and relevant. Durable decisions retain provenance. Stable prompt prefixes may improve provider caching, but reported cache usage must demonstrate the benefit; separate sessions do not imply shared caches.

The [Repomix strategy](.agents/docs/repomix-strategy.md) applies this contract mechanically: reuse a workspace-sensitive index, filter relevant implementations/interfaces/tests/rules, count and bound the packet, and deliver it at dispatch. Full source, compressed outlines and structure-only entries serve different needs; workers retain their normal tools and can request more evidence. Architect establishes repository facts before asking avoidable questions. Indexing and focused retrieval should reduce repeated exploration, rather than add a mandatory research ceremony. All 26 canonical English guide pages were reviewed; a local library probe reduced selected submission context from 80,702 to 6,807 content tokens. Production integration and total cost/quality benefits remain to be verified through Desktop.

### 6 Measurement and learning

A `RunRecord` links specification, policy, context, model/provider versions, attempts, state transitions, artifacts, and evidence. Record tokens, reported cache usage, cost, elapsed time, tool calls, verification time, retries, and human interventions. Distinguish missing measurements from zero.

Compare fixed tasks from the same starting revisions with the same acceptance criteria, tools, and quality gates. Include failed attempts and repairs in total cost and time. Report acceptance rate, cost per accepted task, and accepted tasks per hour together. Repeated trials establish whether an optimization helps; one successful run establishes feasibility only.

## Platform boundary

Build on OpenCode and its native provider access. Use the user's ChatGPT subscription for current dogfooding; OpenRouter supplies equivalent API price estimates and may supply execution models when authorized. Reuse native sessions, structured questions, tools, skills, permissions, persistence, and worktrees where validated. Keep policy and lifecycle logic separate from thin host and desktop adapters.

The transcript's API examples, model prices, and performance targets are research leads. Pin and test the actual host and SDK before depending on specific hooks or desktop extension points. Unsupported enforcement paths must be exposed before enabling them.

## Development scaffold

An optional parallel [WebGPU experiment](.agents/docs/webgpu-api.md) adds a Desktop model cache, queued local questions and typed decisions, and native agent tools in this same package. Settings → LAZERS covers the whole plugin and provides a local-inference master switch plus independent capability switches; `options.webgpu: true` seeds the initial master preference. The core task workflow works with local inference off. This experiment is independent of the main Architect dogfooding sequence. Build its Desktop entry with `bun run build:gui`. The API document records the native voice integration gap in OpenCode 2.2.5; the experiment does not replace the built-in voice controls.

The optional [task-hardening tool](.agents/docs/task-hardening.md), `lazers_verify_task`, checks task JSON and returns one targeted correction at a time. It allows three verification rounds total, advances revised concerns on equal-or-better scores, and continues at the limit with concerns retained. Architect uses it before ordinary submission when local Task review is enabled. Its quality benefit is the subject of the next [parallel evaluation phase](.agents/docs/parallel-task-review-evaluation.md).

```text
src/index.ts                         Effect server plugin adapter
src/architect.md                     Packaged Architect definition
src/architect.ts                     Validated definition and native agent registration
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

The scaffold targets the installed OpenCode CLI and Desktop 2.2.5 with `@opencode/plugin` 2.2.5. It exports TypeScript source directly; the server plugin needs no bundle step. Effect setup opens the task repository, registers native tools and Architect, writes a persistent `loaded` marker, and logs the host version/database path. The package includes its agent definition and registers it through `agent.transform().update()`, which creates missing agents in the pinned host. A packed artifact loaded and registered Architect in a clean project without an agent file. Desktop trials verify structured interviewing and persisted task submission; see the [capability and definition audit](.agents/docs/architect-validation.md) and [evaluation evidence](.agents/docs/spikes/006-architect-interview.md). Task execution and scheduling remain unimplemented.

Use the Bun version pinned in `package.json`, then run `bun install --frozen-lockfile`. The selected canary package is `1.4.4-canary.20261030.1`, verified as binary revision `1.4.4-canary.1+da867c60b`. Run native `bun fmt` to format, `bun fmt --check` to check formatting, `bun lint` to lint, and `bun check` to typecheck. `bun run verify` runs the non-mutating checks together.

Open this repository in OpenCode Desktop to discover the local plugin. LAZERS is one reusable package, dogfooded through the project-local loader. It stays private until a release is prepared. Run `bun test` for contract, persistence, and tool behavior tests.

| Tooling                                   | Status                                                                                 |
| ----------------------------------------- | -------------------------------------------------------------------------------------- |
| OpenCode and its V2 plugin SDK            | Required host and plugin API                                                           |
| Strict TypeScript                         | Checked by native `bun check`; matching TypeScript package retained for editor tooling |
| Bun                                       | Selected runtime, package manager, and test runner                                     |
| Formatter and linter                      | Native Bun tooling; no separate Biome, ESLint, Prettier, or Oxlint dependencies        |
| Task schema validator                     | Zod 4.6.7, generating JSON Schema for the submission tool                              |
| Vite, Solid, and a GUI bundle             | Optional, for a later custom Desktop panel                                             |
| Orchestration framework or memory service | Add only when a dogfood spike establishes the need                                     |

The server uses OpenCode's Effect-native SDK. `@opencode/plugin` and `effect` are pinned peer/dev dependencies because OpenCode supplies them at runtime. Tasks use Bun's native SQLite adapter in a plugin-owned database, separate from OpenCode's private tables. The default file is `${XDG_DATA_HOME:-~/.local/share}/opencode/plugins/lazers/tasks.sqlite`; a plugin `dataDirectory` option can supply an absolute override. Canonical project directories partition tasks and share them across that project's worktrees; each task records its original worktree and session. The native `lazers_submit_task`, `lazers_get_task`, and `lazers_list_tasks` tools validate input and explicitly check their permission actions. A successful submission records `submitted`; it does not admit or start execution. Tasks are immutable in this slice. Token, equivalent cost, elapsed time, tool-call, retry, and repair limits are recorded requirements, not yet runtime-enforced budgets.

### Desktop tryout

1. Open this folder in OpenCode Desktop and start a new session. It should select **architect**; existing sessions keep their previous agent and need manual selection. Use your connected **Sign in with ChatGPT** subscription and select the model/reasoning setting in Desktop. The project deliberately does not pin a model or switch an existing session's provider.
2. Give Architect a clear real request, for example: “Specify the smallest next increment that makes task submission safe to retry after a lost response. Preserve SQLite persistence and the read-only Architect boundary. Do not implement it.” Expect inspection followed by `lazers_submit_task` and a durable task UUID, with scope and evidence. This request addresses a current limitation: retries can create duplicate tasks.
3. Ask “Retrieve task <UUID>.” Restart Desktop/the connected host, reopen the repository, and retrieve that UUID again. Expect the same stored specification, without a new submission.
4. Try a materially ambiguous request, such as “Add task export for our external system,” without naming the system or interface. Expect focused questions before submission. Also verify that Architect cannot edit files, run a shell, or launch another agent. These operations are denied by its permission rules and are outside its role.

Record the Desktop/host versions, selected subscription model and reasoning setting, task UUID, restart/retrieval result, and any tool/permission failures. This is the acceptance evidence for [spike 004](.agents/docs/spikes/004-desktop-architect.md); CLI discovery alone does not complete it. The agent has a host-enforced 12-step limit per user input. No paid OpenRouter verification is authorized. Equivalent API costs can later be estimated from measured tokens and dated OpenRouter prices for the same model; distinguish cached/uncached input, output, and unknown usage. A displayed subscription charge of zero is not an equivalent cost estimate.

## Tasks panel — retained first pass

Open **Tasks** from the session's extra-panel list or `/tasks`. It is an optional,
closable native tab. The default view shows tasks submitted from that session;
the quiet scope menu switches to the current canonical project's tasks. Search
and selection use the same bounded project-scoped read service as task tools.
Done when remains visible; Details and Activity start closed. Descriptions use
native Markdown, and the full JSON specification has a collapsed, height-limited
scroll area with native highlighting and copy support.

This first pass displays real immutable `submitted` records. Dependency/waiting
reasons, grouping, execution state and measured evidence will come from the
durable runner. Typed Code Mode read adapters exist, but normal Architect
activation awaits native confinement/overlap verification. See the
[first-pass outcome and deferred gates](.agents/docs/spikes/008-focused-tasks-panel.md).
The next increment should advance the actual durable runner and its Architect
decision loop, with panel refinements alongside that work.

## How we build each spike

Use these contracts to build LAZERS itself. Until automation exists, apply them manually. Start each spike with a small task record in its change description:

```text
Question:       One uncertainty this spike resolves.
Increment:      Smallest usable behavior added to the previous retained spike.
Scope:          Starting revision, allowed writes, dependencies, and exclusions.
Acceptance:     Observable result and the evidence required to prove it.
Execution:      One worker, explicit model/skills/tools, and context references.
Usage:          Resolved model policy when configured; actual usage and unknown costs.
Verification:   Checks at the completion boundary and invalidation conditions.
Outcome:        Artifact, measurements, unresolved issues, retain/revise/discard.
```

Do not generate arbitrary caps to fill out a task. Ask only questions that change scope, acceptance, or authorization. Implement one increment, verify it at the completion boundary, and use at most one bounded verification repair by default. A discarded experiment still delivers evidence answering its question.

Retain a small working increment or a useful finding before starting dependent work. Extend the previous retained slice; avoid speculative scaffolding. Record reusable knowledge only when it will reduce later work. Route any development or verification server through Portless, following repository guidance.

## Build order for progressive dogfooding

The first useful slice is an Architect we can use inside OpenCode Desktop to specify the remaining plugin work. Continue from the [next phase handoff](.agents/docs/handoff.md). Follow this order:

| Stage                             | Build                                                                                                                                                                                               | Exit evidence                                                                                                                       |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 1 API reference                   | Maintain a single-page lookup of the entire public API surface in [.agents/docs/opencode-api.md](.agents/docs/opencode-api.md), with concise summaries and direct authoritative source links.       | Every server/Desktop/TUI/RPC/client/SDK/HTTP surface indexed; experimental APIs and platform boundaries identified.                 |
| 2 Scaffold and stack decisions    | Create the smallest loadable plugin and useful directory structure. Separate required tooling from optional additions. Review concrete choices with the architect before fixing the stack.          | The plugin typechecks and loads; the local workflow is documented; consequential stack choices are answered.                        |
| 3 Task format and first Architect | Define the minimal structured task format, its validation, and one default Architect agent. It inspects relevant code, asks material questions, and produces scoped tasks with acceptance evidence. | A clear request yields a valid task; an ambiguous request yields focused questions. The Architect is available in OpenCode Desktop. |
| 4 Build through the Architect     | Use our own Architect inside OpenCode Desktop to specify and dogfood each remaining increment. Apply the spike record and completion boundary above.                                                | Real plugin changes are specified with our task format, implemented, verified, and used to improve the next spike.                  |

During stage 4, choose the next spike from observed friction: skill admission, worker dispatch, budget enforcement, verification, bounded repair, measurement, recovery, dependency scheduling, or desktop controls. The Architect specifies that increment before implementation. A custom desktop panel and a complete execution engine are not prerequisites for using the native Desktop agent.

The target Architect flow above guides these increments: enable current web research and, where useful, bounded investigation/research specialists; support feature plans with task dependencies and overall acceptance; add admitted dispatch; then deliver durable outcomes and validated repair/reschedule/replan decisions. Keep each addition independently usable and verified in Desktop. Select specialist models through execution policy according to cost and fit rather than hard-coding one model for every role.

Model routing, cache affinity, parallel workers, bounded memory, hashline editing, and selective compound learning remain separate experiments. Each needs a stated hypothesis, a fixed comparison, and a retention criterion.

Source: [Agent Harness Solutions conversation](https://chatgpt.com/share/6ae566ed-4b30-83ea-9d5d-23d85c7c4ae4). The [original design brief](.agents/docs/sources/original-design-brief.md) and [visible source transcript](.agents/docs/sources/agent-harness-solutions.json) are retained locally with fetch provenance. The contracts operationalize its final mission; the spike sequence is the proposed implementation path. Current user decisions take precedence over historical examples.
