# Auditor reports (Fallow, LAZERS workspace)

Baseline (before `omni-sol-cleanup` files):

- Run `93e01cce-ce37-4551-95f9-fcc98df9eb3a`, completed.
- deadCode 291, duplication 299, health 2594, architecture 3, featureFlags 3.
- Findings are pre-existing LAZERS-internal dead-code/duplication/health signals,
  unrelated to the runntime Sol simplification. No LAZERS source was deleted here.

Follow-up (with `omni-sol-cleanup` contribution files):

- Run `d42c6ce5-8fd5-4a80-bb14-bc4bfcae6c75`, completed.
- deadCode 290, duplication 298, health 2593, architecture 2, featureFlags 2.
- Delta is within noise for an additive docs/patches/evidence directory; no new
  LAZERS concerns introduced by this contribution. No finding suppressions were
  recorded to improve a score; the runntime simplification itself (fewer graph
  dispatches, stable pipeline key, shared reads) lives in the sibling ruNNtime
  checkout and is documented in `sol-review-status.md` and
  `evidence/measurements.md`, not in Fallow's LAZERS scope.

Repair (retained review): fixed three corrupted pinned identities in this
receipt against the retained audio manifest and `src/webgpu/manifest.ts`;
dropped the unsafe fused readback (finding 7, evaluated and rejected with
reason); added failure recovery and stream-only regression tests. No LAZERS
source changes were needed for the repair beyond this receipt.

Decision log (task-linked):

- Common causes: session-owned upload lists, reshape copies around norms,
  duplicated range reads, pipeline-key churn on cache fill, separate readback
  submits.
- Chosen repair: one structural fix per cause (observer + ownership, grouped +
  residual norms, packed MLP, shared reads preserved, uniform-carried padLeft)
  rather than per-symptom workarounds. Fused readback was evaluated and rejected
  (pre-submit failures poison the shared queue); the safe separate-submit path
  is kept with regression tests.
- Tradeoffs: GPU wall-time, pipeline/dispatch counts and full-vocabulary parity
  still require real WebGPU runs with the exact pair; retained here as pending
  with baselines preserved, not as assumed benefits.
