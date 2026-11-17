# Current dogfood handoff

Updated 2026-11-17. The external dogfood driver is now Claude Code; Codex no
longer drives OpenCode. Runtime/API/DB state is authoritative; this file is a
locator. Earlier detail (2026-11-09 and before) remains in Git history.

## Product goal (user direction, 2026-11-17)

LAZERS turns a request into **integrated** code. Handing work back for review
is a step, not the goal. A queued task must reach exactly one of:

| End state    | Meaning                                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------------ |
| Integrated   | Architect reviewed it and merged it into the current branch.                                                 |
| Pull request | Pushed to the remote with a merge-ready PR awaiting integration.                                             |
| Escalated    | Raised to the human with a concrete question the Architect cannot answer from the plans or its own guidance. |

A plan that sits in any other state without progress is a product defect, not
an expected wait. A stalled scheduler with an Architect that is not unblocking
it is strong evidence of a flaw to fix.

Corrections to earlier framing:

1. **Done is a valid review outcome.** When the checks pass and the review
   agrees, the work is done. The next step is integration or a PR, not another
   repair/retry/replan loop.
2. **"Unknown" is not a default UI state.** Missing telemetry for a task is a
   bug. A missing price is a bug unless the source has no price, in which case
   the price UI is omitted rather than shown as unknown. Missing test coverage is
   a known fact ("no tests"), not unknown. Every product decision built on
   "unknown" needs to be audited and reconciled. This includes the website copy
   (`website/src/Sections.tsx:658`, `:793`) and the cost line in AGENTS.md,
   README and contributor contracts.
3. **Overlapping write scopes do not force serial execution.** The Architect
   may choose parallel work on overlapping files when it knows how to integrate
   it. The Architect can queue a small integration prompt for itself when it
   expects a messy merge. The runtime should warn about large overlapping write
   scopes, the same way plan validation warns, and then honor an explicit
   parallel choice. Parallel versus serial work must be a controlled choice,
   not an automatic serialization.

The docs (`docs/reference/contributor-contracts.md`,
`docs/explanation/workflow.md`) still describe the current behavior: overlapping
scopes are serialized and missing costs stay unknown. Update them alongside the
implementation, not ahead of it.

## Live state (read 2026-11-17 via `lazers.tasks.scheduling` project scope)

There are 190 plans: 108 integrated, 29 cancelled, **53 not finished**. The
active sessions are the Architect `ses_e568438ebffeaoFbF9nBb942XM` and four
workers.

**Pending Architect question** (form `frm_1ea437721001idmYgEp4qo4HPq`): should
LZ-214's remaining connected qualification be split from its landed
implementation, releasing its write reservation? LZ-216 (Tasks toggles) and
LZ-224 (plan headings) are queued behind that reservation.

How the 53 unfinished plans are held. Each group is a stall to fix or escalate,
not a state to wait out.

| Hold                                                   | Plans                                                                                                         | Reading                                                                                                                          |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `Combined artifact evidence missing: …:human`          | LZ-43, 56, 62, 77, 80, 81, 83–85, 96, 108, 110, 111, 117, 151/152, 155, 156–158, 168/169, 178, 184 (19 plans) | Accepted work is waiting for human evidence that nobody has asked for. These need to be escalated as questions or self-verified. |
| Connected qualification evidence missing               | LZ-214                                                                                                        | This is the subject of the pending question.                                                                                     |
| Native idle observation unknown or mismatched          | LZ-50, 103, 139, 141, 142, 173                                                                                | An idle-proof gate blocks progress and cleanup. This is a direct case of correction 2.                                           |
| Recovery uncertain, no receipt                         | LZ-63, 72                                                                                                     |                                                                                                                                  |
| Combined verification failed or conflicted             | LZ-59, 138, LZ-130/131 (test merge conflict), LZ-183 (quarantined checkout)                                   | These need Architect repair or composition.                                                                                      |
| Prerequisite cancelled (LZ-182)                        | LZ-189, 190, 191, 192, 200                                                                                    | These need to be rewired to the LZ-214 completion.                                                                               |
| Waiting for accepted prerequisites to integrate        | LZ-196, 219, 221                                                                                              |                                                                                                                                  |
| Accepted, prerequisites integrated, not yet integrated | LZ-88, 154                                                                                                    | This is a direct case of correction 1.                                                                                           |
| Write-scope reservation                                | LZ-216, 224                                                                                                   | This is a direct case of correction 3.                                                                                           |
| Draft, never started                                   | LZ-144, 212, 213, 217, 225                                                                                    |                                                                                                                                  |
| Running with a live worker                             | LZ-99, 134, 135, 146, 222                                                                                     |                                                                                                                                  |

Reproduce this read with `bun .cache/driver/claude-state-20261117.ts`. It is
read-only: sessions, forms, permissions and the paged scheduling read.

## Active plans

- `.agents/plans/lz182-full-completion.md`: complete Tasks Now/Attention/Next
  (LZ-214). Two source gaps are in `src/tasks/scheduling-read.ts`.
- `.agents/plans/panel-streaming-idle-axis.md`: full-result streaming in all
  four panels and Trajectory idle compression. The corrected Auditor report is at
  `.cache/driver/panel-streaming-audit-corrected-92b0a75.md` (not yet published
  to `.agents/docs/panel-streaming-contract-audit.md`).
- `.cache/driver/native-capacity-admission-defect-20261117.md`: a definitive
  pre-admission rejection must not leave an ambiguous interaction lease (LZ-225).

## Driver rules

- Follow `.agents/skills/dogfood` and the AGENTS.md operator workflow. Check
  for pending Architect forms before dispatching work.
- Prompt models through Desktop. SDK and DB reads are diagnostics only. Never
  repair production state with SQL.
- `.cache/driver/client.ts` discovers the existing service. A discovery
  timeout does not prove the service stopped.
- Preserve original workers, useful work and history. Use native worktree and
  lifecycle APIs.
- Run `bun run verify` plus the relevant behavior tests. Project listeners go
  through Portless.
- Original brief: `.agents/docs/sources/original-design-brief.md`. User steering
  supersedes it.
