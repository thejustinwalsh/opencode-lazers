# Semantic analyzer WASM feasibility

Measured 2026-11-28. This is research supporting [task code review](task-code-review.md), not a claim that these analyzers are integrated or packaged in LAZERS.

## Active implementation

Architect admitted plan `f028d426-873e-4708-a852-6ea1a8fd2fdf` on `25cb6e52`:

| Task   | Deliverable                                                                                                                       | Initial attempt                        |
| ------ | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| LZ-277 | Pinned Difftastic 0.71.0 WASM content comparison, Oaink-compatible alignment/tokens/comments, worker lifecycle and fixture parity | `f9b6f622-2924-4dae-a0b2-0a78e04e020d` |
| LZ-278 | Task/Attempt/Since review/Live/Plan comparisons, complete side inventories and paged pinned source reads                          | `8dd4c9e1-ad4e-4521-8203-fff79b722ccc` |

Both initial workers use `openai/gpt-6-luna`, variant `max`, in separate native worktrees under the canonical project's `.worktrees` sibling. The requested project delegated-agent limit is three. During dispatch, the runtime admitted five workers because path and remote project identities used separate capacity pools; see the observation below. Read the task runtime for their current state; this document does not mirror worker status.

Difftastic remains required for the first usable Review surface. Its port is independent of the three feasibility probes below. The external Opus UI lane follows the concrete structural/comparison contracts; no duplicate Luna UI implementation was dispatched.

## Sources and method

Pinned source checkouts:

| Analyzer | Version | Source commit                              |
| -------- | ------- | ------------------------------------------ |
| cccc     | 1.7.0   | `2bbed87685f5d9ad8c6eb6d3173904785236b199` |
| jscpd    | 5.4.0   | `b6f832c62cf02b574ea9cf24e013cfeb17366a35` |
| Gitleaks | 8.30.1  | `83d9cd684c87d95d656c1458ef04895a7f1cbd8e` |

Rust `1.99.0` has `wasm32-wasip1` installed. The Go compiler is `go1.26.1 darwin/arm64`. Native compiler/oracle tools are development dependencies; the proposed plugin runtime receives WASM assets and bundled JavaScript workers, not analyzer executables.

Thin stdin/JSON probes were built in an owned temporary research directory. Native and WASM probes call the same upstream detector entry points. They do not implement substitute algorithms. The WASM runs use LAZERS' actual `runFallowModule()` buffered WASI host from `src/audit/fallow-wasi.ts`.

A first direct Bun `new WASI({stdin,stdout,...})` harness returned EOF from the module's stdin. Reusing LAZERS' buffered host resolved it. That first result was a harness failure, not a detector failure. The production host also clears completed WASI bindings through `settleFallowRun()`.

## cccc: executed with matching native output

`cargo check --locked --target wasm32-wasip1 -p cccc-es -p cccc-rs` passed on the pinned source without analyzer patches.

`cccc_es::analyze_source(path, source)` and `cccc_rs::analyze_source(path, source)` already accept supplied source. The thin entry point dispatches to those functions and serializes their `FileReport`. It avoids `cccc-cli` directory walking, caching, terminal output and outer Rayon orchestration.

Oaink fixture: `fixtures/prs/complexity-increased/{base,head}/src/shipping.ts`.

| Side | Cognitive | Cyclomatic | Native/WASM complete JSON |
| ---- | --------- | ---------- | ------------------------- |
| Base | 2         | 3          | Equal                     |
| Head | 20        | 13         | Equal                     |

Oaink's `rust-trait-impl/{base,head}/src/lib.rs` also executes with complete native/WASM JSON equality: cognitive/cyclomatic 0/1 at base and 1/2 at head, one function on each side.

A subsequent `cargo check --locked --target wasm32-wasip1 --workspace --exclude cccc-cli --lib` passed for every language/core crate with official WASI SDK 34 C tooling (30.43 seconds). Plain Apple Clang first failed because its WASI target had no `stdio.h`; the SDK clang/sysroot resolved that build failure without grammar patches. This full compile check does not establish all-language execution parity.

Scope: TypeScript and Rust execution and full report parity for these fixtures. This is not the full multi-language port or all-language parity. The production increment must cover the languages Oaink's complexity provider exposes and retain parse-error reporting.

## jscpd: executed with matching native output

`cargo check --locked --target wasm32-wasip1 -p cpd-core -p cpd-tokenizer` passed without detector patches.

The probe uses `cpd_tokenizer::tokenizer::tokenize(..., Mode::Mild)` and `cpd_core::detect::detect_with_options(..., 50, 5, ...)`. It passes supplied file contents instead of using `cpd-finder` file walking or memory mapping.

Oaink fixture: `fixtures/prs/duplicate-introduced/head/src/*.ts`.

Native and WASM complete JSON are equal: one `exact` clone, 179 tokens, between `src/invoice.ts` and `src/receipt.ts`. The existing `into_par_iter()` detection path executes successfully in this single-thread WASI build; compile-time Rayon presence alone was not evidence that a threading patch was necessary.

Scope: mild token-based detection for this fixture. Strict/weak, renamed/literal normalization, gapped, AST similarity and cross-format detector parity remain implementation work. Oaink does not enable jscpd's model-backed `--semantic` mode; do not add a model download while porting its current provider.

## Gitleaks: executed after one platform build fix

The detector-only entry uses `detect.NewDetectorDefaultConfig()` and `Detector.DetectContext()` with supplied `Fragment` contents. It emits only rule IDs and line locations; no matched secret or source text appears in its output.

The first `GOOS=wasip1 GOARCH=wasm CGO_ENABLED=0 go build` failed in `github.com/muesli/termenv@v0.15.1`: `foregroundColor`, `backgroundColor` and `ColorProfile` were absent for this target. The existing `termenv_other.go` implementation is selected for `js || plan9 || aix`. Adding `wasip1` to that file's build conditions in an owned local module copy made the WASM build pass. No detector or regex algorithm was replaced.

Gitleaks defaults to the standard-library regex implementation in `regexp/stdlib_regex.go`; `go-re2` is selected with `gore2regex`. Its pinned `.goreleaser.yml` uses that tag for published executables. Both target configurations were built and exercised, rather than assuming the standard-library run was equivalent to the release.

Set `Fragment.StartLine = 1` for a full supplied file. Leaving it at zero shifts every finding one line upward. The detector adds this origin in `detect/detect.go`; its file source initializes it in `sources/file.go`.

Native/WASM rule-and-line outputs match across 15 file comparisons from six existing Oaink scenarios:

- `secret-added`, `secret-same-ends`, `secret-in-new-file`;
- `secret-rotated`, `secret-moved-in-file`, `secret-moved-with-wide-characters`.

For `secret-added`, both report `aws-access-token` at `src/config.ts:2` and `github-pat` at `src/client.ts:4`, matching those vectors' expected locations. All values are the existing fake test secrets.

The standard-library WASM probe also matches the native `gore2regex` detector on 33 file comparisons across 13 source-change scenarios. The extended set adds moves between files, copies, untouched lines, removals, renames, CRLF and a clean change; configuration/allowlist scenarios remain outside this detector-only probe. A WASM build with `gore2regex` itself executes successfully and matches the same-tag native build on all four file comparisons in `secret-added`. Both regex routes are executable, but their measured costs differ substantially.

One cold detector call on the same `secret-added` config file produced:

| WASM regex configuration | Execution time | Exported linear memory at return |
| ------------------------ | -------------- | -------------------------------- |
| Standard library         | 192 ms         | 64.5 MiB                         |
| `gore2regex`             | 19,321 ms      | 1,226 MiB                        |

These are one-run observations in development builds, not statistical benchmarks or process/GPU RSS. The Go RE2 route embeds its WASM regex runtime inside the outer WASM execution. Prefer the standard-library WASM route and compare its results against the native release-regex oracle across the provider fixtures; do not import the nested runtime merely because the native release uses it.

Oaink `scanFiles()` exposes whole-line UTF-16 ranges: indentation to the last line's length. Its `matchedText()` separately interprets Gitleaks' 1-based UTF-8 byte columns, including the extra newline offset after line one, for stable finding identity. Preserve both operations; raw detector columns are not viewer columns. `introducedMatches()` consumes base counts across unchanged lines before changed lines, so moving a secret does not report a new secret.

Scope: these detector rule/line comparisons, not exhaustive regex equivalence. Project configuration, allowlists, inline allow markers, columns, introduced-versus-existing classification and the complete Oaink provider contract still need production integration tests. Raw findings contain secrets inside the detector; redact/project before any host output or database write.

## Implementation order and reuse

Keep LZ-277/LZ-278 running independently. The probes support coherent following increments for the cccc complexity provider, jscpd duplication provider and Gitleaks secret provider. Each should package a pinned WASM entry, execute it in an OpenCode-owned worker, adapt its real findings to the comparison identity, and include native/WASM parity for its existing provider fixtures.

Keep existing Fallow findings authoritative for their audit. `buildPackage()` in `src/audit/audit-findings.ts` already projects complexity, duplication, dead-code and diff-risk findings into `FallowPackage`. cccc/jscpd comparison facts retain their own analyzer provenance; do not create a second Fallow audit or silently substitute one analyzer's measures for another. The three pinned analyzer roots use MIT licenses; retain their notices and review bundled dependency notices when packaging.

Reuse the buffered I/O, read-only filesystem and completed-run memory handling already present in LAZERS. Extract shared host pieces when the actual integrations need them; do not clone the entire Fallow host or build another daemon. Runtime source should come from LZ-278's pinned side inventory, including unchanged files and config/ignore inputs. Oaink provider code is reference for the comparison rules, not a reason to reintroduce native tool downloads.

The observed probe binaries are unoptimized development outputs, not release artifacts or package-size measurements. Production builds still need release optimization, bundled asset/worker checks, cancellation and repeated-run memory checks. Analyzer failure remains local to its review result; it must not hold task scheduling or integration.

## Dispatch observation

The follow-up provider plan is `11bfefe3-4fcc-42f0-9d84-14c39cfde460`: LZ-279 cccc, LZ-280 jscpd and LZ-281 Gitleaks. Initial workers use the same OpenAI Luna Max route as the two foundation tasks. This lists task identity, not completion.

Read-only runtime inspection found all five attempts running. `lazers_settings` stores `limit=3` under `github.com/thejustinwalsh/opencode-lazers`, while active admissions split between that key and `path:/Users/tjw/Documents/ChatGPT/opencode-lazers`. `lazers_project_paths` already maps the directory to the remote key. `DelegatedAgentCapacity` cached the independently resolved key and read only that pool's settings/counts. Commit `b817a810` uses the registered identity for capacity and reconciles active/queued admissions without changing request IDs, queue order or workers. `bun run verify` and 38 capacity/dispatch behavior tests passed. After the regular location reload, read-only inspection showed all five active attempts under the registered remote key and the plugin reported active. Existing work remains intact when its count exceeds the configured limit. Some in-flight native tools reported location-shutdown cancellation during reload; the same sessions continued, and Architect received that cause rather than treating those cancellations as independent implementation failures.

## Local observations

The owned research directory is `/private/tmp/lz-semantic-ports-9gBHyU`. It contains the pinned sources, thin entry points, Cargo/build logs, native/WASM JSON outputs, and `gitleaks-parity.json`. It is not a runner worktree or a product dependency. Once the relevant agents copy the useful source/patch information into their native worktrees and commit portable build scripts, remove these temporary build outputs.
