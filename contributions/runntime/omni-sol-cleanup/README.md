# Omni Sol cleanup

Implements Sol findings 1, 2, 4–7 from `design/reviews/runntime-port-sol-review.md`
against the final LZ-17 audio result (`abee814`), without changing the published
Q4_K_M language / Q8_0 projector artifacts or semantics and preserving safe
resource ownership. Parity and qualification runs remain pending (see below).

- Safe graph: audio speech `result` owns an internal observer for stream-only /
  early-break consumers, mirroring chat; uploads and step values keep their
  cleanup paths. Covered by a direct `speak` unit test plus session-level
  failure-then-success and early-break regressions.
- Graph simplification: grouped RMSNorm for Q/K, residual post-norms, packed
  MLP via `swigluChunk` (`w13` order `[w3; w1]`).
- Loader: no byte change; Q4_K/Q6_K/Q8_0 already share one in-flight range read;
  file identity, progress, abort and temp-byte release preserved.
- GPU submission: `padLeft` rides the dimensions uniform (stable pipeline key).
  Logits-readback fusion was evaluated and rejected (pre-submit failures would
  poison the shared queue); the separate-submit path is kept with no core eval
  change.

`patches/` reconstructs `abee814 → 52bfe74` plus repair commits exactly (see
`partial-manifest.json` tip). `evidence/` holds passing focused build/unit/type
checks, operator GPU results, reconstruction, before/after Auditor reports and
measurement notes with honest pending full-model limitations.
`partial-manifest.json` is the machine-readable receipt; `sol-review-status.md`
is the finding-by-finding disposition. This does not requalify audio quality,
nor does it change D1, matmul kernels, tokenizer/encoder/decoder/codec
semantics or published weights.

Superseding note: this receipt supersedes the `a54e884` repair attempt. That
attempt's pinned identities were corrupted (fixed here against the retained
audio receipt and `src/webgpu/manifest.ts`), its fused-readback patch was
unsafe (dropped here with reason), and its early-break regression exercised
only the chat session (a direct public-audio `speak` regression is added
here). The `a54e884` commit and patches stay in history; only its claims are
corrected.
