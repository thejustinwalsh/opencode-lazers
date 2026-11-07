# LZ-172 retained source and rendered-chart review

## Reviewed source

- Original attempt: `14b02650-aea7-43fa-a7dd-3e60228f00b5`.
- Retained HEAD: `0da668188eb08942edfb9e01fda2538bb3c0b9c8`.
- Four tracked WIP files: comparison chart, presentation helper, panel CSS and
  chart DOM test. Patch SHA-256:
  `1000cbe20f4a356ef6160ed6020bce37c4def7b8536a453aa8cdc6e2157d5c8b`.
- Independent Luna source review and a final hash check confirm this identity.
  The original checkout was not edited, formatted, built, prompted or resumed.

## Findings for the existing UI correction

1. `comparison-chart.tsx:695–699` bounds the already bounded route-aware label
   again. This can erase its distinguishing tail. The dirty test helpers for
   routed ranges and priced ranges remain unused; substring assertions do not
   establish distinct visible route labels.
2. `comparison-panel.tsx:394–398,420–430` still hardcodes “OpenRouter endpoint”
   wording for scenarios resolved from catalog provenance. The panel fixture
   covers only the endpoint case.
3. The WIP adds distinct conditional scalar/range legend symbols. This is useful
   progress, but existing assertions check legend text rather than symbol shape.
4. Strict checking finds eight errors in the dirty route-disambiguation helper:
   `comparison-presentation.ts:410–436` allows undefined component values in
   length/slice/prefix/suffix/map operations. This candidate is not quality-clean.

These are related fixes for the original Models outcome, not new tasks. The user
subsequently rejected the dirty 77-line `p:/m:/e:` coding scheme: replace it with
readable model/effort labels and full-route tooltips within LZ-172. Do not repair
or extend that coding scheme merely to make its strict errors pass.

## Isolated verification

An archive of the exact retained HEAD plus the four-file patch was rendered in
an independent temporary directory. Only that copy received automatic formatting
and lint fixes. Diagnostic additions to its existing chart DOM test exported SVGs;
no product implementation was changed. Checks opened no listening server.

- Automatic `fmt → lint --fix → fmt` completed. Two unused-helper warnings remain.
- `bun check` failed with the eight errors above. Behavior tests were then run
  separately for diagnosis; their success does not override the strict failure.
- Initial focused run: **47 passing, 591 assertions**, with a panel setup error
  because the archive lacked generated `dist/radar-layout-worker.cjs`.
- After running the existing `scripts/build-radar-layout.ts`, the panel-only run
  passed: **7 tests, 79 assertions**.
- The changed diagnostic resize capture alone passed: **1 test, 25 assertions**.
  It waits for ECharts' actual finished render before exporting; an SVG width
  change alone initially captured intermediate resize geometry.

No full quality/behavior pass, candidate acceptance or integration is claimed.

## Narrow/wide pixels and limits

The existing actual ECharts SVG fixture rendered at 330×190, 450×230 and 960×320,
with a 20px inherited font. PNGs are direct rasterizations of those settled SVGs:

- [330px](lz172-retained-render-20261107/narrow-330.png)
- [450px](lz172-retained-render-20261107/medium-450.png)
- [960px](lz172-retained-render-20261107/wide-960.png)

The 330px selected label visibly crowds the dollar tick area and truncates to
“GPT-6 Lun…”. At wider sizes the label still truncates the provider name to
“Open…”, so these images do not demonstrate route disambiguation. The wide
settled plot uses its full available width. These are chart-fixture pixels, not
connected panel or live OpenCode Desktop screenshots; controls, details, native
font metrics and connected interactions remain unverified.

The initial literal “tera” search found no model. After the user's spelling
correction, native catalog search resolved `openai/gpt-6.1-terra#high`. Its review
of these exact PNGs confirms a selected-label/$0.10 tick collision at 330px;
450px removes that collision but still truncates identity; 960px has ample plot
space and legible ticks but also truncates the selected label.

Terra's completion criteria match the user correction: readable model/effort
labels without an encoded scheme, full-route tooltips, no label/tick collisions,
and useful full-width plot space with details below. This is a finding, not visual
approval. Native-font, tooltip, control, interaction and connected full-panel
acceptance remain open.
