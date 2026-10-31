# Desktop inference isolation — observed baseline

## State and priority

Tuning plan `bc4d5dc0-3ad1-458c-bbde-fa9ce8cc1dc9` was reviewed and
integrated through runtime as `dade430d964f677f364969d6e94a384f328c07ca`
(version 32). Its task/graph checks and Architect's independent 143-test,
formatter, linter and typechecker checks passed. Failed attempts and the
stale-retry-baseline recovery remain in runtime history.

Task `c0ef9f9d-7e16-48b7-9a04-f98d9a45a8cf`, plan
`519b8e3c-2997-4455-9cde-09835dc0acda`, is the next priority on
`openai/gpt-6-luna` variant `max`. Other feature plans remain held until its
review, native observations and integration. Architect stays Sol High.

## Evidence, not a complete causal claim

- Desktop's `20261031T095304/window.old.log` records repeated renderer
  unresponsiveness at 10:17:12 and 10:17:28, then a sampled renderer stack at
  10:17:43 inside ONNX WASM `_OrtRun`. `window.log` records further events
  through 10:18:45. These are pre-relaunch observations.
- `20261031T141905/main.log:52–58` records
  `net::ERR_INSUFFICIENT_RESOURCES` while starting a net log after recovery.
  That context does not establish the cause of the original freeze.
- `src/webgpu/runtime.ts` imports the chat engine and decision runtime into
  GUI setup, loads models in `ensureModel`, and invokes them in `run`.
  `decision-runtime.ts` builds the tokenizer, assembles weights, initializes
  ORT and calls its inference session in that execution context.
- The `RendererInference` RPC name is a mailbox, not evidence of a separate
  browser worker. The GUI preset inlines dynamic imports into one CJS bundle;
  a real worker must work under that packaging in Desktop.

Native Relaunch recovered the app and the backend worker survived. Relaunch
is not the fix. No post-restart CPU sample is used to prove the original cause.

## Temporary mitigation and remaining proof

Before further task-review inference, Architect read native feature settings:
`enabled`, `questions`, `decisions`, `review`, `dictation`, `readAloud` were
all true. Through the supported `lazers.webgpu.configure` RPC, only `review`
was temporarily set false; the other five values stayed true. This prevents
planning self-review from immediately retriggering the affected path. Preserve
the tool and restore `review: true` after validating its off-thread path.

No off-thread fix or responsiveness result is claimed yet. Required native
proof includes actual cold loading and representative multi-batch task-review
inference while panel/composer interactions continue, warm inference, model
switching, cancellation/unload, worker/trace identity, and logs for the observed
interval. A toy result, disabled review, mocks alone or moving only an async
wrapper is insufficient. Keep cache verification, queue/deadlines, ownership,
usage reporting and failure/cancellation semantics intact.
