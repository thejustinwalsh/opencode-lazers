# Code Mode repair and active rendering observations

## Tool registration

Root found remaining Code Mode opt-outs in core task tools, runner tools and
WebGPU task review/local tools. The pinned native implementation places
`codemode:false` tools in the direct set and excludes them from the Code Mode
catalog/executor. Source: [OpenCode 2.2.5 tool selection](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/tool.ts#L274-L279).

Commit `97da169` changes those registrations to true. Existing permission checks,
Architect-only checks, tool schemas, task validation, enabled settings and
inference behavior remain unchanged. Existing tests now assert eligibility,
including permission-before-access and native caller identity behavior.

Verification: **22 tests / 199 assertions pass** across core task, runner,
WebGPU inference-tool and task-review-tool tests. Bun formatting, lint,
typecheck and diff checks pass. No explicit `codemode:false` remains in `src`.
The active Desktop Architect was asked to verify catalog discovery and perform
a small read through Code Mode; native observation is pending at report creation.
Discovery alone must not invoke local inference or mutate task state.

## Visible / hidden / visible Tasks comparison

One-shot process CPU windows, with inference settings unchanged and native model
work continuing. Root used OpenCode's Toggle review button to hide and restore
the region; AX observations confirmed Tasks disappeared and returned selected.

| Region | Unix start (ms) | Duration | Service | Renderer | GPU process |
| --- | --- | --- | --- | --- | --- |
| Tasks visible | 1793867504391 | 12.063s | 72.20% | 27.36% | 29.84% |
| Review region hidden | 1793867584022 | 12.064s | 62.42% | 28.93% | 43.68% |
| Tasks restored | 1793867620878 | 12.039s | 47.85% | 19.69% | 39.79% |

These windows do **not** isolate Task animations as the cause: hiding Tasks did
not produce a renderer/GPU-process drop, and model/tool activity was not matched.
Architect and two Luna researchers were active; another legitimate retained-work
coordinator was activated during the final window. No quiet-baseline saving or
causal attribution follows from these measurements. GPU-process CPU is not GPU
utilization. Source changes, inference-setting changes and model stops were not
used during the three measurement windows. The original Tasks view was restored.

Helper: `/private/tmp/lazers-panel-cpu-window.ts`. Processes: service95968,
renderer8902, GPU-process8898. The current AX state also exposed an LFM3 error;
its cause and recovery were not diagnosed by this CPU comparison. No inference
setting was changed to hide it.
