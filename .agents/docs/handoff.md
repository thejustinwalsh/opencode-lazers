# LAZERS next phase handoff

## Desktop driver checkpoint — 2026-10-31, 17:25 UTC

Current main includes the Tasks browser repair `a53dba3`, native interaction
proof `7a9d009`, Start continuation race repair `ce6174d`, and shared first-node
baseline repair `6da13a5`. The combined suite passes 168 tests / 1,493 assertions
plus formatting, lint and typecheck. Main was loaded through supported native
`location.reload`; LAZERS is active. Project-native Architect is Sol High and
implementor is `openai/gpt-6-luna#max`.

Read [native Desktop evidence](evidence/021-tasks-start-continuation/browser.md)
and [runner source review](evidence/021-tasks-start-continuation/source-review.md).
The narrow panel, scrolling, split resize, close/reopen restoration and manual
Start were exercised in Desktop. Start admitted existing Repomix task `f55e7013`
under plan `aa71e2c0` without duplicating it; worker execution remains queued.

Actual Luna Max child `ses_4f015aa635c64fd4a9af9d2effa8484a` is still implementing
parallel-runner task `2958fa32` in its owned native worktree (attempt
`efb203d8-1c32-4995-a6c6-96a2d218a330`). Its result needs review/merge preserving
the newer Start and baseline repairs. Native parallel overlap is not yet proved.
The existing product graph `b50a1a71` has disjoint initial observation/speech
work for that dogfood. No duplicate demonstration tasks are needed.

Linked-worker Session Tasks visibility and completed-plan finalization delays
are recorded against their existing tasks. Inference remains enabled and
unchanged; the previously requested freeze investigation was report-only.


## Latest authority correction

Architect has normal OpenCode tool access, including Code Mode, research, shell,
editing and Git. The blanket denial/allowlist has been removed in favor of native
agent defaults, preserving host/user/project permissions. Architect reviews,
repairs and integrates completed work; runtime owns task dispatch and state.
Historical read-only Architect restrictions below are superseded.

## Current result — first worker accepted and merged

Read [execution report](spikes/011-runner-execution.md) first. Retry-safe submission
task `5f5743c3-1bd0-4a53-a86b-a347dd961e1a` was completed by a real native Sol High
worker, accepted by runtime, reviewed and merged into main as `3b4c105`. Worker
artifact: `38be10db9c398e978c68638fc8b7105070cd56cb`. Combined checks now pass
120 tests / 883 assertions, formatting, lint and typecheck pass at task-guidance
baseline `28c4e67`; the GUI build passed. Four original tasks remain open.

Desktop Architect recorded integration. Plan
`6d1d3afe-f236-4a33-a5a2-86328e838249` reached `integrated`, version 22. Its
`worktree-remove` effect reports `removed: true, native: true`; Git inventory
lists only main and the owned ~541 MiB directory is gone. No manual deletion or
database transition was used.

Cleanup implementation and behavior tests are present: native inventory,
non-forced removal, active/dirty/unmerged protection, visible blocked state,
explicit retry and recovery. Native removal succeeded. Per-worktree ancestry
also protects clean unmerged commits from abandoned attempts.

Retained visible worker trace and token-only per-message pricing are under
`evidence/011-runner-execution/`. Worker-only OpenRouter equivalent: approximately
$1.04; subscription usage, not a charge or total project cost. This failed-then-
repaired run establishes feasibility, not an efficiency improvement.

The older sections below are historical snapshots. Current code and this section
supersede their unimplemented, untracked, step-cap and budget statements.

## Task-quality research and current Desktop trial

Read the [implementor research synthesis](implementor-profiles.md) and its four
source-linked specialist reports. The three classifications are UI, Systems and
Small task / Refactoring. Runtime profile routing is not implemented yet. Public
benchmarks seed matched local trials; they do not establish universal rankings.

Commit `28c4e67` adds optional advisory `guidance`, outcome-first instructions,
balanced self-review, explicit plan `workerModel`, shorter worker dispatch and
required-skill delivery through native session instruction entries. Required
nonempty native skill/permission acceptance remains to be observed.

Fresh Desktop session `ses_e6e0e6239ffdtzIePMeJ1sHA4l`, “LAZERS attempt trajectory
and usage”, runs Architect on Sol High. It submitted read-only trajectory/usage
task `71e53745-0ce8-4798-b453-17f260d03aa0`; requested implementor is
`openai/gpt-6-luna`, variant `max`. Driver answered material choices: tool + JSON,
recorded costs only, redacted visible content with acknowledged arbitrary
prose-secret detection limits. Inspect current plan/dispatch before continuing;
submission alone does not establish execution. Planning context exceeded 110k
and one oversized local review request was rejected before three review rounds.
Retain this overhead as evidence, not a prompt-efficiency success claim.

All model prompts remain through Desktop computer use. A transient automation
lock report was resolved after reconnect/unlock; Desktop control is available.

## Latest execution corrections

Read [workspace policy](workspace-policy.md). Serial tasks should default to
native children in the shared checkout; parallel tasks use native worktrees.
Owned worktrees require recorded integration, reconciliation and cleanup after
merge. Selection and cleanup are implemented and behavior-tested; native
post-merge cleanup completed in the first integrated plan above.

The first worker was misrouted because native child creation ignores `location`
when `parentID` is supplied. It was cancelled through Architect. Six edited files
were preserved in its assigned worktree; a backup patch is at
`/private/tmp/lazers-misrouted-worker.patch`. Main was restored from its committed
checkpoint. Use native `session.move` before prompting isolated workers.
Workers now receive prose directions to the existing `lazers_get_task`, whose
implementor response renders instructions and retains typed output. Do not inject
or repeatedly send raw JSON ContextPackets as user messages.

The user rejected guessed execution budgets. Preserve measured usage and
trajectories; do not enforce historical task token, time, tool-call or spend
numbers or invent replacements. Provider/model capacity limits remain native.
New tasks may omit limits. Schema validation,
Architect self-review/System One, explicit cancellation, and bounded verification
procedures remain useful and are retained.

Use OpenCode's native `ctx.worktree.create/list/refresh/remove` lifecycle. The
native API's `branch` field is the starting ref; its `directory` is a parent
directory and its returned actual directory may differ after collision handling.
LAZERS should not implement another worktree strategy. Runtime records the actual
directory and starting ref. The current driver reviews and integrates accepted
worker commits into main; the user waived PR and human-review stops for dogfooding.

## Governing correction — source hashing removed

The user's latest direction supersedes historical source-hash, fingerprint and
evidence-receipt requirements in earlier task records and research artifacts.
Repository investigation uses ordinary source reads and focused Repomix context;
submission must not depend on unchanged repository hashes or index receipts.
JSON schema validation stays. Architect self-review with `lazers_verify_task`,
including the System One gut check, stays. This is self-review, not approval from
another model. Completion evidence is passing checks and observed app behavior.

Source is now committed: baseline `b3b47fc`, worker-commit preservation `beae6c3`,
native RPC encoding repair `b13ea0e`. The runner and context service are implemented
in a first pass; native worker execution and full original-task acceptance remain
unverified. Older unimplemented/untracked statements below describe earlier phases.
Native Architect submitted additional task `75f62b3b-4cd2-4a3a-b17b-30d22c37aaad`
with rejected source-receipt requirements; do not execute those requirements.
Continue real worker dogfooding through Desktop with the corrected scope.

## Repomix and role alignment — 2026-10-31

Read the [Repomix strategy](repomix-strategy.md) before implementing context or
dispatch. All **26 canonical English guide pages** were fetched and read; the
[coverage manifest](evidence/010-repomix/docs-coverage.json) retains URLs, dates,
page hashes and per-page decisions. A real pinned-Bun/Repomix 1.18.1 probe counted
80,702 tokens across 68 source/test/guidance files versus 6,807 across seven
submission-related files and 1,081 for their structural outline. Selection is a
91.6% content reduction in this fixture, not measured accepted-task cost savings.

The original shared conversation was recovered by **direct HTTPS fetch**.
[Original brief](sources/original-design-brief.md) and [visible source transcript](sources/agent-harness-solutions.json)
are now retained with source URL, message IDs, fetch time and raw-response hash.
Use these copies; do not repeatedly ask the user for the missing brief. Historical
API examples require current verification and current user decisions take precedence.

Desktop Architect specified Repomix investigation task
`313174d7-8358-4911-b006-1a1f25ca779c` and linked implementor/context supplement
`9dde2941-541a-43cd-b426-283854bcf403`, both revision 1, submitted, not implemented.
Their envelopes are in `evidence/010-repomix/`. Do not misreport production
Architect indexing or specialist dispatch as enabled from this research/probe.

Latest user clarification governs implementation: scheduler/runtime owns task
dispatch as well as execution and parallelism. Architect requests narrowly named
internal specialist subagents through cost-controlled runtime admission/dispatch;
these are not extra primary agents for humans or an unbudgeted raw-subagent lane.
Implementors keep normal Code Mode, shell, editing and available native
LSP/diagnostics under project/user policy. They cannot launch subagents. Runtime
enforces scope/artifacts, budgets, verification and acceptance. Do not copy the
Architect's read-only allowlist onto implementation workers. Shared Repomix tools
serve permitted reads beyond writeScope and reuse source-versioned ContextPacket
material. Keep source/outline/navigation distinct and deliver selected evidence
mechanically instead of forcing repeated agent discovery or full-repository prompts.

## Latest runner dogfood — 2026-10-31

The native Desktop Architect (OpenAI GPT-6.1 Sol High) specified and submitted the
durable graph runner as task `94298112-1c6c-44ba-87f6-a06533eafa59`, revision 1,
status `submitted`. It retrieved the record successfully; exported retrieval and
read-only SQLite inspection agree, and the session-scoped Tasks panel displays it.
See [specification dogfood](spikes/009-runner-specification.md) and its focused
evidence before starting runner implementation. The runner remains unimplemented.

User-resolved scope includes dependency graphs now, serial workers, isolated
worktrees, stop-on-uncertain recovery, relational SQLite links, deterministic
overlap/readiness/session audits, explicit orphan reassignment, and shared
Architect/panel audit controls. Idle unarchived sessions keep ownership. Flow and
Timeline remain deferred. Do not reopen these decisions or add a handoff mode.

Two existing tool-adapter bugs were repaired: undeclared structured output from
submit/list, then retained callbacks using a closed registration connection.
Tools now acquire a fresh connection per execution after permission assertion;
WAL and a 5000ms busy timeout remain enabled. Preserve these regressions. Opening
a connection before operating is distinct from retrying a possibly committed
write. Native submission/retrieval confirms the repair in host. Full suite:
65 tests / 386 assertions; native formatter/linter/typechecker pass.

The saved task requires capturing a real source baseline before implementation:
HEAD is still the initial commit and does not represent the untracked plugin
source. Preserve concurrent WebGPU changes. Its eight-hour/$150-equivalent limits
are proposed execution budgets, not paid-inference authorization or actual cost.

## Objective

Deliver the structured task format and first Architect agent, then use that agent inside OpenCode Desktop to specify subsequent plugin work. Follow the user's order: API reference → scaffold and stack decisions → task format and Architect → continued development through our Architect.

Read [repository instructions](../../AGENTS.md), [intent and contracts](../../README.md), and the [complete OpenCode API lookup](opencode-api.md) first. The lookup covers the full platform, including Desktop, TUI, RPC, scheduling, client/SDK, and every HTTP operation. Keep it a concise source-linked index when updating it.

## Selected stack

| Part                 | Decision                                                                                |
| -------------------- | --------------------------------------------------------------------------------------- |
| Package              | One reusable `opencode-lazers` package, dogfooded locally; private until release        |
| Language and runtime | Strict TypeScript and Bun                                                               |
| Bun version          | Published package `1.4.4-canary.20261030.1`; verified binary `1.4.4-canary.1+da867c60b` |
| Quality tools        | Native `bun fmt`, `bun lint`, `bun check`; `bun test` for behavior tests                |
| OpenCode             | CLI and Desktop 2.2.5; `@opencode/plugin` 2.2.5                                         |
| Server API           | Effect-native SDK; using Effect is approved                                             |
| Task contract        | Zod 4.6.7, generating JSON Schema for OpenCode tool input                               |
| Persistence          | Bun SQLite in a plugin-owned native data directory                                      |
| Provider             | ChatGPT subscription for now; estimate equivalent usage using OpenRouter model prices   |
| Architect authority  | Inspect the repository and submit validated tasks                                       |

The Effect adapter, Zod task contract, SQLite persistence, submit/get/list tools, and packaged primary Architect are implemented. The [feasibility and definition audit](architect-validation.md) validates the plugin path and identifies remaining gates. Desktop trials now establish model access, interviewing, and a real persisted task. End-to-end dogfooding remains blocked until the scheduler can execute submitted work and deliver outcomes. Do not add proposal-only or persist-only handoff modes to work around that missing runtime.

## Target Architect experience clarified by the user

The user selects Architect from the Desktop agent dropdown and describes a feature. Architect determines the information needed, investigates the codebase, researches current relevant web sources, and uses structured questions for material gaps. Investigator and researcher may be separate subagents with their own cost/fit model assignments and bounded budgets. Architect produces the tasks/dependencies plus explicit definitions of done, verification, and overall feature acceptance, then requests dispatch through runtime tools.

The runtime owns admission, dispatch, state transitions, verification, dependencies, accounting, and configured retries/repairs. It durably delivers task completion/failure messages and brings Architect back when reasoning is required for repair, rescheduling, replanning, a user question, or final synthesis. Architect issues validated commands; it never owns the running-task state machine or unilaterally accepts work/resets budgets. Routine progress and deterministic continuation do not trigger model calls.

These are target responsibilities, not capabilities already present. The current single-task, inspection/submission-only permissions are an incremental boundary. Web research, bounded specialists, feature task graphs, dispatch, outcome delivery, and decision commands remain to be specified through Architect and implemented progressively. The README's Architect experience and authority section is the governing product contract.

## Current repository state

- `src/index.ts` exports an Effect `Plugin.define` with ID `lazers`; setup opens the task database with scoped cleanup, registers tools, writes `loaded: true`, and logs the host version/database path.
- `.opencode/plugins/lazers/index.ts` re-exports the package implementation for project-local discovery.
- `package.json`, `bun.lock`, strict `tsconfig.json`, `bunfig.toml`, `.editorconfig`, and `.gitignore` exist. The `verify` script runs formatting checks, lint, and typechecking. Native command names are not shadowed by package scripts.
- `.agents/docs/opencode-api.md` was audited against the pinned release: 169 HTTP operations, 32 resource groups, Desktop/TUI extension inventories, and 90 versioned source links.
- Native quality checks and actual OpenCode 2.2.5 host discovery/activation passed; see [spike 001](spikes/001-effect-host.md). Desktop interviewing and persisted submission are now verified in [spike 006](spikes/006-architect-interview.md).
- `src/task.ts` defines strict proposals and runtime-owned submitted envelopes. Zod generates the submission JSON Schema and checks evidence references, identifiers, paths, and budgets. `submitted` does not mean admitted or running.
- `src/storage.ts` owns SQLite migration version 1. Default path: `${XDG_DATA_HOME:-~/.local/share}/opencode/plugins/lazers/tasks.sqlite`; plugin option `dataDirectory` accepts an absolute override. Canonical project paths partition tasks and share them across worktrees. Original workspace/session and unborn/committed Git provenance are retained.
- `src/submission.ts` validates before collecting provenance or writing. `src/tools.ts` registers `lazers_submit_task`, `lazers_get_task`, and `lazers_list_tasks`, with explicit permission assertions. The adapter uses native direct tools, so Code Mode is unnecessary.
- `src/architect.md` is the packaged primary agent definition with a 12-step limit per user input. The initial 529-word body was reduced to a 138-word baseline; Desktop evaluation subsequently tightened material-question handling. The current 171-word body resolves task scope/behavior/verification, asks only material task questions, then submits the specification. The runtime owns scheduling and execution. Proposal/persistence/handoff choices and a scheduler-availability preflight were both rejected and removed: neither changes what must be built. `src/architect.ts` validates the definition against the native schema and registers it through `agent.transform().update()`. The plugin supplies the agent without a repository agent file. Its current allowlist permits read/glob/grep/questions and the three task tools; execution is not yet available. Native permission assertions verified allowed/denied outcomes in a clean project. `opencode.json` selects the project default; installing elsewhere makes Architect selectable without forcing the default.
- Seventeen task/Architect tests (91 assertions) cover schema validation, portable exported path patterns, SQLite reopen, invalid submissions, project isolation, migration compatibility, Git provenance, tool behavior, permission denial before writes, and agent registration/replay isolation. No task execution engine, submission idempotency, or scheduler exists. Concurrent WebGPU work adds a separate optional GUI/inference slice; preserve that work and consult its own evidence.
- Git is on `main` with empty initial commit `b5da4ca`; scaffold files remain untracked. The commit was created while investigating Desktop project selection. Preserve the source work; missing `HEAD` remains a supported case in provenance tests.

## Implementation sequence

Use the README's spike record for each increment: one question, scoped change, explicit budgets, acceptance evidence, and at most one bounded repair.

1. **Host setup complete.** Effect entry point, pinned peer/dev dependencies, and actual project-local host activation are verified in spike 001.
2. **Task contract retained.** See [spike 002](spikes/002-task-contract.md).
3. **Persistence and submission retained.** See [spike 003](spikes/003-durable-submission.md). The native host loaded the Bun SQLite/tool adapter successfully. Unit tests prove reopen and rejection behavior; subsequent Desktop model trials persisted and retrieved tasks.
4. **Architect interviewing/submission verified in Desktop.** See [spike 004](spikes/004-desktop-architect.md). The user explicitly plans to load and exercise it in Desktop. Do not substitute additional CLI probes for that acceptance.
   **Packaging/definition audit retained:** [spike 005](spikes/005-architect-validation.md) and [capability audit](architect-validation.md). A tarball extracted outside the checkout registered Architect and the task tools in a clean project without an agent file. This corrects the earlier assumption that plugin transforms could only update existing agents.
5. **Desktop comparison retained.** Baseline Sol High, Luna Max, Luna Low, and final Sol High task/trace artifacts are linked from [spike 006](spikes/006-architect-interview.md). The final 171-word definition asked material questions and submitted task `1b774b28-c1a4-4df4-900f-fea015ea84bc` with discriminating restart/concurrency checks. The original baseline task was retrieved through Desktop after a real background-service restart. Use an Architect-produced task before implementing the next increment. Diverse unseen-feature evaluation remains unperformed; do not infer universal reliability.

After Desktop acceptance, have Architect specify a bounded next step toward the clarified experience. Priorities include current web research and useful investigator/researcher delegation, feature-level task dependencies/acceptance, admitted dispatch, and durable completion/failure delivery with repair/reschedule/replan commands. Do not treat today's denied research/delegation permissions as a permanent product decision or implement the entire orchestration system in one spike.

The user selected ChatGPT subscription access on 2026-10-31; use OpenRouter pricing only to estimate equivalent API costs and label these as estimates. Do not make paid OpenRouter verification calls. Confirm the connected subscription model and reasoning setting before model verification. The Luna 6 Max research agent used earlier does not determine the Architect's model.

## API facts that affect implementation

- `ctx.agent.transform().update(id, callback)` creates a missing agent in 2.2.5; there is no separate `add`. Both pinned core source/public adapter and the packed-plugin probe confirm it. Files/config remain alternatives. Preserve a compatibility check when upgrading.
- `ctx.storage` provides durable JSON key/value operations, not a public SQL handle or database path. Verify the native location and own the task database explicitly; do not access private host tables.
- Task submission can use JSON Schema/Standard Schema tools and RPC. The documented session-generation API returns text and has no schema-output parameter.
- The native experimental schedules API schedules session prompts. Dependency scheduling, admission policy, and acceptance remain LAZERS functionality.
- Native Desktop agents are usable without a custom GUI bundle. Desktop GUI extensions are available for later work through the experimental GUI API.

Follow the API lookup to the exact source definitions before writing integration code.

## Acceptance and verification

The phase is complete when Architect is usable in Desktop and submits a real task that validates, persists in SQLite, and can be retrieved after restart. A clear request should yield a scoped task without unnecessary questions; material ambiguity should yield focused questions. Invalid submissions must not persist as valid tasks. Verify the Architect's permission restrictions as well as its instructions.

Run `bun install --frozen-lockfile`, then `bun run verify`. Add meaningful `bun test` coverage for task validation, persistence/reopening, invalid submissions, and submission behavior. Capture actual Desktop/host verification evidence; importing the module alone does not prove host integration.

Most recent checks on 2026-10-31: lint and typechecking pass; evaluation files pass focused formatting. Full verify passed earlier, but the final run found formatting required in concurrently edited `src/webgpu/server.ts`; this evaluation did not alter that file. Full current suite: 29 tests / 154 assertions; focused task/Architect suite: 17 tests / 91 assertions. All four retained task envelopes parse with the production schema. Native permission assertions in the packed-plugin probe verify allowed/denied operations. The [Desktop evaluation](spikes/006-architect-interview.md) records selected subscription models, questions, persisted tasks, focused native-export traces, token totals, and dated API-equivalent estimates.

The current definition body is 171 words; the full file (including frontmatter) has SHA-256 `ecf2251fc6cff121da67d60cfa4d2571dc8f04f460655efb6c0f1eb9e94f0aab`. Luna Max and Low used the preceding 164-word version and asked about retry identity before submitting. Both plans substituted an in-process database reopen for a process restart; Low also omitted distinct-key acceptance. A generic requirement-to-acceptance and discriminating-check refinement followed. Final Sol High explicitly covers fresh-process/lost-response, concurrency, rollback, conflict/distinct keys, validation, isolation, permissions, and migration. This is one fixture across models; it does not prove that the prompt generalizes, and model/wording changes are confounded.

The final task is `1b774b28-c1a4-4df4-900f-fea015ea84bc`, status `submitted`; no retry implementation or execution is claimed. Isolated Luna/final test rows remain in `/private/tmp/lazers-interview-20261031`. Temporary evaluation plugin configuration has been removed; the normal database is active. Task `5f5743c3-1bd0-4a53-a86b-a347dd961e1a` was retrieved using native `lazers_get_task` through Desktop after the background service restarted; [focused evidence](evidence/006-restart-retrieval-trace.json) is retained.

Every evaluation prompt was driven through native Desktop, not CLI or service APIs. OAuth reconnection plus removal of obsolete global `provider.openai.api: "codex"` restored model access. The exported tool schema's Unicode regex was repaired using equivalent C0/C1 ranges. A concurrent WebGPU import failure left a rejected module cached; the user authorized the supported maintenance command `opencode service restart`, after which the repaired plugin loaded. This was host maintenance, not model-session driving.

The original task methodology governs: ask only when an answer changes what must be built. Proposal/persist/implementation choices and a scheduler-availability preflight were mistaken additions, rejected and removed. Do not reinstate them or add handoff modes as a runtime substitute. Current scope remains task definition and submission; missing scheduling capability is a product implementation boundary, not an extra interview question.

The [local decision-model recipe](local-decisions.md) documents provider registration, the existing System One protocol, and an advisory semantic checker. Its examples typecheck. No local model was started by this evaluation; concurrent WebGPU work has its own evidence. Structural validation cannot prove semantic completeness.

Use Portless for any project development or networked verification server, following `AGENTS.md`. Do not build a complete execution engine, parallel workers, memory system, or custom dashboard before the Architect can help specify that work.

## Task visibility direction — 2026-10-31

**First pass retained; user approved wrap-up:** See
[spike 008](spikes/008-focused-tasks-panel.md) for the exact outcome, verification
and deferred gates. Continue toward the durable task runner bound to Architect;
refine this panel as real runner/dependency/evidence data becomes available.
Do not continue polishing this pass or silently enable unverified authority.

Architect specified task
`2d955ffa-8b58-48c7-b34b-494b2af0d7fc` in native Desktop (Sol High); the envelope is
in `evidence/008-task-panel/task.json`. Shared canonical-project query/detail,
snapshot pagination, durable invalidation/polling and the Solid native Tasks
panel are implemented. Current Architect permissions have **not** been widened
to Code Mode; isolated native executor/overlap acceptance remains outstanding.
Do not mark the complete task accepted from UI or unit checks alone.

GPT-6.1 Terra High reviewed the approved image, connected Desktop capture and
source. Its corrections are in `design/task-panel/visual-contract.md` and
`panel-after-review.png`: optional, closable Tasks tab in the native extra-panel
list; quiet scope/search controls; content-aware initial list height; bounded
display excerpts; native Markdown and code; readable metadata behind disclosures.
The latest user correction keeps **Done when visible**, with three previews and
Show all; Details and Activity are collapsible and closed by default. The temporary
change collapsing Done when was reverted. Native close → extra-panel launcher →
reopen was verified. Dependencies/blocking reasons are absent from v1 task data;
do not invent a Waiting on value or pretend scheduling exists.

Full specification is a nested disclosure, closed by default, using native
`Ui.Code` JSON highlighting/copy in a keyboard-focusable independently scrolling
region capped at `min(24rem, 45vh)`. Native Desktop expansion and inner scrolling
were verified; `design/task-panel/full-specification.png` records the result.
The pinned public GUI SDK exports Markdown/Code, not a JSON tree component.
Terra's final comparison also caught an indistinct selection background; the
selected row now blends the reactive host text/background tokens for visibility.

Latest full suite: 44 tests / 260 assertions pass; lint/typecheck and GUI build
pass. Full `verify` stopped on formatting in concurrently edited
`.agents/docs/webgpu-api.md`; that file was left to the WebGPU session. Broader
native scope/reconnect/appearance/Code Mode acceptance remains unperformed.

**Latest user correction:** The first dense mockups below were rejected as too complicated. [Focused v2](../../design/task-panel/tasks-focus-v2.png) supersedes them: task titles with small lifecycle glyphs, subtle feature grouping, and a lower inspector showing objective, one dependency reason, and done criteria. Full metadata and history stay behind Details/Activity disclosures; omit prominent tabs, grids, relation chips, metrics, and control bars. The updated interaction contract is authoritative; the first images are historical drafts. Native side panels belong to the session layout. Default task scope is the routed session and its linked plan/worker work; the only broader view is the current canonical project across its sessions, explicitly selected. There is no global task feed. Use reactive session context, independent per-session view state, and cancel/ignore old-scope requests and events when switching sessions. Architect's overlap queries may inspect the current project across sessions without making the panel global.

The user prefers the focused v2 direction and explicitly requires OpenCode fonts and theme wherever supported. Use `ctx.ui` native components, inherit the host UI font for custom text/controls, and read `ctx.appearance.font('mono')` reactively for code/identifiers. Custom surfaces/text/borders/selection use inherited semantic host CSS variables; the mockup's font sizes/colors are not literal implementation values. Verify named-theme, light/dark, and monospace-font changes while the panel remains open, preserving session scope, selection, and scroll.

The user requested native LAZERS side panels for observing tasks and the eventual scheduler. [Dark](../../design/task-panel/tasks-dark.png) and [light](../../design/task-panel/tasks-light.png) image-generation mockups show a Linear-like grouped task list above a selected-task inspector, with a resizable horizontal split. The [interaction contract](../../design/task-panel/interaction-spec.json) records dependencies, sequential/parallel eligibility, state versus wait reason, accepted-history filtering, retained failures/attention, full specification/evidence/attempt detail, reconnect/resync, keyboard continuity, and dynamic host theming. [Prompts](../../design/task-panel/prompts.json) are retained. These are illustrative designs, not a running panel or scheduler.

Agent Radar inspires a separate System view for live runs, state transitions, wait reasons, budgets, and durable outcome delivery; a dependency canvas is not the primary Tasks interface. Pinned GUI APIs support native side panels and themed `ctx.ui` components, plus reactive appearance mode/font. Custom styles can inherit the host's current semantic CSS variables; isolate those source-verified token mappings for upgrade checks.

The user approved the future System visualization direction. Saved concepts:
[Flow](../../design/system-panel/system-flow-v1.png) and
[Timeline](../../design/system-panel/system-timeline-v3-narrow.png), with
[interaction notes](../../design/system-panel/interaction-spec.json) and exact
built-in image-generation prompts in that directory. **Latest correction:** the
native side panel is narrow; put visualization above selected-run information,
separated by a horizontal resizable divider, with independent scrolling. The
earlier wide Timeline's right-hand inspector is superseded. Keep System optional
and closable, inherit host appearance, and build live views from actual durable
runner/dependency/attempt/outcome records after those exist. The concept's
failure and delivery states are illustrative, not events that have occurred.

GPT-6.1 Terra High evaluated the actual images and wrote the
[System implementation plan](../../design/system-panel/implementation-plan.md).
**Flow now means the real runner state machine** (intended XState-backed view),
not task dependencies. The existing Flow image is only a visual-family reference
until its nodes and edges are redesigned around the actual machine. XState is
not installed or integrated yet. The GUI consumes authoritative versioned
topology and durable state/transition records; it must not run a second actor or
replay side effects. The plan orders real runner data → scoped snapshot/recovery
reads → Flow → Timeline, with native Desktop acceptance per bounded increment.
This is design guidance; future product work still starts with our Desktop
Architect's task specification.

The user rejected a permanent blanket Code Mode restriction for Architect. Intended authority includes confined Code Mode with a typed, bounded, project-scoped task query API shared with the GUI, so Architect can investigate existing work, include history, compare scope/acceptance, and ask about genuinely ambiguous overlap before submitting. Existing direct list/get tools allow basic inspection but list only the newest 100 summaries; they are not complete overlap search. Current live permissions/tool registrations were not changed by this mockup task. A future implementation must expose the read API in Code Mode and verify it through Desktop while keeping transitions/admission/budgets runtime-owned. Semantic overlap and retry idempotency are separate concerns. Do not require a user question merely because search returned a candidate.

The Desktop Architect specified this read-API/panel increment before implementation;
its first pass is now retained. Preserve the concurrent WebGPU slice and the single
GUI entry. Current records display their actual `submitted` status until real
runtime capabilities exist; do not populate fake execution states or add manual
handoff modes. Have Architect specify the next bounded durable-runner increment
before implementation, carrying forward the unresolved native read/permission
acceptance gates recorded in spike 008.
