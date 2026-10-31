# Explicit retry baseline verification

## Focused regressions

Command:

```sh
bun test src/runner/runtime.test.ts src/runner/artifacts.test.ts test/runner
```

Result: passed — 21 tests, 423 expectations. The focused suite includes
real-Git tests for explicit corrected-baseline selection across runtime reopen,
continuation without a new baseline, retained failed-attempt usage/outcomes, and
artifact-specific verification. The same run also covers runner process
recovery, artifact scope checks, dependencies, and cancellation/resume.

## Full suite and quality

Full-suite command:

```sh
bun test
```

Result: passed — 145 tests across 35 files, 1,281 expectations.

Quality command:

```sh
bun run verify
```

Result: passed — Bun formatter check (201 files), linter (109 files), and
typechecker (104 files).
