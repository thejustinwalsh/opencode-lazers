# Retained-work bootstrap repairs

## Explicit baseline retry

`8fcdca0` fixes a reproduced bug: retrying an unstarted task accepted
`baseCommit` but silently retained the old plan baseline. The existing owner can
now explicitly advance a wholly unstarted plan to reviewed committed source on
current HEAD. Task specifications, owner, dependency graph and model route stay
intact. Prior attempts cannot have their baseline rewritten. Invalid sources and
unresolved effects reject without partial changes; exact replay returns the same
receipt. The failing regression became passing.

Verification: 8 focused tests/150 assertions; 267 runtime/schema/continuation/tool
tests/4,052 assertions; formatting, lint, typecheck and diff checks pass.

**Observed natively:** existing owner `ses_c59b85e3559c47a8a6f8191eb3b47eae`
retried original LZ57 through Code Mode. Plan
`d0ce36bb-3b8a-481b-b525-9e2b45c55cb6` reached version19/revision3, with LZ57
ready on `8fcdca05d2012602036152e38efd72f75b43e065`. Baseline selection was
recorded at Unix milliseconds `1793869066984`; requeue at `1793869066989`.
Exact replay added neither event again. Owner, original task revisions,
dependencies and OpenAI Luna Max route were preserved; attempts and effects
remained zero. LZ58 remained cancelled. LZ99 still prevented dispatch.

## Guarded source isolation

`658099c` extends the existing source-quarantine operation to a retained running
attempt whose exact current foreground input has completed successfully. It
requires the existing native ownership/location/input/approval checks, an
installed source guard, native archival and public readback before sealing.
Only independent isolated source admission is released. Shared or identical
physical checkouts remain excluded; old execution, acceptance, uncertain checks,
resources, worktree and history are retained. It neither supplies a missing idle
observation nor accepts the old task.

Pending running admission uses a detailed input read. Sealed maintenance does
not load context; a regression checks this. Code Mode remains available for safe
reads/handoffs, while native inner tool hooks still deny source writes and shell
execution for the quarantined worker.

Verification: broad lifecycle regression275 tests/4,143 assertions. After the
final native-adapter adjustment, focused quarantine/role tests15/249 assertions
and native adapter/registry tests36/207 assertions pass. Formatting, lint,
typecheck and diff checks pass. The positive case exercises native archive
authorization SQL/readback, separate physical trees, retained unknown background
and lack of old acceptance. Negative cases include busy, pending, failed,
missing and wrong-input foreground observations; existing permission, reassignment,
restart, lost-response and physical/shared exclusion tests remain passing.

**Native operation remains pending at report creation.** Architect was asked to
obtain a focused Luna Max source review, then have the existing LZ99 owner use
the supported control and observe actual scheduling. Before-operation state is
saved at `/private/tmp/lazers-lz99-before-source-isolation-20261105.json`:
LZ99 planblocked/version19, original attempt running, three effects retained.
No source-quarantine success, task completion, old cleanup or resumed worker is
claimed by these test results.
