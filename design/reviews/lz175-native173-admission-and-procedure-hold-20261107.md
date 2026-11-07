# LZ-175 native LZ-173 admission and procedure hold

## Server activation and original candidate

Root reports supported server-wide `client.location.reload()` at global idle,
receipt `/private/tmp/lz175-native-runtime-reload-20261107.json`, Unix
1794071693061–1794071701471. Service PID 3219 stayed unchanged; global active
sessions were empty before/after, and canonical plus original 173/174/172 had no
pending permissions/forms. No restart, prompt, SQL mutation or replacement.
Canonical `2b1a898` contains reviewed LZ-175 integration `cbf20ee`.

Original LZ-173 remains exact attempt
`4d783df7-eb05-463c-b4db-df48a5c308c5`, session
`ses_145885557d454551815079ab36bd9c24`, authorized input
`msg_bce2549adb4346a0a0fd2221d8576edd`. Its clean original checkout holds reviewed
`0b289721647eddafa8e5d9bba4f5ce2daf945811`, strictly descending from the old
recorded `ddefc44`. No original worker prompt was emitted here.

## Obsolete authority retired through the existing control

The first registered `verify-retained` was refused by a conflicting retained
verification authority, not candidate mismatch. Native plan inspection plus
read-only SQLite diagnostics identified the sole active authority as original
LZ-156 operation `34d2518c-4a7a-41ad-bb69-59943b6fd87d`, generation 3, held on
unbound combined `comparison` verification.

Its task `b01121b` was already accepted and landed; native source-integration
history and Git ancestry agree. Both task check receipts remained completed with
cleanup complete; 24 resource rows were already removed. No pending plan effects
were observed. Existing Models combined/human gates were not passed.

Architect used existing `cancel-retained-verification` on only that operation,
owned plan `eade12ae-74f3-48af-874b-f5950f4a41c3`, version 28. Native result
confirmed cancellation. Readback retained both completed check receipts and all
24 removed resource rows; operation cleanup remains pending. This retired only
obsolete verification authority, not the task, original session, independent
resource obligations, unknown execution history or unresolved plan gates.
No database mutation outside the control or manual cleanup was performed.

## Actual corrected-descendant admission

Retried the exact original LZ-173 `verify-retained` request with unchanged
project/plan revision/task revision/attempt/candidate bindings at plan version 85.
Runtime admitted operation **`8618a6eb-5812-4063-8a8a-9a11d73117cf`, generation 1**,
binding both task and combined candidates to exact `0b28972`. Durable readback
contains its repair binding and the same original session/input/attempt.

This is actual functional observation of LZ-175's new descendant admission path,
not proof from GUI reload or inventory. It is **not** completed verification,
acceptance, original idle evidence or LZ-175 fulfillment.

## Current concrete blocker: declared trajectory procedure

The operation immediately held, before any check/resource rows were created:

> Verification trajectory has no project-authored procedure/resource binding;
> only project-relative Bun test targets, scoped quality commands, and
> candidate-declared Bun scripts are currently bound; required resources are not
> bound to the retained context.

The immutable declared check is:

```sh
bun run build:gui && bun test src/trajectory/read.test.ts src/trajectory/tools.test.ts test/trajectory-panel
```

`src/runner/retained-verification/procedure.ts:91–150` accepts either a standalone
safe Bun test command, or an `&&` chain of narrow quality commands and named
candidate-declared scripts. The trailing Bun test step is not accepted in the
latter branch. This is an existing procedure-binding limitation, separate from
LZ-175 candidate binding. No check has passed or failed on this new operation.

Root's next concrete repair boundary is supported binding/isolation for this
already-declared build-then-test procedure, without rewriting/waiving the check,
accepting arbitrary shell, weakening resource isolation or replacing the worker.
Preserve this held generation and history; do not retry unchanged or create
another generation before a real relevant repair and supported reconciliation.

Original LZ-174's `67d4e6d` content-scan gate remains rejected unchanged. LZ-173's
connected original LZ-137 human probe and Models/UI/source gates remain open.
LZ-175 still has zero implementation attempts and is not fulfilled from admission
alone. Original workers, old receipts, usage and unknown resources stay intact.
