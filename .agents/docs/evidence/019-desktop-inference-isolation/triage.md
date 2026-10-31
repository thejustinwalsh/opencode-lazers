# Desktop inference isolation — observed baseline

## State and priority

Tuning plan `bc4d5dc0-3ad1-458c-bbde-fa9ce8cc1dc9` was reviewed and
integrated through runtime as `dade430d964f677f364969d6e94a384f328c07ca`
(version 32). Its task/graph checks and Architect's independent 143-test,
formatter, linter and typechecker checks passed. Failed attempts and the
stale-retry-baseline recovery remain in runtime history.

Task `c0ef9f9d-7e16-48b7-9a04-f98d9a45a8cf`, plan
`519b8e3c-2997-4455-9cde-09835dc0acda`, was explicitly stopped by the human.
Runtime recorded cancellation at version 8; native interrupt confirmed worker
`ses_2d3ee27ce39e4d258af5be6f3ea2c37c` was idle before any cleanup edits.
Do not restore, refine, build, reload, deploy or redispatch that refactor.

Codex driver parked exactly its six unfinished `src/webgpu` files in Git stash
`e6b3f592f6cff3a02c69b57f9ba6483515f2aa62`, labelled
`LAZERS cancelled inference isolation 2026-10-31` (`stash@{0}` when recorded).
The main checkout is clean and its tracked inference files match the working
pre-refactor baseline. No new GUI bundle was built or deployed. The successful
full-source read correction remains in main.

The original product sequence resumes, starting with retry-baseline recovery,
then trajectory permission, native providers/personas, reusable index, durable
progress/reporting, task references and Radar. Architect stays Sol High and
workers Luna Max. Inference isolation is not a prerequisite or approval gate.

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
The diagnosis was overstated: these observations do not prove WebGPU failure.
The human and driver confirmed that existing inference works; preserve that
working stack rather than pursue the cancelled refactor. When consulting the
old sampled stacks, strip enormous inline data URLs before printing any log
lines, retaining function names and offsets.

## Settings restored; no further GPU changes

Before further task-review inference, Architect read native feature settings:
`enabled`, `questions`, `decisions`, `review`, `dictation`, `readAloud` were
all true. Architect temporarily set only `review` false. That historical action
must not be reapplied: Codex driver restored Task review through Desktop settings
and observed all six switches ON, with GPU runtime Ready on apple. A subsequent
read-only native settings check confirmed all six values true after cancellation.
Do not disable any local feature as a workaround or make further GPU changes.
Retain the working models, WebGPU and `lazers_verify_task`. No off-thread fix or
responsiveness improvement is claimed for the abandoned work.
