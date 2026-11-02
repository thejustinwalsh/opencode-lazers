# Native parallel worker observation

Read-only observation on 2026-11-02, approximately 19:10 UTC; service PID 7793.
Source: project SQLite `runner_attempts` and native-event `runner_progress`.
All timestamps below are Unix epoch milliseconds. This measures observed execution
intervals, not final integration or acceptance latency.

| Task                               | Attempt start | Native successful-turn marker | Observed interval   | State at readback                                |
| ---------------------------------- | ------------- | ----------------------------- | ------------------- | ------------------------------------------------ |
| LZ-70 recovery producer activation | 1793644507128 | 1793645038235                 | 531.107 s (8m51s)   | accepted; source integrated as a5e52c4           |
| LZ-68 Models editor                | 1793643936030 | 1793645599066                 | 1663.036 s (27m43s) | verifying; native background observation unknown |

Attempts are respectively `ba1dd1f0-1ea8-40e3-933a-01a9f6ca122c` and
`dffe9628-84f2-42cc-8774-109a2c610717`. Both were independently read back on
OpenAI Luna Max, in separate native isolated worktrees. Their observed execution
intervals overlap by 531.107 seconds; this is one pair of genuinely parallel
implementation attempts, not a count of all historical parallel runs. Successful
turn markers alone do not establish feature acceptance. LZ-68 returned 3e432be;
its source review subsequently found uncertainty tracking and project-resolution
error handling defects. Its native UI/tool walkthrough remains open.

At Unix 1793646535163, the production recovery journal had both insert/modify
triggers and 188 project facts. Known captured categories included 67 modified
tool records and two modified execution outcomes. Fact 148 references source
sequence 5328956, LZ-70's attempt and native event at 1793645038235; a direct
source join confirms the row and timestamp. Earlier source rows and coalesced
updates remain distinguishable. This proves real journal capture, not that this
particular merge first activated it, that a detector notified Architect, or that
an intervention improved an outcome. Forty-eight source kinds remained explicit
unknowns, not fabricated categories.

Attempt aggregate token counters read 2,425,077 and 15,897,511, with billed cost
unknown for both. These aggregates are not independently qualified billing or
uncached-token measures and must not be used to invent completion prices.
Persona/model cost comparisons still require source usage breakdown, cache
categories and dated OpenRouter fallback market pricing.

## Manual Start and the next actual parallel run

At Unix 1793647393506, Root clicked the existing LZ-61 task's native Start button.
The Tasks row/detail changed from Queued/Start to Running. SQLite confirms attempt
`b20b9aa7-8466-43a7-83eb-57f48408eedc`, native session
`ses_1f1d4570c48f412697ca0e56ccef3893`, isolated native worktree with that attempt
ID. Independent native session readback at 1793647418389 confirms OpenAI Luna Max,
no pending permission/inbox, and the same worktree. This was the existing plan,
not a synthetic test task. [Actual Tasks capture](parallel-native-20261102/tasks-running.png).

The original LZ-68 worker was resumed through the scheduler's native resume action
in the same attempt/session/worktree, with OpenAI Luna Max confirmed at 1793647215994.
Its current patching and passing focused checks were observed; no replacement
attempt or feature implementation replay was created. At1793647651969 both
implementers and the Sol High Architect remained active. Neither feature is
claimed complete from those active handles.

## Actual two-worker Radar review

[Actual Radar capture](parallel-native-20261102/radar-two-workers.png) shows a
current observation and source-backed busy model/state. Accessibility exposes
both busy worker nodes and two active workers; the second lies below the initial
viewport. Authorized Tera 6.1 High review rejects this initial overview for the
two-worker workload: only Architect and one worker are visible, without a visible
active-worker count or indication of the second concurrent worker. The 46-session
inventory count is not a substitute. The previous visual acceptance covered a
smaller workload and does not clear this new case. Assignment attribution is a
separate observed bug: the Architect node takes the first authored task as its
current task. Both findings were returned through Desktop for native tasking.
No static screenshot proves pulse animation or recovery/refresh behavior.

Additional scope audit observations: managed-only inventory tests exclude native
children that are not explicit managed sessions, so Architect helper visibility
needs qualification. The current speaker/mic pills are still on the left in the
real capture; LZ-20's accepted objective covered persistence/auto-speech, not the
separate requested right-side placement. Do not silently drop that earlier ask
from final scope audit or claim a supported placement slot without checking it.
