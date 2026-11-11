# Liquid models on ruNNtime

Add two native WebGPU entries to the ruNNtime zoo: quantized D1 Omni 600M
for System One decisions and LFM3 Omni for streaming chat, transcription,
and speech. Build both from the public zoo API and prove both through
LAZERS in OpenCode Desktop. Start with D1 text decisions.

The starting point is [ruNNtime's D1 branch][branch] at `68f3a125` in
[the fork][fork]. The branch contains a text/image decider under
`packages/runntime/src/zoo/d1/`, with working calls in
`packages/runntime/playground/d1/shared.ts`. It loads a Safetensors state dict,
initializes WebGPU with `initRunntime`, and returns typed answers and actual
input tokens from `createD1Decider().systemOne()`. It does not expose D1 in the
published zoo entry point, implement a quantized D1 weight path, or port audio.
The community Q8 ONNX export is a parity reference. Its weights are not a
ruNNtime artifact. Check the upstream main branch for API changes before
preparing a contribution.

Follow existing ruNNtime zoo patterns for public loaders, model registration,
weight formats, range loading, executor ownership, errors and disposal. Reuse
core operators and quantization kernels. Implement a missing operator in the
appropriate shared layer when both the model and parity tests demonstrate the
need. Use the pinned TypeGPU version and build transform, typed schemas and
bindings, and the ruNNtime executor's submission and resource lifecycle.
Reuse persistent buffers and pipelines where the executor supports it.
Exercise cleanup after cancellation, failed load and device loss.

Use ONNX graphs and reference implementations to recover input/output contracts,
operator behavior and parity vectors where useful. Translate the required
operators and supported weights into ruNNtime rather than introducing ONNX
Runtime as a zoo dependency. For LFM3 Omni, compare against the current Liquid
engine for streaming, speech and transcription behavior.

Use the current LAZERS runtime as the baseline. D1 Omni 2B Q4F16 reads
1.57 GB of decoder weights. Desktop reported 4.97 GB of JS heap usage before
the renderer crash. The 2B path also lost the GPU device on synthetic
2,538- and 5,138-token decisions. The current recovery retires the failed
session and loads on the next request. A short native decision succeeded after
both losses. Measure the candidate on those same inputs and on representative
task reviews while the Desktop remains responsive.

Work in coherent increments that each deliver a behavior someone can exercise:

1. Run the branch's D1 text decider on WebGPU using the pinned Liquid reference.
   Verify yes/no, named choice and rubric outputs against reference cases.
   Measure load, peak memory, decision latency and device release. Audit
   `decider.ts` cleanup when `toArray` rejects and check repeated initialization
   and device loss before exposing a public zoo API.
2. Connect a quantized, text-only 600M artifact to ruNNtime. Compare Q8 first
   with reference probabilities and decisions, then Q4 if it offers a material
   benefit. Measure the actual loaded weights and transient buffers. Keep
   model-specific token markers, option ordering and temperature calibration.
   The branch's prompt code can truncate inputs. Preserve LAZERS' behavior of
   reporting overflow explicitly rather than scoring incomplete text.
3. Integrate the verified backend through LAZERS' existing local inference
   mailbox and cache. Read weights with the lease-owned range reader and
   propagate cancellation through the adapter. Keep the current D1 path
   available during qualification. Preserve the System One response shape and
   record the actual model, precision, revision and token usage. Update
   `src/webgpu/system-one.ts`, `task-review.ts` and the GUI from the selected
   model instead of labelling both backends 2B.
4. Port LFM3 Omni separately. Inspect the current Liquid engine in
   `src/webgpu/runtime.ts` and `scripts/prepare-engine.ts` for chat sessions,
   streaming, audio input and voice output. Preserve those behaviors as their
   replacements become ready. A different speech recognition model would be
   a product change. The D1 branch provides no LFM3 generator or TTS path.
5. Prepare both upstream zoo contributions against ruNNtime main with public
   exports, examples, unit and GPU tests, model provenance and upstream
   review. Keep LAZERS RPC, settings and workspace code in LAZERS. ruNNtime
   code is MIT. Check the Liquid weight terms and attribution for the exact
   derivative before redistributing it. Build the fork with its pinned pnpm
   version and Node requirement. Test packaging as a consumer, including
   the TypeGPU transform and the actual OpenCode Desktop bundle.

Use the isolated Desktop for acceptance. Run the LAZERS checks and actual
WebGPU decisions, exercise device loss followed by a successful request, and
measure cold load, peak memory and responsiveness on the original failure
workloads. Test chat, dictation and speech through their existing product
controls before switching those routes. Report measured behavior, the quality
comparison and retained results for each backend. Preserve the production
Desktop's active sessions, queued work, credentials and cached models.

[branch]: https://github.com/software-mansion/runntime/tree/68f3a12506bada2c9ac6cb3629426f3e06a56349
[fork]: https://github.com/thejustinwalsh/runntime

References: [Liquid 600M model](https://huggingface.co/LiquidAI/d1-omni-600M),
[Q8 ONNX parity reference](https://huggingface.co/onnx-community/d1-omni-600M-ONNX),
[ruNNtime range source](https://docs.swmansion.com/runntime/api/zoo/interfaces/rangesource/).
