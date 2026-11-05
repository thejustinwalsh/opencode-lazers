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

Later inspection found the cancelled successor blocks the whole plan. LZ57's
ready node is therefore not a claim of dispatch eligibility. Changed remaining
requirements must be reconciled through the existing linked task/disposition
flows. An older admitted baseline alone is not a global execution failure;
delivered LZ130 history must not be rewritten just to refresh queued LZ131.

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

**Observed natively:** existing owner used request
`lz99-completed-input-source-isolation-20261105-v1`; quarantine sealed at Unix
milliseconds `1793871137426`, with native archival at `1793871137393`.
Independent before/after inspection found the original attempt metadata/state
and three original effects unchanged; the original tree remains. LZ99 remains
unaccepted with background status unknown. This releases independent source
admission, not task completion or resource cleanup.

The scheduler resumed original LZ133 attempt
`6ee1191f-95ef-45d0-9b90-8e96623b9841`, same worker
`ses_9250c22e68da40ff86371b407b9c3c11`, on OpenAI `gpt-6-luna/max`.
Its instruction read completed at `1793871146135`; subsequent native shell and
patch calls changed the source journal/store pagination implementation and tests.
Root observed ongoing work at `1793871761962`; acceptance and native reprobe are
still pending. Before-operation snapshot:
`/private/tmp/lazers-lz99-before-source-isolation-20261105.json`.

## Review corrections

Luna Max reviewer `ses_e55054657ffebAGSulafITdIMx` found an input race between
runtime preflight and native archival. `eb7d696` checks the retained native input
at the archive boundary and during readback for running attempts. A newer input
visible before update produces zero archive calls; a change after update leaves
quarantine pending and source admission held, without repeating the archive.
The public update is not a compare-and-swap operation; the latter test explicitly
preserves that distinction. Final quarantine/race tests:16 pass/260 assertions.

Root also found native Code Mode `fetch` bypasses tool hooks and instead asserts
`webfetch` permission. Source: [pinned fetch extension](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/codemode/fetch.ts#L24-L34).
`9c342e2` preserves the previous quarantine restriction through OpenCode's
permission-evaluation hook. Normal sessions retain their existing fetch policy;
quarantined sessions can use Code Mode's permitted task/handoff tools, while
fetch, source writes and shell remain denied. Role/adapter/guard-lifetime
tests:39 pass/237 assertions. Formatting, lint, types and diff checks pass.

Both corrections were delivered through Desktop for focused review and the
existing owner's native walkthrough. No extra Root approval/release remains.
