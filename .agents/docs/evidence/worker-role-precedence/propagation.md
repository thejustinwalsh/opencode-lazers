# Retained-worktree configuration propagation

Reviewed main `54e4ecd4e5f7b44ed2260b02d863a67a6e6d2cff` was merged normally into
the latest retained LZ-28/36/37/38/40 worktrees. Each was clean before the merge;
all merges completed without conflicts and left clean trees. LZ-40 was updated
only after its task and combined verification completed, with no pending effects.
No task/session/workspace/route was replaced, no service or worker was restarted,
and no system-prompt body was copied into instructions or configuration.

| Work  | Original returned source                   | Updated worktree HEAD                      |
| ----- | ------------------------------------------ | ------------------------------------------ |
| LZ-28 | `7e02ce000b4add82e31165625f67c625c22f3064` | `7b7232c5d44d4d116109957b32e0fd4cd53e28a8` |
| LZ-36 | `c1e297760fbb042221396b714dce11ae8ad9e0d5` | `de9af3b620f9afb23a178696284e5429eda36a3c` |
| LZ-37 | `097eab95e592f4e6122c44aa525ef911c94bb9a7` | `be760cb2c31ca75bd4608354150629b8060bf73a` |
| LZ-38 | `2315b4ab743e743a225797614b252fe7075709ea` | `071b5c13a417f1fc69fe92b88660b433e1b0dfb8` |
| LZ-40 | `00d91a9fcc6f48c7d7172f19865ff876fd063752` | `b312949c47516686d5386d4e47e00ea491dd7509` |

The original commits remain ancestors, preserving implementation and history.
Focused Git comparisons confirmed LZ-36's trajectory/observation feature source,
LZ-37's timer/span implementation and LZ-40's validator/test implementation were
unchanged by propagation. Main's formatting-only automatic-capture.json correction
is now present in LZ-38, alongside current shared definitions and configuration.
Original receipts remain evidence for their recorded inputs; runtime must decide
which receipts match the updated source, not relabel old receipts or waive checks.

## Effective native readback

Public `agent.get`, with explicit `location[directory]` for each worktree, returned
**1,642 characters** of system instructions at main and every updated latest
worktree. Each contains task-instruction retrieval and current evidence guidance.
Every route remains exactly **openai/gpt-6-luna#max**. LZ-40's first immediate read
after merge still saw zero; a later read after normal watcher processing returned
1,642. No reload was needed for that configuration observation.

The native session list also retains LZ-38 session
`ses_179e4f628f2f4ba8a4e22e99214adddd` at attempt
`2f9e5b2e-8fc8-488b-a778-5f9610b5fcdb`, and LZ-40 session
`ses_cadd2f639303482f86f6eda7aaa8cf96` at attempt
`2321628a-9de5-4cf0-bf0d-e8d02393d854`, both with the same route and location.
LZ-28/36/37 retain their previously recorded latest identities. No LZ-39 worktree
exists yet; its eventual dispatch inherits the then-current reviewed configuration.

This proves current effective native role configuration, not the contents of
historical model requests, retrospective tuning effectiveness, task acceptance or
native UI usability. Subsequent work must exercise that effective role normally;
no task was restarted merely to claim it was exercised.
