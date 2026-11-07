# LZ-172 combined 2a4 preview: native Terra High review

Terra viewed the actual narrow/wide images in
`design/reviews/artifacts/lz172-2a4-desktop/` against the approved mockup,
`DESIGN.md` and latest user direction. These show Root's combined `2715a4b`
preview of candidate `2a4ad5c` plus current canonical source, not candidate-only
activation. Main source remains unmerged; Root owns the review checkout/build.

**Improved:** compact controls, full-width chart, readable model/effort labels,
and no longer clipped axis title/legend at the split.

**Still fails visual acceptance at both widths:**

1. The selected Qwen inspector below the split shows its name but no visible
   cost summary. Images prove absence from the first view, not its implementation
   cause; Root separately reports the summary sits in the upper scroll region.
2. The selected two-line Qwen badge overlaps x-axis tick labels near chart bottom.

One bounded correction in the same original worker: keep an applicable sourced
one- or two-line selected cost summary visible directly below the chart at stored
split 56, without scrolling the upper region; omit genuinely unknown costs. Keep
point labels from obscuring axes. Preserve the improved full-width layout,
compact controls, collapsed details, selection IDs, hover identity, truthful
partial/unknown coverage and source provenance. No backend accounting redesign.

Extend focused registered/rendered coverage for these actual selected marks and
split geometry. Root's actual selection/scroll/keyboard/hover probes and final
narrow/wide reprobe remain required. Passing checks and still images do not grant
full acceptance. Keep source and plan integration pending; no duplicate Architect
integration checkout, GUI build or activation.

## Related source finding for the same correction

Independent Luna review found `chartModelEffortLabel` bounds the model name but
appends `route.variant` unbounded (`comparison-presentation.ts:413–424`); the route
contract permits up to 512 characters. The new fixture covers only
`preview-effort`, and existing 340px assertions check text/options rather than
non-overlapping geometry. Bound the combined visible identity appropriately while
retaining the exact full route/effort in hover/accessibility and unchanged
selection IDs. Keep this related label fix and its focused regression with the
same summary/axis presentation repair, not another task or backend change.
