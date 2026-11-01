# Renewal host findings and open reconciliation design

2026-11-01. Native OpenCode investigation:
`ses_e687a0f55ffeuodjgp0VDqALFr`. Supported host: OpenCode 2.2.5, source
`9bbb8ce18c80f099e0e448775f59d965ead40a21`.

**LZ-28 is unfinished; unsupported renewal is not established.** Candidate `8c8f86c` sets
`architectInputAdmissionSafe: false`; containment is not delivered renewal or
archival. No lifecycle candidate was merged or activated. Its attempts and
unmerged work remain available. Independent Radar no longer depends on lifecycle
integration, and stopped lifecycle work must not retain an active write lease.

The user corrected the initial conclusion: the task requires durable accounting
and preservation of admitted inputs, not an atomic fence over every native
admission. The findings below rule out a sealed cutover, but do not by themselves
rule out a supported durable handoff/reconciliation protocol. Native investigation
has reopened that alternative: retain the archived predecessor as a recoverable
source; distinguish queued, delivered and already-processed inputs; reconcile late
arrivals and outcomes with stable IDs without replaying executed business work.
Crash recovery, two schedulers and visible native archival remain acceptance
requirements. Do not promote the stronger fence assumption into task acceptance.

## Two separate upstream defects

1. **No safe retirement/admission fence.** Archival and input admission are
   independent operations. Archival does not atomically check idle execution,
   inbox emptiness or an expected admission generation, and does not seal future
   admission. Synthetic `resume:false` bypasses prompt hooks and need not change
   busy/idle. A final empty-inbox read can therefore precede an accepted input
   that remains on the predecessor after transfer/archive. Input can also be
   admitted after archival. This proves missing accounting, not physical deletion.
2. **Plugin archival adapter omits `archived`.** The public plugin
   `session.update` adapter at `packages/core/src/plugin/host.ts:619–626` does not
   forward archival, although the public HTTP handler supports it. Using the
   public client can work around that adapter defect but cannot fix the first
   problem.

Pinned primary sources:

- [Archive operation, session.ts:75–84](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/session/session.ts#L75-L84)
- [Synthetic admission, session.ts:286–326](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/session/session.ts#L286-L326)
- [Inbox mutation/promotion serialization](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/session/inbox.ts)
- [Plugin update adapter](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/plugin/host.ts#L619-L626)
- [Public HTTP archival handler](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/server/src/handlers/session.ts#L235-L262)
- [HTTP cancellation handler](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/server/src/handlers/session.ts#L540-L546)

Cancellation is not conditional claiming: it can target queued or steering
inputs, and the HTTP handler suppresses lifecycle conflicts. A success response
does not prove cancellation won against delivery. Public 2.2.5 declarations expose
no expected-revision or ownership predicate to recover that proof.

## A stronger upstream solution, not an established task prerequisite

A publicly exposed durable, idempotent **idle-retirement/admission fence** could
support a sealed-cutover design by providing:

- Atomically check execution inactivity, empty inbox and expected admission
  generation, then install a seal checked at every admission commit and execution
  start, including already-prepared user prompts.
- Preserve accepted input. Later submissions must be durably parked/redirected or
  explicitly rejected before acceptance, never silently admitted to a retired owner.
- Expose queryable receipts and archive/abort recovery so LAZERS can coordinate
  its separate ownership transaction and withhold handoff delivery until settled.

Archive-if-empty without a continuing admission seal is insufficient for that
sealed-cutover design. A reconciliation design must instead establish conclusive
accounting for cancellation/delivery races, including ambiguous replies, using
supported retained state. Whether existing readback and stable native identities
suffice is under investigation; it is not answered merely by absent precondition
fields. No private database or transport interception is proposed.

Polling, events, `wait`, prompt/context/instruction hooks and GUI navigation do not
supply sealed-cutover atomicity. `experimental.idle` runs before execution settles and does
not own inbox admission; the runner can discover newly admitted input afterward.

Either supported design needs user-prompt preparation versus retirement; queued and
steering synthetic input including `resume:false`; wake registration before busy
visibility; stale-owner outcome admission; cancellation versus promotion; two
schedulers; and lost-response/crash boundaries between seal, ownership, archive
and handoff. These are required discriminating tests, not native cases claimed to
have passed here and not proof that an upstream change is necessarily required.

The separate stale-verification-receipt defect is repaired by main `2536084` and
was activated through supported public `location.reload`. It explains the
unnecessary second LZ-28 attempt; it does not supply the missing host feature.
