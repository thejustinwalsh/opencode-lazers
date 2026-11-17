# LAZERS panel design review — 17 Nov 2026

Live, read-only review of every LAZERS surface in OpenCode Desktop 2.2.6 (dark theme, window
1383 × 868, right pane about 520 px), followed by a source read for what the live session could
not reach. Mockups show the recommended design for each panel.

## Ranking and order

| Rank | Surface | Why it needs work | Size |
| --- | --- | --- | --- |
| 1 | **Loading and failure states (all panels)** | After a service restart, Radar, Models and Trajectory spun for 4–6 minutes with no timeout, retry or last-known content. This hides every other panel's design. | M |
| 2 | **Models** | Six competing status lines while loading; the Assignments tab swaps only the lower pane; the densest "unknown / unavailable" vocabulary in the product. | L |
| 3 | **Trajectory** | Seven header lines before the timeline; raw Unix milliseconds and internal prose in the inspector; manual "Load more"; olive-green tool marks. | M |
| 4 | **Radar** | Header reflows between Monitor and Diagnostics; an empty inspector is open by default; two overlapping error messages. | M |
| 5 | **Tasks** | Closest to done. Priority is the sort key but is not shown; accepted and integrated differ by color only; the inspector truncates its title and leaks runtime prose. | S–M |
| 6 | **Settings and header indicators** | Two differently built pages for one plugin; 40 px indicator beside 26 px host controls. | S |

Recommended implementation order:

1. **Shared panel states** (rank 1). One small module used by all four panels. Everything else is easier to judge once panels show content or a clear failure.
2. **Tasks polish**. Small, high daily use, and it sets the glyph and color rules the other panels reuse.
3. **Trajectory header, inspector and colors**.
4. **Models** information architecture and copy.
5. **Radar** header and inspector.
6. **Settings and indicators**.

## How the review was done, and its limits

| Done live | Not possible in this session |
| --- | --- |
| Opened Tasks, Radar, Models, Trajectory, LAZERS settings, Provider budget settings | Selecting or expanding Tasks tree rows, scrolling, hover tooltips and keyboard navigation: background accessibility input reaches buttons, tabs and menus only, and full-screen control was interrupted on every attempt |
| Tasks: state filter menu (Open → All → Open), search open/close, blocker link | Resizing the pane to 360 px (not attempted, to leave the persisted layout alone) |
| Radar: actions menu, Diagnostics, back to Monitor | Loaded Radar and Models: they never finished loading after the restart |
| Models: Observed ↔ Benchmark, Compare ↔ Assignments | Settings menus: they could not be closed again without choosing a value, so they were left unopened |

Two things to know when reading the findings:

- **The OpenCode service restarted at 5:54 PM during the review** (new process id, start time
  5:54). It happened seconds after the LZ-219 blocker link was pressed; the cause was not
  established. All four LAZERS tabs disappeared, the pane showed the host "New tab" page, and the
  tabs returned about 30 s later with the Tasks selection reset. Tasks reloaded; the other three
  panels did not within the remaining 6 minutes.
- **Loaded Radar and Models were not seen today.** Their loaded-state findings come from source
  and from repository screenshots dated 6 and 8 Nov (`evidence/historical-*.png`), which predate
  recent changes. Those findings are marked "source" or "historical" below.

Evidence images are in `evidence/`. Mockups are in `mockups/` (`<panel>.html` source,
`<panel>.png` render, `render.sh` to rebuild).

## Cross-panel findings

### 1. Loading has no end (highest priority)

| Panel | Observed after the 5:54 PM restart | Evidence |
| --- | --- | --- |
| Radar | "Connecting" + "Loading live activity…" for about 4 minutes, then "Live observation is unavailable. Transport: Timed out waiting for th…" with Retry, plus a second line "Live session activity is unavailable. Nothing can be concluded about workers." The status chip read "Syncing" at the same time. | `radar-01`, `radar-02` |
| Models | "Refreshing sources…", "No comparison yet · Loading", "Loading comparison…", "Task unavailable", "Select a model to compare.", "Loading selected task evidence…" all at once, unchanged for 6 minutes. Refresh disabled. | `models-01` |
| Trajectory | "Loading trajectory" spinner for 6+ minutes. No retry, no elapsed time. | `trajectory-02`, `trajectory-03` |
| Tasks | Reloaded in under 30 s. On selection or filter change the inspector blanks to "Loading task…". | `tasks-04`, `tasks-07` |
| Host | A service restart closes the plugin's tabs and shows "New tab". | `host-05` |

Recommendation, one contract for all four panels:

```
first load      → skeleton of the real layout + one status line
> 10 s          → "Still loading · 12 s" + Retry
refresh/reconnect → keep last content, dim it, one banner: "Reconnecting · as of 5:54 PM  Retry"
failed          → one sentence in user terms + Retry; transport detail behind "Details"
selection change → keep the previous inspector content until the new one arrives
```

Plan:

- Add `src/panel-status.tsx` (or extend `src/panel-error.ts`) with `PanelBanner`, `PanelSkeleton`
  and a `slowAfter(ms)` helper. Use it from `src/tasks/panel.tsx`, `src/radar/monitor-view.tsx`,
  `src/radar/panel.tsx`, `src/models/comparison-panel.tsx`, `src/trajectory-panel/panel.tsx`.
- Each panel state module keeps its last successful snapshot across reconnects
  (`panel-state.ts`, `monitor-state.ts`, `comparison-state.ts`, trajectory `panel-state.ts`).
- Give the Trajectory and Models first reads the same timeout the Radar transport already has,
  then show the failed state.
- Tab loss on restart is host behavior. Raise it with OpenCode or re-register panels with stable
  ids so the host can restore them; confirm which applies in `.agents/docs/opencode-api.md`.
- Acceptance: restart the service with each panel open. Content stays visible and dimmed, a
  banner appears within 2 s, Retry works, and no panel shows a bare spinner longer than 10 s.
- Size: M (one shared component, four call sites, four state changes).

### 2. "Unknown" and "unavailable" as display values

The owner rule: omit data that legitimately does not exist; missing telemetry and prices are bugs.
Places that break it today:

| Where | Text | Source |
| --- | --- | --- |
| Tasks inspector (live) | "Native idle background observation is unknown: Native session.inbox.delivered was observed after the last experimental.idle background report" | `evidence/tasks-03` |
| Tasks row fallback | state word defaults to "Unknown" | `src/tasks/row-presentation.ts` `stateWord` |
| Trajectory inspector (live) | "duration not recorded"; "absent endpoints remain unknown" | `evidence/trajectory-01` |
| Trajectory | "Unknown", "Time unknown", "Model not recorded", "duration unavailable: …", "Price source unavailable", "Known subtotal · full total unavailable" | `src/trajectory-panel/panel.tsx` lines 89, 151, 159, 112, 1836, 1873 |
| Models | "Unknown", "Unknown market cost", "Age unknown", "tokens unknown", "Unavailable · not a zero price", "freshness unknown", "provider unavailable · tag unavailable" | `src/models/comparison-panel.tsx` lines 124–493, `comparison-presentation.ts` lines 208–462 |
| Models (live) | disabled chip "Task unavailable" | `evidence/models-01` |
| Radar | "State unknown", "Scheduler unknown", "Unknown tool", "status unknown", "Model not observed", "Unavailable", "Not reported", "None reported" | `src/radar/monitor-model.ts` lines 103–334, `monitor-view.tsx` lines 323, 503, 748, 750 |
| Radar (historical, 8 Nov) | "unavailable · unknown · unknown"; "unknown · participant count unknown" | `evidence/historical-radar-20261108.png` |
| Budget tooltip | "Earlier weekly usage unknown"; label "—" | `src/budget/gui.tsx` `presentation` |

Rule to apply everywhere: a missing optional fact removes its row or segment; a missing required
fact (model, price, timing of a recorded call) is logged as a defect and shown once in a
panel-level "data gaps" disclosure, not repeated per row.

### 3. Green

Green is reserved for done and successful. Findings:

- **Tasks (live): no misuse.** Completed rows in State: All render a near-white check
  (`evidence/tasks-08`). They are "accepted"; "integrated" is the green one. The problem is the
  reverse: accepted and integrated share one glyph and differ by color only.
- **Trajectory (live): tool-call marks are olive green** (sampled `#9aab64`), from
  `--trajectory-hue-tools: var(--syntax-string)` in `src/trajectory-panel/panel.css`. A track of
  in-flight and failed-or-not tool calls reads as success. Change the hue (mockup uses violet).
- **Host diff counts** ("+14") are green; that is OpenCode's, outside LAZERS.
- Not seen today, check in source before shipping: Radar connection dot and Models "current"
  freshness. Neither should be green; "live" is a state, not a success.

## Tasks

Mockup: `mockups/tasks.png`.

**Keep**

- The flat, single-line, 30 px rows. The list reads fast and the title gets the width.
- Ring glyph family and the neutral link icon.
- State filter and search tucked into the header; inspector below a divider.
- Done-when checklist with square requirement markers.

**Problems**

1. **The sort key is invisible.** The list is ordered by priority, but no row shows it. LZ-232
   (priority 1) and LZ-99 (priority 20) look like peers (`tasks-02`, `tasks-09`).
2. **Accepted and integrated are distinguishable by color only** (same `circle-check`). In
   State: All, dozens of accepted-not-integrated tasks look finished (`tasks-08`).
3. **State: All interleaves completed work with open work** by priority (LZ-211 done sits above
   LZ-222 waiting, `tasks-07`).
4. **Changing the filter drops the selection** and blanks the inspector to "Loading task…"; the
   list then scrolls itself to a different task (`tasks-07` → `tasks-08`).
5. **Inspector title truncates** with an ellipsis; DESIGN.md asks for a two-line heading.
6. **Four fact rows for one line of information.** "Sequencing: Parallel-eligible · No
   dependencies; can run alongside other work" restates what the tree already shows, on tasks
   that have no dependencies.
7. **Runtime prose in the reason line** (see "Unknown" table).
8. **The disclosure chevron is an `aria-hidden` span** about 16 px wide
   (`src/tasks/panel.tsx` near line 835). Keyboard users have the tree keys; pointer users get a
   small target with no hover state.
9. **State menu shows no current selection and no counts** (`tasks-06`).
10. **Header dot is unexplained.** It changed from grey to orange during the review with no label.
11. **Search field stops at 60 % width** (`tasks-10`).

**Ranked improvements**

| # | Change | Rationale |
| --- | --- | --- |
| 1 | Add a 2-character mono priority column before the reference; omit for priority 0 | Makes the flat order self-explaining without sections or headings |
| 2 | Accepted = outlined check, neutral. Integrated = filled disc, green | Shape carries state; green stays unique to finished work |
| 3 | In All, sort open → accepted → integrated → failed/cancelled, priority inside each. No headings | Open work stays on top; honors the no-sections decision |
| 4 | Keep selection across filter changes when the task is still listed; otherwise keep the inspector's last content until a new selection | Removes the blank inspector and the jump |
| 5 | Inspector: two-line title; one meta line "Priority 1 · plan name · step n"; drop Sequencing unless there are dependencies | Removes three rows; more room for Done when |
| 6 | Reason line in user terms, raw reason behind "Details" | Readable, and removes "unknown" |
| 7 | Chevron becomes a 20 × 24 px button with hover | Usable target |
| 8 | State menu: checkmark on current, count per state; split Completed into Accepted and Integrated | Shows the integration backlog |
| 9 | Replace header dot with "23 open · 4 running" | Text says what the dot could not |
| 10 | Elapsed time on running rows only ("12m") | One glance shows which worker is stuck |
| 11 | Search input fills the row | Alignment |

**Implementation plan**

- `src/tasks/row-presentation.ts`: accepted → new `ring-check` glyph; integrated → `disc-check`.
  Remove the "Unknown" fallback in `stateWord`.
- `src/tasks/state-glyph.tsx`: add `ring-check` and filled `disc-check`.
- `src/tasks/panel.tsx`: priority cell and elapsed cell in the row; chevron as `<button
  tabIndex={-1}>`; header count; menu items with check and counts; inspector meta line and
  conditional Sequencing; selection retention.
- `src/tasks/panel.css`: grid columns for priority; `-webkit-line-clamp: 2` on the inspector
  title; search input `flex: 1`.
- `src/tasks/execution-list.ts` or `schedule-order.ts`: state-rank comparator for All.
- `src/tasks/state-filter.ts`: Accepted and Integrated as separate filters; counts.
- `src/tasks/presentation.ts`: map runtime reasons to short user sentences.
- Tests: extend `test/task-panel/icon-colors.test.ts` (accepted is not green and has a distinct
  glyph), `row-presentation.test.ts`, `tasks-virtual.test.ts` (All ordering, selection kept).
- Acceptance: at 360 and 500 px, priority column aligns across one- and two-digit values; in
  All, no completed row appears above an open row; no "unknown" text in list or inspector;
  switching Open → All → Open keeps LZ-232 selected.
- Size: S for items 1, 2, 5, 7, 9, 11; M with ordering, selection and counts.

## Radar

Mockup: `mockups/radar.png`. Loaded-state findings are from source and the 8 Nov screenshot.

**Keep**

- The session row design in `monitor-view.tsx`: role, task, model, state, age on one line with
  current calls beneath. This is the right shape.
- Monitor first; map and statechart as diagnostics.

**Problems**

1. **Unbounded connecting state, then two overlapping errors and a "Syncing" chip** (live).
2. **The header reflows between views** (live, `radar-01` vs `radar-03`). In Diagnostics the
   scope moves from left to right, a "Live monitor" button and an outlined "Managed sessions"
   button appear, and Map/Flow tabs sit at the far right.
3. **Diagnostics is two clicks deep** behind the ⋯ menu, with a separate back button.
4. **An empty inspector is open by default** and takes about 20 % of the height to say "Select a
   session to see its details and history."
5. **Parent → worker relationship** is a flat list in the markup; DESIGN.md asks for it to stay
   readable (source).
6. **Raw identifiers and unknowns** in session facts (historical and source; see table above).
7. **No scheduler summary line**: paused, capacity and counts are not visible at a glance
   (source: `lazers-radar-monitor-summary` exists; content not seen live).

**Ranked improvements**

| # | Change | Rationale |
| --- | --- | --- |
| 1 | Shared loading contract; one error sentence; connection chip has three values: Live, Reconnecting, Offline | Removes contradiction |
| 2 | One header for all views: title, `Monitor · Map · Flow` segmented control, connection, scope, ⋯ | No reflow; Diagnostics becomes one click |
| 3 | No inspector until something is selected; the list takes the full height | Content before chrome |
| 4 | Workers indented under their Architect with a guide line | Relationship at a glance |
| 5 | One summary line: running, needs you, failed, queued, capacity | The first question Radar should answer |
| 6 | Inspector: state, task link, one facts line, then Calls / Files / Messages | Replaces label-value grids of ids |
| 7 | Idle state says what is true and links to Tasks | Useful empty state |

**Implementation plan**

- `src/radar/panel.tsx`: single header component with the segmented view switch; remove the
  "Live monitor" back button and the Diagnostics menu item (keep Refresh in ⋯).
- `src/radar/monitor-view.tsx`: group sessions by parent; render the inspector and separator
  only when `selectedSessionID()` is set; summary line; remove "Model not observed", "Not
  reported", "Unavailable", "None reported" rows when empty.
- `src/radar/monitor-model.ts`: drop "State unknown", "Scheduler unknown", "Unknown tool"
  strings; return `undefined` and let the view omit.
- `src/radar/map-view.tsx`: render inside the shared header; same connection chip.
- `src/radar/panel.css`: tree indent and guide; segmented control; no-inspector grid rows.
- Tests: `monitor-model.test.ts` (no unknown strings), `presentation.test.ts`, a view test for
  inspector-absent layout.
- Acceptance: switching Monitor ↔ Map moves nothing in the header; with no selection the list
  uses the full height; disconnecting the service shows one banner and keeps the last sessions.
- Size: M.

## Models

Mockup: `mockups/models.png`. Loaded-state findings are from source and the 6 Nov screenshot.

**Keep**

- Compare first, chart at full width, selected model below the split.
- Persona and kind as compact filters.
- Chart data available as a table behind a disclosure.

**Problems**

1. **Six status messages while loading** (live, `models-01`), including the contradiction "No
   comparison yet · Loading".
2. **Assignments is not a view.** Selecting the tab keeps the Compare filters, Sources and chart
   area on top and changes only the lower pane to "Loading saved assignments…"
   (`models-03`).
3. **Benchmark empty state is a sentence with no action**: "Public benchmark data hasn't been
   retrieved. It needs OpenRouter access configured in OpenCode; Refresh retries." Refresh was
   disabled at the time (`models-02`).
4. **Header and filter chrome is five rows** before any data: title + scope + Refresh, tabs,
   filters, "Refreshing sources…", Sources disclosure, then chart title + toggle + subtitle.
5. **Filter chips put the chevron on the left** and prefix the value ("Persona · All"); Tasks
   puts it on the right with the bare value.
6. **Accounting vocabulary in the primary view** (source and historical): "priced portion",
   "Priced subtotal · total unknown", "partial", "Coverage gaps", "Unavailable · not a zero
   price". DESIGN.md asks for readable rounded prices up front and the basis in detail.
7. **Chart axis labels collide** at narrow width (historical: "$3 $2.5 $2 $1.5" overlap).
8. **The selected-model summary has no primary action**; assignment is reached through
   Provider and Effort dropdowns in the inspector (historical).

**Ranked improvements**

| # | Change | Rationale |
| --- | --- | --- |
| 1 | Assignments becomes a full view: persona rows on top, one editor below; Compare chrome is not rendered | The tab means what it says |
| 2 | One loading surface: chart skeleton + one line | Replaces six messages |
| 3 | Header in two rows: `Models · Compare · Assignments … prices time · refresh icon`, then filters + `Your runs · Benchmark` | Chart moves up about 80 px |
| 4 | Selected model: name, price range in large type, four stats, one button "Assign to <persona>" | Decision and action together |
| 5 | Everything about basis, coverage, sources and rates moves into disclosures under the selection | Honest without caveats in the first view |
| 6 | Benchmark empty state: title, one sentence, "Open provider settings" | Actionable |
| 7 | Chips match Tasks: value then chevron; "Task" chip appears only when a task filter applies | Consistency; removes "Task unavailable" |
| 8 | Fewer y ticks at narrow widths; legend reduced to "Best trade-off" and "Other" | Legibility |

**Implementation plan**

- `src/models/comparison-panel.tsx` (3,244 lines): split the render into `CompareView` and
  `AssignmentsView` chosen by the tab; this is the main cost. Move Sources, coverage and
  estimate-basis blocks into the selection disclosures. Replace status text signals with one
  `status()` memo feeding the shared banner/skeleton. Add the "Assign to" action using the
  existing draft path (comment at line 791, handler near line 1884).
- `src/models/comparison-presentation.ts`: remove display strings for unknown/unavailable;
  return `null` so the view omits the row. Keep the precise values for the disclosure.
- `src/models/comparison-chart.tsx`, `benchmark-chart.tsx`: tick thinning below 420 px; two-item
  legend; selected point halo.
- `src/models/comparison-panel.css` (1,452 lines): expect a net reduction once the stacked
  header rows go.
- Tests: `comparison-presentation.test.ts` (no unknown strings in summary output),
  `comparison-chart.test.ts` (tick count by width), a view test that Assignments renders no
  chart.
- Acceptance: Assignments shows no chart or Compare filter; loading shows exactly one status
  line; the first view at 360 px contains no "unknown", "unavailable", "partial" or "subtotal";
  the chart starts within 110 px of the panel top.
- Size: L. Do the view split first, alone; copy and layout follow in separate changes.

## Trajectory

Mockup: `mockups/trajectory.png`. Loaded-state findings are from the live capture before the
restart (`evidence/trajectory-01-initial.jpg`).

**Keep**

- Equal-height tracks on a shared axis with bar-and-cap marks.
- Compressed idle with a marker on the ruler.
- Selection detail below the split; zoom controls.

**Problems**

1. **Seven lines of header before the timeline**: reference; truncated title; "LZ-137 ·
   0f6bb558 · r1"; "gpt-6-luna · max Attempt 1 · duration not recorded"; "1 attempt · 31 tool
   calls"; Objective disclosure; "Elapsed since first attempt · 2:18:33 AM"; "As of capture
   5:47:28 PM Refresh". The reference appears twice.
2. **Title truncates** at one line.
3. **Hatching covers the whole timeline background**, so real recording gaps do not stand out.
4. **Tool marks are olive green** (see Green).
5. **The attempt lane label is "1 31"**: two bare numbers with no words.
6. **Footer is reconciliation prose**: "24 calls placed · runner counted 31 · 0 file targets · 2
   recording gaps · 50 of 209 captured events loaded", then a manual "Load more". DESIGN.md
   requires background loading to exhaustion.
7. **Inspector shows raw values and internal notes**: "Start · 1793863275851 Unix ms · 2:21:15
   AM · +2:42"; "Timing source · Verification receipt check.startedAt/check.endedAt; absent
   endpoints remain unknown".
8. **The axis starts at 1m30s** after a compression mark with no label for what was skipped.
9. **Six-minute spinner** after the restart (cross-panel finding 1).

**Ranked improvements**

| # | Change | Rationale |
| --- | --- | --- |
| 1 | Header in three lines: reference + state + Open task; two-line title; attempt picker + model + active time + counts | Timeline moves up about 90 px |
| 2 | Hatch only recording gaps; compressed idle is a narrow labelled break ("1m32s idle") | The two are different facts and must look different |
| 3 | Track hues: attempt blue, tools violet, files amber, checks neutral strong; failures red on any track | No green outside success |
| 4 | Lane labels: "Attempt 1", "Tools 31", "Files 7", "Checks 6" | Words beside numbers |
| 5 | Remove "Load more"; show "118 of 184 events" with a thin progress line while streaming | Matches the streaming contract |
| 6 | Inspector: state + kind + duration; the command; Started / Ended / Result in clock time with offset; Output and Timing source as disclosures | Removes Unix ms and prose |
| 7 | Attempt usage block: market cost, tokens in (cached), tokens out, with price source and date; omit cost when no price exists | One honest summary |
| 8 | Reconciliation counts ("placed" vs "runner counted") move to a "Data gaps" disclosure shown only when they differ | A defect report, not a footer |

**Implementation plan**

- `src/trajectory-panel/panel.tsx` (2,159 lines): header block; lane labels; footer; inspector
  sections for checks (near lines 1500–1610) and tools (near 1640–1670); usage block (near
  1800–2050). Remove the strings listed in the Unknown table.
- `src/trajectory-panel/panel.css`: `--trajectory-hue-tools` to a non-green host token (for
  example `--syntax-keyword` or `--icon-agent-build-base`; confirm against the host theme on
  light and dark); hatch only on `[data-gap]`; break marker style; two-line title clamp.
- `src/trajectory-panel/panel-state.ts`: auto-continue pages until the cursor is exhausted;
  expose `loaded / total` for the progress line. This is already scoped in
  `.agents/plans/panel-streaming-idle-axis.md`; land the display with that work.
- `src/trajectory-panel/tracks.ts`, `panel-layout.ts`: emit break labels from the same transform
  as marks.
- Tests: a CSS token test like `test/task-panel/icon-colors.test.ts` asserting no success token
  on tool marks; layout test that breaks and marks share the transform.
- Acceptance: at 360 px the first track is within 150 px of the panel top; no "Unix ms",
  "unknown" or "not recorded" text; no manual load control; gaps and idle breaks are visually
  distinct in a screenshot.
- Size: M (S for colors, labels and header; M with streaming display).

## Settings and header indicators

Mockup: `mockups/settings.png`.

**Keep**

- Feature switches with one-line descriptions.
- Advanced diagnostics collapsed.
- Read-only framing of the provider budget.

**Problems**

1. **Two pages for one plugin, built differently** (`settings-01`, `settings-03`). "LAZERS" has
   an eyebrow, 18 px title at y = 76, right-aligned switches and menu buttons. "Provider budget"
   has no eyebrow, title at y = 40, a small-label switch on the left, native `<select>` and
   number input, and a narrower column. Both use the same sidebar icon.
2. **Provider budget shows fields for both providers at once**: "Go allowance" and "OpenRouter
   weekly budget" regardless of the Provider value.
3. **"Task workflow" is a section with no controls**, pushing the first control below 360 px.
4. **GPU runtime repeats its state**: an "Unloaded" badge and "Unloaded; the next request loads
   the cached model".
5. **Idle unload reads "Unload when idle: 15 minutes"** on this machine. The menu's default is
   "Never (default)". If the owner intends Never as the standing choice, the stored value needs
   changing by hand; the page does not signal that the current value differs from the default.
6. **Settings as menu buttons with the value inside the label** ("Unload when idle: 15 minutes",
   "Voice: …") instead of label left, control right.
7. **Voice has no preview** next to the picker (source: voice tests exist elsewhere on the page).
8. **Inference indicator is 40 × 40 px** (`inferenceIndicatorStyles`: `min-width: 40px; height:
   40px`) beside 26 px host controls; the accessibility frame is 37 × 37 against the neighbor's
   55 × 26 (`header-01`). It showed the icon only, alternating between the unloaded diamond and
   the error mark during the review, with no model name.
9. **Budget indicator shows "—"** when there is no reading (source). It was switched off on this
   machine, so it was not seen live.

**Ranked improvements**

| # | Change | Rationale |
| --- | --- | --- |
| 1 | One LAZERS page; provider usage becomes a section on it | One place, one style |
| 2 | Every setting is a row: label and hint left, control right | Scannable; matches host pages |
| 3 | Show only the fields for the chosen provider | Removes dead inputs |
| 4 | Drop the "Task workflow" section; fold its one fact into the page lede | First control near the top |
| 5 | Rename to "Keep model loaded" with values Always / 1 / 5 / 15 minutes; runtime state shown once in the section header | Positive phrasing of the owner's default |
| 6 | Voice row: picker + Preview | Choose by ear |
| 7 | Indicators at 26 px height with 16 px glyphs; name + glyph; compact mode drops the name | Aligns with host controls |
| 8 | Budget ring with no reading shows a dashed ring only | No "—" |

**Implementation plan**

- `src/gui.tsx`: remove `Overview` "Task workflow"; restructure sections into rows; replace
  `Ui.Menu` label-value buttons with a labelled row + menu; add the Preview button using the
  existing read-aloud test path; mount the budget section.
- `src/budget/gui.tsx`: export the settings body as a section component instead of registering
  its own `SettingsPage`; replace `<select>`/`<input>` with `ctx.ui` controls; conditional
  fields; dashed ring and no "—" label in `presentation`; remove "Earlier weekly usage unknown"
  from the tooltip (keep it in the settings hint).
- `src/webgpu/indicator.tsx`: `height: 26px; min-width: 26px; padding: 0 7px`; 16 px icon.
  Update `indicator.test.tsx`.
- Check `docs/reference/user-controls.md` for the page names and update it with the change.
- Acceptance: one "LAZERS" entry in the settings sidebar; the indicator's box height equals the
  host context button's; with Provider = OpenRouter no Go field is rendered; first control is
  within 200 px of the page top.
- Size: S–M.

## Mockups

| File | Shows |
| --- | --- |
| `mockups/tasks.png` | Priority column, tree expansion with guides, two-line inspector, filter menu with counts, All ordering, reconnecting state, glyph set |
| `mockups/radar.png` | Single header with Monitor/Map/Flow, parent → worker tree with live calls, inspector on selection only, offline state, map view, idle state |
| `mockups/models.png` | Compare with chart-first layout and "Assign to" action, Assignments as its own view, single loading surface, actionable benchmark empty state |
| `mockups/trajectory.png` | Three-line header, non-green tracks, labelled idle break vs hatched gap, clean inspector with usage, streaming progress, slow-load and no-task states |
| `mockups/settings.png` | Unified LAZERS settings page; inference and budget indicators at host size in every state |

Mockup colors are stand-ins sampled from the live dark theme (`mockups/shared.css`); product code
keeps using the host tokens named in DESIGN.md. Values in the mockups are illustrative.
Mockup font is the system UI face because Inter is not installed on this machine.

## DESIGN.md changes this review implies

These are for the owner to accept or reject; nothing was edited.

- Tasks section still describes "Now and Attention rows" and grouped parallel siblings. It
  predates today's flat-list decision.
- Add the green rule and the "omit, do not label unknown" rule to Shared patterns so they bind
  every panel.
- Add the loading contract from cross-panel finding 1.
- Trajectory: name the track hues and state that no track uses a success color.
