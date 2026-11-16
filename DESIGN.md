# LAZERS interface

LAZERS is a focused OpenCode workbench. A developer should immediately see what
is happening, what needs attention, and what they can do next. Use the quiet,
compact hierarchy of Linear and the current OpenCode theme and fonts.

## Shared patterns

- Public plugin commands and tools use the short `lz-*` namespace: `/lz-models`,
  `/lz-tasks`, `/lz-radar`, `/lz-trajectory`. Keep bare command names available to
  the host. Follow native naming and Code Mode invocation semantics.
- One continuous panel surface, restrained selection, subtle separators, compact
  rows. Use a 4px spacing rhythm; existing references suggest 32–36px list rows
  and 12–20px panel insets, adjusted to host sizing. Image pixels are not CSS sizes.
- A small title and native controls form the header. Scope/filter/search stay
  compact. Put explanations where they help a decision; avoid repeated labels,
  nested summary cards, full paths and implementation prose in the first view.
- Write for the person using the product. Show facts and useful actions, not
  internal review notes such as “partial evidence.” Show the current market
  estimate when available; omit a cost when no applicable price exists instead
  of displaying “Cost unavailable.” Explain estimate limits in a tooltip or
  collapsed details. Keep values honest without repeated caveats.
- Panels are optional entries near the bottom of the native extra-panel list.
  Each opens as a closable tab with an appropriate host icon. Never force a closed
  panel back open. Preserve session-local selection, filters, split and scroll;
  task data can be scoped to the session or its project.
- Lists/visualizations sit **above** a selected-item inspector, separated by a
  horizontal resizable divider, including at wide widths. Each region scrolls
  independently. Keep useful content visible before requiring scroll.
- Make the primary identity and current state clear. Put payloads, technical
  provenance and secondary history behind disclosures. Long meaningful text wraps;
  short display labels may truncate only with full content accessible.
- Use native controls and icons where available. Keep visible keyboard focus,
  accessible names, usable hit targets, keyboard selection/resizing, and a
  non-color indication of state. Honor reduced motion.
- Loading, empty, stale, disconnected and error states are distinct. Keep the
  existing selection and scroll stable on live updates. Surface actionable
  conflicts and uncertain operations beside their recovery controls.

## Host appearance

Inherit the host UI font, including on custom buttons and inputs. Use reactive
`ctx.appearance.font('mono')` for IDs, paths, commands and measurements. Prefer
`ctx.ui` components; use inherited semantic CSS tokens for custom surfaces:
`--background-base`, `--surface-base`, `--surface-base-hover`, `--text-strong`,
`--text-base`, `--text-weak`, `--border-weak-base`, `--border-selected`, and the
appropriate host status tokens. Token names are pinned-host integration details;
keep their mapping small and check it on host upgrades. Do not freeze computed
colors, bundle a font, or maintain a separate light/dark palette.

Changing theme or font updates an open panel without losing view state. Raster
references establish composition and hierarchy, not literal colors or typography.

Design each panel for side-panel width first. Review the full workflow at 360
and 420 CSS pixels inside a wide OpenCode window. Use the panel's available width
to adapt the layout. Keep primary content and controls readable at those widths.

## Tasks

Reference: [tasks-focus-v2](design/task-panel/tasks-focus-v2.png) and the
[visual contract](design/task-panel/visual-contract.md).

Use Linear as the reference for a compact, expandable list. Give each task one
row with a readable title and a copyable project reference. Use theme-aware
colors, icons and short badges to distinguish running, blocked, scheduled and
attention states at a glance. Show dependencies in the list tree. Group parallel
siblings and place sequential work under its actual plan relationships. Expose
state filters, including completed tasks, and access to historical trajectories.
Make current work, attention and next eligible work easy to distinguish. Show
actual priorities, dependencies and reservation reasons from the runtime;
queued tasks inside running plans remain queued. Link executing work to its
Radar session and trajectory. Keep acceptance, integration and cleanup distinct.
Keep blocker reasons short in the row and put explanations in the inspector.
Offer a contextual Run next action through the scheduler. A priority change
moves eligible work ahead in the queue and keeps dependency and capacity checks
in effect. Show the blocker when the task cannot start yet.

The lower inspector leads with reference, title, waiting-on relationship and goal.
**Done when stays visible as a checklist.** Details and Activity start collapsed.
Render descriptive Markdown with native Markdown; commands/JSON use native code.
Full specification starts collapsed and scrolls within `min(24rem, 45vh)`.
Acceptance requirements are not passed checks. Keep available runtime actions
small and contextual; specification changes go through Architect conversation.

## Radar

Radar is the realtime system and agent monitor. Show what each session is doing:
assigned task, actual model/effort, state, current tool calls, read/edit targets,
durations, results, trajectory health and observed message/data flow. Default to
LAZERS-managed sessions; optionally include others. Task ordering and the backlog
belong in Tasks.

Use [Agent Radar](https://awesome-copilot.github.com/extension/agent-radar/) as
the reference for live relationships and activity. At side-panel widths, show
the current scheduler state and active or waiting sessions in a vertical
overview. Keep the parent and worker relationship readable. Use the inspector
for the selected session's calls, file activity and observed flows. Keep the map
and statechart in Diagnostics, and use Trajectory for historical timelines.

Lead with compact live session activity above the existing horizontal inspector.
Keep concurrent calls distinct. Show last meaningful activity and concrete wait
or failure reasons; native busy state alone does not establish progress. Attribute
file activity only when the tool/event supplies a trustworthy session/call target.
Keep unavailable telemetry explicit. Selecting a session, call, file or flow event
shows its detail and related history below, with navigation to worker, task and
trajectory. Keep C4/XState maps as optional diagnostics. Animate recorded activity
without shifting focus or rebuilding history on every event. Use small live
summaries/deltas and fetch selected historical detail separately.

[Current review](design/reviews/astra-radar-perf-20261104.md).

## Trajectory

Reference: [trajectory-review-v2](design/trajectory-panel/trajectory-review-v2.png).
Lead with the task, selected attempt and its model/effort. Show a scrollable
session timeline with separate tracks for tool calls, recorded file activity
and checks. Align tracks on the same time axis so successes and failures show
when they happened. Give each mark a keyboard-accessible selection and show its
details below the split. Keep payloads and secondary activity collapsed.
Show timing origin, units, coverage and gaps. Separate token categories and
measurement scope; unknown cost remains unknown. Never expose private reasoning.

## Models

Approved visual reference: [models-approved](design/models-panel/models-approved.png).
Keep Compare first, compact filters, and the selected-model details below a
horizontal split. The chart fills the comparison width at every panel size;
there is no model table or separate information panel beside it. Point tooltips
show model and cost details. Selecting a model shows a one- or two-line cost
summary; detailed stats, related trajectories and assignment controls sit below.
Secondary detail starts collapsed. Assignments is secondary. Inherit OpenCode
theme and fonts. Example values and the drawn curve
are illustrative; derive actual points and the frontier from compatible records.

Help choose a capable model that completes the intended work efficiently, using
our research, live catalogs/prices/benchmarks and historical task outcomes. The
primary view is **comparison for a task class/persona**, not a config editor.
Use persona as a comparison filter. Show public benchmark results and live
market prices as a baseline. Add comparable trajectory observations where
available so the user can see measured task outcomes and cost. Label the source
of each comparison and keep unlike measures out of the same Pareto frontier.
Use live APIs wherever the relevant data is available. Product costs, recorded
market valuations, estimates and comparisons use an ordered price-source setting,
independent of execution provider or subscription. Initially offer OpenRouter and
OpenCode, defaulting to OpenRouter then OpenCode. Reuse access configured in
OpenCode; skip unavailable sources and omit the cost when none provides an
applicable price. Identify the chosen source briefly; put rates in expanded detail.
A session's reported charge is not a market-price source, and absent prices are not zero. OpenRouter
also supplies benchmark evidence and related model metadata. Retain dated source
observations and refresh without blocking the panel. Native OpenCode remains
the authority for available execution routes; the data source does not choose
or restrict the execution provider.
Show a focused Pareto plot. Keep a complete keyboard-accessible data alternative
behind a disclosure, rather than a persistent competing table. Selecting a model
reveals a concise task estimate, with quality/acceptance, sample size, tokens,
cost, time, related runs and price details available below. Use current OpenRouter
market prices for the estimate when available, with the configured source fallback.
An estimate does not require exact historical billing reconstruction. Use readable
rounded prices in the summary; retain precise values and the estimate basis in
accessible detail. Do not invent missing prices or present a known subtotal as a
complete total. Omit genuinely unpriced costs without an unavailable label.

The researched default plot compares mean tokens and comparable cost per
completed logical task, with acceptance quality alongside. Cost per accepted
result versus accepted tasks/hour is a useful alternate. Compare compatible
cohorts/accounting bases only; include failed/repaired work in outcome costs.
Keep observed results, projections and external benchmarks distinct in data and
accessible detail. Put sample counts, coverage, rate dates and estimate basis in
collapsed detail. The primary chart and selection summary communicate models and
costs without internal accounting or review labels. Unknown is not zero;
subscription usage is not free API cost. No invented task-fit score, universal ranking or causal claim from an
unmatched small sample. An empty chart explains what data is missing and still
offers sourced catalog/research comparisons.

Assign persona → model/effort from that decision, with shared defaults and
project/task overrides. The secondary assignment view shows compact persona
rows and one selected editor. Offer native catalog choices and exact manual
IDs; catalog absence must not forbid a route. Collapse full paths, revision
history and layer details; conflicts/uncertain writes remain visible.
Distinguish saved assignments from actual worker routes. Until dispatch
integration is active, retain a concise visible notice.
[Research and accounting contract](.agents/docs/research/phase-planning/models.md).

## Inference indicator

Show only the short model name as text, including the loading target. The icon
conveys loading/available/error, with accessible tooltip semantics. Available uses
the normal theme indicator color; errors use the theme error color. No GPU vendor,
Ready label, green success decoration, or inline error prose.

## Design and acceptance

For a substantial new view, create a focused mockup in this visual family and have
Tera 6.1 High describe the layout/components before implementation. Review actual
connected Desktop screenshots against it at narrow side-panel widths (roughly
330–450 CSS px) and wide widths. Exercise theme/font changes, keyboard behavior,
split/independent scroll, live updates and the relevant error/write states.
Keep the review and correction scoped. A mockup, passing tests or message delivery
alone does not establish a usable live feature. Existing observations belong in
evidence notes; this document contains the current design direction.
