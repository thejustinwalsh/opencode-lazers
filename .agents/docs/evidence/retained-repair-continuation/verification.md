# Retained-repair interrupted continuation and recovery

Observed 2026-11-07 in deterministic temporary Git/SQLite fixtures using the
registered `TaskRuntime` command path. The regressions retain the original
attempt and native session identity, workspace, baseline, route policy,
artifact, usage, and owner/control epoch while exercising a process-replaced
interrupted retained-repair worker. The continuation case checks the durable
input-lineage receipt, completed prompt effect and receipt, and focused plus
combined verification receipts after matching completion and zero-background
observation. The ordinary interrupted-worker continuation regression also
remains in the focused suite.

The recovery regression constructs the historical fail-closed shape: it removes
the newly recorded authority marker and restores the prior equality-based repair
lookup in the fixture, so runtime cancellation occurs without admitting a prompt.
It then writes dirty content to the retained worktree and calls the supported
owner-authorized `resume` with exact task/attempt IDs. Recovery returns the same
attempt, appends an input-lineage receipt bound to the failed reservation and
historical block/cancel transitions, retains the dirty content and usage, and
admits the prompt in the original session. Replaying the command returns the
same result. A separate regression records a real owner cancellation after the
fence failure and confirms that subsequent resume is rejected without another
prompt. The tests also reassert the native parent, route, workspace and attempt
metadata. This is a simulated legacy failure in disposable test state; it is
not a mutation or recovery of the production LZ172 worker.

## Verification

- `bun test src/runner/interrupted-continuation.test.ts src/runner/runtime.test.ts src/runner/native.test.ts src/runner/schema.test.ts src/runner/tools.test.ts` — 385 passed, 0 failed, 5,354 assertions.
- `bun test src/runner test/runner` — 572 passed, 0 failed, 7,631 assertions.
- `bun fmt --check && bun lint && bun check && git diff --check && bun run build:gui` — passed; formatter covered 836 files, lint covered 401 files, typecheck covered 389 files, and the GUI bundle evaluation succeeded. The build emitted the existing Vite `inlineDynamicImports` deprecation and dependency `import.meta` CommonJS warnings.

No OpenCode service, production database, live worker, source activation, or
original LZ172 session was changed or prompted. Native activation and actual
original-attempt recovery remain for Root's reviewed quiet boundary.

## Final-admission fence correction

On 2026-11-07, review of `6622ebf` identified that recovery's early task checks
were not repeated after asynchronous native revalidation. The registered resume
transaction now re-reads the exact task from the same SQLite transaction used
for reservation, binds its ID and current revision to the command, original
attempt and admitted plan node, checks project identity/directory, and rejects
any current task disposition. It performs this check before changing the attempt
message, state, task node, or plan.

New runtime-path regressions defer native worktree/owner observations while
disposition, task revision/project, owner reassignment, or native input changes.
They assert rejection with no added resume receipt, prompt effect, native prompt,
or replacement attempt. Additional registered recovery cases reject a wrong
route, repair artifact, caller, uncertain effect, pending executable controls,
and a real cancellation. The already committed 6622ebf implementation and its
prior evidence/check history above remain intact; tests use only disposable
fixture repositories and do not touch the original LZ172 resource.

Correction verification:

- `bun test src/runner/interrupted-continuation.test.ts src/runner/runtime.test.ts src/runner/native.test.ts src/runner/schema.test.ts src/runner/tools.test.ts` — 395 passed, 0 failed, 5,575 assertions.
- `bun test src/runner test/runner` — 582 passed, 0 failed, 7,852 assertions.
- `bun fmt --check && bun lint && bun check && git diff --check && bun run build:gui` — passed; formatter covered 836 files, lint covered 401 files, typecheck covered 389 files, and GUI bundle evaluation succeeded. Vite reported its existing `inlineDynamicImports` deprecation, dependency `import.meta` CommonJS warnings, and a plugin timing notice.
