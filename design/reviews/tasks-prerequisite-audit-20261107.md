# Tasks prerequisite audit — 2026-11-07

## Findings

Read-only Luna research and persisted plan inspection distinguish source interfaces,
product acceptance, and resource reservations. No behavior tests were run for this audit.

- LZ-138's accepted `00c20ad48129d912a7c82b35c222c77b1f562bac` has a task-level
  source-integration receipt at `6045d07ea1aea1acac5107e2a77ab29ecd090be6`.
  That landing includes required host fixes `e36a42c` and `63d5001`. All are
  ancestors of inspected main `ffa8f6f6cb7f31c29f64e6086df1b7b8191d08bd`.
- LZ-182's existing admitted baseline `f637e0b` already contains `6045d07`
  and LZ-147's `88b35f579922f0ff4dd811391b3682b7694fbde4`; no baseline refresh
  is necessary merely to consume those sources.
- LZ-147 supplies the activity/filter read interface explicitly consumed by
  LZ-182. Its whole-plan integration receipt is recorded, with cleanup held
  independently on missing original-worker idle evidence.
  `src/runner/prerequisite-proof.ts` permits valid `cleanup-blocked` integration
  proof; the inspector's waiting label is not authoritative dispatch proof.
- LZ-88 repairs observation fencing and approval-only hold restoration, not an
  interface consumed by Tasks scheduling. Its actual repair remains important:
  fresh empty native permission lists have repeatedly required explicit
  reconciliation while original workers continue.
- LZ-72 has no identified feature interface consumed by LZ-88, but retains an
  uncertain verification effect and overlapping runtime write scope. Existing
  explicit ordering and native reservations remain intact. Removing another
  dependency does not settle that effect or release its resources.

## Supported schedule changes

- LZ-182 now follows LZ-147 only, rather than LZ-138, LZ-147 and LZ-88.
- LZ-88 now follows LZ-72 only, rather than LZ-72 and LZ-138.

These revisions remove obsolete whole-plan gates, not required acceptance.
Priorities, existing worker identities, source/resource fences and reservation
checks are unchanged. In particular, this is not a claim either queued task can
dispatch through LZ-72's retained reservation. LZ-88's two original behavior
obligations remain required. No worker was restarted or replaced.

## Unresolved LZ-138 combined verification

The original receipt
`runner/receipts/e48290a6-a871-42a2-94f1-c88f700c0d11/all-00c20ad48129d912a7c82b35c222c77b1f562bac-82.json`
records `bun test` exit 1, no timeout, unchanged candidate, and 281890 ms elapsed.
Its saved stderr is 32787 characters, ends in `[output truncated]`, and contains
no failing result before truncation. Stdout contains successful fixture builds;
the retained sibling files contain focused/all/quality JSON only, not a fuller log.
The cause remains unproven. No broad suite was rerun to guess it.

Task checks, task native evidence and source landing do not grant combined
acceptance. Preserve the failed receipt and separately assess the original-129
repair/review clause against actual evidence. LZ-138 advice revision 27 records
this limitation and current automatic-format/lint-fix guidance.
