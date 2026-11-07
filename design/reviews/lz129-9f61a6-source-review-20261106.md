# LZ-129 `9f61a6`: same-worker correction review

Independent read-only Luna review found **no material findings** in
`9f61a6633dd3d64a3bc51672c4e5d63e1234adcb` against rejected parent
`6ee21e01d939a1bc806ef3af91d6ca55bbb47707`. Original worker, attempt, parent,
route, artifacts, usage and resource history remain preserved.

## Confirmed corrections

- Publisher identity no longer includes the reader secret. Source fingerprints
  use a process-shared key with canonical database path, project directory and
  revision (`src/observability/changes.ts:29–37, 63–86, 314–337`). Different
  per-location secrets share publication state; live reader queues stay private.
- Publisher close forces a fresh gap for a surviving publisher even when the
  original failed gap set `gapActive` (`changes.ts:244–255, 466–483`). A registered
  RPC regression uses two random secrets, fails an actual gap emission, disposes
  that publisher and observes the successor's resnapshot boundary without another
  native event.
- History cursor signing/validation still uses each reader's secret
  (`src/observability/live-store.ts:347–367`).
- The reviewed delta preserves the migration-only legacy backfill/reopen guard,
  indexed active assignment query, query-first inventory, UTF-16-safe truncation
  and independent reader queue paths.

## Evidence and boundary

The reviewer ran the focused no-listener regression: **1 test / 15 assertions**;
the retained candidate worktree remained clean. Architect separately inspected
runtime task and graph receipts bound to exact `9f61a6`: live **112 tests / 1,176
assertions**, compatibility **40 / 269**, and quality passed, all unchanged and
without timeout. The earlier 137-pass/two-timeout diagnostic is not relabeled as
a full pass.

This review resolves the two source blockers in
`lz129-6ee21e-source-review-20261106.md`; it does not integrate or activate source,
resolve canonical merge conflicts, prove native event-count improvements, profile
historical association materialization, or authorize cleanup. Root owns the safe
reviewed source landing and actual probes. Preserve the paused obsolete `6ee`
isolated integration trial until Root reconciles it; do not apply blanket
ours/theirs resolution or force removal.
