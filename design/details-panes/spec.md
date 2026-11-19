# Details panes

Approved by the owner on 2026-11-19. The mockups in `mockups/` are the visual
reference (open the `.html` source; every style is inline). `audit-20261119.md`
records what the panes showed before. `DESIGN.md` remains the design system;
where this file and `DESIGN.md` disagree about a details pane, this file wins
and `DESIGN.md` is updated to match.

## Why

The owner opens a pane to learn, in one screen: what the item is, what it aims
to do, how far along it is, what state it is in and why, how long it has run
and what it has been doing. The panes answered with 1,200 to 2,200 words, the
same sentence up to five times, conflicting state words, raw identifiers and
accordions that hid the one useful fact.

## Rules for every pane

1. The first screen (the pane at its default height) answers: what, state, why,
   what next, how long, what it did.
2. One fact appears once. The bar names the item; the body does not repeat the
   bar, the list row or itself.
3. Values, bars and rows before sentences. No paragraph over two lines.
4. One state word per item, the same in every panel. Tasks, Radar and
   Trajectory read it from one presentation function.
5. Omit, do not label unknown (`DESIGN.md`). A missing optional fact removes its
   stat, row or disclosure. An empty disclosure is not rendered.
6. Labels are one or two words, a noun: Progress, Activity, Summary, Coverage,
   Position, Duration, Runtime, Age, Calls, Rates, Events, Gaps, Payload,
   Caveats, Identifiers. Never a phrase or a question. "Done when" is kept by
   owner decision.
7. Disclosures add depth. A closed row shows its label and, where it has one, a
   count: `Events · 165`. Raw ids, hashes, paths to the repo root, snapshot ids
   and column names appear only under Identifiers, each with a copy control.
8. Selecting a small thing shows that thing and a link to its parent. The
   parent's report is not repeated beneath it.
9. Internal event and state names are translated for display (`EFFECT_INTENDED`,
   `worker-execution-outcome`, `exact-native-model-quote` are not display text).
   The raw name stays available in Payload or Identifiers.
10. Money shows one figure at two decimals where it is read, more only in a
    disclosure table. One caveat, once, as a label or under Caveats.

## Shared pieces

Build these once and use them in every pane. Colors come only from host tokens
or `color-mix(in oklch, …)` of host tokens, as `--lazers-hue-tools` is defined
in `src/trajectory-panel/panel.css`. No hex values, no new palette.

| Piece      | Looks like                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bar        | The existing 32 px `DetailsPane` bar: chevron, state glyph, state word in its tone, identity, actions as text buttons                                                                                                                                                                                                                                                                                                                                           |
| Callout    | The existing `.lazers-tasks-callout`: raised surface, 8 px radius, no border, tone on the glyph only, one or two sentences, optional Details link                                                                                                                                                                                                                                                                                                               |
| Stat row   | Up to four columns between two hairlines; label 12 px weak, value 12.5 px mono strong. A column with no value is not rendered                                                                                                                                                                                                                                                                                                                                   |
| Label      | 1 px border in the hue, fill `color-mix(in oklch, hue 22%, transparent)`, 3 px radius, 11 px text. For a state that changes how a number should be read                                                                                                                                                                                                                                                                                                         |
| Progress   | Five 2 px segments with a word under each. Passed: neutral. Current: the state's tone. Later: border color. Green only for Integrated                                                                                                                                                                                                                                                                                                                           |
| Activity   | One Trajectory-style lane: inset track between hairlines, tool ticks in the tools hue, failures in critical, a collapsed quiet stretch as a narrow (20 px) hatched break. No text and no captions inside or under it; hover or keyboard focus shows the detail (a mark: what, when, how long; a cluster: its count and time range; a quiet stretch: its length and from-to; the bare track: start and end), and its accessible name states the summary in words |
| Coverage   | A 4 px two-part bar (priced, unpriced) with one caption line                                                                                                                                                                                                                                                                                                                                                                                                    |
| Rows       | Flat grid rows, 28 to 30 px, hairline between, a 26 px weak header row for tables                                                                                                                                                                                                                                                                                                                                                                               |
| Disclosure | A bare chevron row, 28 px: label, then `· count` in weak text. No border, no card                                                                                                                                                                                                                                                                                                                                                                               |

Type follows the scale in `src/trajectory-panel/panel.css`: body 13, controls
12.5, meta 12, small meta 11.5, mono 10.5 to 12. Radii: 8 on the callout, 6 on
controls and code, 3 on labels, none on stats or rows.

## Panes

Each pane lists what the first screen holds, top to bottom, then its
disclosures. Data that does not exist yet is the implementer's to source from
the runtime; if it cannot be sourced honestly, omit the piece and report it.

### Tasks, one task (`src/tasks/panel.tsx`)

- Bar: reference, glyph, state word, title, primary action, more menu.
- Title (two lines at most) and the existing meta line.
- Callout when the task is waiting, blocked, failed or needs the owner: the
  real reason in one sentence (today it is two disclosures deep) and what to do.
- Progress: Queued, Working, Checks, Review, Integrated, mapped from the task
  and plan lifecycle states in `lifecycleMachines`.
- Stat row: Age, Runtime, Calls (with files), Model.
- Activity lane for the latest attempt, with "Open in Trajectory".
- Done when: one line per criterion, square marker, a chevron to read the full
  text. A short line is derived, not stored: the evidence name when one exists,
  else the first clause at a word boundary. Per-criterion results are shown
  only when recorded.
- Disclosures: Scope, Checks, Guidance, History, Identifiers.

### Trajectory, one attempt (`src/trajectory-panel/panel.tsx`)

- Bar: glyph, outcome, attempt n of m, task reference, Open task.
- Callout: why it ended, when the outcome is not plain success.
- Stat row: Duration, Calls (with files), Tokens, Cost (with a `partial` label
  when some usage has no price).
- Summary: Setup, Work, Errors, End, one row each, derived from the recorded
  events. Errors links to the filtered events.
- Coverage bar with the price source and date.
- Disclosures: Rates, Events, Gaps, Identifiers. Events is a filterable list
  with translated names.

### Trajectory, one call, check or event

- Bar: glyph, result, tool name, position `12 / 38`, previous and next.
- Link back to the attempt.
- Command or target in a code block.
- Stat row: Started (with offset into the attempt), Duration, Result as a label.
- Position lane with the selected call outlined.
- Disclosures: Output, Files, Payload, Identifiers, each only when non-empty.
- Nothing from the attempt report below.

### Radar, one worker (`src/radar/monitor-view.tsx`), and Flow selections (`src/radar/panel.tsx`)

- Bar: glyph, state, role, task reference, Open task, Trajectory.
- Last call line, with an `idle` label when the worker has been quiet.
- Stat row: Started, Runtime, Calls (with files), Model.
- Activity lane (the same component as Tasks).
- Recent calls: four rows with a header (Tool, Target, Duration, Time).
- Disclosures: Calls (earlier), Files, Messages, Identifiers. Zero counts are
  not rendered.
- Group nodes (Needs you, Failed, Queue) list their tasks as rows that select
  the task; the count is not repeated three times.
- Flow edge and state selections follow the same shape: bar, one stat row,
  Identifiers.

### Models, your runs and benchmark, one model (`src/models/compare-view.tsx`, `known-usage-card.tsx`)

- Bar: model name, route in mono, Assign.
- One headline figure with its unit, and a `small sample` label when it applies.
- Stat row: Accepted, Tokens / task, Time / task, Attempts / task (your runs);
  Score, Input, Output, Cached (benchmark).
- Coverage bar: the priced share and what is not priced.
- Runs: one row per task with outcome, tokens, cost and a Trajectory link.
- Disclosures: Tokens, Sources, Caveats, Identifiers.
- The all-models table is not part of the details pane.

Assignments is a form and keeps its layout; apply the shared pieces and rules
6 and 7 only.

## Not in scope

The lists and charts above each pane, the pane's open, close and resize
behavior, and any runtime behavior.

## Acceptance

For each pane: the first screen at default height holds the items listed above
for a real selection in the running app; no fact repeats; no display text
matches `unknown`, `unavailable`, `not recorded` or a raw event name; expanded,
no prose block exceeds two lines; existing panel tests pass and new ones cover
the derived values (progress mapping, summary rows, short criterion lines,
omitted empty pieces).
