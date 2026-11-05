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

## Correction reprobe

At1793847391277, Root exercised the corrected draft against a consistent SQLite
backup of the actual database, applying the worker's real store migration only to
that disposable copy. Production was opened read-only and was not modified.

- Store initialization/migration:26.33ms; traversal and mutation checks:55.52ms.
- Traversed4657 distinct retained records across95 pages without omissions caused
  by duplicate record IDs.
- An unrelated project observation-revision change preserved the journal cursor
  and returned the next five records; selected journal revision remained0.
- Updating a retained input in the selected journal correctly invalidated its
  prior cursor with the journal-change message.
- The disposable backup directory was removed and its absence confirmed.

This addresses the reproduced cursor defect at component/migration level. It is
not registered native tool observation or runtime acceptance. The reader now
requires the new journal-revision table; the original read-only production probe
cannot exercise that draft before its migration is installed. Script:
`/private/tmp/lazers-journal-migrated-clone-probe-20261104.ts`.

At1793848806589, authenticated `client.session.message.get` resolved an actual
retained predecessor reference: session`ses_e68a9ed37ffeVqzPWRXN5SB7Uw`, message
`msg_1a9794037001guCoXw4ue64keL`. Returned ID/type matched. Before/after SQL reads
kept disposition`delivered`, referenced revision55 and updated_at1793848737876
unchanged. No message body was printed and no production data was written.
This establishes native reference retrieval/non-acknowledgement for that record;
registered journal-tool observation on an activated candidate remains outstanding.
Probe:`/private/tmp/lazers-journal-native-reference-probe-20261104.ts`.
