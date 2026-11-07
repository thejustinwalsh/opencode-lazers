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
