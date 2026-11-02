# Handoff review interruption recovery

2026-11-02. Source correction; native worker-tool walkthrough remains pending.

`83a5c31` corrected exact-reservation late-result selection and shared three-round
accounting across authorized reviewers. Its independent native review cleared
those two findings. Following that change, the production reviewer exposed another
failure: a current Architect recovering an expired worker reservation reached
`recordReviewOutcome`, which correctly rejected writing another actor’s result.

The regression first failed with `Review round belongs to another request or
caller`. Recovery now has an explicit store operation: check current request/source
and actor authority, require expiration of the same reservation lease inside the
transaction, and record only an unavailable outcome with its explicit limitation.
Normal inference writes remain restricted to the reservation’s reviewer. The
reservation preserves its original actor; the completion event records that actor,
the actual completing actor and whether this was recovery. Immutable outcomes are
never overwritten and the reserved round remains consumed.

The production-path regression covers database reopen and independent connections,
early recovery rejection, semantic-pass rejection, Architect replacement and old
owner rejection, interrupted-outcome replay, and release of a late original result
after a newer genuinely reviewed round. A separate regression interrupts all three
rounds and confirms continuation with concerns, zero inference calls and retained
unavailable outcomes. No source hashes or fabricated live acceptance are involved.

Checks: `bun test src/recovery src/review src/webgpu/task-review.test.ts` —
39 passing tests, 460 assertions, six files. `bun fmt`, `bun lint`, `bun check`
and `git diff --check` pass. This does not establish the future handoff tools,
request delivery, finalization, Architect disposition or subsequent worker use;
those remain on the native roadmap and require live observations.
