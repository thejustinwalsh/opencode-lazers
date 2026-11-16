# Auditor tools for restricted OpenCode installs

Use the existing Auditor role and audit history. Ship the analyzer as a
WebAssembly module inside the OpenCode service. Vendor or fork Fallow if an
upstream release does not support the required analyses. Distribute only the
WebAssembly Fallow build. The project test runner executes the checks.

## What ships today

The published [v0.1.0 archive](https://github.com/thejustinwalsh/opencode-lazers/releases/tag/v0.1.0)
contains no native executables, native libraries, or WebAssembly modules. A
clean macOS arm64 install with `bun add --ignore-scripts` installs 19
WebAssembly modules for Repomix and Tree-sitter, plus these Mach-O files:

| File under `node_modules`                                            | Role                                                                                                                     |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `@fallow-cli/fallow-node-darwin-arm64/fallow-node.darwin-arm64.node` | Loaded by `src/audit/report.ts` for static analysis.                                                                     |
| `@fallow-cli/fallow-similar-code-darwin-arm64/fallow-similar-code`   | Optional similar-code companion. The audit report does not start it.                                                     |
| `@typescript/typescript-darwin-arm64/lib/tsc`                        | Native compiler from the optional `fallow-type-aware` dependency. The audit report does not request type-aware analysis. |

Build-only Vite dependencies do not appear in this consumer install. Scope the
inventory to macOS arm64. Repeat it on each release target that needs the same
policy; the consumer resolves transitive dependencies at install time.

The current `lz-fallow-report` does not run project tests or mutations.
`lz-import-audit` imports report sections into the same history.
`lz-get-audit` reads report sections and findings after worktree cleanup.
The plugin does not use audit scores to accept tasks.

## What to use in code review

| Question                                                                   | Current scan or proposed check                                                            |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Did the change add hard-to-follow code or CSS drift?                       | `computeHealth` in the `health` section.                                                  |
| Did it copy code or test setup?                                            | `detectDuplication` in the `duplication` section. Check whether repetition is deliberate. |
| Did it leave unused exports or dependencies?                               | `detectDeadCode` in the `deadCode` section. Check runtime entry points and consumers.     |
| Did it add a cycle or cross a boundary?                                    | `detectArchitecture` in the `architecture` section.                                       |
| Did it leave an obsolete feature flag?                                     | `detectFeatureFlags` in the `featureFlags` section.                                       |
| Can a test detect wrong behavior? Does another test cover the same faults? | Scoped mutation outcomes and a targeted kill matrix. These need actual test execution.    |

Have reviewers read the task's existing audit run first with `lz-get-audit`.
Match findings to changed files and check behavior before reporting a defect.
Reuse a matching report before scanning again. Record the path, observed
problem, and proposed correction. Report relevant inherited problems separately
from regressions. Use Auditor when the fix needs a broader refactor. Keep
review and scores independent of dispatch and acceptance.

## Type checking

`go version -m` identifies the installed `tsc` as
`github.com/microsoft/typescript-go/cmd/tsgo`, built with Go 1.26.4.
Remove the optional dependency chain in the analyzer port. The five current
scans do not need a TypeScript checker.

If we add semantic checks, qualify Oxc's
[`@ts-rs/wasm`](https://github.com/oxc-project/tsrs/blob/main/docs/STATUS.md)
first. I ran `0.15.0-ts7.1.0-dev.20260929` in Bun with in-memory files.
`tsc` accepted a valid assignment and returned `TS2322` for a string assigned
to a number. The package declares no native dependencies. Its Bun entry
runs on the calling thread, so use a dedicated worker in OpenCode. The
smoke test did not exercise a full TypeScript project.

Diagnostics do not implement [Fallow's semantic protocol](https://github.com/fallow-rs/fallow/blob/main/docs/type-aware-analysis.md).
Before enabling type-aware Fallow rules, prove an in-process adapter can
answer the required symbol queries and preserve unknown results. Compare the
answers with the native backend in development only; keep that backend out of
the distributed plugin.

## Implementation plan

1. **Prove the analyzer port.** Pin the upstream Fallow source. Build a thin
   WebAssembly binding around its analysis library, or adopt an upstream
   binding if it passes the same checks. Run a fixture in the OpenCode service
   on the supported host. Compare the five existing report sections with the
   native analyzer. Verify file scope, cancellation, errors, and no external
   analyzer process. Keep CPU work off the service event loop. Use the smallest
   host interface that supplies the required project files and configuration;
   do not give the module unrestricted filesystem, network, or process access.
   The [upstream Node binding](https://github.com/fallow-rs/fallow/tree/main/crates/napi)
   uses native N-API. The reviewed upstream install channels do not publish a
   WebAssembly analyzer. Do not wrap the CLI as-is: the full CLI has native
   filesystem and process dependencies. Prefer a library binding with explicit
   host inputs over a WASI command with broad filesystem access.
2. **Package the proven analyzer.** Put the built module and license in the
   release archive and replace the native Fallow dependency. Remove the unused
   similar-code and type-aware companion dependency chains. If a future
   requirement needs either companion, implement and qualify it in WebAssembly
   first. Keep the current
   tool names, assignment context, request replay and SQLite history. In CI,
   inspect the archive and a clean install for executable or library formats,
   including transitive `.node` files. Qualify the installed package on the
   target policy. Do not silently download or load a native fallback.
3. **Add test audit reports.** Let the WebAssembly mutator generate instrumented
   source. Give it a small host API for reading and writing files within a
   disposable audit worktree. Run the project's configured test command through
   existing verification against that worktree. Check a passing baseline before
   attributing failures to mutants. Preserve setup, configuration, and mocks
   from the project. Restore instrumented files between trials and clean up the
   worktree after success, failure, or cancellation. Record completed and
   incomplete trials in the audit history. Qualify the flow on an existing
   project suite before advertising support.

[Fallow mutation](https://fallow.tools/docs/cli/mutation/) runs project tests
against changes to source. Upstream supports Vitest, the Node test runner, and
Bun by starting their native runtimes. Its kill matrix can identify candidates
for redundant tests. [Fallow health](https://fallow.tools/docs/cli/health/) can consume saved
coverage and mutation reports. Confirm the selected build supports the runner
and report format before exposing those options in LAZERS.

The [Fallow mutation crate](https://docs.rs/fallow-mutation/latest/fallow_mutation/)
can generate and instrument mutations from source without I/O. Use it to
generate mutations for the worktree host API. Keep static
test reach, measured coverage, and mutation results separately labeled. A
failed baseline cannot establish a mutation score.

### Prototype results

- `cargo check --locked -p fallow-mutation --target wasm32-unknown-unknown`
  passes at Fallow `v3.41.0` and Rust 1.99. A small Rust binding calls
  `fallow_mutation::instrument` and returns the instrumented source and mutant
  list. The resulting module declares zero WebAssembly imports.
- The same target fails for the static analysis crate group. Cargo traces the
  first error through `fallow-config → ureq → rustls → ring → getrandom`.
  Disabling remote config transport in a scratch copy exposed a second path:
  `fallow-extract → lightningcss → getrandom`. Keep CSS analysis. Qualify its
  entropy backend in the WebAssembly binding before testing static reports.
- With JavaScript entropy enabled and the existing 64-bit cache layout
  assertions scoped to 64-bit targets, `fallow-extract`, `fallow-graph`, and
  `fallow-core` passed `cargo check` for `wasm32-unknown-unknown`. The full
  `fallow-engine` still fails in platform-specific Git path conversion,
  churn-cache path handling, file URLs, and dependency symlinks. Use explicit
  host inputs for those operations.
- A temporary binding built with `wasm-bindgen 0.2.130` ran
  `fallow_extract::parse_from_content` and `compute_css_analytics` in Bun.
  The TypeScript fixture returned one import, one export, and zero parse
  errors. The CSS fixture returned one rule and two declarations. These
  in-memory calls establish extraction. The five project-wide report
  sections still need a host adapter and parity checks.
- Bun ran the instrumented output with a fresh Worker per mutant. A test
  asserted that the boundary value 10 qualifies. The run found eight mutants:
  two killed by the assertion, two survived, and four in a function the test
  did not call. This proves a small custom fixture. It does not qualify the
  existing project test suite.
- A disposable copy of `src/panel-error.ts` and its existing test proved
  disk-based instrumentation. The original and instrumented baselines each
  passed both tests using `bun test`. A preload activated Fallow's
  return-value mutant, and the same two assertions failed on the mutated
  return value. The production integration still needs to run this flow
  through the verification service in an audit worktree.
  Project verification uses the configured host commands. The WebAssembly Fallow
  package supplies analysis and mutations. The existing verification path runs
  the project's tests and collects their results.
