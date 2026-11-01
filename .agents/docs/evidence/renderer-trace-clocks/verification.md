# Renderer trace clocks — implementation verification

The production renderer timer callback now sends lag measurements through the
active request span when one is open, or through a persistent renderer-runtime
span while idle. Request terminal emission closes that request clock immediately,
before asynchronous trace delivery drains. Both paths use `InferenceTraceSpan`
sanitization; lag magnitude remains in `rendererLagMs`, and emitted records keep
`observedEP: "unknown"` without provider evidence.

## Fake-clock regression

`test/webgpu-runtime.fixture.ts` invokes the timer callback installed by
`createInferenceRuntime`, with the runtime model adapters isolated in the existing
child-process fixture. The fake clock starts at 1,000 ms and proves:

| Event                                                  | Request/runtime clock | `elapsedMs` | `deltaMs` | `rendererLagMs` |
| ------------------------------------------------------ | --------------------- | ----------: | --------: | --------------: |
| Idle lag before a request at 5,000 ms                  | renderer runtime      |       4,000 |     4,000 |           3,500 |
| First request `generate` at 10,000 ms                  | request               |           0 |         0 |               — |
| Active lag at 20,000 ms                                | same request          |      10,000 |    10,000 |           9,500 |
| Next request stage, `dispose`, at 20,025 ms            | same request          |      10,025 |        25 |               — |
| Lag at 30,000 ms while terminal trace delivery is held | renderer runtime      |      29,000 |    20,000 |           9,500 |
| Idle lag between requests at 35,000 ms                 | renderer runtime      |      34,000 |     5,000 |           4,500 |
| Second request at 40,000 ms                            | new request           |           0 |         0 |               — |

The active lag keeps the first request/job correlation and configured WebGPU
metadata while its observed provider remains unknown. The post-terminal and
between-request lag records use the distinct renderer ID, have no job ID, and do
not extend the terminal request. The second request has fresh timing and its own
request/job correlation. The assertions fail against the former mixed-clock
timer route.

The fixture also checks prompt/output/audio fields are absent, private request
text is not retained, and inference still completes if trace delivery rejects.
Existing `inference-trace` tests continue to cover bounded numeric sanitization;
the renderer lifecycle fixture continues to cover lifecycle and cleanup fault
injection.

## Verification results

- `bun test src/webgpu` — 81 passed, 0 failed.
- `bun test` — 391 passed, 0 failed.
- `bun run verify` — formatting, lint and strict typecheck passed with no warnings.
- `bun run build:gui` — GUI package built successfully. Vite reports an
  `inlineDynamicImports` deprecation and `EMPTY_IMPORT_META` warnings from the
  ONNX Runtime Web dependency.

The first full-suite attempt preceded GUI packaging and could not resolve the
generated `.cache/lfm3-engine.js`; after the required packaging step prepared the
pinned engine, the full suite passed.

## Causal boundary

This verifies trace-clock coherence, not why the renderer freezes or whether
responsiveness improves. The regression uses a deterministic clock and isolated
engine mocks; no diagnostic inference, induced hang, settings change, Desktop
reload, or live profiler was used. Freeze cause and responsiveness improvement
remain unproven.
