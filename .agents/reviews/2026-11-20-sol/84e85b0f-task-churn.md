# 84e85b0f — task-churn

## Findings

### 84e85b0f-1 — blocker / confirmed

- **Where:** `src/runner/takeover.ts:445-455,469-474`.
- **What:** A crash after claiming a notice leaves `notifying` with `noticeSent: true`, which has no deadline-driven exit while the worker stays busy. Restarted calls cannot reclaim it and never reach deadline handling.
- **Failure scenario:** Persist the claim at 452, then service reloads before sending the notice or advancing to `awaiting-handoff`. The worker remains busy (for example, a hanging tool call). Every subsequent `advance` calls `notify`, whose claim returns false; worker attempt remains excluded from ordinary stepping by `heldAttempts`, even after the handoff deadline.
- **Evidence:** `notify` returns at 455 without checking an existing claim/deadline. Deadline transition exists only in `awaitHandoff`; `run` eventually returns in-progress but does not settle the row. Graph reachability does not catch this payload-dependent dead end.
- **Suggested fix / test:** Reconcile an existing claim to the waiting/deadline path without resending an unknown notice. Restart from a persisted notifying/claimed row and assert bounded progress to stopping/taken-over.

### 84e85b0f-2 — major / confirmed

- **Where:** `src/runner/takeover.ts:331-342,692-785`; `src/retention/retention.ts:415-420` (later unit).
- **What:** Each takeover opens a reviewed-handoff request, but takeover settlement/cancellation never closes that request. The later slim path also leaves it open, so completed takeover plans remain protected from retention indefinitely.
- **Failure scenario:** Complete and integrate a task after takeover. Age the plan beyond retention cutoff. The orphaned `recovery_handoff_requests` row has no disposition, and classification keeps the plan forever as “a handoff is open.”
- **Evidence:** Start calls `handoff.request`; settlement only updates runner takeover/attempt/node/plan rows. `cancelForPlan` likewise only changes takeover state. Retention tests disposition existence, not takeover completion.
- **Suggested fix / test:** Do not create the obsolete reviewed request for slim handoffs, or record its terminal disposition with takeover settlement/cancel. Test completed/cancelled takeover followed by age-eligible retirement.

## Checked and sound

- Detector records concerns and does not stop/pause workers.
- Task-wide rules reuse concern identity across attempts; unanswered concerns escalate on doubled magnitude.
- Takeover state transitions use `lifecycleMachines`; workspace snapshot uses a private index rather than resetting user files.
- Later units fix stale synthetic-session settlement, resubmission receipt reuse, and accepted-result resubmission; those historical defects are not counted again.

## Not reviewed

- No production-data threshold replay, live takeover or complete runtime test execution.
- Broad panel presentation changes were inspected for takeover/missing-usage distinctions, not exhaustively rendered.
