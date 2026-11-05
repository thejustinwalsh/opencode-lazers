# LZ133 draft cursor observation

Root executed the uncommitted journal reader against the actual database in
read-only mode; this was a draft component probe, not registered native acceptance.

At1793846599394, page1 returned five retained records for the original LZ129 plan.
At1793846599801, page2 failed with “Journal changed since this page; restart the
journal view”. Project observation revision changed149647→149650 in407ms.

Across both reads, journal metadata was unchanged:

| Table             | Count | Latest update, Unix ms |
| ----------------- | ----: | ---------------------: |
| Architect sources |     3 |          1793846598050 |
| Architect inputs  |   806 |          1793846597969 |
| Architect results |  3848 |          1793846598050 |

Source inspection confirms the draft cursor is bound to the project-wide
`observation_revisions` counter. Unrelated parallel-worker activity can therefore
invalidate traversal. Journal changes still need coherent handling, but unrelated
task/progress changes should not prevent paging an unchanged journal.

Root sent the reproduction through Desktop to the original worker's Architect,
requesting scoped freshness and an unrelated-activity regression before integration.
No source/task state was modified by the probe. Script:
`/private/tmp/lazers-journal-draft-cursor-probe-20261104.ts`.
