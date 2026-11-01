# Decision cleanup ownership verification

The isolated probe in `test/decision-runtime.fixture.ts` imports the actual decision adapter and runtime. It replaces ORT, WebGPU, tokenizer, and the decision parser with deterministic fakes so release rejection and cancellation can be injected without downloading or executing model weights. `src/webgpu/decision-runtime.test.ts` launches the probe in a fresh Bun process so its module mocks cannot affect other inference tests.

The probe verifies:

- Concurrent and repeated release, plus same-kind and different-kind ensures, remain rejected after ORT release fails. The decision model cannot be reused, no replacement loader runs, and ORT release/device destruction each run once.
- Cancellation or failure after session readiness with rejected cleanup installs an ownership barrier. `retryLoad` does not retry uncertain cleanup, later ensure/release attempts retain the same failure, and the caller cannot receive a usable model.
- Through `createInferenceRuntime`, the failed canceled load remains in error and retains the main `ModelLease`; a second window cannot acquire it.
- Successful cleanup of a canceled load permits a later explicit decision load and healthy switching to another model.

Verification on the task revision:

| Check                                                  | Result                                                                                                                                                                                                      |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun test src/webgpu`                                  | Passed: 80 tests                                                                                                                                                                                            |
| `bun test`                                             | Passed: 390 tests                                                                                                                                                                                           |
| `bun lint`                                             | Passed                                                                                                                                                                                                      |
| `bun check`                                            | Passed                                                                                                                                                                                                      |
| `bun fmt --check` on the four changed TypeScript files | Passed                                                                                                                                                                                                      |
| `bun run build:gui`                                    | Passed                                                                                                                                                                                                      |
| `bun run verify`                                       | Blocked at the repository-wide formatter check by the existing `.agents/docs/evidence/renderer-freeze-20261101T1540/automatic-capture.json`; that unrelated, out-of-scope evidence file was left unchanged. |

The GUI build emitted existing Vite warnings about deprecated `inlineDynamicImports` and CommonJS `import.meta`; the build completed successfully. This evidence makes no renderer-freeze or responsiveness claim.
