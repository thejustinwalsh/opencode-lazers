# LZ-177: preserved candidate and native completion hold

Original isolated candidate: `7f8bd70348c697dede039c0f0f46c901edf2adcd`,
based on `1981d7aeb6f853d08091bf221661e9af84200547`. Read-only Git inspection
found the original worktree clean. Five changed files are within the submitted
write scope. No source integration or task acceptance is claimed.

## Native evidence and supported follow-through

Plan `a8394e90-b1dd-4510-8bb9-1a7f7f6ef0ec`, original attempt
`291bb88d-cca6-497f-82d1-d1472ba012a4`, native session
`ses_5cd7fb530a554a3f8e3513f2624a5a1b`, assigned input
`msg_9e1bd182f5bc42138b5704f3a54c9f30`.

The worker reports successful execution completion. Native terminal observation
records completed/succeeded, no busy/pending input, zero pending permissions/forms,
and no unstable observation. However, background remains **unknown**:
“Native execution success did not match the current experimental.idle execution”.
Model-idle/terminal success is not promoted into background-idle evidence.

All three creation effects—worktree, session and prompt—have completed receipts.
No uncertain creation/prompt effect needs replay. Architect issued the allowed
`audit`, then one `reconcile` against current plan version 6. Reconciliation
advanced through version 7 and returned to the same hold at version 8, as observed
through the owned native trajectory. No retry, cancel, replacement worker, prompt
replay, resource deletion, service reload or fabricated idle evidence was used.

Root reports that the service and this original worker continued through the
separate GUI-only `cbd66d8` rollout. This is therefore fresh evidence of the
lineage symptom, not proof that a service restart caused this particular hold.

## Work that can continue safely

Two independent native Luna Max read-only reviews were launched on the exact
candidate: disposition eligibility/authority/replay, and actual dispatch/retry
atomic fencing plus race-test discrimination. Reviews are not acceptance.
The disposition/authority reviewer returned **no material correctness finding**
in its scoped diff: the never-executed branch requires zero attempt rows and
strict cancelled/cancelled or queued/draft node/plan combinations, with active
states and review holds checked first; accepted/incorporated behavior remains.
That reviewer ran no tests and did not assess the separate runner/reservation
race changes. The separate runner reviewer also returned **no material defect**:
the guarded node move precedes attempt insertion in the immediate transaction;
failure rolls back before session/prompt preparation, including both retry paths.
Its test limitation is explicit: two connections exercise serialized winners in
sequence, not simultaneous lock contention, and dispatch-wins manually reproduces
reservation. This is not a newly observed production race or a test execution.
Tests have not been rerun by Architect in the original unknown-resource checkout.
Existing focused read-only recovery research has received this new lineage
evidence. Preserve the candidate, original worker, usage and all resource holds;
resolve missing native lineage through supported authority rather than another
proof turn. Original LZ-174→172 priority and queued LZ-178 remain independent.

## Supported independent verification requested

With both scoped source reviews and Root's source review returned, Architect
requested existing native `verify-retained` for the original clean committed HEAD.
The public control admitted operation `e875321a-3457-45fc-aaec-8f7c8897cb7e`,
generation 1, bound to original task/attempt and exact `7f8bd70348c697dede039c0f0f46c901edf2adcd`.
This requests ordinary declared checks in native-owned isolated contexts, without
an implementation turn or original-tree/resource reuse. Admission is not a pass.
No check result or integration is claimed here; original missing idle lineage
and independent worker/resource obligations remain intact.

## Native task acceptance and independent integration preparation

Subsequent native receipts record the task's fulfillment check **61 pass / 0 fail /
682 assertions**, and quality command exit 0 (formatter, lint, strict typecheck,
diff check, GUI build/evaluation). Both checks were unchanged and did not time
out. Their isolated contexts were cleaned. `RETAINED_TASK_CANDIDATE_ACCEPTED`
records the exact original candidate on its original attempt; this is actual
task acceptance, not fabricated original-worker idle or whole-plan fulfillment.

Architect created a separate native integration checkout
`/Users/tjw/.local/share/opencode/worktree/b5da4c/lz177-reviewed-integration-20261107`
at canonical `d73d8b8deb9a007283a3f96c10d16946c8936536`, preserving Root's
`cbd66d8` GUI repair and committed evidence. The original candidate merged cleanly
there as `e2d75bb3c4ae2c0f3664524e33311090a5a4c2c7`; canonical source has **not**
been changed by this merge. Actual integrated fulfillment/strict/GUI checks were
launched in that separate checkout. Await their completion notification; no
integration check result or watched-source activation is claimed yet.

LZ-179 separately specifies the minimal prospective current-hook correction.
It must not turn Root's diagnostic capture into a historical idle certificate,
or become a dependency blocking this already-reviewed source integration.

## Checked source landed; native external fulfillment demonstrated

The separate integrated checkout passed **61 tests / 0 failures / 682 assertions**.
The full formatting command then failed on two review files that exactly match
baseline `d73d8b8`: `lz173-generation2-native-task-verification-20261107.md` and
`lz176-native-runtime-reload-20261107.json`. Architect verified they were unchanged
from the baseline and left them intact; no full-repository formatting pass is
claimed. All five changed source/test files passed scoped formatting; repository
lint, strict typecheck, diff check and GUI build/evaluation then passed.

Native `session.active` showed only this Architect before canonical landing.
Architect fast-forwarded canonical `main` from `d73d8b8` to checked integration
`e2d75bb3c4ae2c0f3664524e33311090a5a4c2c7`, preserving `cbd66d8` and all existing
untracked Root review evidence. Native task-only integration was recorded.
No server restart or original worker replacement occurred.

Actual registered `lz-dispose-task` calls subsequently succeeded:

- LZ-175: reviewed `fulfilled`, disposition **16**.
- LZ-176: reviewed `fulfilled`, disposition **17**.

Fresh `lz-get-task` readback confirms both executor histories remain **cancelled
with zero attempts**. The records retain their real reviewed artifacts,
verification/live evidence, and prior histories; no native implementation was
invented. This demonstrates the installed disposition repair, not merely source
presence. The existing `native-reviewed175176-fulfillment` human gate was recorded
through its normal artifact-bound plan control against original `7f8bd70`.

One supported reconciliation was requested after these materially new facts to
advance ordinary follow-through. This note does not claim whole-plan acceptance,
combined checks, resource cleanup, or restoration of the discarded original idle
report. Preserve the existing retained operation and passing receipts.

## Same-generation combined checks and human confirmation

Later native inspection at plan version 11 records **both combined checks**
(`fulfillment` and `quality`) exiting 0 against the same exact original `7f8bd70`.
Architect then recorded the actual disposition16/17 and cancelled/zero-attempt
readback through `human-evidence` explicitly bound to retained operation
`e875321a-3457-45fc-aaec-8f7c8897cb7e`, generation 1. The control returned
`recorded` for that same operation/generation. This supplements the earlier
normal plan evidence with its required retained-generation binding; no new
verification generation or worker turn was created.

Whole-plan acceptance/integration and supported cleanup must still be confirmed
from native readback. Neither passing combined checks nor this human evidence
restores the discarded original idle report or releases independent resources.

## Whole-plan acceptance and integration follow-through

Native readback subsequently confirmed **accepted**, plan version 12, exact
original `7f8bd70`. Architect issued whole-plan `integrated` against existing
canonical `main`; it returned `cleanup-requested`, version 13. No second merge
was performed. Await native cleanup outcome; do not equate the request with
successful removal of original or retained verification resources.

The separate Architect-created integration checkout was independently confirmed
clean and merged into `main`, then removed by native `worktree.remove` with
`force:false`, returning `removed:true`. That is not the original worker checkout
or a retained-verification resource, and establishes no historical containment.

## Original checkout cleanup remains independently guarded

Native cleanup subsequently held at version 14: the original worker activity is
not conclusively idle. A fresh read-only Git check confirmed original HEAD is
exact `7f8bd70`, the checkout is clean, and its HEAD is an ancestor of canonical
`main`. Thus dirty/unmerged work is not the reported blocker; missing matching
native idle authority remains unresolved.

Architect retried the existing `integrated` control against current version 14,
requesting only fresh native revalidation and non-forced cleanup. It returned
`cleanup-requested`, version 15. That is not successful cleanup or a repaired
historical idle report. No original files/resources were manually removed, and
no worker prompt, interruption, restart, certificate reconstruction or force was
used. Await the native outcome; do not repeat unchanged retries if the same idle
hold returns. This hold must not interrupt healthy LZ-180 implementation.

That retry returned the same cleanup hold at version 16, confirmed by fresh native
inspection. No newly conclusive original-worker idle evidence is available, so
there is no basis for another identical retry. Preserve the original checkout;
accepted source integration and recorded external fulfillment remain valid.
