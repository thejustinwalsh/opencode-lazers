# Recovery investigation — reproduced source defects

Native research `ses_e6832f0c0ffe7SDOnJPdQvMIDh` inspected main `c27de5f` and
confirmed relevant inference/ownership sources unchanged from `0f75340`. Later
Architect reads at `5307c40` confirm the same adapter/lifecycle boundary. No live
inference, deployment, settings change, profiler attachment or stash access was
performed. These are recovery-correctness findings, not an identified freeze cause.

## Existing mechanisms to preserve

`src/webgpu/runtime.ts:216–225,244–279` already connects device loss to coalesced
recovery, aborts without replay, waits for active work, releases the model and
reloads verified cached assets, with a repeated-loss circuit breaker.
`src/webgpu/lifecycle.ts:23–63` serializes release/allocation and taints a resident
entry after disposal failure. This handling is present; replacing the engine,
provider or recovery architecture is not justified by absence of handling.

## Reproduced gaps

1. **Known-loss rejection without callback:** `decision-runtime.ts:68–71` relies
   on `device.lost`, but `:157–205` has no fallback for a positively identified
   loss rejection. Runtime turns a rejected run into failed work and may return
   Ready (`runtime.ts:401–429`); the next ensure uses the resident model (`:152`).
   A variation of the existing isolated runtime fixture withheld the callback,
   rejected the first run with a device-loss error, then observed two calls on
   one loaded decision instance. The failed request was not replayed; the later
   explicit request reused the model. Negative generic errors must not be
   mistaken for device loss, and unstructured descriptive messages do not reveal
   the cause of the loss.
2. **False disposal success:** `decision-runtime.ts:91–98` sets disposed before
   awaiting ORT release. A rejection is followed by successful no-op disposals,
   permitting ExclusiveModels to clear its tainted entry. A probe composing the
   actual adapter and actual lifecycle with mocked ORT/device/assets observed
   release once, destroy once and a subsequent replacement allocation after
   unconfirmed ORT cleanup. This proves false acknowledgment, not two live devices.
3. **Load-time ownership gap:** cancellation after session-ready (`:80–89`) can
   encounter rejected cleanup before returning a model to ExclusiveModels
   (`lifecycle.ts:48–49`). An actual-adapter/lifecycle probe then admitted another
   allocation with no tainted slot. The same uncertainty must survive failed load,
   retryLoad and subsequent release/ensure calls, not only installed-model disposal.

The pinned ORT release can partially clean up before throwing
(`node_modules/onnxruntime-web/lib/wasm/wasm-core-impl.ts:539–567`). Do not invent
idempotent native-release retry safety. Coalesced cleanup must retain its failure
instead of silently turning it into success or allowing a replacement allocation.

## Pending execution is not abortable by promise timeout

The adapter checks cancellation around ORT but does not have a live AbortSignal
bridge into the run (`decision-runtime.ts:176–181`). The installed direct path
awaits OrtRun; run-options termination is copied at setup, not driven by a live
signal. A mocked pending run plus loss/deadline reproduced caller failure while
unload remained pending, the lease stayed held and renderer timers still ran.
Releasing the gate allowed cleanup. Pending work alone did not reproduce a UI
freeze. Preserve waiting/ownership: a Promise.race followed by allocation would
not terminate native work and would break safety.

## Verification and remaining native gate

Research ran:

```text
bun test src/webgpu/runtime.test.ts src/webgpu/lifecycle.test.ts src/webgpu/broker.test.ts src/webgpu/resources.test.ts
12 pass / 0 fail / 69 assertions
```

Four stdin-only isolated probes assert the undesirable current behavior; their
commands/results remain in the native research session. Two preliminary harness
mistakes were corrected, not counted as production test failures. New durable
regressions must exercise the actual adapter plus lifecycle and runtime/broker,
not the existing fixture's whole-adapter replacement. These checks do not prove
the proposed repair has passed.

Separate the ownership correction from the known-loss eligibility correction;
serialize their shared adapter/tests. Preserve the actual pending-run barrier,
negative error cases, late/duplicate loss callbacks and no-replay semantics. Do
not edit LZ-37's clock scope or restore cancelled LZ-14 work.

The real freeze's sample remains unattributed. Safe failure retirement is a
compatible repair candidate, not native responsiveness acceptance. The exact
combined artifact still needs repeated ordinary review near eight questions /
2,087 actual tokens while native navigation works, all six features ON/Ready,
apple/WebGPU and idle Never unchanged, plus normal question/decision/speech/model
switching and preserved worker identities. Record completions, correlation and
footprint across repetitions; neither Relaunch nor one successful answer passes.
