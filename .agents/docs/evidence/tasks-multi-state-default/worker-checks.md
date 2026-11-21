# LZ-216 implementation checks

## Automated evidence

- `bun run verify` — passed (formatter, auto-fixing lint, and TypeScript checks).
- `bun test --timeout 120000 src/tasks src/storage.test.ts src/observability/task-reads.test.ts test/task-panel test/observation-panels/tasks-activity.test.ts test/observation-panels/tasks-scheduling.test.ts` — 176 passed.
- `bun test --timeout 120000 test/observation-panels/tasks-virtual.test.ts` — 27 passed, including immediate toggles, project-wide persistence on reopen/session change, stale reply fencing, and multi-page union coverage.
- The four required pagination-isolation files passed separately after parenthesizing the state-set SQL union; each was supervised by an independent process-group wall-clock watchdog.
- `bun run build:gui` and `git diff --check` — passed.
- `bun fmt --check src scripts test website/src` and `bun lint src scripts test website/src` — passed.

## Not established by these checks

- Candidate-bound Desktop narrow/wide interaction, reload, screenshots, and action receipts have not been collected. Fixture tests are not native evidence; coordinate those observations after source integration.
- The repository-wide `bun test --timeout 120000` run was stopped by an external 600-second process-group watchdog without a summary. `src/runner/runtime.test.ts` also did not finish under a separate 90-second watchdog; no runner files are part of this change.
- Website type-check dependencies are absent (`website/package.json` dependencies are not installed). The Rust verification commands reference the absent `crates/fallow-wasm/Cargo.toml`.
- `lz-fallow-audit` is unavailable until the Architect provides a project Fallow config; no repository config exists.
