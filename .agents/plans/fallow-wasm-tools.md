# Fallow as in-process WebAssembly tools

Status: plan only. Nothing here is implemented. Line numbers are as read on
2026-11-19 and will drift; function names are the stable reference.

## Problem

Fallow reaches LAZERS today as a 27 MB native N-API addon that one
model-initiated tool loads. Nothing deterministic runs it. A worker can finish
a task that adds a 200-token clone or a function with cognitive complexity 40,
and the runtime accepts it when the authored checks pass.

Three changes fix that:

1. Build Fallow's analysis to WebAssembly from vendored source and run it in a
   worker thread of the service. No native addon, no analyzer process.
2. Run duplication and complexity as a runtime verification check when a worker
   finishes. A failure returns specific fix guidance through the existing
   repair path.
3. Give agents a small set of bounded tools for exploration, where a
   deterministic check cannot decide.

## Findings: the earlier spike

The spike is recorded in `design/auditor-tooling.md` ("Prototype results"),
commits `f3e11818`, `e40b3dfd`, `aa4bdd0f`, `d3095c6b` (2026-11-16). The
binding source was temporary and is not in the repository.

| Claim                                                              | Result                                                                                                                                                               | Source                              |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `fallow-mutation` builds for WASM                                  | `cargo check --locked -p fallow-mutation --target wasm32-unknown-unknown` passes at Fallow `v3.41.0`, Rust 1.99. Module declares zero imports.                       | `design/auditor-tooling.md:118-121` |
| Static analysis crates build as-is                                 | No. First failure `fallow-config → ureq → rustls → ring → getrandom`; second `fallow-extract → lightningcss → getrandom`.                                            | `design/auditor-tooling.md:122-126` |
| `fallow-extract`, `fallow-graph`, `fallow-core` build with patches | Yes, with JavaScript entropy enabled and the 64-bit cache layout assertions scoped to 64-bit targets.                                                                | `design/auditor-tooling.md:127-129` |
| `fallow-engine` builds                                             | No. Fails in Git path conversion, churn-cache paths, file URLs, dependency symlinks.                                                                                 | `design/auditor-tooling.md:129-132` |
| Extraction runs in Bun                                             | A `wasm-bindgen 0.2.130` binding ran `fallow_extract::parse_from_content` (1 import, 1 export, 0 parse errors) and `compute_css_analytics` (1 rule, 2 declarations). | `design/auditor-tooling.md:133-138` |
| Mutation runs in Bun                                               | Fresh Worker per mutant: 8 mutants, 2 killed, 2 survived, 4 uncovered. Disk flow proved on a copy of `src/panel-error.ts` with `bun test`.                           | `design/auditor-tooling.md:139-152` |

What the spike did not establish:

- **Project-wide reports in WASM.** "The five project-wide report sections
  still need a host adapter and parity checks" (`design/auditor-tooling.md:137-138`).
- **Duplication in WASM.** The clone detector is in the crate that does not
  build: `crates/engine/src/duplication_detector/` (`detect/suffix_array.rs`,
  `token_visitor.rs`, `token_types.rs`) and `crates/engine/src/duplicates.rs`
  at `v3.41.0`. Complexity is in `crates/extract/src/complexity.rs`, which
  does build. So the complexity half of the gate is proven feasible; the
  duplication half is the first risk to retire (Phase 1).
- **Bundle size, cold start, memory, how the module loads from `dist/`.** Not
  recorded anywhere.
- **Toolchain.** The notes say Rust 1.99. This machine has `rustc 1.98.1` with
  the `wasm32-unknown-unknown` target and `wasm-opt`; `wasm-bindgen` and
  `wasm-pack` are not installed. Fallow's root `Cargo.toml` at `v3.41.0`
  declares `rust-version = "1.97"`, edition 2024.

## Findings: the product today

| Fact                                                                                                                                                                                | Source                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Fallow is `@fallow-cli/fallow-node` 3.41.0, a native addon loaded in the service process. No separate process, but a 27 MB Mach-O plus an 8.6 MB similar-code binary install.       | `package.json:45`; `src/audit/report.ts:36`; `du` of `node_modules/@fallow-cli/*`    |
| One scan path: `fallowReport()` runs `detectDeadCode`, `detectDuplication`, `computeHealth({css:true})`, `detectArchitecture`, `detectFeatureFlags` sequentially on the whole root. | `src/audit/report.ts:37-44`                                                          |
| It runs only when a model calls `lz-fallow-report`. Five tools: `lz-fallow-report`, `lz-query-audits`, `lz-get-audit`, `lz-record-audit-finding`, `lz-import-audit`.                | `src/audit/tools.ts`                                                                 |
| The Auditor prompt says "Start with `lz-fallow-report` when available".                                                                                                             | `src/auditor.md:1-2`                                                                 |
| The contract says Fallow does not gate: "Fallow reports inform review; they do not gate task completion".                                                                           | `docs/reference/contributor-contracts.md:53`; `design/auditor.md:5-7`                |
| Verification is `TaskRuntime.verify()`: for each authored `proposal.verification` check it journals a `verify:<id>` effect and runs the shell command in the attempt workspace.     | `src/runner/runtime.ts:9660`, `:9888-9930`; `runCheck` `src/runner/artifacts.ts:812` |
| A failed check calls `failAttempt()`: task `verifying → REPAIR → ready` once (`maxRepairAttempts ?? 1`), otherwise `FAIL` plus a hold advertising `audit`, `reconcile`, `cancel`.   | `src/runner/runtime.ts:9942-9954`, `:10041-10069`; `src/runner/machine.ts:36-47`     |
| The repair attempt's dispatch text carries `previousAttempt: { id, evidence }`.                                                                                                     | `src/runner/runtime.ts:8208-8215`                                                    |
| `verify:`, `graph-verify:` and `mechanical-fix` effects are re-runnable: no receipt means superseded and re-run.                                                                    | `src/runner/runtime.ts:413`; `design/runtime-state-machines.md:210-217`              |
| A receipt reaches the Trajectory checks lane through `recordVerification()` as `{ checkID, result, exitCode }`.                                                                     | `src/progress/recorder.ts:2820-2866`                                                 |
| A failed combined check holds the plan: "Combined artifact verification failed".                                                                                                    | `TaskRuntime.finish()`, `src/runner/runtime.ts` near `:10300`                        |
| Worker threads: four, each listed in `scripts/build-server.ts` and spawned through `workerURL`.                                                                                     | `scripts/build-server.ts:13-19`; `src/worker-url.ts`                                 |

## Findings: Fallow on LAZERS itself

Native `@fallow-cli/fallow-node` 3.41.0, four threads, on `main` at
`185b4017`, 2026-11-19. Dead code, duplication, health and architecture took
2.6 s in total (0.86 s, 0.15 s, 1.27 s, 0.31 s).

| Measure                           | No config | With `.fallowrc.json` entry points                   |
| --------------------------------- | --------- | ---------------------------------------------------- |
| Unused files                      | 19        | 1                                                    |
| Unused exports                    | 237       | 237                                                  |
| Unused types                      | 81        | 81                                                   |
| Unused class members              | 50        | 50 (33 in `src/runner/store.ts`)                     |
| Import cycles                     | 1         | 1 (`src/storage.ts` ↔ `src/tasks/classification.ts`) |
| Functions over a complexity limit | 736       | 735 (72 in tests)                                    |
| Clone groups                      | 185       | 185 (2.6% of lines; 18 test-only)                    |
| Health score                      | 77.8, B   | not re-read                                          |

Worst functions: an arrow function at `src/runner/runtime.ts:3791` (1,267
lines, cognitive 381), `radar` at `src/observability/read.ts:714` (1,048
lines, cognitive 360), `readRadar` at `src/observability/live-read.ts:806`
(cognitive 304).

What this changes in the plan:

- **A project needs entry points before a dead-code check means anything.**
  18 of 19 "unused files" were worker scripts, fixtures and CLIs loaded by
  path (`workerURL`, spawned tests). The config is on branch
  `chore/fallow-self-cleanup`. The dead-code gate (Phase 4) must not run on a
  project with no Fallow config; it reports instead.
- **Introduced-only is not optional.** With 735 inherited complexity findings
  a gate on all findings would fail every task.
- **The budget for the changed-file check is realistic.** The whole repository
  takes 1.3 s for health natively with threads; the gate analyses changed
  files only.
- **Clean up first.** A dead-code pass over this repository runs before
  Phase 0, so parity tests compare against a tree we understand. It is tracked
  on `chore/fallow-self-cleanup`, by lane, not in this plan.

## Research: Fallow

Sources: the Fallow docs (`fallow.tools/docs`), the source at tag `v3.41.0`
(`github.com/fallow-rs/fallow`, tag object `bcacc6f5`), the installed typings
(`node_modules/@fallow-cli/fallow-node/types/index.d.ts`), and the agent plugin
at `github.com/fallow-rs/fallow-skills` commit `be9f4268`.

The docs pages were read through a summarising fetch. Flag spellings below
should be re-checked against the page before any are wired into code.
Typings, source paths and plugin files were read directly.

### Commands

| Command                                        | What it reports                                                                                                 | Gate semantics                                                                                                  | Source                               |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `dead-code`                                    | Unused files, exports, types, dependencies, members; unresolved and unlisted imports; duplicate exports         | Exit 1 on an error-severity finding                                                                             | `fallow.tools/docs/cli/dead-code`    |
| `dupes`                                        | Clone groups. Modes `strict`, `mild` (default), `weak`, `semantic`. Defaults: 50 tokens, 5 lines, 2 occurrences | Exit 0 even with clones unless `--fail-on-issues` or `--threshold N` (percent; config default 0 = off)          | `fallow.tools/docs/cli/dupes`        |
| `health`                                       | Per-function cyclomatic and cognitive complexity, CRAP, file scores, hotspots, targets, a 0-100 score           | Exit 1 on an error-level complexity finding. Defaults: cyclomatic 20, cognitive 15, CRAP 30, file lines off     | `fallow.tools/docs/cli/health`       |
| `audit`                                        | Dead code, complexity and duplication on changed files, each finding marked introduced or inherited             | Verdict `pass`/`warn` exit 0, `fail` exit 1, error exit 2. `--gate new-only` (default) fails only on introduced | `fallow.tools/docs/cli/audit`        |
| `architecture`                                 | Import cycles, boundary violations, policy violations                                                           | Exit 1 on an error finding                                                                                      | `fallow.tools/docs/cli/architecture` |
| `flags`                                        | Feature-flag patterns                                                                                           | Exit 0 unless `--max-flag-age` is exceeded                                                                      | `fallow.tools/docs/cli/flags`        |
| `fix`                                          | Edits files: removes unused `export` keywords, dependencies, enum members                                       | `--dry-run` first                                                                                               | `fallow.tools/docs/cli/fix`          |
| `mutation`                                     | Mutants that no test kills. Runs the project tests                                                              | Opt-in; exit 1 below `--min-score`                                                                              | `fallow.tools/docs/cli/mutation`     |
| `similar-code`                                 | Semantically similar functions through a local model                                                            | Discovery only                                                                                                  | `fallow.tools/docs/cli/similar-code` |
| `guard`, `inspect`, `trace`, `explain`, `list` | Context for one file, export or finding                                                                         | Read-only                                                                                                       | `fallow.tools/docs/cli/`             |

How `audit` attributes a finding (same page): dead code is keyed without line
numbers; complexity matches by path and function name as introduced, worsened
or inherited; a clone group is inherited when no instance overlaps added
lines. `--worsened` defaults to `warn`.

Config files: `.fallowrc.json`, `.fallowrc.jsonc`, `fallow.toml`,
`.fallow.toml`. Threshold keys: `health.maxCyclomatic` (20),
`health.maxCognitive` (15), `health.maxCrap` (30), `duplicates.minTokens` (50),
`duplicates.minLines` (5), `duplicates.mode` (`mild`), `duplicates.threshold`
(0). Suppressions: `// fallow-ignore-next-line <type> -- <reason>` and
`// fallow-ignore-file <type>`. Source: `fallow.tools/docs/configuration/overview`,
`.../configuration/suppression`.

Performance: the docs publish no benchmark. The only measured number we hold
is ours: the native five-section scan of this repository took 4.866 s
(`design/auditor.md`, "Native observation").

### Library surface

The Node binding exports nine async functions and no `audit`, `fix`, `trace`
or `inspect` (`types/index.d.ts:756-764`; `fallow-skills`
`fallow/skills/fallow/references/node-bindings.md`). Report shapes the tools
below draw from:

```ts
// types/index.d.ts:391-408, 621-636 (abridged)
interface CloneInstance {
  file: string
  start_line: number
  end_line: number
  fragment?: string
}
interface CloneGroup {
  instances: CloneInstance[]
  token_count: number
  line_count: number
  spread: number
}
interface HealthFinding {
  path: string
  name: string
  line: number
  cyclomatic: number
  cognitive: number
  line_count: number
  exceeded: string
  severity: string
}
```

Crate chain at `v3.41.0`: `napi → api → engine → core → {extract, graph,
config, types}`. What a WASM host must replace:

| Native dependency                                    | Where                                                                    | Replacement                                         |
| ---------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------- |
| File discovery, `ignore::WalkBuilder`                | `crates/core/src/discover/walk.rs`                                       | Host passes the file list                           |
| `std::fs` reads                                      | `crates/core/src/discover/*`, `crates/engine/src/vital_signs.rs`         | Host passes file contents                           |
| `git` subprocess for changed files, churn, hotspots  | `crates/engine/src/git_env.rs:44`, `changed_files.rs`, `churn.rs`        | Host passes the changed set; no hotspots in WASM v1 |
| Remote config over HTTPS (`ureq`, not feature-gated) | `crates/config/Cargo.toml:37`; `crates/config/src/config/parsing.rs:433` | Patch out; a remote `extends` is an error           |
| `rayon` thread pools                                 | core, engine, graph                                                      | Single-threaded in the worker                       |
| Entropy for `lightningcss`                           | root `Cargo.toml:44-47`                                                  | JavaScript entropy backend (spike)                  |

Upstream ships no WASM build of the analyzer; `wasm32-wasip2` appears only for
its Zed extension (`.github/workflows/ci.yml:1552-1556`). Licence: MIT at the
workspace root and every crate (`LICENSE`, `Cargo.toml:9`). Two parts are
outside it: `crates/license` gates paid runtime coverage, and the `fallow-cov`
sidecar is not in the repository. Neither is in scope. Release cadence: ten
tags between 2026-10-27 and 2026-11-16; latest `v3.43.2`.

### Fallow's own agent plugin

`fallow-skills` `fallow/` is one plugin for Claude Code, Codex and Cursor
(`fallow/.claude-plugin/plugin.json`, version 1.4.154, MIT).

| Surface         | What it does                                                                                                                                                                                                  | Who triggers             | Source                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------- |
| Commit gate     | `PreToolUse` hook on `Bash`. On `git commit` or `git push` it runs `fallow audit --format json --quiet --explain --gate-marker agent`. Verdict `fail` blocks the command and prints the audit JSON to stderr. | Harness, deterministic   | `fallow/hooks/hooks.json`; `fallow/hooks/fallow-gate.sh:4-34`, `:650-651` |
| Gate fail-open  | Missing binary, missing `jq`, an old Fallow or an audit runtime error allows the command with one visible notice.                                                                                             | Harness                  | `fallow-gate.sh:27-32`, `:616-670`                                        |
| `fallow` skill  | 17 agent rules and a task map: trace before deleting, `audit` before commit, `health --hotspots --targets` to prioritise refactoring, `dupes --trace` to consolidate.                                         | Model                    | `fallow/skills/fallow/SKILL.md:44-62`, `:81-106`                          |
| `fallow-review` | The model writes judgments that must cite an id Fallow emitted; Fallow rejects an id it did not emit, and a stale snapshot. "The verifier is the graph, not a second model."                                  | Model, validated by tool | `fallow/skills/fallow-review/SKILL.md:83-130`                             |
| File context    | Designed, not shipped: after `Read`/`Edit`/`Write`, add about 1 KB of compact text for that file to the tool result, 2 s budget, add nothing on failure.                                                      | Harness                  | `design/shared-agent-view.md`                                             |
| MCP server      | 44 tools, most a thin wrapper over one CLI command (`find_dupes`, `check_health`, `audit`, `trace_export`, `fix_preview`, `fix_apply`).                                                                       | Model                    | `crates/mcp/src/server/mod.rs` at `v3.41.0`                               |
| Dashboard app   | An MCP App server started by the plugin manifest; `/fallow:analyze` opens it.                                                                                                                                 | User                     | `fallow/README.md`; `fallow/commands/analyze.md`                          |

### Fallow's workflow against the LAZERS thesis

| Fallow plugin                                                   | LAZERS                                                                               | Decision                                                             |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| Gate at `git commit`, by intercepting the model's shell command | The runtime commits the artifact itself in `verify()`; workers do not own the commit | Gate in `verify()`, on the artifact. No shell interception           |
| Gate on introduced findings only                                | A worker is held to its task and write scope                                         | Adopt: introduced fails, worsened warns, inherited is ignored        |
| Fail open on a tool error, visibly                              | Holds are for real, observable loss                                                  | Adopt: an analyzer error never fails a worker and never holds a plan |
| 44 model-callable tools                                         | Prefer runtime checks; workers keep native tools                                     | Five tools. The rest stays out                                       |
| Model told to run `audit` before commit                         | A rule the model can skip is not a check                                             | Runtime runs it. The prompt only says it will happen                 |
| Judgments must cite an emitted id                               | Auditor records dispositions by `findingID` (`lz-record-audit-finding`)              | Already matches. Keep                                                |
| `fix --yes` edits files                                         | The write path is the worker's, inside write scope                                   | Not exposed                                                          |
| Compact per-file text after an edit                             | Context packets guide reads                                                          | Not now. Revisit after the gate has data                             |

## Design

### Vendoring

```
vendor/fallow/                 upstream source at the pin: allowlisted crates,
                               Cargo.toml, Cargo.lock, LICENSE
vendor/fallow/UPSTREAM.json    { repo, tag, commit, tarballSha256, importedPaths }
vendor/fallow-patches/         numbered patches, one concern each
crates/fallow-wasm/            our binding crate (cdylib, wasm-bindgen)
scripts/vendor-fallow.ts       import or update: fetch pin, copy allowlist, apply patches
scripts/build-fallow-wasm.ts   cargo build → wasm-bindgen → wasm-opt → artifact + manifest
src/audit/wasm/                built fallow.wasm, JS glue, ARTIFACT.json
```

- **Pin.** Exact tag and commit in `UPSTREAM.json`. Start at `v3.41.0`, the
  version the spike and the installed native binding both use, so Phase 1 can
  compare outputs like for like.
- **Import, not submodule.** A script copies an allowlist of crates
  (`types`, `config`, `extract`, `graph`, `core`, `engine`, `mutation`,
  `security`, `output`, `report-protocol`, `process` as the dependency edges
  require) and applies the patch queue. This follows the precedent in
  `contributions/runntime/*/patches` with a `manifest.json`. A patch that no
  longer applies fails the import loudly.
- **Patches.** Expected set, from the spike: JavaScript entropy for
  `getrandom`; 64-bit assertions scoped to 64-bit targets; `ureq` behind a
  feature that the WASM build leaves off; `cfg` gates around the engine's Git,
  churn-cache, file-URL and symlink code. Each patch is written to be offered
  upstream.
- **Updates.** `bun scripts/vendor-fallow.ts <tag>` on a branch, then the
  Phase 1 parity suite. Merged like any change; no history rewrite. Upstream
  tags two to three times a week; LAZERS updates when it wants a fix, not on
  that cadence.
- **Licence.** Keep upstream `LICENSE` in `vendor/fallow/`. Ship
  `dist/THIRD_PARTY_LICENSES` in the release archive with Fallow's MIT text
  and the licences of the Rust crates linked into the module (generated at
  build time). `crates/license` and anything that reads a licence key are not
  imported.
- **From source vs prebuilt.** The `.wasm` is always built from the vendored
  source. Whether the built file is committed is an owner decision (Question 2).

### Build and shipping

```
scripts/build-fallow-wasm.ts
  cargo build -p fallow-wasm --target wasm32-unknown-unknown --release --locked
  wasm-bindgen --target bundler-less (raw wasm + JS glue)
  wasm-opt -Oz
  → src/audit/wasm/fallow.wasm, fallow.js
  → src/audit/wasm/ARTIFACT.json { upstreamCommit, patchSetSha256, wasmSha256, bytes, toolchain }

scripts/build-server.ts
  + ["src/audit/fallow-worker.ts", "fallow-worker.js"]
  + copy src/audit/wasm/fallow.wasm → dist/fallow.wasm

scripts/release-package.ts
  + dist/fallow-worker.js, dist/fallow.wasm, dist/THIRD_PARTY_LICENSES
  + assert the installed consumer tree holds no .node file from Fallow
```

Target: `wasm32-unknown-unknown` with explicit host inputs. This keeps the
earlier decision ("Prefer a library binding with explicit host inputs over a
WASI command with broad filesystem access", `design/auditor-tooling.md:82-83`).
A WASI build with the worktree as its only preopened directory is the fallback
if the engine patches prove too invasive; it is not evaluated yet.

Runtime shape:

```
service main thread                       fallow worker thread (dist/fallow-worker.js)
───────────────────                       ───────────────────────────────────────────
FallowClient.check(request, signal) ───▶  instantiate dist/fallow.wasm once
  one request at a time per worker        host adapter:
  signal abort → worker.terminate()         list files   git ls-files in the worktree
  timeout      → worker.terminate()         read files   Bun.file, realpath under root only
                                            changed set  given in the request
                                            config       .fallowrc.json[c] / fallow.toml text
                                          wasm: parse, tokenize, detect
                                   ◀────  compact result (never the raw report)
```

- The worker is spawned with `workerURL("./fallow-worker", import.meta.url)`.
  The module path needs the same source-versus-bundle switch; add a
  `wasmURL` next to `workerURL` in `src/worker-url.ts`.
- **Filesystem.** The module has none. The worker reads and passes bytes. It
  refuses any path whose realpath leaves the workspace root. The WASM module
  gets no network, process or filesystem import.
- **Git.** The module never calls Git. The runtime already knows
  `attempt.base_commit` and the artifact commit; it passes changed paths and
  added line ranges (`git diff -U0`), and base-side file contents for changed
  files (`git cat-file --batch`).
- **Remote config.** A config with a remote `extends` returns
  `remote-extends-unsupported`. Fallow's own skill treats remote config as
  untrusted input (`SKILL.md` rule 9).
- **Cancellation.** Terminating the worker is the only cancel. The next
  request starts a new one.

Budgets. These are proposals; Phase 1 measures them and the plan is revised
if they do not hold.

| Budget                                      | Proposed limit                              | Reference                                      |
| ------------------------------------------- | ------------------------------------------- | ---------------------------------------------- |
| `fallow.wasm` after `wasm-opt -Oz`          | 8 MB raw                                    | Native addon is 27 MB                          |
| Worker start to module ready                | 300 ms                                      | None measured                                  |
| Changed-file check on this repository       | 2 s at p95                                  | None measured                                  |
| Full five-section report on this repository | 15 s                                        | Native took 4.866 s, multi-phase, with threads |
| Hard timeout, any request                   | 60 s, then terminate and report unavailable |                                                |
| Worker memory                               | Recorded, no limit yet                      |                                                |

### Tool catalogue

Conventions follow `src/audit/tools.ts`: `z.strictObject` input,
`ctx.permission.assert` with the tool name as the action,
`options: { codemode: true, permission: <name> }`, output returned as
`{ content: JSON.stringify(output), output }`, failures as `Tool.Error`. No
input carries a version or revision field. Task, plan, attempt and workspace
come from the runtime assignment, never from the model.

Shared output rules: paths relative to the workspace; every finding has
`file` and `line`; lists are ranked worst first and paged (`limit` default 10,
maximum 25, `offset`, `nextOffset`); no source fragments; no raw report.

| Tool                  | Fallow source                       | Input                                                                                             | Output                                                                                                                             | For                             |
| --------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `lz-fallow-check`     | The gate function itself            | `{}` for the caller's changed files, or `{ paths: string[] }`                                     | `{ verdict: "pass" \| "fail", introduced: Finding[], warnings: Finding[], thresholds }`                                            | Implementor, Auditor, Architect |
| `lz-fallow-dupes`     | `dupes` / `detectDuplication`       | `{ paths?, mode?, minTokens?, minLines?, limit, offset }`                                         | `{ groups: [{ id, lines, tokens, instances: [{ file, startLine, endLine }], moreInstances }], total, duplicationPct, nextOffset }` | Auditor, Architect              |
| `lz-fallow-health`    | `health` / `computeComplexity`      | `{ paths?, sort: "cognitive" \| "cyclomatic" \| "lines", limit, offset }`                         | `{ functions: [{ file, line, name, cyclomatic, cognitive, lines, exceeded }], total, thresholds, nextOffset }`                     | Auditor, Architect              |
| `lz-fallow-dead-code` | `dead-code` / `detectDeadCode`      | `{ paths?, kinds?: ("file" \| "export" \| "type" \| "dependency" \| "member")[], limit, offset }` | `{ findings: [{ id, kind, file, line, name }], total, nextOffset }`                                                                | Auditor, Architect              |
| `lz-fallow-report`    | All five sections, durable (exists) | `{ taskID?, phase? }` (drop `threads`: one thread in WASM)                                        | Unchanged `AuditScanOutput`                                                                                                        | Auditor, Architect              |

```ts
// Finding, as returned by lz-fallow-check and written into the gate receipt
type Finding = {
  id: string // stable within the run; cite it in lz-record-audit-finding
  check: "duplication" | "complexity" | "dead-code" | "cycle"
  status: "introduced" | "worsened"
  file: string
  line: number
  endLine?: number
  subject: string // function name, export name, or "38 lines, 212 tokens"
  measured?: number
  limit?: number
  before?: number
  others?: { file: string; line: number; endLine: number }[] // other clone instances, max 3
  fix: string // one sentence, from a fixed template per check
}
```

Errors, all as `Tool.Error` with a stable leading code:
`analyzer-unavailable`, `timeout`, `cancelled`, `config-invalid: <message>`,
`remote-extends-unsupported`, `path-outside-workspace`, `no-supported-files`.

Kept as they are: `lz-query-audits`, `lz-get-audit`,
`lz-record-audit-finding`, `lz-import-audit`.

Not exposed, and why:

| Fallow capability                                                                           | Reason                                                                                                    |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `fix`                                                                                       | Writes files outside the worker's own edit path. The binding does not expose it either                    |
| `audit` as a tool                                                                           | `lz-fallow-check` is the audit, with LAZERS attribution                                                   |
| `trace`, `inspect`, `guard`                                                                 | Not in the library surface; lives in the CLI. Add `lz-fallow-trace` only if Phase 4 finds a library entry |
| Hotspots, ownership, churn                                                                  | Need Git history inside the engine. Omitted, not shown as unknown                                         |
| `similar-code`                                                                              | Needs a local model companion (`design/auditor.md`)                                                       |
| `mutation`                                                                                  | Separate track, already planned in `design/auditor-tooling.md` step 3                                     |
| `security`, `flags` as tools, `watch`, `init`, `agent`, `hooks`, cloud, coverage, telemetry | Outside the simplification and gate use cases                                                             |

### Who runs what, and when

Thresholds come from the project's Fallow config, else Fallow's defaults
(cyclomatic 20, cognitive 15, 50 tokens and 5 lines in `mild` mode).

| Lifecycle point                     | Fallow check                                                                                            | Trigger                                      | Fails when                                                                                                                              | On failure                                                                                                                               | What the agent is told                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Plan submitted                      | None                                                                                                    |                                              |                                                                                                                                         |                                                                                                                                          | Nothing. Admission stays base-commit and route preflight                                                  |
| Worker dispatched                   | None                                                                                                    |                                              |                                                                                                                                         |                                                                                                                                          | `src/implementor.md` gains three lines: the check runs when you finish, its limits, and `lz-fallow-check` |
| Worker mid-task                     | Complexity and duplication on its changed files                                                         | Agent tool `lz-fallow-check`, optional       | Never; it reports                                                                                                                       |                                                                                                                                          | The same findings the gate would produce                                                                  |
| Auditor attempt starts              | Full five-section baseline report, linked to the attempt                                                | Runtime                                      | Never                                                                                                                                   | Unavailable is recorded; the Auditor proceeds from source                                                                                | The baseline run ID is in the task; read it with `lz-get-audit`                                           |
| Worker finishes → task verification | Complexity and duplication, changed files only, base `attempt.base_commit`                              | Runtime, effect `verify:lazers-fallow`       | A function in a changed file crosses a limit it was under at base (or is new and over); or a clone group has an instance on added lines | First time: `REPAIR`, one new attempt. Second time: `FAIL` and the existing hold (`audit`, `reconcile`, `cancel`)                        | Guidance text below                                                                                       |
| Same point, warn level              | Complexity that was already over and grew; new unused exports; added `fallow-ignore` comments           | Runtime, same run                            | Never                                                                                                                                   |                                                                                                                                          | Nothing to the worker. Listed in the `task-accepted` outcome for the Architect                            |
| Auditor finishes                    | Same gate, plus the follow-up report linked to the baseline                                             | Runtime                                      | Same rule                                                                                                                               | Same path                                                                                                                                | Same guidance. Finding-count delta goes to the Architect and gates nothing                                |
| Architect review                    | None automatic; the verdict and warnings are already in the outcome                                     | Agent tools for scoping a cleanup            |                                                                                                                                         |                                                                                                                                          |                                                                                                           |
| Pre-integration, combined check     | Complexity and duplication across all tasks; dead code and import cycles introduced since the plan base | Runtime, effect `graph-verify:lazers-fallow` | Introduced findings on the combined artifact. Catches two tasks that each added the same helper                                         | Existing path: the plan holds with "Combined artifact verification failed" plus the findings; Architect submits a cleanup task or waives | Architect gets the findings in the hold reason and outcome                                                |
| After integration                   | Full report on the default branch, stored as the project baseline                                       | Runtime, on the integration event (no timer) | Never                                                                                                                                   |                                                                                                                                          | Architect is notified only when a section crosses a project limit                                         |

Why dead code gates at the plan and not the task: a task may add an export
that a later task in the same plan consumes. At task level it is a warning.

Guidance text, composed by the runtime from fixed templates, at most ten
findings and 1,500 characters:

```
Verification lazers-fallow found 2 findings introduced by this task. Older findings are not counted.
1. complexity src/runner/plan-step.ts:120 `planStep` cognitive 31, limit 15 (was 12).
   Move the branch at lines 140-190 into a named function.
2. duplication src/tasks/read.ts:210-248 repeats src/tasks/detail.ts:77-115 (38 lines).
   Keep one implementation and import it in both files.
Fix these inside your write scope. Run lz-fallow-check to confirm. Do not add fallow-ignore comments.
```

The first line is the task's reason line. The hold reason keeps the
`Verification <id> …` prefix so `hold-actions.ts` maps it to the existing
verification family.

Where an agent tool is worth having:

- **Auditor**, exploring: which clone families and complex functions sit in
  the assigned boundary, and what the dead-code candidates are. Judgement
  about what is deliberate cannot be a threshold.
- **Architect**, scoping: sizing a cleanup task and choosing its write scope
  before submitting it.
- **Any worker**, self-checking with `lz-fallow-check`: the default allows one
  repair attempt, so finding the problem before finishing saves that attempt.

Where it is not: deciding whether a task passes. That is the runtime's.

### Attribution and baselines

No baseline file. The base is the commit the attempt started from.

| Check       | Analysed                                                           | Introduced when                                                                                                            |
| ----------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Complexity  | Changed files at the artifact, and the same files at `base_commit` | Function (path + name) is over a limit now, and was absent or within it at base. Over at both and higher now is `worsened` |
| Duplication | Candidate tree, clone groups touching changed files                | At least one instance overlaps a line the diff added                                                                       |
| Dead code   | Combined artifact and plan base                                    | Finding key (kind + path + name, no line) absent at base                                                                   |
| Cycles      | Combined artifact and plan base                                    | Cycle (sorted member set) absent at base                                                                                   |

These are Fallow's own `audit` rules (`fallow.tools/docs/cli/audit`),
reimplemented in the host because the library exposes no `audit`.

Per-project configuration:

| Setting                       | Where                                                                                                                                 | Default             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Limits, ignore patterns, mode | The project's own Fallow config, so the CLI, CI and LAZERS agree                                                                      | Fallow defaults     |
| Gate mode                     | Plugin option `fallowGate: "gate" \| "warn" \| "off"`, read in `src/core/core.ts` beside the Architect routing options                | `gate` (Question 4) |
| Per-finding waiver            | A Fallow suppression comment with a reason, written on the Architect's instruction; reported to the Architect as an added suppression |                     |

Surfacing, with no new panel elements:

| Panel                   | Shows                                                                                                   | Through                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Tasks, reason line      | First line of the guidance                                                                              | Node reason set by `failAttempt()`; read in `src/tasks/read.ts` |
| Trajectory, checks lane | `lazers-fallow` passed or failed, with timing                                                           | `recordVerification()`, unchanged                               |
| Trajectory, checks lane | Nothing when the analyzer was unavailable; one `FALLOW_UNAVAILABLE` record per attempt                  | `store.record()`                                                |
| Radar                   | Not verified in this plan. Phase 3 confirms which existing records Radar reads before any claim is made |                                                                 |

### Where the Fallow config lives

Complexity and duplication work with no config (Fallow defaults). Dead code
does not: it needs entry points. On this repository 18 of 19 "unused files"
were workers and fixtures loaded by path.

| Option                                  | Travels with a worktree | CLI, CI, editor agree | Who can loosen the gate                      | Cost                                          |
| --------------------------------------- | ----------------------- | --------------------- | -------------------------------------------- | --------------------------------------------- |
| A. Fallow config file in the repo       | Yes                     | Yes                   | Anyone who lands a commit, visible in review | One task per project to create it             |
| B. LAZERS project store, by project key | Yes, passed by runtime  | No                    | Whoever calls a settings tool; no diff       | New storage, new tool, second source of truth |
| C. Carried on the plan or tasks         | Yes                     | No                    | The Architect, per plan                      | Re-authored every plan; plans drift           |

Recommended: A, with two rules.

1. The runtime reads the config at the attempt's base commit, never from the
   candidate. A task cannot loosen its own gate; a config change applies to
   tasks that start after it integrates.
2. Plans and tasks carry no Fallow settings. The receipt records the config
   path and content hash.

The analyzer takes config as text from the host, so B can be added later
without changing it.

How the Architect learns a project has none, as a runtime fact and not a
prompt rule:

```
first check in a project, no config at the base commit
  complexity + duplication   gate as normal, Fallow defaults
  dead code                  off, omitted from results (not shown as zero)
  Architect notice           once per project:
                             "No Fallow config. Dead-code checks are off.
                              lz-fallow-config returns a draft."
```

`lz-fallow-config` (read-only, Architect and Auditor): returns the resolved
config, its path and hash, and, when there is none, a draft built from
Fallow's `recommend` output plus entry points the runtime can see. The
Architect submits an ordinary task to commit it.

Location versus project: Fallow searches upward to the workspace root and
takes the first config (`fallow.tools/docs/configuration/overview`). Analysing
from the worktree root gives every OpenCode location in a project the same
file. The upward search through the library path is unverified; Phase 1 tests
it.

### State-machine fit

No new state. No new machine event. `lifecycleMachines` is unchanged.

| Need                      | Existing mechanism                                                                                                                                                          |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Journal and run the check | An effect in `effectMachine` with kind `verify:lazers-fallow` or `graph-verify:lazers-fallow`. `isRerunnable` already covers both prefixes (`runtime.ts:413`)               |
| Pass                      | Receipt with `exitCode: 0`; `checkSucceeded()` unchanged                                                                                                                    |
| Fail, first time          | `failAttempt()` → task `verifying --REPAIR--> ready`                                                                                                                        |
| Fail, after the repair    | `failAttempt()` → `verifying --FAIL--> failed`, hold advertising `audit`, `reconcile`, `cancel`. Exits: `RETRY`, `RESUME`, `ADOPT_ACCEPT`, `RETAINED_ACCEPT` (`machine.ts`) |
| Analyzer error or timeout | The effect completes with a receipt marked `skipped`, verification continues, `FALLOW_UNAVAILABLE` is recorded once. No hold, no failed attempt                             |
| Service restart mid-check | No receipt → superseded and re-run, as for any `verify:` effect                                                                                                             |
| Combined check fails      | Existing plan hold; exits are the existing `reconcile`, `resume`, `cancel`                                                                                                  |

The receipt is a `CheckReceipt` with `command: "lazers:fallow-check"`,
`exitCode` 0 or 1, and the guidance in `stdout`. `lazers-fallow` becomes a
reserved check ID; `PlanInput` validation rejects an authored check with that
ID (`src/runner/schema.ts:153`).

### Contract change

`docs/reference/contributor-contracts.md:53`, `design/auditor.md` and the
`lz-fallow-report` description say Fallow never gates. The new rule:

> Fallow scores never gate. Findings a change introduces, above the project's
> limits, fail verification. Older findings never do.

## Phases

Each phase is one or more atomic commits on a branch and ends with
`bun run verify` plus the listed checks.

### Phase 0: vendor and reproduce the spike

1. `scripts/vendor-fallow.ts`, `vendor/fallow/` at `v3.41.0`,
   `UPSTREAM.json`, the two spike patches.
2. `crates/fallow-wasm/` exporting `parse` and `complexity` for one file.

Accept when: a clean clone builds the module with one command; the module
declares no filesystem, network or process import; a Bun test gets the same
cyclomatic and cognitive numbers as native `computeComplexity` for every
function in `src/runner/checks.ts`.

### Phase 1: duplication and the project-wide sections in WASM

1. Patch `fallow-config` (no `ureq`) and `fallow-engine` (`cfg` gates) until
   the duplication detector builds; if the engine resists, bind
   `duplication_detector` directly.
2. Host adapter: file list, contents, changed set, config text.
3. Dead code, architecture, feature flags through the same adapter.

Accept when: on this repository and on one fixture with a framework plugin,
WASM and native agree on clone groups (file and line ranges), complexity
findings, and dead-code finding keys, with every difference listed and
explained; size, start time, check time and memory are measured and written
into this plan against the budgets; a failed budget is reported, not hidden.

Stop and return to the owner when: duplication cannot be built without
rewriting the detector.

### Phase 2: worker and tools

1. `src/audit/fallow-worker.ts`, `FallowClient`, `wasmURL`; entries in
   `scripts/build-server.ts` and `scripts/release-package.ts`.
2. `lz-fallow-report` runs on WASM. Remove `@fallow-cli/fallow-node` and its
   companions from `package.json`.
3. Add `lz-fallow-check`, `lz-fallow-dupes`, `lz-fallow-health`,
   `lz-fallow-dead-code` with permissions per role in `src/runner/roles.ts`.

Accept when: existing `src/audit/*.test.ts` pass on WASM; a release archive
installed with `bun add --ignore-scripts` contains no Fallow `.node` or Mach-O
file; aborting a request terminates the worker and the next request succeeds;
the service event loop stays responsive during a full report (measured with
the existing stall probe); each tool's output for this repository is under
8 KB at default `limit`.

### Phase 3: the task gate

1. Attribution in the host (complexity base-side, added-line overlap).
2. `verify:lazers-fallow` in `TaskRuntime.verify()`, receipt, guidance text,
   `FALLOW_UNAVAILABLE`, reserved check ID, `fallowGate` option.
3. Three lines in `src/implementor.md`; contract wording in the three places
   named above.

Accept when, in `runtime.test.ts`: a task that adds a clone fails
verification, moves `REPAIR`, and the repair attempt's dispatch input
contains the guidance; a task that edits a file with an old over-limit
function, without touching it, passes; an analyzer error accepts the task and
records `FALLOW_UNAVAILABLE` once; a restart mid-check re-runs it;
`lifecycle-machines.test.ts`, `lifecycle-dead-ends.test.ts` and
`hold-actions.test.ts` pass unchanged. And in the Desktop walkthrough: the
Tasks reason line and the Trajectory checks lane show the check; what Radar
shows is recorded here.

### Phase 4: Auditor and the plan gate

1. Runtime runs the baseline report when an Auditor attempt starts and the
   follow-up at verification; `src/auditor.md` stops telling the model to
   start the scan.
2. `graph-verify:lazers-fallow` in `TaskRuntime.finish()` with dead code and
   cycles.
3. Warnings in the `task-accepted` outcome.
4. Look for a library entry for `trace`; add `lz-fallow-trace` only if found.

Accept when: two tasks that each add the same helper pass alone and hold the
plan at the combined check with both locations named; an Auditor attempt has
a baseline and a linked follow-up without the model calling
`lz-fallow-report`.

### Phase 5: after-integration baseline

1. Full report on the default branch when a plan integrates, stored as the
   project baseline; Architect notice when a section crosses a limit.

Accept when: the notice fires once per crossing, not per integration.

### Agents

| Phase | Lane                              | Agent              | Model  |
| ----- | --------------------------------- | ------------------ | ------ |
| 0, 1  | Rust: vendoring, patches, binding | `fallow-wasm`      | Sonnet |
| 2     | Worker, client, tools, packaging  | `audit-tools`      | Sonnet |
| 3, 4  | Runtime gate                      | `runner-gate`      | Sonnet |
| all   | Tests, `bun run verify`, builds   | `runner` per phase | Haiku  |

Phase 1 may need a step up for the engine patches; say so when it happens.

## Open questions for the owner

1. **Vendoring form.** Scripted allowlist import with a patch queue
   (recommended, smaller, matches `contributions/runntime`), or a full
   `git subtree` of the upstream repository?
2. **Built artifact.** Commit `fallow.wasm` under `src/audit/wasm/` so
   `bun run build:server` needs no Rust (recommended, with CI rebuilding and
   comparing the hash), or build it on every server build?
3. **Contract.** Confirm the new wording: scores never gate; introduced
   findings above limits fail verification.
4. **Default mode.** `gate` for every project from the first release, or
   `warn` until Phase 3 has run on real tasks for a while?
5. **Worsened complexity.** Warn, as Fallow does by default, or fail?
6. **Waiver.** Is a suppression comment with a reason, written on the
   Architect's instruction, an acceptable waiver, or should a waiver live in
   the plan?
7. **Dead code at task level.** Warning only, as planned, or gate with an
   exemption for exports another task in the plan consumes?
8. **After-integration report.** Run on the integration event, as planned.
   Is a time-based sweep wanted as well? `design/auditor.md` currently rules
   out a recurring timer.
9. **Upstreaming.** Offer the WASM patches to `fallow-rs/fallow`, or keep
   them private to this repository?
10. **Pin.** Start at `v3.41.0` for parity with the spike, then move to the
    latest tag after Phase 1?

11. **Config source.** Repo file read at the base commit (recommended), a
    LAZERS project store, or settings carried on the plan?
12. **Config edits.** Should a task that changes the Fallow config be flagged
    to the Architect in its outcome, or is ordinary review enough?
13. **No config.** Dead code off until a config exists (recommended), or hold
    the plan gate until the Architect creates one?

## Follow-ups noticed, not part of this plan

- `scripts/release-package.ts` copies `processor.js`, `repo-worker.js` and
  `decision-worker.js` but not `transition-indexes-worker.js`, which
  `scripts/build-server.ts` builds and `src/runner/transition-indexes.ts`
  spawns.
