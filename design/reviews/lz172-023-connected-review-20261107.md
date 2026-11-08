# Models containment correction: connected review

Original worker candidate `0233df0` was merged into Root's existing native review branch as `e6ef0819ae498a367d8156f2a6c70c45c2f8866c`. Canonical pricing producer and WebGPU source are preserved. Automatic formatting/lint fixes, type checks, GUI build and **72 tests / 1,707 assertions across eight files** passed on this composition. Native worker recorded 60 required tests / 1,643 assertions passing. No new checkout or worker was created.

Root staged the composed GUI at Unix ms1794096096230 through normal bundle watch. Reversible preview metadata: `/private/tmp/lz172-023-current-preview.json`; source is still unmerged in main.

Actual Desktop observations:

- Luna's selected label is fully visible inside the right plot edge at narrow and wide widths. Qwen's selected label stays above the x-axis ticks and inside the plot.
- The selected sourced cost is immediately visible below the horizontal divider at stored split56, without upper-pane scrolling, for both models and widths.
- Clicking Qwen's plotted point selects Qwen and updates the cost summary; the native model selector selects Luna and updates its current OpenRouter range. One wide Luna point click missed its narrow hit target; selection via the native selector succeeded. No inference/model route setting was changed.
- Full-width chart, compact controls, lower inspector, collapsed sources/details and inherited native theme remain present. No persistent right-side table.

Screenshots: [Luna narrow](artifacts/lz172-023-desktop/lz172-023-narrow.png), [Luna wide](artifacts/lz172-023-desktop/lz172-023-wide.png), [Qwen narrow](artifacts/lz172-023-desktop/lz172-023-qwen-narrow.png), [Qwen wide](artifacts/lz172-023-desktop/lz172-023-qwen-wide.png).

Driver assistance: after hot update, the panel remained at loading producer data across repeated observations. Existing read-only native overview/rows/configurations requests returned one shared snapshot in7,832ms at Unix ms1794096198490. One native Refresh then immediately populated the chart. Cause is not attributed; initial automatic loading/recovery is not proven by manual Refresh. Record this separately from the observed label/cost improvements. No service restart or active worker interruption occurred.

Native Terra High screenshot follow-through, remaining interaction checks and supported runtime acceptance/integration are pending at this report boundary. This report does not claim whole Models pricing/routing delivery or whole-product performance acceptance.
