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
39 passing tests, 475 assertions, six files. `bun fmt`, `bun lint`, `bun check`
and `git diff --check` pass. This does not establish the future handoff tools,
request delivery, finalization, Architect disposition or subsequent worker use;
those remain on the native roadmap and require live observations.

## Independent review correction

Native reviewer `ses_e627a81dbffe6k9adTYtUzDisG` found that `eccd06f` accepted
caller-supplied interruption payloads too broadly: an unavailable outer outcome
could carry premature terminal status or fabricated semantic observations. That
review did not clear the follow-up.

Recovery now accepts only request ID, review ID and round. The store derives the
interruption result from the durable source, draft, exact reservation/checks and
actual shared reservation count. It shares the existing review-input identity
function with normal review; this is not file or source freshness evidence.
It records no answers, probabilities, scores, model or invented usage. Continuation
with concerns occurs only once the shared three-round policy is exhausted.
Existing durable outcomes replay before recomputation, including after later rounds.

Expired-reservation regressions reject supplied premature terminal status,
answers, resolved findings, alternate identity and invented usage without writing
an outcome. Production review then derives the matching interruption, retains
unknown usage, and preserves exact replay after a later genuinely reviewed round.
The updated 39-test / 475-assertion compatibility run and fmt/lint/check/diff pass.
Independent native re-review remains necessary.

Broader Main run before this final derivation change: 680 pass and two owned-launch
boundary failures inside the restricted sandbox. The full owned-launch file then
passes with host process/private-temp access: 29 tests / 165 assertions. Those two
failures did not require a source fix. Do not report the broad run as all-green or
as a live Desktop feature walkthrough.
