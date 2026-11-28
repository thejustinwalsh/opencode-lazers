# Changes reading-experience pass

Authorized 2026-11-28: “Go ahead with changes pass.”

## Delivery graph

```text
LZ-291 structural/navigation + Changes naming repair
  ├─ LZ-297 reading presentation: host themes, structural emphasis, importance order
  └─ LZ-289 pinned symbols/sections
       └─ LZ-290 real semantic + existing landed/discussion consumers
             ↑ reading presentation and discussion producer

Native Settings producers → LZ-296 feature-PR homes/branch comparison
                                 └─ LZ-298 progressing Plan/PR UI consumer
                                      ↑ LZ-290
```

The presentation task needs LZ-291's genuine structural/native renderer path,
not Settings, discussions, symbols or PR-home completion. It can run alongside
the symbol producer after the current UI repair integrates. LZ-290 consumes real
symbols once LZ-289 integrates, preserving its existing target/discussion
obligations. Only the new progressing Plan/PR consumer needs LZ-296.
Serialize UI writers in this order; preserve current workers. All native
implementation/review uses OpenAI Luna Max within the project limit of three.
External Opus remains reserved for Settings UI.

## Reading presentation

Tracked by **LZ-297**. Runtime task/plan records own dispatch state and receipts.

Follow actual OpenCode theme tokens, including switching between two themes
of the same mode as well as light/dark, surfaces, syntax, selection, font and
readable contrast. Reuse `hostSyntaxTheme`, `bridgeStyle` and `reviewShadowCSS`
in `src/code-review/ui/renderer/theme.ts`; these already implement a host-token
bridge and Oaink-derived context muting. Repair demonstrated gaps rather than
replacing the theme or adding another palette.

Genuine Difftastic analysis must reach Pierre with the exact pinned comparison,
source/side/object identity. Changed tokens stay prominent while unchanged
structural context recedes slightly without losing syntax hue/readability.
Line-engine, unavailable and unsupported fallbacks stay honest and readable:
`toLineDiff` intentionally does not claim structural muting. Created/deleted
files must not appear entirely unchanged or receive fabricated token marks.
The dirty Oaink reference
`/Users/tjw/Developer/oaink/packages/webviews/diff/pierre-theme.ts` is read-only.

Order the actual rendered file sequence and next/previous-change traversal by
review importance, not only a sidebar. Use deterministic, inspectable source
facts with a compact understandable rationale (for example conflicted files,
behavior/configuration changes versus generated/lock-only content). Do not
claim language-service reachability, risk certainty or symbol facts not supplied
by a real producer. Stable path tie-breaks are useful, path-only ordering is not
the outcome. Available inventory/structural evidence must suffice without
eagerly parsing/downloading every file or waiting for LZ-289.

Keep comparison/source/file IDs, selected side/range, links and loaded state.
Paging, later analysis and a changing ranking must not silently select another
file or move the reader's source anchor. Navigation, visual sequence and
nearby-loading neighborhoods must share the same order, with bounded work.
Keep additions in focused presentation modules instead of growing the panel.

### Relocated evidence

Main `e7d30f014` still has path sorting in `ui/model/files.ts:93-119`;
`ui/session.ts:189-193` publishes both files and Pierre items, and `near()` uses
that same file sequence. The LZ-291 candidate `08f9f2843` adds validated
`transport.analysis` at `ui/transport.ts:214`, structural/fallback tracking in
`ui/session.ts`, and host mode/font at `ui/panel.tsx:956-958`. Its naming repair
is still owned by that worker; use the integrated successor, not this stale
candidate. `renderer/code-view.tsx` applies the fallback attribute and themed
shadow rules. `renderer/structural.ts:39-108` distinguishes genuine structural
conversion from the line fallback.

### Focused acceptance

Use the real registered structural RPC/store with pinned fixture sources, not
a fabricated `FileAnalysis` alone, to drive the retained session and Pierre
render path. Prove changed token ranges/context distinctions, false-identity
rejection and readable degradation. Verify themes in rendered shadow roots,
not just CSS-string snapshots.

Use a mixed fixture whose alphabetical order differs from expected review
importance. Assert file list, Pierre item IDs, next/previous-change traversal
and prefetch order agree, explain the evidence, then page/add analysis and
verify the selected path/side/range and source anchor remain stable. Include
binary, renamed, added/deleted, generated/lock and unavailable sources.

Run `bun run verify`, `bun test src/code-review/ui/
test/code-review/reading-experience/ src/tasks/links.test.ts`,
`bun run build:gui`, `bun run build:server`, and `git diff --check`.

## Populated semantic consumers

Reuse LZ-289 for the versioned pinned TypeScript/TSX/JavaScript/Rust/Python
symbol/section producer. LZ-290 renders actual populated symbol names, kinds,
signature/body/format-only classifications and changed/outside sections where
the producer supports those facts, with correct side-specific source navigation.
No placeholder badges, empty semantic panels, guessed symbols or structural
token counts relabeled as declaration semantics.

LZ-290 retains all original existing landed-target/discussion/stored-reopen/
correction-navigation requirements. It follows the presentation task plus its
real discussion and symbol producers, not Settings or LZ-296. Test actual
registered symbol/section reads and rendered content for supported languages;
unsupported/parse-error/missing data remains explicit readable file fallback.
Reuse the presentation order and preserve selection through section geometry
changes. Consumers must not introduce their own parser or competing theme/order
implementation.

## Progressing Plan/PR consumer

Tracked by **LZ-298**, after LZ-296 and LZ-290 integration.

This separate follow-up consumes LZ-296 after LZ-290, rather than making its
backend/Settings prerequisites hold the reading improvements.

Use LZ-296's implemented native association and comparison contract for compact
PR/branch identity and a working link. Task scope remains task-specific; full
Plan/PR scope shows the complete actual selected feature-branch range while the
plan progresses, including Architect resolutions, without requiring a combined
artifact. Distinguish local branch and remote published observations and
worker-only unmerged work. Reuse one target authority and guarded reconciliation
controls; preserve native metadata, pinned identities, old links and selections.
No copied per-task/session PR store or guessed main. This moves only the newly
clarified progressing-plan/home consumer from LZ-290, not its original existing
landed-target/PR navigation requirements.

Run real-native registered consumer tests with a progressing no-artifact plan,
task A landed, B worker-only, an Architect resolution and changed PR/base/head
observations. Assert exact task versus plan ranges, identity/link provenance and
old pinned reopen. Run project quality, focused consumer/native tests and both
builds.

## Combined regular Desktop verification

Architect owns candidate review, composition, runtime integration and native
non-forced cleanup. Integrate independently useful returned work promptly.
Coordinate the driver to reload the integrated regular Desktop bundle; no
isolated verification profile and no human-evidence gate.

Exercise narrow and wide widths, actual same-mode and light/dark host theme
switches, real Difftastic changed tokens versus unchanged context, importance
ordering and next/previous navigation, selection/source-anchor persistence,
fallbacks and populated semantic results. Record which integrated commit and
actual host states were observed. Use native product-probe/review workers within
capacity; unexercised Desktop behavior remains unproven, not an acceptance claim.
