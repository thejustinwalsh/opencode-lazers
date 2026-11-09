# Recovery controls: candidate review

Candidate: LZ-195 `59dd346`. The worker reports quality checks and32 recovery
tests/446 assertions passing. This is source review, not live qualification.

## Required corrections

1. The user's latest recovery judgment is not reflected in candidate Architect
   guidance or its runbook: weigh measured usage/market cost, failed approaches,
   actual progress, scope growth and remaining work against the next useful
   worker step and takeover overhead. No universal quotas or automatic frontier
   escalation. Advice revision1 was recorded during the worker run, but
   `lz-attach-task-advice` only persists advice. Use existing steering/repair and
   review the result; stored advice is not demonstrated consumption.

2. The public handoff tools differ from the explicit user request.
   `src/recovery/tools.ts` currently exposes worker-facing submit-draft →
   verify-by-draft-version → finalize. The requested workflow is
   **`lz-verify-handoff` accepts structured handoff data; `lz-submit-handoff`
   finalizes the reviewed handoff**. Keep durable drafts/history and existing
   review implementation internally. The worker should not need a third public
   finalization tool. Tests should exercise those actual public semantics, not
   merely prove the current alternative API works.

## Still to observe

Architect reviews the corrected result and integrates it through supported
flows. Existing LZ-196/192 work connects automatic notifications and follow-up
wakes; candidate195 alone does not deliver them. Live walkthroughs must show
request delivery, worker review/submission, attached history, Architect correction
and subsequent work using it. Handoff submission does not complete the task.

Preserve the candidate and original worker. These are corrections to the current
requested feature, not new scope or grounds to discard working implementation.
