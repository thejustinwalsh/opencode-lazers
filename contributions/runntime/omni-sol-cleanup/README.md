# Omni Sol cleanup

Implements Sol findings 1, 2, 4–7 from `design/reviews/runntime-port-sol-review.md`
against the final LZ-17 audio result (`abee814`), preserving exact published
Q4_K_M language / Q8_0 projector parity and safe resource ownership.

- Safe graph: audio speech `result` owns an internal observer for stream-only /
  early-break consumers, mirroring chat; uploads and step values keep their
  cleanup paths.
- Graph simplification: grouped RMSNorm for Q/K, residual post-norms, packed
  MLP via `swigluChunk` (`w13` order `[w3; w1]`).
- Loader: no byte change; Q4_K/Q6_K/Q8_0 already share one in-flight range read;
  file identity, progress, abort and temp-byte release preserved.
- GPU submission: `padLeft` rides the dimensions uniform (stable pipeline key);
  logits (+hidden) read back fused into the eval submit via the existing
  `ReadbackQueue`, with failure cleanup preserved and no core eval change.

`patches/` reconstructs `abee814 → c5f288c` exactly. `evidence/` holds passing
focused build/unit/type checks, reconstruction, before/after Auditor reports and
measurement notes with honest pending GPU limitations. `partial-manifest.json`
is the machine-readable receipt; `sol-review-status.md` is the finding-by-finding
disposition. This does not requalify audio quality, nor does it change D1,
matmul kernels, tokenizer/encoder/decoder/codec semantics or published weights.
