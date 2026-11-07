# LZ-172 `0da6681`: source review

Independent read-only Luna review found two remaining defects in
`0da668188eb08942edfb9e01fda2538bb3c0b9c8`. Architect confirmed the relevant
source paths. This is not Desktop visual acceptance.

- **P1: visible chart labels lose route disambiguation.**
  `comparison-presentation.ts:348–364` adds route suffixes to colliding friendly
  names, but `comparison-chart.tsx:453, 674–675` truncates the resulting label from
  the end to as few as eight characters. Distinct provider/model routes can again
  show the same visible text; title/aria/tooltip precision does not repair the
  always-visible selected mark. Existing regressions assert a prefix rather than
  the distinguishing rendered suffix. Preserve a concise friendly name and enough
  real route identity to distinguish collisions at narrow widths/larger fonts;
  compare actual rendered label text for duplicate names and long shared prefixes.
- **P2: the partial-range legend symbol implies a scalar.**
  `comparison-chart.tsx:915–922` uses the diamond subtotal key for both scalar
  subtotals and interval-bar subtotal ranges. A compact combined description is
  fine, but its visible key must also communicate the actual interval mark.

Responsive layout, selected reference labeling/tooltips, exact-route controls
and quieter accounting have meaningful source/test coverage. The setOption-count
change from two to three is justified by applying responsive options after size
change; same-layout guarding and disposal/listener cleanup remain present.

Runtime exact-candidate task and graph checks passed 56 tests / 1,412 assertions,
GUI build and quality, unchanged and without timeout. The reviewer did not rerun
those suites. Simulated SVG dimensions/options do not prove actual Desktop tick
geometry; Root's narrow/wide interaction and visual gates remain open.

Correct these within the original LZ-172 scope and preserve its original worker,
attempt, delivered artifact and usage history. No new pricing arithmetic,
replacement task/worker, persistent table/right panel or source activation is
authorized by this review.
