# Native worktree dependency setup correction

Real156 verification operationf0a3a894-5a30-4c07-b57a-ea44c4eed7bf reached an
owned native candidate checkout but held before any check: “Candidate checkout
already contains an unowned node_modules resource.” This was a runtime/host
compatibility defect, not failed model implementation or passing verification.

The pinned official [OpenCode worktree implementation](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/worktree.ts#L236-L255)
runs the project's startup command in the actual destination and awaits success
before returning. Public CreateInput has no skip-startup flag. LAZERS incorrectly
assumed a successful native checkout always had an empty dependency path.

Fixe36a42c adopts a physical private dependency directory from the runtime-owned
candidate checkout by moving it into the newly reserved verification dependencies
resource. The existing candidate-lock installer, resolver link, resource identity,
check and cleanup paths then apply. Shared directory links and external package
links remain rejected. No original checkout, source quarantine or old receipt is
cleared. Rename avoids copying a second dependency tree; cross-device relocation
failure remains explicit rather than sharing an external resource.

Validation:

- Before fix, frozen candidate startup/install reproduced the exact native hold.
  -30coupled tests/355assertions passed16.92s, including actual Bun imports/private
  SQLite/profile writes, unsafe links, cancellation/reopen and retained acceptance.
- Formatting/lint/typecheck/diff passed.
- Real native-created LAZERS checkout was exercised at exacte36a42c. Its already
  installed dependency directory moved into the private context with the same
  physical identity. Actual `bun check` passed384files; canonical dependency
  directory stayed untouched. Context and candidate alias were removed afterward.
- Disposable diagnostic state was removed; receipt retained separately. This probe
  verifies native setup compatibility, not task156 acceptance or the full138 gate.

Private diagnostics: `/private/tmp/lz-native-host-deps-probe.log`,
`/private/tmp/lz-native-host-deps-probe-receipt.json`,
`/private/tmp/lz-native-host-deps-coupled-tests.log`.
Root integratede36a42c while implementation workers were idle, then directed
Architect through Desktop to use a justified native retry/new generation on
original156 ff55/b011, preserving failed setup history and zero model prompts.
Actual156 qualification, normal reconciliation and157→158 dispatch remain pending.

## Compiled-host installer correction

Real generation2 reached the installer but held before checks. `process.execPath`
in OpenCode's bundled service is opencode-cli, which has no install subcommand;
stdout/stderr were discarded by the old setup runner. This was not evidence of a
bad committed lockfile. Root reproduced the exact failure with an actual compiled
Bun executable, then fixed installation to resolve standalone Bun from the check
PATH (63d5001). The compiled fixture now passes.

Final coupled31tests/375assertions passed17.48s with quality checks. An initial
sandboxed run failed because the newly added native-startup fixture used global
Bun cache;62b0170 moves that fixture cache into disposable state. The failure is
retained in /private/tmp/lz-compiled-host-coupled-tests.log; final results are in
/private/tmp/lz-compiled-host-coupled-tests-final.log. Source is active; Architect
was directed through Desktop to use the supported cancel/new-generation flow on
the same original156 attempt. Generation2 was not claimed as passed.
