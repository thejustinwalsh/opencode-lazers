# Scheduler artifact review and handoff repair

Existing task `2958fa32-9f7a-43d9-9252-3d30f2d4dca1`, plan
`6ed421e4-88cc-4324-b521-8f9a32d5de43`; accepted worker artifact
`3c6ee1ef75a90431d586f1bb6bcaeca34cddd83e`, based on `134f5c3`.

## Evidence inspected

- Retrieved the existing task, exact acceptance boundary, attempt and native
  trajectory; inspected the plan audit and Git diff. The worker attempt is
  accepted; its plan was still running/v6 with no combined artifact while another
  shared worker was active. Task acceptance is not integration.
- Audit watermark 415 showed unresolved legacy unplanned tasks and overlaps
  among those records, not a new unresolved finding involving scheduler task
  `2958fa32`. No replacement task or invented overlap disposition was submitted.
- The recorded worker used Luna Max, one native session and 163 tools. Native
  context was compacted; omitted reasoning and missing history were not read or
  inferred. Categorized cumulative usage is one session snapshot, not a sum of
  transcript pages. API-equivalent cost remains unknown.
- Review/repair was performed in the host-created isolated worktree
  `/Users/tjw/.local/share/opencode/worktree/b5da4c/scheduler-review`, not main.
  Repomix `f55e7013` was actively editing main; its files were not modified,
  stashed, reset or committed by this review.

## Preserved integration behavior

The isolated merge retains current main's Tasks Start authorization, immutable
Run receipt identity, crash recovery and ownership round-trip protection. It
retains explicit shared retry-baseline priority, failed-artifact retry continuity,
and reviewed shared HEAD for each new node's first attempt. Isolated inputs now
combine actual accepted dependency ancestors, not unrelated ordinal predecessors.
No inference code, settings, provider fallback or resource budget was changed.

## Defects repaired during review

- Accepted-task outcomes now request native queued synthetic **resume**, with
  the durable message identity and a concise instruction to review the artifact
  and continue existing work without waiting for plan finalization. Blocked,
  combined-accepted and cleanup outcomes likewise carry concrete actions;
  informational integration receipts remain non-resuming. Full check logs stay
  in durable evidence, not repeated in the notification.
- A completed plan can finish and deliver its outcome while another independent
  worker remains active. When the shared checkout has advanced, combined checks
  use an exact-artifact native worktree rather than mislabeling newer/dirty source
  as the old accepted artifact.
- Resumed preparing attempts obey the same shared-checkout/scope admission as
  fresh dispatch. Stable unsent-reservation priority prevents mutual waiting;
  already intended prompts remain occupied until conclusively stopped.
- Uncertain effects cannot prevent interruption of admitted siblings during
  cancellation. Cancellation remains unresolved while effects are uncertain;
  no stopped-state proof is fabricated. Final observed usage is retained without
  lowering cumulative historical measurements or double-counting snapshots.
- Asynchronous combined-worktree/check completion and attempt verification cannot
  overwrite a concurrent cancellation with acceptance.

Real-Git delayed-host regressions exercise these cases, original branch
combination/conflicts and protected cleanup. Native adapter tests assert queued
synthetic delivery with resume=true and stable message IDs; restart tests retain
delivery idempotence. These are not proof of two real native workers overlapping.

Verification in the combined isolated review tree: **59 runner tests / 943
expectations**, **187 full-suite tests / 1,835 expectations** across 38 files,
and formatting/lint/typecheck all passed. The current-message-identity regression
also proves two conflicting shared resumes make serialized progress rather than
deadlocking behind historical stopped prompts. No GUI source was changed.

## Native follow-up and integration boundary

Use the existing `b50a1a71-1a54-4d89-8ef2-0644bcccc327` product graph's disjoint
projection and speech work for actual native fan-out, not a demo graph. Retain
`native.md`'s unresolved status until observed worker intervals, combined review
and non-forced owned cleanup are recorded. Preserve active shared work before
merging this review into main and recording runtime integration; a branch receipt
alone does not establish integration.

At the final merge-readiness check, Repomix had committed `c787af3` and left main
clean, but the runtime had already dispatched `fc88ccc0` in the same main checkout
from that baseline. Its execution was still running, with runner files in its
write scope. The reviewed merge is committed as `98637b4` in the isolated native
worktree and retained; it was not merged over that active shared worker, and no
runtime integration or cleanup is claimed. Finish at a quiescent shared boundary,
reload the committed runner through the supported location API, then record the
existing scheduler plan's integration after its combined acceptance. Preserve
the original accepted artifact/attempt and the review commit as separate facts.
