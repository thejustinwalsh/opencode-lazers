# LZ-180 delivery and retained verification

## Delivered candidate

- Exact committed candidate: `2ad21e7c4bce696c6f0e5d2966a409d1b1221a0f`.
- Original task: `834d8513-b419-45b5-b89e-d81041902b8d` (LZ-180).
- Original attempt: `805fadf8-efa5-4df6-ac48-bd4e1443f02c`.
- Original baseline: `e2d75bb3c4ae2c0f3664524e33311090a5a4c2c7`.
- Fresh Git inspection confirms the original checkout is clean at that candidate.

Root reviewed the production delta without a material finding and reports the
final 420 lifecycle tests, automatic `verify` and GUI build passed after the
worker corrected the real end-to-end regression. Architect has not duplicated
Root's checks. These reports support review; native acceptance remains governed
by the existing artifact-bound verification controls.

## Separate native hold

Plan `002c3469-5346-4d74-a21f-6991eb52eeec`, version 16, remains held because native
success did not match the current idle observation. The runtime has not captured
an ordinary attempt artifact. This is not a reported code/test failure, and the
candidate's prospective hook correction does not retroactively reconstruct the
missing historical observation.

No worker replacement, new repair task, proof prompt, fabricated idle, forced
cleanup or unchanged reconcile loop was used.

## Existing retained path

The authorized `verify-retained` command accepted the exact original task,
attempt and clean HEAD bindings. It requested generation 1, operation
`2c86b98f-c4f8-43e9-b7c1-53fc056ffc34`, with both task and combined candidate bound
to `2ad21e7`. Runtime owns isolated checks and receipts; request admission is not
proof those checks passed.

Prioritize this candidate's native acceptance and source integration when those
receipts arrive, before dependent dispatch. Retain the original idle/resource
hold independently; ready source integration must not wait for cleanup.

## Scoped procedure admission corrected

Generation 1 held before running checks because the scoped `bun fmt --check`
targets were not recognized as a project-authored retained procedure. No failing
behavior or quality check ran in that generation. Root corrected target
recognition in `28066f4e462f4f3723ab4f790d8fe61fbbb932b8`, with the exact LZ-180
command regression, 16 procedure tests and automatic/strict checks passing.

Fresh inspection confirmed unchanged clean original `2ad21e7`. The first new
verification request found generation 1 still owned active verification
authority. Supported `cancel-retained-verification` closed that admission-held
run without deleting its history. The same stable new request then admitted
generation 2, operation `d723d59e-0285-4926-9a51-f958b80fe309`, again binding both
task and combined checks to `2ad21e7` and the original attempt. This is a tooling-
corrected verification run, not a replacement implementor or changed candidate.
Await its actual receipts; no pass is inferred from request admission.

## Native task acceptance and source landing

Generation 2 completed both task checks (`lifecycle-tests`, `quality`) with exit0,
no timeout and `unchanged: true`, bound to exact `2ad21e7`. Native task acceptance
advanced the plan to version 17; the original native idle hold stayed recorded.

The reviewed, accepted task source was merged onto canonical `main` through
`d2f4a79712ee49373e54ad3bb44f426c04284b7b`. Git confirms both original `2ad21e7`
and Root's `28066f4` tooling correction are ancestors. The merge changed only the
production hook and two new test files; equivalent package/review formatting
changes were already present on main. Root's retained LZ-174 checkout was not
touched, no server activation/restart was requested, and no duplicate suite ran.

Combined retained checks and whole-plan acceptance are still pending at this
inspection. Defer the integration-record version advance until they finish,
avoiding the known benign-version hold; this does not defer the physical source
landing or wait for cleanup. Do not claim whole-plan integration or resource
removal until the corresponding native outcomes are observed.

## Deferred combined phase resumed through existing control

Root identified that the deferred `task-accepted` branch returns while the plan
is blocked. Inspection confirmed `run` would reject a plan with prior attempts,
and worker `resume` does not admit an accepted node. Existing `reconcile` is the
appropriate plan control: it resumes a blocked plan without changing its accepted
worker, while deferred retained promotion explicitly handles the current version.

Fresh inspection found all nodes accepted and no intended/uncertain effects.
Supported reconciliation advanced the plan to running, version 18. Native
readback confirms the **same operation/generation 2** promoted to combined
verification and reserved its combined checkout for exact `2ad21e7`. The original
attempt remains accepted with its original message ID; no worker input, retry,
replacement generation or premature integration-record mutation occurred.

## Whole-plan acceptance and integration recorded

The same generation 2 subsequently completed both combined checks with exit0 and
`unchanged: true`. Native `RETAINED_CANDIDATE_ACCEPTED` confirms whole-plan
acceptance of exact `2ad21e7`, version 19. All four task/combined check receipts
remain attached to that candidate.

The supported whole-plan `integrated` control then recorded its canonical source
landing and returned `cleanup-requested`, version 20. This finishes acceptance
and source-integration follow-through without another worker or duplicate Root
suite. Cleanup remains a separate non-forced operation; its completion and the
original idle hold must not be inferred from product acceptance or source proof.
