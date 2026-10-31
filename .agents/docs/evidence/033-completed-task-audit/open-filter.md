# Cancelled-plan Open-list repair

Native Desktop showed task `c0ef9f9d` as failed after its plan was cancelled. The
recorded interruption remains valid history; it is no longer actionable Open work.
Commit `9ab588f` filters cancelled plans in project queries. Native testing then
found the new association-aware Session query had copied the previous filter;
`653e2c4` applies the same cancellation policy there.

Regression coverage checks project/session queries in both reader implementations:
cancelled-plan tasks disappear from Open, failed/running/exhausted/cleanup-blocked
plans remain actionable, and history/direct task reads retain cancelled records.
The full tree after the first repair and projection merge passed 264 tests / 2,492
assertions. The Session correction passes seven focused tests / 78 assertions,
formatting, lint and strict TypeScript.

Native Project showed nine Open tasks; Session initially showed ten and retained
the cancelled task. After the Session correction, native Session also showed nine.
The screenshots capture both successful scopes. No task state or inference setting
was changed to achieve the display result.

A global location reload encountered an already-removed native Qwen worktree.
The pinned host source confirms `location.reload` reloads all cached locations;
`debug.location.evict({location:{directory}})` invalidates a specific cached
location. Root reactivated only the canonical project using eviction plus
`location.get`, then successfully read the scoped observation RPC: 17 plans,
21 attempts and 94 checks. The worker locations were not evicted. This is supported
native maintenance, not a custom worktree recreation or a service restart.

The duplicated query policy caused a real divergence immediately after integration.
Keep cross-scope behavioral coverage; consolidate the shared query path when it is
next changed rather than adding task-writing rules about this incident.
