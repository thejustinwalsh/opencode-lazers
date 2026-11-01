# LAZERS phase review plan

Updated 2026-11-01. All four phases have been reviewed. LAZERS itself is the dogfood target.
Review and brainstorm each phase with the user before driving its task planning
and execution through OpenCode Desktop. This updates the proposed order in the
[production audit](production-audit-and-next-phases.md); historical delivery and
verification records remain evidence of their recorded checkpoints.

## Four phases

| Phase | Outcome                                                                                                                     | Review state       |
| ----- | --------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| 1     | Usable task/history investigation and a live operational Radar, alongside existing reliability repairs                      | Direction recorded |
| 2     | Persona-based dispatch, model evidence database, usage/cost accounting and Models panel                                     | Direction recorded |
| 3     | Better planning and change management: task revisions, guided model configuration, focused research delegation where useful | Direction recorded |
| 4     | Complete usable public-repo release, cross-machine dogfood, clean installation and upgrade/recovery                         | Direction recorded |

These are outcomes, not four giant tasks. Architect should inspect current code,
reuse open task lineages, and decompose approved work into small coherent tasks
with source findings, done conditions and useful implementation guidance.

## Phase 1: see and investigate real operation

### Decisions from the user

Radar shows scheduler operation, active sessions/agents, models used, session and
agent state, and message/data flow. Tasks/plans and dependencies supply context.
Use C4-style SVG and elkjs; the scheduler's live operation is the primary view.
Use [gh-wat-dis](https://github.com/thejustinwalsh/gh-wat-dis) as rendering/layout
prior art. Tera 6.1 High reviewed the current source, screenshots and prior art.

Keep Project/Session scope. Provide an explicit task-state filter, including
completed work. A selected old task must open its own Trajectory directly.
Maintain the quiet Linear-inspired task list, native fonts/theme, closable tabs,
and graph/list above details with a horizontal divider in the narrow panel.

### Proposed work packets

1. **Task history and navigation.** Separate scope and state controls, preserve
   the chosen filters, and open the selected task's Trajectory with its reference
   and attempt history intact. Completed, cancelled and failed work remains
   discoverable. Start in `src/tasks/{panel,contract,read}.ts*` and
   `src/trajectory-panel/{panel,panel-state,projection}.ts*`.
2. **Live operational data.** Extend the existing observation projection with
   actual components, native sessions/agents, observed routes/states and typed
   message/data relationships. Reuse runner effects/outbox, native session facts
   and durable progress; add missing instrumentation where facts are absent.
   Start in `src/observability/`, `src/runner/{store,native}.ts`, `src/progress/`
   and the pinned [API index](opencode-api.md).
3. **Readable Radar.** Render that projection as a stable SVG/ELK operational
   map. Component and session nodes show concise names, route and status;
   selecting a node/edge exposes full details and related task/session links
   below. Animate recorded activity, retain selection during updates and keep
   labels readable. Status changes update the view without redoing layout.
   Follow the [Tera design and research](research/phase-planning/radar.md).
4. **Stable live history.** Keep browsing/expanding old trajectory events while
   new events arrive; avoid repeatedly loading unchanged full session context.
   This also supports economical Radar inspection. Source: trajectory panel
   state, observability reads, trajectory reads and durable progress sequences.

Graph edges distinguish architectural connections, dispatch, delivery, reads and
dependencies. Animation reflects observed activity; unknown/stale data stays
visible as unknown/stale. ELK execution placement must fit the pinned plugin
packaging without blocking the renderer. This remains one native plugin.

Phase 1 is demonstrated when a real run shows scheduler dispatch, active worker
sessions with their routes, outcomes returning and the resulting task state;
completed tasks remain filterable and their old trajectories reachable. Tera
reviews actual Desktop screenshots against the agreed direction.

Radar defaults to LAZERS-managed sessions. An explicit option includes other
native sessions within the selected Project/Session scope. This does not change
the scope boundary or make unrelated sessions managed by LAZERS.

### Existing reliability work stays visible

LZ-28 is not currently making progress: its original worker returned candidate
`e127d1a`, checks passed, and the plan is blocked at v10. Review reproduced a
queued-input archival race. Repair its existing lineage before activating that
candidate; see [the retained review](evidence/architect-context-lifecycle/review.md).
The older handoff's running status is a timestamped historical checkpoint.

The reproduced trajectory private-content omission gap and failed LZ-14 renderer
freeze investigation remain in scope as existing repairs. Preserve enabled local
inference. These lanes can proceed independently where write scopes permit;
they do not replace the requested panel features.

## Phase 2: model choice as an explicit product feature

Every new task receives an Architect-assigned persona/agent. The persona stays
with the task. Scheduler resolves provider/model/effort from the current live
hierarchical mapping at dispatch and records the exact route for the attempt.
Shared defaults support project and explicit task overrides. Waiting tasks use
the current mapping; running attempts and past history retain their selected route.

Build the Models panel and evidence database from existing
[implementor research](implementor-profiles.md), native OpenCode catalog and
usage, OpenRouter pricing/benchmarks and LAZERS outcomes. Separate externally
sourced evidence, projected estimates and observed work. Compare average tokens
and their cost by task class/persona, with acceptance, rework, sample counts and
coverage visible. Include failed attempts and review effort in accepted-result
accounting. Scheduler and Trajectory own these metrics throughout execution.
For subscription work, use OpenRouter average market pricing for the model/effort
as the standing fallback price index, preserving actual charges separately.

The panel edits persona model/effort assignments and presents a table plus Pareto
views. Native model choices remain user-controlled. Detailed API fields,
accounting, source coverage and remaining product questions are in the
[Phase 2 research](research/phase-planning/models.md). The user selected live hierarchical mapping, with shared defaults and overrides;
implementation must make precedence visible in the settings and dispatch record.

### Phase 2 decisions and planned shape

Keep three concise implementor personas: UI, Systems, and Small task/refactoring.
Classify by the acceptance surface; design-heavy UI work can carry its approved
reference and source-grounded guidance without adding another role by default.
Architect assigns the persona at task creation. A displayed model recommendation
reflects the live mapping; a creation-time suggestion does not pin execution. The
resolved dispatch route and observed use remain separately visible.

Configuration: shared persona defaults with project overrides and an explicit
task override. An agent can help configure these through the same
persisted settings used by the Models panel. Model catalog, prices, benchmarks
and observations inform the user rather than restricting available routes.

Resolve the mapping when dispatching each new attempt. Record the winning
configuration layer and selected route with that attempt. Do not rewrite task
intent or old attempts when a mapping changes.

Future user-configured selectors may use the model database, observed performance,
current prices, promotions and other criteria. Keep the mapping capable of
expressing a fixed choice or a future selection policy; Phase 2 does not need an
automatic optimizer. A policy must remain explainable through its selected model,
criteria and source data; explicit user choices retain precedence.

Models starts with persona assignments, then a task-class comparison chart and
sortable table. Externally sourced benchmark evidence, LAZERS observations and
projections are separate. Show total effort through acceptance, including failed
attempts and repairs, beside mean tokens/task and token cost. Point selection
opens contributing tasks/trajectories and the pricing/benchmark source.
Use existing real work for tuning; no synthetic paid sampling campaign.

## Phase 3: adapt plans without growing prompts

Source review: task specifications and plan nodes currently require revision 1;
scope amendments and scheduling updates exist but cannot represent a general
change of goal or acceptance. Architect already has normal repository/web tools
and cached Repomix discovery. Dedicated research-role dispatch is not implemented.

Proposed outcomes:

1. **Revise intent coherently.** An Architect conversation can change a task's
   goal or done conditions, preserve its prior specification/attempts, and update
   affected dependencies. Waiting work uses the current revision; active work
   receives a deliberate continue/repair/cancel decision. Independent work keeps
   moving, and combined acceptance reflects the revised feature.
2. **Focused research delegation.** Architect can use native child agents for
   code investigation or web research when useful. Pass a specific question,
   relevant cached index and source pointers; return concise findings. Reuse
   native OpenCode agents/session APIs before creating a separate mechanism.
   The task scheduler continues to own implementation dispatch and parallelism.
3. **Guided model configuration.** Architect helps edit the same hierarchical
   mappings as Models, using database evidence and the user's priorities. This
   is an agent-facing interface to Phase 2 settings, not another preference store.
4. **Compound useful findings.** Carry specific reuse points and pitfalls into
   later relevant tasks, with source links. Keep agent definitions short; do not
   inject research reports or require a retrospective on every task.

Native [agent documentation](https://opencode.ai/v2/docs/agents/) describes fresh
foreground/background child sessions and their own model preferences. The pinned
[API index](opencode-api.md) remains the implementation boundary. Start revisions
in `src/task.ts`, `src/runner/{schema,store,runtime}.ts`; preserve actual history.

User decision: specification revisions happen through Architect conversation
first. Tasks shows the current specification and retained history; a direct
specification editor is outside this increment.

## Phase 4: complete usable release and broader self-dogfood

LAZERS itself is the ongoing dogfood target. Root drives OpenCode Desktop
Architect, observes native workers and results, reviews and integrates delivered
work, and turns concrete failures into focused repairs. Every phase uses this
loop; no external application or synthetic benchmark is needed to begin.

Measurement is a prerequisite for dependent features, not work deferred to the
end. Scheduler/Trajectory must retain model/effort, usage, execution and review
intervals, repairs and interventions, through integration. Reuse existing facts
and close actual gaps. Current source already exposes worker token categories
and activity but `src/runner/native.ts` still returns `cost: null`; complete
whole-feature/Architect attribution remains unfinished.

### Standing market-price index

OpenRouter is always the fallback price index. Subscription work gets an
API-equivalent market estimate using average OpenRouter prices for the matching
model/effort, applied to observed token usage. Retain the model/effort, dated
prices and averaging basis so historical estimates remain interpretable.
Effort is retained in comparisons; do not invent a separate effort tariff where
the source publishes one model rate. Include reasoning/cache semantics correctly.
Distinguish market estimate from the provider's actual charge or allowance.
Refresh prices/promotions in the model database for future decisions; historic
attempts keep their recorded price basis. An unmatched model remains visible for
mapping and estimation rather than being silently assigned another model's price.

### Release outcome

Ship a complete usable release in the public repository, then continue dogfood
on other machines and tasks. No announcement is planned. A private/public pilot
distinction is unnecessary for this plan; publishing to a package registry is
not implied by a public repository release.

1. **Install the actual package.** A clean profile loads the built server/GUI,
   agents, settings and panels without depending on the development checkout.
   Complete real LAZERS work and observe the installed package.
2. **Preserve work across machines and versions.** Verify supported setup,
   restart/upgrade, backup/restore and retained task/model/trajectory settings.
   Reconcile owned native worktrees safely and preserve unmerged work/history.
   Continue real feature tasks on other machines as they become available.
3. **Finish release contents.** Set version, chosen license, shipped notices,
   supported host versions, installation/upgrade instructions and diagnostics.
   Resolve dependency compatibility findings against that host version.

OpenCode's [plugin packaging](https://opencode.ai/v2/docs/build/plugins/) supports
one server/GUI package; [GUI packaging](https://opencode.ai/v2/docs/build/plugins/gui/)
requires the built CommonJS bundle and remains experimental. Current package is
private 0.0.0; root license/notices and clean installed-package proof are still
unfinished. No separate LAZERS daemon or inference server is introduced.

## Collected sources

- [Radar source review, telemetry gaps and SVG/ELK guidance](research/phase-planning/radar.md)
- [Models/persona source review, APIs and measurement](research/phase-planning/models.md)
- [Implementor profiles](implementor-profiles.md) and underlying research:
  [UI](research/implementors/ui.md), [Systems](research/implementors/systems.md),
  [Small task/refactoring](research/implementors/small-refactoring.md),
  [Model value](research/implementors/model-value.md)
- [Original brief](sources/original-design-brief.md), [delivery audit](completed-task-audit.md)
  and [production audit](production-audit-and-next-phases.md)

Research files are planning references, not bodies to inject into agent prompts.
Phase review is complete. The product requirements are distilled in
`design/roadmap.md`, without a task breakdown or test coaching. Architect's shipped
definition owns research, native interviews for material uncertainty, decomposition
into small tasks/plans and orchestration; the scheduler owns execution.

Root stopped the coached run, preserved its transcript and the existing LZ-28
lineage, and activated the concise definition through supported native location
reload. Native agent readback matched the shipped definition. A fresh Desktop
session will receive only: “Here is the agreed plan: design/roadmap.md. Let's build
it.” Sol High and Luna Max are configured in OpenCode, not supplied as prompting
instructions. Judge actual research/interview/decomposition/dispatch behavior;
source registration tests alone do not establish planning quality.
