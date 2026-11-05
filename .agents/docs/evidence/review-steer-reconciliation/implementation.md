# Review-input reconciliation evidence

## Scope and native-message shape

This increment adds an explicit current-owner reconcile option for an already
observed synthetic review input. It records an append-only input-lineage
transition; it does not send a message, replace the assigned prompt, allocate a
worker or attempt, or certify acceptance. The existing native current-input,
successful-terminal, zero-background and ordinary verification gates remain
authoritative.

The observed native payload is represented by the `lazersReview` identity
metadata only; `delivery` and `resume` are transport fields and are not required
on the persisted message. Additional native metadata is allowed. The source
review reference is Root's probe
`/private/tmp/lazers-review-message-metadata-probe-20261104.ts` (observation
`1793849927640/643`), which read the original review messages
`msg_c9ffde5810784b15b6b62006616426e4` (owned133) and
`msg_118166ff437e4ce6b18e68161896467b` (owned135). The runtime regression uses
that persisted shape and separately checks harmless additive metadata.

## Regression evidence

`src/runner/runtime.test.ts` exercises owner authorization, exact task/attempt/
session/project/route and assignment binding, current review-message metadata,
fresh terminal/idle evidence, pending/unstable/approval and background holds,
uncertain effects, idempotent replay, reopening, and owner handoff after a valid
admission. It verifies the runtime-produced transition payload through the
strict persisted-alias parser and matching path, including source and
`runtimeSentMessage: false` provenance.

The deferred owner-observation tests change the native input or execution while
owner liveness is being read and require reconciliation to reject without
recording an alias. Durable cancellation, reassignment, and attempt-change races
are also fenced. Negative execution/event/terminal sequences are rejected by
the runtime and by the strict persisted-alias schema.

Focused verification passed:

```text
bun check
bun test src/runner/runtime.test.ts src/runner/schema.test.ts
200 pass, 0 fail
```

The required compatibility and quality checks also passed:

```text
bun test src/runner src/progress test/runner
401 pass, 0 fail, 27 files
bun fmt --check && bun lint && bun check && git diff --check
passed
```

One earlier full-suite run had a timeout in an unrelated adopted-descendant
fixture; that case passed in isolation and the subsequent complete suite passed.

## Qualification boundary

These are fixture-based regressions, not live native qualification. Root-owned
completion of the original owned133 and owned135 attempts, exact-candidate
registered-control qualification, and Root's separate journal/steering
observations remain unconfirmed here. No original task, worker, attempt,
assignment, or owner was changed as part of this evidence.
