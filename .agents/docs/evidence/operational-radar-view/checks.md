# Operational Radar map verification

Automated checks for the LZ-34 operational Radar implementation, run in the
assigned worktree on 2026-11-01.

| Check                                                   | Result                                                                                                         |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `bun test src/radar test/radar test/observation-panels` | Passed: 26 tests, 168 assertions.                                                                              |
| `bun run build:gui`                                     | Passed; generated `dist/gui-experimental.cjs` and copied the worker adapter to `dist/radar-layout-worker.cjs`. |
| `bun test`                                              | Passed: 431 tests, 4,009 assertions.                                                                           |
| `bun run verify`                                        | Passed: all 431 files formatted, 217 files linted, 208 files typechecked.                                      |
| `git diff --check`                                      | Passed.                                                                                                        |

The focused suite executes the pinned elkjs layout through the packaged
worker-thread adapter and checks that layout returns grouped node/edge geometry
with a worker thread ID, repeated geometry reuses its result, obsolete scope
results are rejected, and an aborted request does not publish stale geometry.
Map tests cover scoped operational records, stable measured geometry under
status/activity updates, selected-record identity and visual scroll preservation,
recomputation keys for topology/font/scope changes, and quiet activity baselines
across startup and reconnect.

The GUI build emitted the existing Vite `inlineDynamicImports` deprecation and
`onnxruntime-web` CommonJS `import.meta` warnings; the build completed
successfully. Those warnings did not prevent the Radar worker adapter from being
copied beside the GUI bundle.
