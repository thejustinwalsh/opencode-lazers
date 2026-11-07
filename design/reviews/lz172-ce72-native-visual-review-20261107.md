# LZ-172 ce72ed5 actual Desktop visual review

Native reviewer: `openai/gpt-6.1-terra#high`. All three images and `DESIGN.md`
were viewed. This review ran no tests, edits, reloads or controls.

## Basis

- Candidate: `ce72ed5576397ba02bb88a868f6d46f13215d9bb`, still unmerged.
- Actual connected screenshots:
  `design/reviews/artifacts/lz172-ce72-desktop/wide.png` and `narrow.png`.
- Reference: `design/models-panel/models-approved.png`.
- Latest direction overrides the reference's obsolete table arrangement: chart
  full width at every size, selected cost one or two lines **below**, no side
  table, minimal consumer copy, secondary details initially collapsed.
- Root preview uses ignored GUI assets only, with canonical rollback retained at
  `/private/tmp/lz172-ce72-gui-preview-jqi01e_4`. It now renders real project data
  without the previous sourceLink crash. That fixes compatibility, not visuals.

## Verdict: both widths require bounded presentation repair

Wide: selected Kimi has no visible point label; Qwen's label truncates. The
legend clips at the default horizontal split. Primary-view “Partial” and
“Priced portion only” expose accounting diagnostics rather than a quiet consumer
comparison hierarchy.

Narrow (340px): selected Kimi is again unlabeled and Qwen truncates. The x-axis
title and legend clip below the initial split. Large filter controls wrap across
two rows and consume substantial vertical space. The selected-cost source line
repeats “current.”

## One coherent correction in the original worker

Restore compact native/Linear comparison hierarchy at both widths: reduce
header/filter footprint, fit the complete chart including axes and legend in the
initial comparison region, and make model **and effort** readable for plotted
identities, especially selection. Keep the full-width chart without a side table.
Put selected cost in one or two concise lines below it. Remove repeated wording;
move coverage, assumptions and accounting diagnostics into tooltips or initially
collapsed detail.

Preserve selection IDs, exact full-route hover/accessibility, sourced estimates,
the current three-source consumer contract and truthful partial/unknown costs.
Do not imply a subtotal is a complete total or replace unknown with zero.
This is consumer presentation, not backend accounting redesign or a new task.

## Remaining actual interaction qualification

Root continues selection probes. Recheck keyboard/focus, point/full-route hover,
Refresh and selection stability, split resizing and independent scroll, relevant
theme/font and state behavior. Still images do not establish these or full
acceptance. Source and plan integration remain withheld pending actual review.
