# LZ-141 native review

Source: original Luna Max worker `c6f380c`, integrated in main `569f2e0`.
Task89646906-1d2e-4027-b28d-bdd6be580fe9; original attempt
d63243f2-4f6c-4a14-b26b-4a72200d073b; session
ses_9f38dcf3886440938e167596f2517a32. No replacement worker.

## Verified

- Current-main45 tests/1017 assertions in5 files pass. Format/lint/types, diff
  check and GUI build pass. Logs: `/private/tmp/lz141-split-main-tests.log`,
  `/private/tmp/lz141-split-main-verify.log`,
  `/private/tmp/lz141-split-main-gui-build.log`.
- Actual Desktop Assignments keeps compact persona rows above the horizontal
  split and renders the selected editor below. Compare-only filters and empty
  prompt are absent. The native model picker finds the OpenAI Luna route for
  `openai gpt-6-luna`; cancelled without changing the saved route.
- Actual panel widths differ: divider moved from screenshotx1836 tox2224 in a
  3024px Retina capture, approximately590→400 CSSpx. Captures:
  `/private/tmp/lz141-split-desktop-wide-20261105.png` and
  `/private/tmp/lz141-split-desktop-narrow-20261105.png`.
- Tera6.1 High reviewed both actual captures: no blocking visual defect. Narrow
  provenance wrapping, excess upper whitespace at the saved split, and the
  Selected task heading near the lower edge are optional polish.
- Keyboard adjusted the split56→51→56. Lower inspector scrolled to the selected
  task and recorded-attempt disclosure while upper persona rows stayed fixed.
  `/private/tmp/lz141-split-desktop-inspector-scroll-20261105.png`.
- Native Appearance changed Dark/Ayu/default UI font to Light/Ayu/Georgia. Panel
  surfaces, text and controls inherited theme and font without rebuilding.
  `/private/tmp/lz141-split-desktop-light-georgia-20261105.png`.
  Restored Dark/Ayu and blank UI Font (Inter placeholder). Code/terminal fonts,
  inference settings and saved persona mappings were not changed.
- Earlier functional run created a temporary LZ137 UI task override, saved/read
  back/reopened it, then removed it (revision2). Project Luna Max revision1 stays
  unchanged. This review made no additional mapping writes.

## Observed effort and defects

Current correction foreground interval:1793895754067–1793897305590 Unixms,
25m51.523s. A bounded DB aggregation found110 distinct recorded tool call IDs,
92 step facts and3 commentary records in this window. Step facts are not a
provider-request count; these are not whole-task totals or a cost estimate.

The connected test repeatedly caught an absent editor while a Portal was used.
The final candidate uses direct component composition and preserves the
inspector-containment assertion. Root relayed Tera's review and a focused
composition finding through Architect advice; the worker was already changing
composition before the later steer arrived, so no causal efficiency gain is
claimed. Browser tools reported a disconnected Desktop session; Root navigated
Tasks→Trajectory→Open worker session and later verified the reviewed main build.

Settings navigation resets local persona-editor selection; reselecting works.
No mapping was lost. The unchanged private baseline's old task133 evidence note
still fails formatting there; current main is formatted. No rework turn was
created merely to repair that private historical note.

## Still open

The final native idle hook reported unavailable start lineage; runtime acceptance
and resource cleanup remain unresolved. Source tests and this live UI review do
not reconstruct that observation. The prospective live-peer repair1d1d73d still
needs native qualification. Do not call LZ141 runtime-complete yet.

Compare/Pareto production data126→122 and actual persona dispatch142 remain
separate unfinished deliverables. The visible routing-inactive notice is truthful.
