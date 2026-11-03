# Models connected Desktop review — 2026-11-03

**Presentation needs correction before visual acceptance.** In the connected wide and approximately 400 CSS px captures, the panel has the approved continuous surface, Compare/Assignments hierarchy and horizontal inspector split. It truthfully says the estimate is unavailable. However, the upper pane is consumed by filter explanations and source snapshots: the wide capture only reaches the top of the unavailable-chart message, and the narrow capture does not reach the chart or candidate rows at all. The approved reference makes comparison and selectable candidates the first-view focus. The lower pane shows a selected route and task context, but the screenshots do not establish selection behavior.

1. **Bring comparison into the initial upper pane.** In `comparison-panel.tsx`, condense the persona-context and unavailable task-class/cohort/period explanations into a compact truthful status near the controls; keep the full explanation discoverable. Collapse the three source-snapshot blocks into a concise source/coverage disclosure, keeping refresh failures and stale or unavailable warnings visible. Place the chart's honest unavailable state and candidate rows immediately after these controls. The scrolled narrow capture shows each candidate as a tall block repeating source headings and missing-match explanations; make these compact selectable rows with route/effort and concise truthful availability, and move the detailed source correspondence into the selected inspector. Preserve readable host-sized text and the narrow stacked/wide side-by-side composition; do not fabricate a plot or rows.
2. **Restore the selected-model inspector hierarchy.** Lead with route, task estimate or its unavailable state, and a concise selected-task summary. Put detailed per-category usage, provenance and route evidence behind the existing disclosure pattern, retaining all values and clear coverage/unknown states. The current inspector starts useful but its extended technical detail competes with the decision surface.
3. **Keep narrow controls understandable.** The project and selected-task labels truncate in the narrow capture, while explanatory lines wrap over several rows. Reflow compact controls and provide the full project/task identity through an accessible name or disclosure; keep the context-only meaning and unavailable filters explicit. Preserve the split and independent pane scrolling rather than shrinking text.

These are presentation corrections to the current partial view. Comparable cohorts, frontier, valuation, task estimates and editable/live assignments remain separate data and behavior work; the screenshots do not prove them complete. Root observed that one upper-pane scroll left the inspector stationary. The captures do not establish keyboard, theme/font, refresh, disclosure or divider interaction acceptance. Recapture connected narrow and wide views after correction, including a selected candidate and an unavailable or stale state, and exercise those interactions separately.

References: [approved composition](models-approved.png), [implementation guide](implementation-plan.md). Captures: `/private/tmp/lazers-models-wide-20261103.png`, `/private/tmp/lazers-models-narrow-20261103.png`, and `/private/tmp/lazers-models-narrow-candidates-20261103.png`.

## Confirmed grouping and identity defects

The user clarified that effort is a model configuration, not a separate model
row. The connected view expands 471 native catalog records into 1,373 candidates.
Group the model presentation and offer applicable effort selection; retain exact
provider/model/effort identity and separate measurements beneath that presentation.

`comparison-read.ts` currently attempts the external model join only when
`providerID === "openrouter"`. This excludes direct Anthropic/OpenAI routes from
the provider-independent fallback. The app already retains both native
`anthropic / claude-fable-5` and external `anthropic/claude-fable-5`, yet the direct
route shows no match. A fresh authenticated metadata-only call to
`https://openrouter.ai/api/v1/models` at Unix ms `1793735476720` returned HTTP200,
417 records and 20 Anthropic records, including that model, Sonnet 5.5, Haiku 5.5
and `openai/gpt-6-luna`. No inference or credential persistence occurred.

Associate source-backed model identities across execution providers, including
verified aliases where necessary. Preserve real release/fast/batch differences
and ambiguity; distinguish an unsupported association from upstream absence.
Corrected direct Anthropic/OpenAI rows require live validation before acceptance.

A further native metadata read at Unix ms `1793736540560` confirms that
`Model.Info` exposes `modelID` separately from the catalog `id`; our snapshot
currently drops it. Direct Sonnet/Haiku5.5 still use hyphenated IDs while
OpenRouter uses dotted versions, so this field alone does not resolve them.
Native `openai/gpt-6-luna-fast` has underlying `modelID: gpt-6-luna`: underlying
identity alone must not erase intentional Fast configurations/products. Any
remaining alias gap must be reported as unsupported association rather than
upstream absence. Retaining this field is useful source-harvest work, not proof
that all provider aliases are solved.

## Post-LZ96 visual assessment

The connected [narrow](/private/tmp/lazers-models-narrow-lz96-20261103.png) and [wide](/private/tmp/lazers-models-wide-lz96-20261103.png) captures show a substantial correction: compact context and collapsed source snapshots now let the honest unavailable-chart state and candidate list appear above the split. The narrow view stacks them; the wide view places them side by side. The selected route and unavailable estimate lead the lower inspector, with task and evidence details subordinate. This matches the approved composition's hierarchy for the data currently available.

**Remaining visual blocker:** the selected-task menu trigger clips its text vertically in both captures, with the chevron on a separate line. Make the native trigger a single aligned row with a bounded, meaningful task label and ellipsis; expose the complete task identity accessibly and in the menu/inspector. Verify at both widths after the correction. At narrow width, keep the unavailable-chart message concise so more than one compact candidate can be scanned above the divider without reducing text size.

The wide list repeats one model for each effort; the active LZ97 grouping and subsequent provider/effort selector wiring address that known identity issue. These captures do not establish that behavior. Comparable cohorts, frontier, valuation and estimates remain unavailable, and the approved image's illustrative numbers are not a basis to fill them. The captures alone do not establish keyboard, theme, refresh or disclosure behavior; recapture after the trigger fix and check those interactions separately.

**Trigger correction:** The subsequent [narrow](/private/tmp/lazers-models-narrow-trigger-fixed-20261103.png) and [wide](/private/tmp/lazers-models-wide-trigger-fixed-20261103.png) captures show “Task · LZ-93” and its chevron aligned and fully visible. The previously observed clipping blocker is resolved in these views. This disposition covers the captured partial layout only; grouping, matching and comparable-cohort features remain pending, and screenshots do not establish interactive or complete Models acceptance.

Root's connected interaction pass confirmed the native task menu opens and
closes with Escape; keyboard Down/Enter selects Fable Low and updates its
inspector; Up/Enter restores High. The keyboard divider moved from56.92482 to
61.92482 and back. Source disclosure revealed the actual dated471 native /418
OpenRouter /152 benchmark snapshots and collapsed again. These checks do not
establish theme/font changes, grouped-route selectors or full Models acceptance.

One data-display follow-up remains: the menu correctly calls LZ93 accepted while
the inspector says submitted, because it renders specification status instead
of the existing execution state. Correct this in the subsequent UI wiring.
