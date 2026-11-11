# Scheduler cleanup notification stall — 2026-11-10

Observed source: `4b4b1e5`. Production source was not edited by this observation.

## Recorded inputs and outputs

- `runner_plans`: 37 `cleanup-blocked`, 37 `blocked`, 8 `running`,
  2 `accepted`, 1 `draft`, 26 `cancelled`, 57 `integrated` at inspection.
- `runner_transitions.created_at` in `[1794355700000,1794356000000]`:
  228 `CLEANUP_BLOCKED` and 227 `CLEANUP_RETRY_SCHEDULED` records across 37 plans.
- `TaskRuntime.worktreeCleanupFactsChanged()` returns true after
  `WORKTREE_CLEANUP_FALLBACK_MS = 60_000` even when retry facts are unchanged.
- `TaskRuntime.tick()` reopens the plan as `cleaning`; a failed
  `TaskRuntime.cleanupWorktrees()` changes it to `cleanup-blocked`, increments
  its version and calls `outcome(..., true)`.
- `assertWorktreeQuiescent()` calls `backgroundBlockReason()` for surviving
  worker sessions. The repeated recorded rejection was
  `No experimental.idle background report was observed for the assigned attempt`.
- Architect `ses_8ce6308ac2ec4c61b45dea8aa759b28a` repeatedly replied
  `Unchanged hold, covered by LZ-203` to the resulting synthetic messages.
- LZ-203 plan `7dd43a51-827c-4ce0-96db-08bd2b3815f7` has a persisted dispatch
  pause until LZ-154 (`c8fdd538-c1eb-4ca5-8414-e74f0f1aabbf`) and LZ-187
  (`222a9c71-dae9-4a31-bb98-450d6fb76cd9`) integrate.
- Native `client.session.active()` showed Architect and LZ-154's worker
  `ses_1460ccaeafe24dc1a44fe01b7f07b026` running. The worker's `bun run verify`
  passed; its subsequent four-file behavior run returned 405 pass / 3 fail.

## Driver action and observed response

User requested repair of the stalled scheduler. The external driver submitted that
request through the Desktop composer, with the observed notification path and
LZ-203 pause conditions. Native user message:
`msg_1c7f3bc69001vToq8OSzYHufw7`, timestamp `1794356002045`.

Architect `ses_e568438ebffeaoFbF9nBb942XM` acknowledged the request and called
`lz-inspect-plan` through Code Mode, read current Git state, and searched the
cleanup retry symbols. This establishes request consumption and investigation;
it does not establish corrected dispatch, integration or autonomous recovery.
No live database records, workers, pauses or dependency links were changed by
the external driver. Repair and observed post-repair dispatch remain pending.
