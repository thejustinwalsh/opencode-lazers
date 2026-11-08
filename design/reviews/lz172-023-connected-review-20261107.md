# Models containment correction: connected review

**Complete:** LZ-172 is accepted and integrated at native plan version138. Source landed in main `c94debf`; both the original worker checkout and Root review checkout are removed. The rest of this report preserves the observations leading to that result.

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

## Completed interaction review and source integration

The same native Terra High reviewer viewed all four screenshots and reported a visual pass with no essential remaining gap. Native Luna source review also reported no material blocker. Root then completed the connected interaction pass:

- Closed Models as a normal tab and reopened it through Add tab → Models. Data loaded automatically without Refresh and retained the selected model. Later returns from Settings and the canonical bundle update also loaded automatically. The earlier hot-update/manual-Refresh occurrence remains an unattributed observation, not a universal startup success claim.
- Keyboard resized the split56→61→56. Chart data opened, Tab reached its model controls, and keyboard Return selected Qwen, updating its exact route and cost. Disclosures were collapsed again.
- Temporarily selected host Light appearance, Georgia UI font and125% zoom. Models adopted the light colors and serif font; chart labels and cost remained readable. At the larger zoom, the upper pane scroll exposed the lower chart axes/legend while the lower inspector stayed in place. Lower inspector scrolling independently preserved the chart. Original **Dark / Ayu / default Inter field /100% zoom** were read back after restoration.
- Native Refresh preserved the selected Qwen configuration. Documentation filtering produced a real empty graph with absent amounts; All restored the comparison. Root replaced the empty inspector's internal configuration-ID message with short loading/selection copy in `7295465`, updating the existing registered-panel expectation. The composed candidate again passed72tests/1707assertions, quality fixes and GUI build. The canonical empty message was observed as “Select a model to compare.” No forced provider outage or live error-state claim is made; naturally observed loading/empty/priced-portion states and tested error/cancellation paths remain distinct facts.

Source is now integrated into main as **`c94debfe4d48beccdb457100e1c233ec4c801436`**, including original worker `0233df0`, composed review and Root copy correction. Canonical automatic quality checks and GUI build passed, and the canonical GUI is loaded. The ignored preview is ended; `/private/tmp/lz172-023-current-preview.json` and its backup remain historical rollback metadata. This accepts the scoped LZ-172 visual/interaction correction against its design direction. Supported native acceptance/integration recording and non-forced owned checkout cleanup remain for Architect/Root to complete; residual performance and broader Models roadmap are not declared complete.

Additional actual artifacts: [host appearance](artifacts/lz172-023-desktop/lz172-023-light-georgia-125.png), [upper scrolling](artifacts/lz172-023-desktop/lz172-023-light-georgia-125-scrolled.png), [independent lower scrolling](artifacts/lz172-023-desktop/lz172-023-lower-scroll.png), [canonical empty state](artifacts/lz172-023-desktop/lz172-023-empty-canonical.png).

## Native finalization and cleanup

At Unix ms1794097668196, readback shows plan09cb85ba-dc17-40ed-adff-c0e7e50ad135 **integrated / version138**, task and original attempt accepted at artifact0233df0fd7867dc58e45b95861b4ac42e2ac8545. Native Architect recorded the existing Root human observation, task landing, reconciliation and plan integration through ordinary supported controls. No production SQL mutation or worker replacement was used.

Both checkout paths are absent on direct readback. Root's separate clean, fully merged review checkout was removed with OpenCode's native `worktree.remove` and `force:false` at Unix ms1794097608884: [receipt](artifacts/lz172-023-desktop/root-review-cleanup.json). Original worker cleanup completed through runtime. Canonical source/history, committed images, model files and the active Tasks/Radar work were preserved. The preview metadata is historical; do not rebuild from the removed review directory.
