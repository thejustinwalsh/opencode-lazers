# Fresh worker completion blocked by retired listener ownership

Root read-only observation, 2026-11-07. Original LZ-177 implementor
`ses_5cd7fb530a554a3f8e3513f2624a5a1b` completed commit `7f8bd70` on
OpenAI `gpt-6-luna/max`. Native execution ran from Unix ms 1794075835617 to
1794077415140: **26m 19.523s**. This is execution wall time, not total task lead
time, active CPU time, or billed duration. Its 61 targeted tests and quality/build
results are reported by the worker; Root reviewed the changed production code.

## Observed cause of this hold

Read-only DB capture: [exact observation](lz177-fresh-idle-observation-20261107.json).

- Both canonical and assigned-worktree listeners observed actual execution start
  sequence 7. Stored latest invalidating event sequence was 9.
- At 1794077415027 the real `experimental.idle` hook ran in the assigned worktree
  and reported **backgroundCount: 0**.
- At 1794077415134 the hook resolved the original assigned input
  `msg_9e1bd182f5bc42138b5704f3a54c9f30`, but emitted
  `idle-lineage-unavailable` instead of persisting its actual background report.
- The listener identities at idle differed from those that observed start 7.
  This establishes listener replacement, not its trigger. No explicit server
  restart/reload occurred during Root's Desktop-only cache rollout.
- Native success at sequence 1313 then produced the expected downstream failure:
  `Native execution success did not match the current experimental.idle execution`.
  The stored idle report is null. A later audit/reconcile did not reconstruct it.

Thus this hold is not absence of a real idle-hook observation, a reported live
background job, or a failing implementation test. The application discarded a
current native observation because the observer could no longer obtain a live
module witness or retained native log of the execution start.

## API contract and correction direction

The pinned primary contract in
`node_modules/@opencode/plugin/dist/effect/session.d.ts:155` states that the hook
runs after model work with no pending input, before successful idle; its background
array lists actual work still running. It does not run after failure,
interruption or manual compaction. Hook-admitted input continues in the same
execution. This is stronger than inferring empty background from session status.

Use the fresh native hook as an observation of current background work while
checking assigned session/input identity and concurrent changes. Module retirement
alone must not invalidate current native facts. Preserve terminal confirmation
and ordering; never reconstruct zero background from ordinary success, failed
replay or missing data. Already-held work needs a supported recovery path using
genuine retained observations, with its original source/history/resources intact.

Root sent this finding and capture to the existing Architect through Desktop.
This report is not a task-state mutation, a claim of runtime acceptance, or a
new model-generated idle event. The original candidate and native hold remain
preserved pending the correction.
