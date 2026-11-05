# LZ118 native error-boundary review

In-progress original worker: `ses_8a19b036a82f42599a1d978220fb871a`, attempt
`50345fa1-fccf-4cb7-9e85-e459ec1f85d9`. This records a reproduced finding at
`1793876109068`; subsequent worker changes require fresh review.

The startup classifier accepts only the HTTP protocol `WorktreeError` envelope
(`name`, `_tag`, `data.message`). The native adapter calls in-process
`ctx.worktree.create`. The pinned [PluginHost](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/plugin/host.ts#L573)
directly forwards that call to the core worktree service. It does not map errors
through the HTTP handler. The [core service](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/worktree.ts)
can return core typed errors, including `Worktree.OperationError` and
`Worktree.DirectoryUnavailableError`.

Root's one-shot reproduction imports the installed `Worktree.OperationError`,
passes actual failures through `Effect.runPromise`, then calls the worker's actual
classifier. Results:

| Failure shape                                   | Recognized |
| ----------------------------------------------- | ---------- |
| Installed core `Worktree.OperationError`        | false      |
| Pinned directory-unavailable tagged-error shape | false      |
| HTTP `WorktreeError` envelope                   | true       |

Script: `/private/tmp/lazers-startup-native-error-shape-review-20261105.ts`.
This is a classifier/Effect boundary regression, not a live startup-settlement
qualification. Existing HTTP-only adapter tests do not cover the real plugin
boundary. Correct and test genuine native shapes before acceptance; keep unknown
transport/lossy cases honest. This finding does not reconstruct missing historical
fields or establish that old effects have settled.

Root sent the finding through Desktop; Architect attached blocking advice to the
original task and notified its owner. Delivery is not proof the worker consumed
or corrected it. Native source/behavior and final tests must establish correction.
