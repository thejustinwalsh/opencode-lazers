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
- Stream the full result for the current scope and filters in database pages.
  Render the first page as soon as it arrives and continue loading in the
  background until the cursor is exhausted. Merge live updates as pages arrive.
  Virtualize large lists and timelines where rendering slows interaction.
- Lists/visualizations sit **above** a selected-item inspector, separated by a
  horizontal resizable divider, including at wide widths. Each region scrolls
  independently. Keep useful content visible before requiring scroll.
- Details pane (`src/details-pane.tsx`, every list-over-inspector panel). It is always
  present at the bottom as a 32 px header bar and starts collapsed; the header is the
  collapsed state: one line saying what is selected, with its actions at the right
  (`empty` text when nothing is). A chevron, a double-click on the bar or Enter toggles
  it; there is no divider row: the bar's top 5 px is the resize handle (a focusable
  `role="separator"`, Up/Down move 5 %), a pip appears there only on hover or focus,
  dragging below a 72 px body snaps it collapsed. Open, the bar stays pinned and only
  the body scrolls; the list above keeps at least 120 px. A user selection (click, Enter
  or Space on an item, a link to it) opens a collapsed pane; refreshes, automatic default
  selection and re-mounts never do, and a person who collapses it stays collapsed until
  their next selection. `size` is the last expanded height: collapsing by any path keeps
  it and every open restores it. Panels persist `open` and `size` and open the pane from
  their own user-selection handlers (no prop on the component).
- Details pane kit (`src/details/`, spec `design/details-panes/spec.md`). One module builds
  every pane body: `StatRow`, `Label`, `Progress`, `ActivityLane`, `Coverage`, `Rows`,
  `Disclosure`, `Callout`, `Identifiers`, plus `durationText`/`compactCount`. Pieces omit
  themselves when given nothing to show; colors are host tokens or `color-mix` of them.
  Styles register once from the plugin root (`detailsKitStyles`).
- Make the primary identity and current state clear. Put payloads, technical
  provenance and secondary history behind disclosures. Long meaningful text wraps;
  short display labels may truncate only with full content accessible.
- Use native controls and icons where available. Keep visible keyboard focus,
  accessible names, usable hit targets, keyboard selection/resizing, and a
  non-color indication of state. Honor reduced motion.
- Every panel follows one loading contract, rendered by the shared
  `src/panel-status` module and nothing else:

  | Situation                   | What the panel shows                                                             |
  | --------------------------- | -------------------------------------------------------------------------------- |
  | First load                  | A skeleton of the real layout and one status line                                |
  | Longer than 10 s            | "Still loading · 12 s" and Retry                                                 |
  | Refresh or reconnect        | The last content, dimmed, under one banner: "Reconnecting · as of 5:54 PM Retry" |
  | Failed with nothing to show | One sentence in user terms and Retry; transport text behind Details              |
  | Selection change            | The previous inspector content until the new one arrives                         |

  A panel never shows a bare spinner, two status messages at once, or a blank
  inspector. Empty is a separate state: it says what is true and offers the next
  action. Keep the existing selection and scroll stable on live updates. Surface
  actionable conflicts and uncertain operations beside their recovery controls.

- Omit, do not label unknown. A missing optional fact removes its row or
  segment. "Unknown", "unavailable", "not recorded", "not reported" and "—" are
  not display values. A missing required fact (the model, price or timing of a
  recorded call) is a defect: log it and show it once in a panel-level "Data
  gaps" disclosure, not on every row.
- Green means done and successful, and nothing else. Integrated tasks and passed
  checks are green. Live, connected, current, available, running and accepted
  are states, not successes: use the interactive, neutral or warning tokens.
- Shape carries state; color reinforces it. Two states never share a glyph.

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

Reference: [tasks mockup](design/reviews/fable-ui-review-20261117/mockups/tasks.png).

One flat, expandable list in the manner of Linear. No sections, headings or
group rows. Each task is a single 30px row:

```
[chevron] [reference] title ……………… [link] [elapsed] [state glyph]
```

- The list is ordered by scheduler priority. The order is the only sign of it in
  a row; the number itself is in the inspector's meta line.
- The chevron is a button with an accessible name and `aria-expanded`.
  Dependencies expand in place under their task with a guide line.
- Row status is a glyph only, at every width, so the title keeps the width. A
  link icon opens the first blocker. Running rows show elapsed time. Full
  explanations stay in the inspector.
- State glyphs: proposed (dashed ring), queued (ring), ready (ring with dot),
  running (half disc, interactive), paused, waiting, blocked and needs-you
  (warning), accepted (outlined check, neutral), integrated (filled disc with
  check, green), failed (critical), cancelled (weak). Accepted is not finished;
  integrated is.
- The header reads "Tasks 23 open · 4 running", then scope, state filter and
  search. The state menu marks the current value and counts each state, with
  Accepted and Integrated listed separately.
- State: All sorts open, then accepted, then integrated, then failed and
  cancelled, by priority inside each. Open work stays on top.
- A filter change keeps the selection when the task is still listed. Otherwise
  the inspector keeps its content until something else is selected.

Show actual priorities, dependencies and reservation reasons from the runtime;
queued tasks inside running plans remain queued. Link executing work to its
Radar session and trajectory. Keep acceptance, integration and cleanup distinct.
Offer a contextual Run next action through the scheduler. A priority change
moves eligible work ahead in the queue and keeps dependency and capacity checks
in effect.

The inspector leads with reference, state and actions, then a two-line title
and one meta line: "Priority 1 · plan name · step n". Sequencing appears only
when the task has dependencies. The reason is one sentence in user terms; the
runtime's own wording sits behind Details. **Done when stays visible as a
checklist.** Details and Activity start collapsed. Render descriptive Markdown
with native Markdown; commands/JSON use native code. Full specification starts
collapsed and scrolls within `min(24rem, 45vh)`. Acceptance requirements are not
passed checks. Keep available runtime actions small and contextual;
specification changes go through Architect conversation.

## Radar

Radar is the realtime system and agent monitor. Show what each session is doing:
assigned task, actual model/effort, state, current tool calls, read/edit targets,
durations, results, trajectory health and observed message/data flow. Default to
LAZERS-managed sessions; optionally include others. Task ordering and the backlog
belong in Tasks.

Use [Agent Radar](https://awesome-copilot.github.com/extension/agent-radar/) as
the reference for live relationships and activity. At side-panel widths, show
the current scheduler state and active or waiting sessions in a vertical
overview. Indent workers under their Architect with a guide line. Use
Trajectory for historical timelines.

Reference: [radar mockup](design/reviews/fable-ui-review-20261117/mockups/radar.png).
One header serves every view: title, a `Monitor · Map · Flow` switch, the
connection (Live, Reconnecting or Offline; never green), scope and a menu.
Switching views moves nothing in the header. Under it, one summary line answers
the first question: running, needs you, failed, queued, capacity. The inspector
opens only when a session is selected; until then the list has the full height.
It shows state, task link, one facts line, then Calls, Files and Messages.
When nothing is running, say so and link to Tasks.
Idle sessions are hidden by default; the summary line says how many and shows them on request.

The three views answer different questions and share one live snapshot, so
switching between them never reloads.

| View    | Question                        | Form                                                                |
| ------- | ------------------------------- | ------------------------------------------------------------------- |
| Monitor | What is each session doing now? | Architect row, workers indented beneath, current calls under each   |
| Map     | Who is connected to whom?       | Compact tree: You, Architect, runtime groups, concrete workers      |
| Flow    | Where is the work going, live?  | Sessions on the left, destinations on the right, flow lines between |

Map: stroke carries status. A path that leads to something running is
interactive blue; a failed or needs-you node colours itself and the one edge
into it; ancestors never inherit those tones. Selecting a node dims the rest.

Flow reference: [flow mockup](design/reviews/fable-ui-review-20261117/mockups/radar-flow.png).
It is the Agent Radar canvas turned for a narrow, tall panel. Destinations are
grouped as Models, Local machine and Tools & services, and only those with
activity in the last two minutes are listed. Line weight is volume in that
window, opacity is recency, and moving dots mark a call running now (static
under reduced motion). Line hue follows the destination group and reuses the
Trajectory track hues: models violet, local amber, tools neutral, You warning.
Selecting a session or destination dims everything unconnected and filters the
feed. Below the split, `Feed` lists recent calls newest first and `Models`
shows per-model calls, tokens and rate; omit token figures that were not
recorded. The task lifecycle statechart is a diagnostic in the menu, not a view.

Lead with compact live session activity above the existing horizontal inspector.
Keep concurrent calls distinct. Show last meaningful activity and concrete wait
or failure reasons; native busy state alone does not establish progress. Attribute
file activity only when the tool/event supplies a trustworthy session/call target.
Omit telemetry that was not observed. Selecting a session, call, file or flow event
shows its detail and related history below, with navigation to worker, task and
trajectory. Animate recorded activity
without shifting focus or rebuilding history on every event. Use small live
summaries/deltas and fetch selected historical detail separately.

[Current review](design/reviews/astra-radar-perf-20261104.md).

## Trajectory

Reference: [trajectory mockup](design/reviews/fable-ui-review-20261117/mockups/trajectory.png).
The header is three lines: reference, state and Open task; a two-line title; the
attempt picker with model/effort, active time and counts. Show a scrollable
session timeline with separate tracks for tool calls, recorded file activity
and checks. Give the tracks equal height and the same start, end, and line marks.
Label each lane with a word and its count ("Tools 31"). Track hues: attempt
interactive blue, tools violet, files amber, checks strong neutral. No track
uses a success color. Use red for recorded failures on any track. Collapse
instantaneous events to a mark at their recorded time. Give each mark a
keyboard-accessible selection and show its
details below the split. Keep payloads and secondary activity collapsed.
The inspector gives state, kind and duration, the command, then Started, Ended
and Result in clock time with the offset into the attempt. Output and Timing
source are disclosures. No raw epoch values. Attempt usage shows market cost,
tokens in (cached) and tokens out with the price source and date; omit the cost
when no price applies. Never expose private reasoning.
Compress long idle spans on the shared timeline axis so recorded activity stays
close together. Mark each compressed interval and preserve actual timestamps
and durations in the inspector. Keep recording gaps distinct from known idle
time and keep all tracks aligned through zoom and scrolling: hatch only real
recording gaps, and draw compressed idle as a narrow labelled break ("1m32s
idle"). Events stream in the background; show "118 of 184 events" with a thin
progress line until the cursor is exhausted. There is no manual load control.
Counts that disagree between sources belong in a Data gaps disclosure.

## Models

Reference: [models mockup](design/reviews/fable-ui-review-20261117/mockups/models.png).
The header is two rows: title, `Compare · Assignments` and the price time with
refresh; then persona and kind chips with `Your runs · Benchmark`. Compare and
Assignments are separate views: Assignments renders no chart or Compare filter.
The header, filters and Assignments render at once; comparison data arrives
progressively under the shared loading contract. The selected model shows its
name, a price range in large type, four stats and one "Assign to <persona>"
button; basis, coverage, sources and rates sit in disclosures below.
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
independent of execution provider or subscription. Offer OpenRouter, OpenCode and
models.dev, defaulting to that order. models.dev (MIT, the open database OpenCode itself
uses) needs no key and lists `cost` in USD per million tokens; it is the keyless fallback that
keeps the catalog priced when OpenRouter access is absent. Reuse access configured in
OpenCode; skip unavailable sources and omit the cost when none provides an
applicable price. Identify the chosen source briefly; put rates in expanded detail.
A session's reported charge is not a market-price source, and absent prices are not zero. OpenRouter
also supplies benchmark evidence and related model metadata. Retain dated source
observations and refresh without blocking the panel. Native OpenCode remains
the authority for available execution routes; the data source does not choose
or restrict the execution provider.
Show a focused Pareto plot. Keep a complete keyboard-accessible data alternative
behind an `All models · n` disclosure in the list region under the chart, never in the
details pane. Selecting a model opens the details pane (`src/models/model-pane.tsx`,
presentation in `src/models/pane-presentation.ts`), built from the details kit:

- Your runs: the bar (name, route in mono, Assign), then one headline figure, the
  cost per accepted task at two decimals with its unit and a `small sample` Label when
  fewer than three terminal tasks back it; a stat row (Accepted, Tokens / task, Time /
  task, Attempts / task); a Coverage bar (priced share of tokens and, in one caption,
  what has no published price); Runs as flat rows (task, outcome, tokens, cost,
  Trajectory link); then the disclosures Tokens, Sources, Caveats (at most three short
  lines) and Identifiers.
- Benchmark: the headline score with its benchmark name; a stat row (Input, Output,
  Cached price per 1M); disclosures Scores (only when the source reports more than the
  headline), Sources, Caveats and Identifiers. The chart's 3:1 blended price is named
  once, in Caveats, and is not a stat.
- Exact figures (up to four significant digits), usage by kind with rate coverage,
  price pins, snapshot read times (once, in Sources), and every id, hash and revision
  appear only inside the disclosures. Contract enums are translated for display; a
  missing price omits the figure rather than labelling it. The price source that valued
  the estimate stays visible under Sources, with its quote kind.

Use current OpenRouter market prices for the estimate when available, with the
configured source fallback. An estimate does not require exact historical billing
reconstruction. Do not invent missing prices or present a known subtotal as a
complete total. Omit genuinely unpriced costs without an unavailable label.
The Benchmark empty state names what is missing and offers "Open provider
settings".

The plot is drawn by the plugin as SVG (`src/models/chart-layout.ts` for layout,
`src/models/model-chart.tsx` for the view); there is no charting library. Axes end at
the next round tick above the data so points spread across the plot; the x axis
switches to a log scale, and its title says "· log", only when the largest token
count is more than 50x the smallest. Plot height is clamp(width x 0.48, 220, 360).
Every point is a focusable button (arrow keys move, Enter selects), labelled in base
text; the selection has a halo and a strong label above it. Points closer than 10 px
fan out while one is hovered or focused.

**Best trade-off** has one definition. It is the Pareto set over cost per accepted
task (lower), tokens per accepted task (lower) and acceptance rate (higher), among
observed models with a complete cohort and at least one accepted task; a model with fewer
than three terminal tasks is flagged "small sample · n of m" but still counts. A model is on
it when no other eligible model is at least as good on all three and strictly better
on one. The polyline joins the frontier points ordered by tokens; a frontier of one
point draws no line. Catalog references and projections are a different measure and
never join the observed frontier. Projected and Benchmark use cost (lower) against
the public coding index (higher).

The model set behind the table and Projected is a best-effort union, each entry tagged
with where it came from: Observed (recorded runs), Routed (named by the model
router's persona and layer routes) and Catalog (the configured price sources in
order, the top 30 by public coding index, plus the current Anthropic and OpenAI
lineups for BYOK). Nothing is hard-coded; a source that is unavailable contributes
nothing and is named under Sources in the details pane. Unobserved
models are projected: list prices times the median tokens per accepted task of our
own accepted tasks, with the basis stated. The segmented control is
`Your runs · Projected · Benchmark`. "All models" lists every entry ranked best
trade-off first, then by cost per task.

Projected is a ranking, not a scatter: one row per priced model, cheapest projected cost
first, cost on a `$` axis (log when the spread exceeds 50x), the model name at the left,
the value at the bar end, Observed-backed models with a ring, and public scores as a
muted right-hand column when any exist. Rows scroll inside the chart under a fixed axis
(22 px rows, 12 visible). A cost-vs-score scatter is a secondary toggle, offered only when
at least five models have a score. With no score at all the catalog is the first 40 priced
text- and tool-capable models in the configured price source's own listing order (OpenRouter
models-list order, or OpenCode catalog order; OpenRouter documents a `sort=most-popular`
query on the models endpoint, which the stored snapshots do not use yet), then the
Anthropic and OpenAI lineups and every routed model; the disclosure states the split.

The catalog is cached server-side in the plugin database (`model_evidence_snapshots` and
`model_evidence_refreshes`, per project directory). Readers always get the stored snapshot
first. Prices refresh in the background after one hour, model info (names, context windows,
tool support, benchmark rows) after seven days; a price refresh keeps the stored info,
replaces rates, adds newly listed models and keeps vanished ones until the next info
refresh. One refresh runs at a time per project; the header refresh button forces all.

Two keyless public sources join the same cache. **models.dev** (`models.dev/api.json`, about
7 MB, parsed once on the server; only the fields in use are stored, for the providers this
install routes plus Anthropic and OpenAI) refreshes prices hourly and model info weekly, and
joins a route by the OpenCode provider and model id, then by name identity; a gateway's copy
of a model is never taken as its price. **Epoch AI** (`epoch.ai/data/benchmark_data.zip`)
supplies public coding benchmark scores, refreshed weekly: SWE-bench Verified, Aider
polyglot, Terminal-Bench 2.0, DeepSWE, GSO-Bench and FrontierSWE, each row naming its origin
as the hub lists it. One score ranks the set, never a mix: the Artificial Analysis Coding
Index when OpenRouter benchmark access covers at least as many models, else SWE-bench
Verified, unless another Epoch benchmark covers clearly more (it keeps the lead while it
reaches 80% of the best coverage). Other benchmarks are detail rows in the selected model's
"Public benchmark" disclosure. Epoch data is CC BY 4.0: wherever it is shown the source
line reads "Epoch AI · CC BY 4.0" with the snapshot date; benchmarks the hub lists from
elsewhere keep their own licences and are named by their origin. Requests are plain GETs
with a generic User-Agent and no user, project or machine identifier.

The model set is a union, not only this install's routes. Beyond Observed, Routed, agent and
catalog models, the first page of a comparison read carries `publicCatalog`: the newest
Anthropic and OpenAI models (12 each, whether or not those providers are routed: BYOK), the
newest 30 first-party models of other vendors from models.dev, and the first 30 tool-capable
OpenRouter listings, each once per identity (dated snapshots and `latest` aliases are one
model) and never a model a route already runs. They are listed, priced by the source that
listed them (when it is configured) and scored on the same basis; they are never offered as a
route. A policy saved before models.dev existed gains it, last, when read; an explicitly empty
list stays empty.

One price walk, everywhere (`price-resolution.ts`): every view that prices a model (Projected
ranking and scatter, Benchmark, All models, details, tooltips) gathers what each source quotes
for that model identity and takes the first configured source that quotes it, keeping its source
and snapshot time ("priced by OpenRouter"). A source with no quote is skipped. A model is left
off a cost plot only when no configured source prices it, and then the footer counts it and the
nested disclosure names it. A public score is itself a reason to list a model: the first page of a
comparison read also lists every routed model that has a score (with its quotes), so scored,
priced models plot at once instead of waiting for the page that carries their route; one model
is one point, whatever providers offer it.

Agent routes: Architect, Implementor and Auditor are top-level assignments beside the three
persona kinds. They are rows in the same versioned mapping store (all projects, this project;
never per task), saved through the same RPC. Each agent's model comes from, in order: the
LAZERS route (project, then shared), the agent's native OpenCode configuration, then a plugin
default (the Auditor only; Architect and Implementor use the session or default model). The
agent transforms (`registerArchitect`, `registerWorker`) set `agent.model` (and its `variant`,
the effort) from the route, and saving an agent route calls `ctx.agent.reload()` so the next
session starts on it without a restart. An Implementor attempt resolves persona route, then the
Implementor agent route (the transformed native agent), then native configuration. Architect
sessions LAZERS creates or continues use the configured route over the carried model.

Every cross-source join (native routes, OpenRouter, models.dev, Epoch, our recorded runs and
routes) goes through one name identity resolver (`name-identity.ts`): family, version, tier
words, size and variants make an identity; dates, `latest`, `preview`, `:free`, routing and
cloud prefixes do not, and effort is carried beside it. Matches record their tier (exact id,
cross-id, identity, identity-relaxed, alias) and a row that could be two identities stays
unmatched with the reason rather than being guessed. Coverage is shown, not hidden: "27 of 35
SWE-bench Verified rows matched", with the unmatched names behind a nested disclosure.

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

## Settings and header indicators

Reference: [settings mockup](design/reviews/fable-ui-review-20261117/mockups/settings.png).
LAZERS has one settings page. Every setting is a row: label and hint on the
left, control on the right. Sections carry their runtime state once, in the
section header. Provider usage is a section on this page and shows only the
chosen provider's fields. The voice picker has a Preview button. Advanced
diagnostics stay collapsed.

Header indicators match the host's controls: 26px high with 16px glyphs. The
inference indicator shows the short model name and a state glyph (unloaded,
loading, available, working, error); compact headers drop the name and keep the
glyph. Available uses the normal theme indicator color; errors use the theme
error color and put the reason in the tooltip and Settings. No GPU vendor, Ready
label, green success decoration, or inline error prose. The provider usage ring
shows the amount beside it: neutral under budget, warning above 80 %, critical
over. With no reading it is a dashed ring and no text.

## Design and acceptance

For a substantial new view, create a focused mockup in this visual family and have
Tera 6.1 High describe the layout/components before implementation. Review actual
connected Desktop screenshots against it at narrow side-panel widths (roughly
330–450 CSS px) and wide widths. Exercise theme/font changes, keyboard behavior,
split/independent scroll, live updates and the relevant error/write states.
Keep the review and correction scoped. A mockup, passing tests or message delivery
alone does not establish a usable live feature. Existing observations belong in
evidence notes; this document contains the current design direction.
