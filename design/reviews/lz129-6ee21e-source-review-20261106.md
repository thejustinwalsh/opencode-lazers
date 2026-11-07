# LZ-129 `6ee21e0`: retained source review

Independent read-only Luna review and Architect source confirmation, 2026-11-06.
Exact candidate: `6ee21e01d939a1bc806ef3af91d6ca55bbb47707`, preserving predecessor
`37dadd7f982ae726ceb3fbbbb3298cf219d81810` and the original worker.

## Substantive blockers

1. **Publisher identity is partitioned by a per-location secret.** The plugin
   constructs a fresh observation secret in each registration (`src/index.ts`,
   candidate lines 110–119), while the process-shared tracker registry includes
   that secret's hash in its key (`src/observability/changes.ts:304–309`). Equal
   database/project identities with independently generated secrets therefore
   retain separate sequences. The new Radar transport accepts project-wide
   events regardless of location; unrelated sequence counters can suppress real
   updates or cause false gaps. The module-copy test supplies the same secret,
   missing the actual initialization shape. Verify different secrets through
   separately loaded registrations, including fingerprints/read boundaries and
   repeated unchanged refreshes, without weakening cursor authentication or
   keyed privacy.
2. **Failed gap publication can disappear during failover.** RPC retry state is
   registration-local (`src/observability/rpc.ts:254–278`); disposal clears its
   timer before closing the tracker. The replacement publisher's `streamGap`
   returns immediately if the failed gap already set shared `gapActive`
   (`changes.ts:232–243`). Test failed actual gap emission followed by owner
   disposal and takeover: remaining readers must learn to resnapshot without a
   new native event or artificial reconnect. Preserve bounded retries, sequence
   identity, disposal and per-reader queue isolation.

These are original LZ-129 coherent publication/failover obligations, not a new
task or proof-only turn. Do not integrate `6ee21e0` before their substantive
same-worker correction and review.

## Verified improvements and limits

- Startup backfill is now inside the missing-column migration branch. The test
  inspects executed SQL, upgrades 2,000 retained rows, checks index and triggers,
  then confirms normal reopen does not run the backfill. Preserve this fix.
- The project-scoped partial-index live query, held first-inventory ordering and
  astral-safe UTF-16 truncation have discriminating source/tests.
- Exact-candidate runtime live checks passed 112 tests / 1,163 assertions;
  compatibility passed 40 / 269; quality passed. All receipts bind `6ee21e0`,
  unchanged and without timeout. These do not refute the source findings. The
  earlier 137-pass/two-timeout diagnostic remains **not** a full pass.
- The reviewer did not profile `sourceStampFromDatabase`'s historical association
  materialization. Retain this scaling limit; do not claim every source refresh
  is history-independent merely from the live partial-index query.

## Integration boundary

Canonical `3a116f1` does not include this candidate. A native isolated trial at
`/Users/tjw/.local/share/opencode/worktree/b5da4c/lz129-combined-review-20261106`
is paused with conflicts in observability `changes.ts`, `changes.test.ts`,
`read.ts`, and runner `store.test.ts`. Original/canonical worktrees were not
modified by that trial. Preserve its WIP until reconciled; do not force cleanup
or use blanket ours/theirs resolution. Later canonical membership caching,
active-attempt selection, privacy and event-directory checks must survive.
Root owns eventual reviewed source landing/quiet activation and actual probes;
runtime integration and non-forced cleanup remain unrecorded.
