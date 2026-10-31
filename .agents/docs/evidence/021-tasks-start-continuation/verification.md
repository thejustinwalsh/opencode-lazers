# Tasks Start and continuation verification

## Focused regressions

```sh
bun test src/tasks src/runner src/architect.test.ts test/task-panel test/runner
```

Passed: 47 tests, 657 expectations.

## GUI build

```sh
bun run build:gui
```

Passed. The build emitted the existing Vite `inlineDynamicImports` deprecation
warning and `EMPTY_IMPORT_META` warnings from `onnxruntime-web`'s CommonJS
bundle; no build errors occurred.

## Full suite

```sh
bun test
```

Passed: 156 tests across 36 files, 1,390 expectations.

## Quality

```sh
bun run verify
```

Passed: Bun formatter (206 files), linter (111 files), and typechecker (106
files).

## Native Desktop / Terra

Not verified in this environment. See
[`native.md`](./native.md) for the exact missing observations; the available
screenshots are pre-change references only.
