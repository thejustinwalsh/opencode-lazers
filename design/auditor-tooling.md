# Auditor tools for restricted OpenCode installs

Use the existing Auditor role and audit history. Replace the platform Fallow
add-on with a WebAssembly build if the build can produce the required reports
inside the OpenCode service. Keep mutation execution separate from static
analysis. A WebAssembly module does not supply a Bun, Node, or Vitest runner.

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
   release archive and replace the native Fallow dependency. Keep the current
   tool names, assignment context, request replay and SQLite history. In CI,
   inspect the archive and a clean install for executable or library formats,
   including transitive `.node` files. Qualify the installed package on the
   target policy. Do not silently download or load a native fallback.
3. **Add test audit reports.** Use the project test runner where device policy
   permits it. Capture a passing baseline, scoped coverage, and selected
   mutation outcomes. Store them with the task and attempt through the existing
   report history. Import reports from approved CI when the device cannot run
   the test runner. Report the difference between an untested path, a surviving
   mutant, and a run that did not execute. Review duplicate test candidates
   against actual assertions, fixtures, and distinct behavior before removing
   a test. Do not add a score threshold to task acceptance.

[Fallow mutation](https://fallow.tools/docs/cli/mutation/) runs project tests
against changes to source. Its kill matrix can identify candidates for redundant
tests. [Fallow health](https://fallow.tools/docs/cli/health/) can consume saved
coverage and mutation reports. Confirm the selected build supports the runner
and report format before exposing those options in LAZERS.

The [Fallow mutation crate](https://docs.rs/fallow-mutation/latest/fallow_mutation/)
can generate and instrument mutations from source without I/O. A WebAssembly
build of that crate would still need a host test runner to get kill results.
Test that port only if approved runner integration or CI import cannot meet
the need. Keep static test reach, measured coverage, and mutation results
separately labeled. A failed baseline cannot establish a mutation score.

Review OpenCode's host commands separately from dependency packaging.
`src/runner/artifacts.ts` uses Git and runs configured checks through a shell.
`src/runner/retained-verification/isolation.ts` uses Bun to install candidate
dependencies. `src/verification/opencode/owned-launch.ts` launches OpenCode for
isolated product verification. The analyzer change cannot make an unapproved
host executable available.
