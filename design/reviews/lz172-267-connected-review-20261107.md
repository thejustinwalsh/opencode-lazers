# Models correction: connected Desktop observation

Candidate `267e160ae5b8cc10ae0c4df53b8223191e5e86ac` was composed into the existing native review checkout as `a5bc38b`. Canonical pricing producer and GPU source remain unchanged. Automatic formatting/lint fixes, type checks, GUI build and 40 related tests / 1,279 assertions passed on the composition. The original worker recorded 60 tests / 1,592 assertions passing before committing.

At Unix ms 1794093873863 Root staged the composed GUI through the normal host bundle watch. Source remains unmerged. Preview metadata and reversible backup are recorded in `/private/tmp/lz172-267-current-preview.json`.

Actual Desktop observations:

- Selected Luna current OpenRouter range is visible immediately below the horizontal divider at both wide and narrow widths, without scrolling. Secondary details stay collapsed.
- Clicking the Qwen chart point selects Qwen and updates the inspector to its current OpenCode fallback cost. The selected Qwen label now clears x-axis ticks.
- Regression: the selected Luna label above its far-right point extends beyond the chart's right boundary and is visibly clipped at both widths. Moving all selected labels above their points resolved the axis collision but removed the previous inward placement for edge points. Label containment must handle both horizontal edges as well as axes, while preserving full identity in accessible/hover text.

Screenshots: [wide](artifacts/lz172-267-desktop/lz172-267-wide.png), [narrow](artifacts/lz172-267-desktop/lz172-267-narrow.png), [Qwen selection](artifacts/lz172-267-desktop/lz172-267-qwen-narrow.png).

This is a partial improvement, not visual acceptance or plan completion. Continue the same LZ-172 worker; no replacement task or backend/pricing redesign is needed for this observed defect.
