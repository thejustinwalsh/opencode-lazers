# Existing LZ88: fresh busy-worker reproduction

Root observed LZ130 at Unix ms**1793825526844** with permissions/forms both empty
while its same worker remained busy and completed tools. The plan still repeated
the prior one-permission reason. Architect's earlier owning-location read at
**1793825356133** also returned zero permissions/forms; later tool count advanced
38→41. One evidence-driven reconcile was requested, not a retry/redispatch.

Root's source finding: in `runtime.ts:advanceAttempt`, the busy return around3184
precedes `resumeTransientObservationWait` around3186. Fresh cleared approvals
therefore cannot clear approval-only published state while work continues.

This is **already covered by queued LZ88**`f5619402-d9bf-497f-a29d-05b9f333ce2f`:
its guidance names the busy early return, and acceptance requires fresh zero-
approval restoration while busy plus fenced stale pre-reconcile observations.
Reuse it; do not create another approval fix or broaden permission policy.
Its primary-kind annotation now records bug-repair without rewriting the task.

Plan`04020fac-7522-4024-a4bf-8b606c78034a`v2 has zero attempts, priority450,
and an explicit integrated-LZ72 prerequisite in addition to actual runtime source
reservation contention. Merely removing that edge would not settle the old effect
or establish the required baseline. Existing LZ72/LZ58 ownership/recovery research
must determine the supported proportional next action. Preserve source/tests and
actual old effect uncertainty separately; never fabricate receipt/containment,
cancel merely to shed scope, or introduce another recovery engine.
