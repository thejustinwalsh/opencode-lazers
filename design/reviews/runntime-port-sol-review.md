# ruNNtime port review

Sol 6.1 High reviewed the D1 and Omni port through ruNNtime commit
`b824c95` and inspected the in-progress audio diff. This was a source and
artifact review. It did not run new GPU tests.

| Order | Finding | Follow-up |
| --- | --- | --- |
| 1 | `Lfm3CausalLM.forward` can throw before handing its upload list back to the session. | Give graph construction an upload list owned by the session's cleanup scope. Check cancellation, device loss and synchronous failure. |
| 2 | D1 and LFM3 reshape Q and K around RMSNorm. Each reshape dispatches a copy. | Use grouped RMSNorm to remove four copies per attention layer. Use its residual input for LFM3's post-normalization adds. Check D1 text/image vectors and published Omni parity. |
| 3 | D1 checkpoint hooks repeat row permutation, concatenation and scaling. | Use `permuteRows`, `concatRows` and `scaleWeight` from core. Verify float and Q8 checkpoint loading, including storage accounting. |
| 4 | `q4Tensor` and `q6Tensor` read the same tensor ranges separately for codes and scales. The packed Q4 test read 3.58 GB for a 1.10 GB file. | Share one range read per tensor across component readers, including Q8_0 if the audio implementation still duplicates the reads. Preserve file verification and release temporary bytes. Measure bytes read and cold load. |
| 5 | All 24 published Omni MLP gate/up pairs use Q4_K. Five attention layers use Q6_K for V while Q and K use Q4_K. | Reuse D1's packed `swigluChunk` pattern for MLP. Verify parity and dispatch count. Keep V separate where formats differ. |
| 6 | The depthwise convolution pipeline key includes `padLeft`, which changes as the decode cache fills. | Move `padLeft` to the dimensions uniform. Preserve the depthwise operator and D1's asymmetric text/media boundary if sharing it later. |
| 7 | LFM3 submits a separate logits readback after compute. | Evaluate the existing fused readback path with failure cleanup for any pending readback. Measure the effect independently. |

The two quantized matmul kernels serve different workload shapes. Keep the
small-M and tiled routes. Check affine f16 rounding separately with a focused
GPU test before modifying either route.

Validate cleanup with the existing D1 correction and packed Q8 tests, LFM3
native-reference and packed Q4/recovery tests, and focused operator GPU tests.
Use the final audio diff to recheck the provisional projector findings.
