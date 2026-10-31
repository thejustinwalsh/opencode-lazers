# Incoming outcome coalescing review — current wake recovery

Read-only source review of existing task
`44fb4817-4826-481f-acac-7840caf14341`, attempt
`ebee90d2-157b-4408-83f4-31cd95ebefd7`, using Root's report
`/private/tmp/lazers-outcome-coalescing-review.md`. The worker remains active;
this is not a review of a returned/accepted artifact.

## Latest uncertain outcome with an archived owner

The reviewed `runtime.ts` source confirms the important case: `deliverCurrent`
replaces an invalid/archived owner through `ensureArchitectOwner`, then for a
non-pending latest row records `unknown` and returns. Subsequent delivery skips
`unknown`. `ensureArchitectOwner` only creates/adopts the native successor and
records ownership/continuation facts; it does not enqueue a replacement outcome.
If there is no newer status, the successor can therefore remain without a wake.

The existing worker received native instruction entry
`lazers-outcome-recovery-review` on
`ses_cd2558ed1cb942ee86500a02af2efca3`, without interruption or source edits.
The current notification must remain durably recoverable for the adopted owner,
with old uncertain native-admission evidence retained. Stable continuation and
delivery identity must survive process/store reopen and uncertain replacement
delivery without repeated successor creation or duplicate current wakes.

At return, verify a regression for **no newer outcome**: uncertain/lost native
response, owner archival, successor adoption, reopen and repeated ticks must
leave one recoverable current action for that successor, with honest retained
uncertainty. Instruction admission is not proof that this repair has landed.

## Do not confuse obsolete-notice suppression with lost current work

An **older** uncertain row may correctly become consumption-unknown when a
newer complete durable status supplies the current notification. Replaying the
obsolete old status is not required and can recreate wake churn. Keep a paired
test proving old-notice suppression plus current delivery and unrelated-input
safety. This does not authorize retracting consumed transcript messages or
discarding the only current notification.

The report's missing type import, native fixture shape and legacy
`delivered`/`admitted` assertion failures were observations of mid-edit work.
They remain ordinary verification issues, not additional contract gates or
evidence that the eventual returned artifact fails. Root's source distinction
above clarifies the existing recovery acceptance, not a new lifecycle project.

## Speech observation update

Root's `c5c285f` records automatic read-aloud generation on the real Architect
P1-review final reply, with screenshot and native trace. The native shortcut
restored Auto off afterward. See the scoped
[speech evidence](../024-final-prose-speech/replay-repair.md); this establishes
real-final automatic generation, not perceptual audio quality or behavior on
every provider. No speech setting or diagnostic code was changed by this review.

## Preserve concurrent Root runtime repairs at integration

Root's canonical `a07377c` makes unchanged blocked waits idempotent; Root
reports 60 runtime/recovery tests passing, all nine native locations reloaded
with unchanged service PID, and context plan version 318 remaining stable
across ticks. Root is separately repairing the existing `human-evidence`
command's missing plan-level lane with declared-assertion/current combined
accepted-artifact binding and tests. Do not duplicate that work or overwrite it
when merging the wake-coalescing artifact. Review against the latest canonical
runtime and retain both fixes and their regressions.

The active wake worker received native instruction entry
`lazers-root-runtime-integration-preservation` without interruption. This is a
merge-preservation watchpoint, not an expansion of its immutable task scope.
Context's real native observation remains committed in `c1ced6f`; task acceptance
and the separate plan-command gap are documented in `12e5ae4`. Preserve the
existing plan/task and evidence; do not retire the work, force acceptance or
insert graph evidence through SQL. No duplicate context or runtime repair task
was submitted by this driver.
