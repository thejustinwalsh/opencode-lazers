# Decision loss rejection evidence

## Pinned ORT contract

`package.json:42` pins `onnxruntime-web` to `1.31.1`. Its source distinguishes a
positive lost-device status from ordinary WebGPU and inference failures:

- `onnxruntime/core/providers/webgpu/webgpu_context.cc:1124–1132` polls the
  existing Dawn lost future and reports `WebGPU device lost.`; the installed
  device-lost callback records `WebGPU device lost (<reason>): <message>` at
  `:175–190`.
- `js/web/lib/wasm/wasm-core-impl.ts:933–935` sends a non-zero `OrtRun()` status
  to `checkLastError('failed to call OrtRun().')`.
- `js/web/lib/wasm/wasm-utils.ts:53–64` creates the resulting ordinary `Error`
  with the stable `failed to call OrtRun(). ERROR_CODE: ..., ERROR_MESSAGE: ...`
  envelope.
- The checked completion path calls `CheckDeviceStatus()` at
  `webgpu_context.cc:1135–1191`. Generic WebGPU validation errors use a distinct
  `WebGPU device error(...)` form at `:160–171` and are not loss evidence.

This pins an explicit ORT loss-status signature; it does not establish that every
browser/native device-loss path reaches ordinary `InferenceSession.run()` as
this error. The adapter classifies only a failed `OrtRun()` carrying this exact
loss status; other failed runs remain generic unless `GPUDevice.lost` itself
resolves.

`src/webgpu/decision-loss.ts` therefore recognizes only that ORT `OrtRun()`
envelope plus one of the two exact loss forms. It does not inspect broad
`lifecycle.recoverable` strings or infer loss from `OperationError`, mapping,
validation, inference, shape, or network failures.

## Behavioral boundary

`test/decision-recovery.fixture.ts` launches the real decision adapter and
renderer runtime in an isolated Bun process. Only model assets, tokenizer,
ORT, and the native WebGPU boundary are deterministic fakes. It covers loss
rejection while `device.lost` remains pending, both device-callback orderings,
retired-adapter reuse, callback after disposal/replacement, generic negative
errors, and caller cancellation/deadline while native work remains pending.
These tests establish the adapter/runtime recovery contract; they do not execute
real model weights or prove that the pinned native ORT build emits this signature
in Desktop, and they do not attribute a renderer freeze.

## Verification

| Check                 | Result                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------- |
| `bun test src/webgpu` | Passed: 81 tests, 391 assertions                                                         |
| `bun test`            | Passed: 391 tests, 3,689 assertions                                                      |
| `bun run verify`      | Passed: formatting, lint, and strict typecheck                                           |
| `bun run build:gui`   | Passed; emitted existing Vite `inlineDynamicImports` and CommonJS `import.meta` warnings |

The first full-suite attempt preceded the GUI build and failed because the
generated, ignored `.cache/lfm3-engine.js` was absent. The prescribed build
generated it, and the subsequent full suite passed. This is setup evidence, not
a source change or a native runtime observation.
