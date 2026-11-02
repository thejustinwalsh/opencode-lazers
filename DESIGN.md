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

## Tasks

Reference: [tasks-focus-v2](design/task-panel/tasks-focus-v2.png) and the
[visual contract](design/task-panel/visual-contract.md).

Show a compact grouped list with status icons, readable task labels and copyable
project references. Reveal sequential dependencies and parallel sibling groups
using actual plan relationships; expandable groups keep the list readable. Expose
state filters, including completed tasks, and access to historical trajectories.

The lower inspector leads with reference, title, waiting-on relationship and goal.
**Done when stays visible as a checklist.** Details and Activity start collapsed.
Render descriptive Markdown with native Markdown; commands/JSON use native code.
Full specification starts collapsed and scrolls within `min(24rem, 45vh)`.
Acceptance requirements are not passed checks. Keep available runtime actions
small and contextual; specification changes go through Architect conversation.

## Radar

Show the scheduler, managed sessions, their agent/model/state, and recorded
message/data flow. Default to LAZERS-managed sessions; optionally include others.
Use a readable C4-style SVG map with ELK layout, with the detailed XState chart
as a diagnostic rather than the primary overview. The initial compact view must
expose concurrent activity and active workers without scrolling past metadata.
Select a node/connection to inspect its actual record below. Animate only observed
activity; keep stale/unknown state honest. Timeline and map share the lower
inspector pattern. [Research](.agents/docs/research/phase-planning/radar.md) and
[reference family](design/system-panel/implementation-plan.md).

## Trajectory

Reference: [trajectory-review-v2](design/trajectory-panel/trajectory-review-v2.png).
Lead with the task, real attempt timeline and model/effort. Inspect selected
events/checks below the split; keep payloads and secondary activity collapsed.
Show timing origin, units, coverage and gaps. Separate token categories and
measurement scope; unknown cost remains unknown. Never expose private reasoning.

## Models

Help choose a capable model that completes the intended work efficiently, using
our research, live catalogs/prices/benchmarks and historical task outcomes. The
primary view is **comparison for a task class/persona**, not a config editor.
Use live APIs wherever the relevant data is available. When configured,
OpenRouter is the default fallback for prices, benchmark evidence and related
model metadata. Reuse its native configured connection; retain dated source
observations and refresh without blocking the panel. Native OpenCode remains
the authority for available execution routes; the data source does not choose
or restrict the execution provider.
Show a focused Pareto plot and readable candidate rows with quality/acceptance,
sample size, tokens, cost and time. Keep a complete keyboard-accessible table
alternative. Selecting a model reveals the task estimate, relevant past runs,
source dates and assumptions below the horizontal split.

The researched default plot compares mean tokens and comparable cost per
completed logical task, with acceptance quality alongside. Cost per accepted
result versus accepted tasks/hour is a useful alternate. Compare compatible
cohorts/accounting bases only; include failed/repaired work in outcome costs.
Keep observed results, projections and external benchmarks distinct. Show sample
counts, missing coverage, dated OpenRouter fallback market prices and the basis
of each task estimate. Unknown is not zero; subscription usage is not free API
cost. No invented task-fit score, universal ranking or causal claim from an
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
