# Fallow as in-process WebAssembly tools

Status: Everything now runs in WebAssembly (see "Everything runs in WebAssembly", 2026-11-19; earlier sections describe the first design). Phases 0 to 4 are built, merged and verified live in OpenCode on
2026-11-19 (see "Live verification"). Phase 5 was dropped by owner decision. Line numbers are
as read on 2026-11-19 and will drift; function names are the stable reference.

## Problem

Fallow reaches LAZERS today as a 27 MB native N-API addon that one
model-initiated tool loads. Nothing deterministic runs it. A worker can finish
a task that adds a 200-token clone or a function with cognitive complexity 40,
and the runtime accepts it when the authored checks pass.

Three changes fix that:

1. Build Fallow's analysis to WebAssembly from vendored source and run it in a
   worker thread of the service. No native addon, no analyzer process.
2. Run duplication and complexity as a runtime review when a worker finishes.
   Findings go back to a worker as specific fix guidance through the existing
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
  does build. So the complexity half of the review is proven feasible; the
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
  `chore/fallow-self-cleanup`. The dead-code review (Phase 4) must not run on a
  project with no Fallow config; it reports instead.
- **Introduced-only is not optional.** With 735 inherited complexity findings
  a review of all findings would bury every task in feedback.
- **The budget for the changed-file check is realistic.** The whole repository
  takes 1.3 s for health natively with threads; the review analyses changed
  files only.
- **Unused class members are not trustworthy.** Across both cleanup waves the
  analyzer reported 50 class members as unused; 46 were false. It misses a
  call made through an instance held in another object (`this.store.renew()`
  in `src/runner/runtime.ts`, 30 of the 33 `RunnerStore` findings) and counts
  a test-only caller as none. Exports and types were reliable: about 1 in 30
  was wrong. `lz-fallow-dead-code` and the plan review therefore leave class
  members out unless the project's config turns them on.
- **Un-exporting can trade one finding for another.** A zod schema used only
  through `z.infer<typeof X>` draws a lint warning once it loses its export.
  The fix guidance for an unused export must say "remove the export only if
  the value is still used in the file".
- **Clean up first.** This repository is cleaned before Fallow is dogfooded in
  OpenCode (owner decision). Done means: zero dead-code findings or each one
  dispositioned, the import cycle removed, no clone group over 20 lines
  outside tests, and the three functions over cognitive 300 split. Tracked on
  `chore/fallow-self-cleanup`. First wave, 2026-11-19: `src/models` and the
  verification, recovery, webgpu and core lanes took dead-code findings from
  380 to 200.

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

| Fallow plugin                                                   | LAZERS                                                                               | Decision                                                                                     |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Gate at `git commit`, by intercepting the model's shell command | The runtime commits the artifact itself in `verify()`; workers do not own the commit | Review in `verify()`, on the artifact. No shell interception                                 |
| Gate on introduced findings only                                | A worker is held to its task and write scope                                         | Adopt the attribution: introduced gets feedback, worsened is a concern, inherited is ignored |
| Fail open on a tool error, visibly                              | Holds are for real, observable loss                                                  | Adopt: an analyzer error never fails a worker and never holds a plan                         |
| 44 model-callable tools                                         | Prefer runtime checks; workers keep native tools                                     | Five tools. The rest stays out                                                               |
| Model told to run `audit` before commit                         | A rule the model can skip is not a check                                             | Runtime runs it. The prompt only says it will happen                                         |
| Judgments must cite an emitted id                               | Auditor records dispositions by `findingID` (`lz-record-audit-finding`)              | Already matches. Keep                                                                        |
| `fix --yes` edits files                                         | The write path is the worker's, inside write scope                                   | Not exposed                                                                                  |
| Compact per-file text after an edit                             | Context packets guide reads                                                          | Not now. Revisit after the gate has data                                                     |

## Design

### Vendoring

```
vendor/fallow/                 upstream source at the pin: allowlisted crates,
                               Cargo.toml, Cargo.lock, LICENSE
vendor/fallow/UPSTREAM.json    { repo, tag, commit, tarballSha256, importedPaths }
vendor/fallow-patches/         numbered patches, one concern each
crates/fallow-wasm/            our binding crate (WASI command, wasm32-wasip1)
scripts/vendor-fallow.ts       import or update: fetch pin, copy allowlist, apply patches
scripts/build-fallow-wasm.ts   cargo build → wasm-opt → artifact + manifest
src/audit/wasm/                built fallow.wasm, ARTIFACT.json
```

- **Pin.** Exact tag and commit in `UPSTREAM.json`. Start at `v3.43.2`, the
  latest tag (owner decision). The spike ran on `v3.41.0`, so its patches are
  re-derived, and `@fallow-cli/fallow-node` is bumped to `3.43.2` first so
  Phase 1 compares WASM and native output like for like.
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
  source. The built file is committed; CI rebuilds it and compares the hash.

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

Target: superseded. The first design chose `wasm32-unknown-unknown` with explicit host
inputs (file contents passed in). It could not serve module resolution through
`node_modules`, so the shipped build is `wasm32-wasip1` with a read-only preopened directory;
see "Everything runs in WebAssembly".

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
| `lz-fallow-audit`     | The review function itself          | `{}` for the caller's changed files, or `{ paths: string[] }`                                     | `{ clean: boolean, introduced: Finding[], concerns: Finding[], thresholds }`                                                       | Implementor, Auditor, Architect |
| `lz-fallow-dupes`     | `dupes` / `detectDuplication`       | `{ paths?, mode?, minTokens?, minLines?, limit, offset }`                                         | `{ groups: [{ id, lines, tokens, instances: [{ file, startLine, endLine }], moreInstances }], total, duplicationPct, nextOffset }` | Auditor, Architect              |
| `lz-fallow-health`    | `health` / `computeComplexity`      | `{ paths?, sort: "cognitive" \| "cyclomatic" \| "lines", limit, offset }`                         | `{ functions: [{ file, line, name, cyclomatic, cognitive, lines, exceeded }], total, thresholds, nextOffset }`                     | Auditor, Architect              |
| `lz-fallow-dead-code` | `dead-code` / `detectDeadCode`      | `{ paths?, kinds?: ("file" \| "export" \| "type" \| "dependency" \| "member")[], limit, offset }` | `{ findings: [{ id, kind, file, line, name }], total, nextOffset }`                                                                | Auditor, Architect              |
| `lz-fallow-report`    | All five sections, durable (exists) | `{ taskID?, phase? }` (drop `threads`: one thread in WASM)                                        | Unchanged `AuditScanOutput`                                                                                                        | Auditor, Architect              |

```ts
// Finding, as returned by lz-fallow-audit and written into the review receipt
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
| `audit` as a tool                                                                           | `lz-fallow-audit` is the audit, with LAZERS attribution                                                   |
| `trace`, `inspect`, `guard`                                                                 | Not in the library surface; lives in the CLI. Add `lz-fallow-trace` only if Phase 4 finds a library entry |
| Hotspots, ownership, churn                                                                  | Need Git history inside the engine. Omitted, not shown as unknown                                         |
| `similar-code`                                                                              | Needs a local model companion (`design/auditor.md`)                                                       |
| `mutation`                                                                                  | Separate track, already planned in `design/auditor-tooling.md` step 3                                     |
| `security`, `flags` as tools, `watch`, `init`, `agent`, `hooks`, cloud, coverage, telemetry | Outside the simplification and review use cases                                                           |

### Who runs what, and when

Owner direction (2026-11-19): Fallow is feedback, not rejection, and the
agent that wrote the code fixes it before the Architect sees it. Complexity
and duplication are an extension of linting.

An earlier draft gave Fallow its own three rounds on `ReviewProgression`
(`src/review/progression.ts`, the D1 task-review rule). That is dropped: the
existing repair attempt is the second look, and one repair carries Fallow
findings and failing checks together, so no separate round counter, score or
fingerprint is needed.

```
candidate ──▶ Fallow (changed files, introduced only) + authored checks
                          │
   clean + pass ──────────┼──▶ accept
   findings and/or fail ──┼──▶ one REPAIR; the repair attempt is given everything
   findings only, no repair attempt left ──▶ accept, concerns to the Architect
   analyzer unavailable ──▶ treated as clean, recorded once
```

A Fallow review never rejects a task. Authored verification checks keep
today's behaviour (fail, one repair attempt, then a hold).

Complexity and duplication are treated as an extension of linting (owner
direction, 2026-11-19). The review sits beside the existing mechanical
preparation (`prepareVerificationCandidate`, `src/runner/runtime.ts`), which
already runs `bun fmt` and `bun lint --fix` on changed files.

One repair carries everything (owner decision, 2026-11-19). The runtime runs
the Fallow review and every authored check on the candidate, then decides
once:

```
worker finishes
  → format + lint --fix      runtime, automatic, fixes committed into the artifact
  → Fallow review            runtime            ┐ both always run;
  → authored checks          runtime            ┘ neither short-circuits the other
  → decide once
```

| Fallow review | Authored checks | Repair attempt left | Result                                                                                |
| ------------- | --------------- | ------------------- | ------------------------------------------------------------------------------------- |
| Clean         | Pass            |                     | Accept                                                                                |
| Findings      | Pass            | Yes                 | One `REPAIR`, input carries the Fallow findings                                       |
| Clean         | Fail            | Yes                 | One `REPAIR`, input carries the check failures (today's behaviour)                    |
| Findings      | Fail            | Yes                 | One `REPAIR`, input carries both                                                      |
| Findings      | Pass            | No                  | Accept; the remaining findings go to the Architect as concerns                        |
| Any           | Fail            | No                  | Today's behaviour: `FAIL` and a hold. Fallow findings are attached to the hold reason |

The repair input carries every failing check, not the first. Today
`verify()` reports one (`receipts.find(...)` before `failAttempt()`,
`src/runner/runtime.ts`); Phase 3 changes it to collect all of them with the
Fallow findings. Reason (owner, 2026-11-19): anything the worker is not told
about is left for the Architect, whose fixes cost more.

Fallow never spends a repair attempt of its own and never competes with a
test failure for one. Unlike mechanical preparation, the review does not
depend on the task declaring a quality command: it runs for every worker
attempt whose changed files the analyzer supports.

Thresholds come from the effective Fallow config, else Fallow's defaults
(cyclomatic 20, cognitive 15, 50 tokens and 5 lines in `mild` mode).

| Lifecycle point                 | Fallow check                                                                                                                          | Trigger                                      | Outcome                                                                    | What the agent is told                                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Plan submitted                  | None                                                                                                                                  |                                              |                                                                            | Nothing. Admission stays base-commit and route preflight                                                                         |
| Worker dispatched               | None                                                                                                                                  |                                              |                                                                            | `src/implementor.md` gains three lines: the review runs when you finish, its limits, `lz-fallow-audit`                           |
| Worker mid-task                 | Complexity and duplication on its changed files                                                                                       | Agent tool `lz-fallow-audit`, optional       | Read-only preview of what the runtime's review will report                 | Findings and a `next` instruction                                                                                                |
| Auditor attempt starts          | Full five-section baseline report, linked to the attempt                                                                              | Runtime                                      | Stored. Unavailable is recorded; the Auditor proceeds from source          | The baseline run ID is in the task; read it with `lz-get-audit`                                                                  |
| Worker finishes                 | Complexity and duplication, changed files, base `attempt.base_commit`, after format and lint, alongside the authored checks           | Runtime, effect `verify:lazers-fallow`       | `feedback`: the same attempt continues with the findings. Otherwise accept | Guidance text below                                                                                                              |
| Task accepted                   | Concerns left after the repair attempt; complexity that was already over and grew; new unused exports; added `fallow-ignore` comments | Runtime, same run                            | Never blocks                                                               | Listed in the `task-accepted` outcome for the Architect                                                                          |
| Auditor finishes                | Same review, plus the follow-up report linked to the baseline                                                                         | Runtime                                      | Same path                                                                  | Same guidance. Finding-count delta goes to the Architect                                                                         |
| Architect review                | None automatic                                                                                                                        | Agent tools, for scoping a cleanup           |                                                                            |                                                                                                                                  |
| Pre-integration, combined check | Complexity and duplication across all tasks; dead code and import cycles introduced since the plan base                               | Runtime, effect `graph-verify:lazers-fallow` | No rounds and no hold: no single worker owns the combined result           | Findings in the plan outcome. Catches two tasks that each added the same helper; the Architect submits a cleanup task or accepts |

Decided (2026-11-19): complexity that was already over a limit and grew is a
concern, not feedback that triggers a repair. A deliberate finding is waived with
a Fallow suppression comment that carries a reason, written on the
Architect's instruction, and reported to the Architect as an added
suppression.

Why dead code is reviewed at the plan and not the task: a task may add an
export that a later task in the same plan consumes.

Guidance text, composed by the runtime from fixed templates, at most ten
findings and 1,500 characters:

```
Fallow review: 2 findings introduced by this task. Older findings are not counted.
1. complexity src/runner/plan-step.ts:120 `planStep` cognitive 31, limit 15 (was 12).
   Move the branch at lines 140-190 into a named function.
2. duplication src/tasks/read.ts:210-248 repeats src/tasks/detail.ts:77-115 (38 lines).
   Keep one implementation and import it in both files.
Fix these inside your write scope, then finish again. Do not add fallow-ignore comments.
```

Like `lz-verify-task`, the tool result carries `status` and
`next: { action, instruction }`.

Where an agent tool is worth having:

- **Auditor**, exploring: which clone families and complex functions sit in
  the assigned boundary, and what the dead-code candidates are.
- **Architect**, scoping: sizing a cleanup task and choosing its write scope.
- **Any worker**, with `lz-fallow-audit`: seeing the findings before it
  finishes.

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

| Setting                       | Where                                                                                                                                 | Default         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| Limits, ignore patterns, mode | The project's own Fallow config, so the CLI, CI and LAZERS agree                                                                      | Fallow defaults |
| Review on or off              | Plugin option `fallowReview: "on" \| "off"`, read in `src/core/core.ts` beside the Architect routing options                          | `on`            |
| Per-finding waiver            | A Fallow suppression comment with a reason, written on the Architect's instruction; reported to the Architect as an added suppression |                 |

Surfacing, with no new panel elements:

| Panel                   | Shows                                                                                                   | Through                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Tasks, reason line      | First line of the guidance                                                                              | Node reason set by `failAttempt()`; read in `src/tasks/read.ts` |
| Trajectory, checks lane | `lazers-fallow` passed or failed, with timing                                                           | `recordVerification()`, unchanged                               |
| Trajectory, checks lane | Nothing when the analyzer was unavailable; one `FALLOW_UNAVAILABLE` record per attempt                  | `store.record()`                                                |
| Radar                   | Not verified in this plan. Phase 3 confirms which existing records Radar reads before any claim is made |                                                                 |

### Where the Fallow config lives

Owner constraint (2026-11-19): LAZERS must be fully configurable with no file
in the repository, and analysis must not write into the working tree.

Complexity and duplication work with no config (Fallow defaults). Dead code
does not: it needs entry points. On this repository 18 of 19 "unused files"
were workers and fixtures loaded by path.

Two sources, never merged (owner decision, 2026-11-19). A config file in the
repository is honoured first and alone; otherwise the LAZERS project config
applies; otherwise Fallow defaults.

```
repo config file at the base commit?   yes → use it, ignore the LAZERS config
LAZERS project config set?             yes → use it
neither                                    → Fallow defaults, dead code off
```

| Source                | Stored                                                               | Set by                                     | Seen by CLI and CI |
| --------------------- | -------------------------------------------------------------------- | ------------------------------------------ | ------------------ |
| Repo config file      | The checkout                                                         | An ordinary commit                         | Yes                |
| LAZERS project config | LAZERS SQLite in the plugin data directory, keyed by the project key | `lz-fallow-config` (Architect or the user) | No                 |

- **Keyed by project, not path.** The project key is the normalized default
  remote (`.agents/plans/stable-change-identity.md`, "Project key"), so every
  checkout, worktree and OpenCode location of one project shares one config.
- **One source per check.** No key-by-key merge, so the CLI, CI and LAZERS
  agree whenever the repository carries a config. The LAZERS config uses
  Fallow's own shape, so it can be committed later unchanged.
- **A stored LAZERS config that a repo file shadows is reported** by
  `lz-fallow-config`; it is kept, not deleted.
- **Append-only revisions.** Each change stores the full config, its hash, the
  session and agent, and a timestamp. This replaces the review a commit would
  have had.
- **A task cannot loosen its own review.** The repo file is read at the
  attempt's base commit. Workers (Implementor, Auditor) cannot set the LAZERS
  config; the permission is denied in `src/runner/roles.ts` beside the
  delegation tools.
- **Receipts record the source.** Each check receipt carries which source
  applied and its content hash.
- **Plans and tasks carry no Fallow settings.**

Nothing is written to the working tree:

| Writer                              | Today                                                                                                                                                           | Plan                                                                                                          |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Fallow's cache directory `.fallow/` | The native binding writes it into the analysed root (27 MB on this repository, self-ignored by its own `.gitignore`). `fallowReport()` does not pass `noCache`. | The WASM module has no filesystem import, so it cannot. Until then, pass `noCache: true` (Phase 2 or earlier) |
| Config                              | None                                                                                                                                                            | LAZERS SQLite                                                                                                 |
| Baselines, reports                  | `audits/<runID>.json` beside the task database (`design/auditor.md`)                                                                                            | Unchanged                                                                                                     |

How the Architect learns a project has no usable config, as a runtime fact and
not a prompt rule:

```
first check in a project, no entry points in the effective config
  complexity + duplication   review as normal, Fallow defaults
  dead code                  off, omitted from results (not shown as zero)
  Architect notice           once per project:
                             "No Fallow entry points. Dead-code checks are off.
                              lz-fallow-config returns a draft."
```

`lz-fallow-config`:

| Call                | Who                | Effect                                                                                                |
| ------------------- | ------------------ | ----------------------------------------------------------------------------------------------------- |
| `{}`                | Architect, Auditor | Effective config, its source and hash, and what is missing                                            |
| `{ draft: true }`   | Architect          | A proposed config: Fallow's `recommend` output plus entry points the runtime can see. Stores nothing  |
| `{ set: <config> }` | Architect          | Validates with the analyzer, stores a new revision of the LAZERS config. No repository write, no task |

Location versus project: with the config keyed by project and passed to the
analyzer as text, OpenCode locations need no lookup. For the repo file,
Fallow searches upward to the workspace root and takes the first config
(`fallow.tools/docs/configuration/overview`); the host reproduces that search
at the base commit. Phase 1 tests both.

### State-machine fit

No new state. No new machine event. `lifecycleMachines` is unchanged.

| Need                                                    | Existing mechanism                                                                                                                                                         |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Journal and run the review                              | An effect in `effectMachine`, kind `verify:lazers-fallow` or `graph-verify:lazers-fallow`. Both prefixes are already re-runnable (`runtime.ts:413`)                        |
| Findings, or a failed check, with a repair attempt left | One `failAttempt()` → task `verifying --REPAIR--> ready` (`src/runner/machine.ts`). The repair attempt's input carries the Fallow findings and the check failures together |
| `completed`, with or without concerns                   | The existing `ACCEPT` path in `verify()`                                                                                                                                   |
| `unavailable` (analyzer error or timeout)               | The effect completes with a receipt marked `skipped`; `FALLOW_UNAVAILABLE` is recorded once; accept                                                                        |
| Findings only, no repair attempt left                   | Accept with concerns. Fallow alone never moves a task to `failed` and never raises a hold                                                                                  |
| Service restart mid-review                              | No receipt → superseded and re-run, as for any `verify:` effect                                                                                                            |

Looks are `1 + maxRepairAttempts` (default 1: the original attempt and its
repair). The review adds no repair of its own, no state and no hold, so it
cannot stall a task.

The receipt is a `CheckReceipt` with `command: "lazers:fallow-check"`. It is
recorded for the Trajectory but is not in the set `failAttempt()` reads, so a
Fallow result can never fail an attempt. `lazers-fallow` becomes a reserved
check ID; `PlanInput` validation rejects an authored check with that ID
(`src/runner/schema.ts:153`).

Later optimisation, not planned work: send feedback to the same session
instead (task `verifying --RESUME--> running`), which keeps the worker's
context and prompt cache. It needs a runtime-initiated continuation from
`verifying` that does not exist yet; today's resume paths are
Architect-commanded or interruption-driven.

### Contract change

`docs/reference/contributor-contracts.md:53`, `design/auditor.md` and the
`lz-fallow-report` description say Fallow never gates. The new rule:

> Fallow findings are feedback. A repair attempt gets them and may resolve
> what the task introduced. The runtime then accepts a result that is resolved
> or no worse and reports what remains to the Architect. Scores and older
> findings never block.

## Phases

Each phase is one or more atomic commits on a branch and ends with
`bun run verify` plus the listed checks.

### Phase 0: vendor and reproduce the spike

1. `scripts/vendor-fallow.ts`, `vendor/fallow/` at `v3.43.2`,
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
explained; start time, check time and memory are measured and written
into this plan against the budgets; a failed budget is reported, not hidden. Module size has no
budget (owner decision 2026-11-19: speed matters more than size).

Stop and return to the owner when: duplication cannot be built without
rewriting the detector.

#### Phase 1 (measured results, 2026-11-19)

Pin `v3.43.2` (`b6a3e048dc88`), native `@fallow-cli/fallow-node` 3.43.2,
rustc 1.98.1 (the pin declares `rust-version = "1.97"`, so no toolchain change),
`wasm-bindgen` 0.2.130, `wasm-opt` 129. Build: `bun scripts/build-fallow-wasm.ts`.

What builds for `wasm32-unknown-unknown`: `fallow-types`, `-config`, `-extract`,
`-graph`, `-core`, `-engine` (the whole engine, not only the detector), `-security`,
`-output`, `-mutation`, `-process`. The detector did not need rewriting or a copy
into the binding crate.

Patch queue (`vendor/fallow-patches/`, changed lines excluding context):

| Patch                                              | Lines | Why                                                                                           |
| -------------------------------------------------- | ----- | --------------------------------------------------------------------------------------------- |
| 0001 extract cache size assertions on 64-bit only  | 1     | `CachedModule` and friends are asserted at 64-bit sizes                                       |
| 0002 `fallow-config` `remote-extends` feature      | 24    | `ureq`, `rustls`, `ring` behind an off-by-default feature; remote fetch returns an error      |
| 0003 drop `[[bench]]` targets from core and engine | 21    | benches are not imported; cargo validates them for path dependencies                          |
| 0004 engine on targets without unix or windows     | 35    | git path bytes, churn cache paths, `file://` URLs, dependency symlinks                        |
| 0005 duplication from in-memory sources            | 67    | `detect_duplicates_in_memory` and `find_duplicates_in_memory`: no read, no metadata, no cache |
| 0006 step timing without a clock                   | 58    | `Instant::now()` and `SystemTime::now()` panic on this target                                 |

Total 206 changed lines. The spike's "JavaScript entropy" patch is not needed.

- **`getrandom`:** a fixed-seed custom backend (`crates/fallow-wasm/src/entropy.rs`,
  `--cfg getrandom_backend="custom"` in `crates/fallow-wasm/.cargo/config.toml`).
  Only `getrandom` 0.3 is in the tree for this target. Entropy only seeds
  `ahash` hash maps, so the module is deterministic and needs no host import.
- **Imports declared** (`WebAssembly.Module.imports`): three, all
  wasm-bindgen glue and none a capability: `__wbindgen_string_get` (reads the
  string arrays the host passes in), `__wbindgen_throw`,
  `__wbindgen_init_externref_table`. The test pins this list. Panics are recorded
  in a buffer the host reads with `lastPanic()` after the resulting trap.
- **Rayon** runs on the calling thread on this target; no thread is spawned.
- **Surface** (`Project` in `crates/fallow-wasm/src/project.rs`): constructor
  `(root, paths, contents, configName, configText)`; `duplication(changed, optionsJson)`,
  `complexity(paths)`, `featureFlags(paths)`; every call returns `{ok:true,...}` or
  `{error:{code,message}}`. Codes: `remote-extends-unsupported`, `extends-unsupported`
  (local or `npm:` extends: the host must inline it), `config-invalid`, `options-invalid`.
  The adapter applies source extensions, `ignorePatterns` and discovery's hidden-directory
  rule. Per-file `parse` and `complexity` exports remain.
- **Not done: dead code and architecture (cycles).** They compile, but cannot run:
  they need `oxc_resolver` module resolution, plugin and `package.json`/`tsconfig`
  discovery over a real filesystem (about 2,200 `std::fs` call sites across core,
  graph, config and engine). A virtual filesystem under the resolver is a separate
  piece of work, well past the patch budget. Feature flags need none of that and are
  exposed.

Parity against native 3.43.2 (one-time A/B check, since removed):

| Check                              | This repository (371 analysed files)                      | Fixture (4 files)   |
| ---------------------------------- | --------------------------------------------------------- | ------------------- |
| Clone groups, file and line ranges | 187 of 187 identical; token and line counts identical     | identical           |
| Duplication stats                  | files, lines, duplicated lines, group count identical     | n/a                 |
| Complexity findings                | 377 of 377 identical (cyclomatic, cognitive, name, line)  | identical           |
| Feature flags                      | none in this repository                                   | identical (2 flags) |
| Changed-file run                   | equals the full run filtered to groups touching the files | n/a                 |
| Dead-code finding keys             | not available                                             | not available       |

Differences, all explained:

1. **CRAP-only complexity findings** (358 of native's 735 here) are absent: they need
   the coverage model. The module lists cyclomatic and cognitive findings only.
2. **File set.** Native walks the disk; the module takes the host's list. They agree
   when the host passes `git ls-files`; untracked, unignored files are the host's call.
3. **Remote and local `extends`** return an error; native follows local ones.

Measurements, this repository, Apple silicon, Bun 1.4.4, module run in a `Worker`
(a 10-iteration loop after one warm-up; p95 over those 10):

| Budget                             | Limit   | Measured                                                                                                                                       | Result |
| ---------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Worker start to module ready       | 300 ms  | 15 ms (first call 5 ms)                                                                                                                        | pass   |
| Changed-file check, 10 files       | 2 s p95 | 235 ms p50, 370 to 465 ms p95 for complexity and duplication; with reading 647 files and building the `Project`, 255 ms p50, 410 to 500 ms p95 | pass   |
| Whole-repository duplication       | 15 s    | 221 ms p50, 225 to 238 ms p95; whole-repository complexity 1.4 s                                                                               | pass   |
| Worker memory (recorded, no limit) | n/a     | wasm linear memory 98.6 MB; worker RSS about 220 MB after the run                                                                              | n/a    |

That first build was size-optimised (`opt-level = "z"`, fat LTO, 4.86 MB). There is no size
budget (owner decision 2026-11-19); the shipped module is built for speed, see "Build settings".
A changed-file check re-tokenizes the whole corpus (the cost is the corpus, not the 10
files), so it is about as slow as a full run; a token cache across calls would remove that.

### Phase 2: worker and tools

1. `src/audit/fallow-worker.ts`, `FallowClient`, `wasmURL`; entries in
   `scripts/build-server.ts` and `scripts/release-package.ts`.
2. `lz-fallow-report` runs on WASM. Remove `@fallow-cli/fallow-node` and its
   companions from `package.json`.
3. Add `lz-fallow-audit`, `lz-fallow-dupes`, `lz-fallow-health`,
   `lz-fallow-dead-code` with permissions per role in `src/runner/roles.ts`.

Accept when: existing `src/audit/*.test.ts` pass on WASM; a release archive
installed with `bun add --ignore-scripts` contains no Fallow `.node` or Mach-O
file; aborting a request terminates the worker and the next request succeeds;
the service event loop stays responsive during a full report (measured with
the existing stall probe); each tool's output for this repository is under
8 KB at default `limit`.

### Phase 3: the task review

1. `verify()` collects every failing authored check into the repair input
   instead of the first. Lands on its own, before any Fallow code, with a test
   that two failing checks both reach the repair attempt.
1. Attribution in the host (complexity base-side, added-line overlap).
1. `FallowReview`: analyzer result into introduced findings and concerns for
   one attempt.
1. `verify:lazers-fallow` in `TaskRuntime.verify()`, after mechanical
   preparation and alongside the authored checks; one combined decision;
   receipt, guidance text,
   `REPAIR` with the findings in the repair attempt's input on `feedback`, `FALLOW_UNAVAILABLE`,
   reserved check ID, plugin option `fallowReview: "on" | "off"`.
1. Three lines in `src/implementor.md`; contract wording in the three places
   named above.

Accept when, in `runtime.test.ts`: a task that adds a clone moves `REPAIR`,
the repair attempt's dispatch input contains the guidance, and it is accepted
clean after it removes the clone; a task whose repair attempt does not fix it
is accepted with the concern in the `task-accepted` outcome and is never
`failed` or held; a task that adds a clone and breaks a test gets exactly one
`REPAIR` whose input contains both the Fallow findings and the test failure;
a task whose test still fails after the repair holds as it does today, with
the Fallow findings attached; an unchanged tree replays its review result; a
task that edits a file with an old over-limit function, without touching it,
gets no feedback; an analyzer error accepts the task and records
`FALLOW_UNAVAILABLE` once; a restart mid-review re-runs it;
`lifecycle-machines.test.ts`, `lifecycle-dead-ends.test.ts` and
`hold-actions.test.ts` pass unchanged. And in the Desktop walkthrough: the
Trajectory checks lane shows the review on each attempt; what Radar shows is recorded here.

### Phase 4: Auditor and the plan review

1. Runtime runs the baseline report when an Auditor attempt starts and the
   follow-up at verification; `src/auditor.md` stops telling the model to
   start the scan.
2. `graph-verify:lazers-fallow` in `TaskRuntime.finish()` with dead code and
   cycles.
3. Warnings in the `task-accepted` outcome.
4. Look for a library entry for `trace`; add `lz-fallow-trace` only if found.

Accept when: two tasks that each add the same helper pass alone, and the plan
outcome names both locations without holding the plan; an Auditor attempt has
a baseline and a linked follow-up without the model calling
`lz-fallow-report`.

### Agents

| Phase | Lane                              | Agent              | Model  |
| ----- | --------------------------------- | ------------------ | ------ |
| 0, 1  | Rust: vendoring, patches, binding | `fallow-wasm`      | Sonnet |
| 2     | Worker, client, tools, packaging  | `audit-tools`      | Sonnet |
| 3, 4  | Runtime review                    | `runner-review`    | Sonnet |
| all   | Tests, `bun run verify`, builds   | `runner` per phase | Haiku  |

Phase 1 may need a step up for the engine patches; say so when it happens.

## Live verification in OpenCode, 2026-11-19

Driver-assisted. The driver (Claude) built and merged everything below,
reloaded the regular OpenCode service, re-enabled Architect contact and drove
the session. What the product did on its own is marked "product"; what the
driver fixed is marked "driver".

### What ran

| Run                                    | Plan       | Result                                                                                                                                                                                                                                                                                                                |
| -------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auditor task LZ-241, first base        | `2a6c1efd` | Review ran (`clean`). Two authored checks failed for reasons on `main`, one repair with both failures in its prompt, then fail and hold. Product                                                                                                                                                                      |
| Same work, fresh plan                  | `9f85d801` | Dispatched in 3 minutes; `verify-run`, `test-audit`, `lazers-fallow` (clean, 1.9 s) passed; task and plan accepted; integrated as `e1363c59`. The callback in `src/audit/history.ts` went from cognitive 27 to 6. Product                                                                                             |
| Probe 1, intentional clone and nesting | `c959a3c6` | Review found 3 introduced findings; one `REPAIR`, guidance in the repair prompt; the repair worker asked which of task and review wins; accepted. Exposed the repair-base defect below                                                                                                                                |
| Probe 2, same, after fixes             | `7b7432f1` | First attempt: 2 findings, guidance as designed. Repair attempt: review again reported 2 introduced and 1 dead-code concern; task accepted, never failed or held; `task-accepted` carried all three for the Architect. Product                                                                                        |
| Auditor task after Phase 4             | `f54b6582` | `projectProgressFact` in `src/progress/projection.ts` split. Task review clean (4.9 s); plan-level review `graph-verify:lazers-fallow` clean (7.0 s, includes native dead code and cycles); the runtime started the Auditor baseline (7.0 s) and the linked follow-up (7.8 s) itself; no `.fallow` directory. Product |

Guidance the worker received in probe 2:

```
Fallow review: 2 findings introduced by this task. Older findings are not counted.
1. complexity src/audit/probe-clone-2.ts:43 `probeClassify2` cognitive 201 (limit 15), cyclomatic 38 (limit 20).
   Split it into smaller named functions.
2. duplication src/audit/probe-clone-2.ts:1-43 repeats src/audit/attribution.ts:73-114 (43 lines).
   Keep one implementation and import it instead of copying it.
Fix these inside your write scope. Do not add fallow-ignore comments.
```

### Defects the walkthrough found, all fixed by the driver and re-verified live

| Defect                                                                                                                                                | Fix                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lz-fallow-*` tools returned nothing for a directory in `paths`                                                                                       | `resolveToolPaths`, `src/audit/fallow-tools-support.ts`                                                                                                     |
| Scheduler ticks took 11 to 20 minutes: a cancelled plan's cleanup ran a squash search of up to 15,600 diffs every tick and ran before all other plans | Bounded, memoised containment proof (`src/runner/change-identity.ts`); terminal cleanup runs after runnable plans; `PLAN_STEP_SLOW` record names slow steps |
| Starting an Architect renewal threw `UNIQUE constraint failed: runner_architect_sources.session_id`                                                   | Upsert on both paths, `src/runner/store.ts`                                                                                                                 |
| `bun check` failed in every fresh worker worktree: a test fixture re-exported from `echarts`, which is not a dependency                               | Dead export removed. Fallow's self-scan had flagged it as an unlisted dependency                                                                            |
| A WASM parity test required findings in a file the Auditor had just fixed                                                                             | Repository parity tests derive their inputs from the tree                                                                                                   |
| Changed-file duplication grouped clones differently from the full run (upstream behaviour, native too)                                                | The module always runs the full detection and filters; the focused path is deleted                                                                          |
| A repair attempt's review compared its artifact with itself and read `clean`                                                                          | Review base is the task's attempt chain, `taskChainBase` in `src/runner/runtime.ts`                                                                         |
| Guidance anchored a clone in the original file, split adjacent clones in two, and named no metric                                                     | `src/audit/review.ts`, `attribution.ts`                                                                                                                     |
| The dead-code pass had made the `ArchitectContact` RPC contract private; only the operator's script imports it                                        | Re-exported and listed in `ignoreExports`                                                                                                                   |

### What is in WebAssembly and what is not

Everything. Superseded 2026-11-19 by "Everything runs in WebAssembly" below. No Fallow npm
package is a dependency of any kind (see "Verification without a native reference").

## Everything runs in WebAssembly (2026-11-19)

Owner decision: LAZERS requires no native binary. Dead code, import cycles, architecture,
feature flags, duplication, health and the in-memory complexity and clone operations all run
in `src/audit/wasm/fallow.wasm`; `lz-fallow-report`, the task review, the plan review and the
tools use no other engine. Branch `feat/fallow-wasi`.

### Approach

| Choice               | Decision                                                                                                                                                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Target               | `wasm32-wasip1`, a WASI command: JSON request on stdin, JSON envelope on stdout, panic text on stderr. One instance per request. No `wasm-bindgen`                                                                          |
| Entry points         | `fallow-api` (vendored, `crates/api`): `run_dead_code`, `run_circular_dependencies`, `run_architecture`, `run_feature_flags`, `run_duplication`, `run_health_with_runner`, with the same serializers the napi crate uses    |
| Filesystem           | Rust `std::fs` compiles to WASI imports. The host (`src/audit/fallow-wasi.ts`) serves them with Bun's `node:wasi`: one preopen, the real project root, plus the config's directory when it lies outside                     |
| Read-only            | Every write-capable import returns EROFS, `path_open` refuses create, truncate, append and write rights. Bun refuses paths and symlinks that leave a preopen. The analysis passes `no_cache`, so nothing is written         |
| Host calls           | Only `lazers_host.git_run` and `git_result`, for the `git` the engine runs (HEAD, shallow state, churn, default branch). The host allows read-only subcommands under the root and nothing else; a refusal reads as "no git" |
| Entropy, clock, exit | `random_get` is a fixed seed (deterministic output). `proc_exit` throws a catchable error (Bun's own would end the process). Clock is Bun's                                                                                 |
| Cancellation         | Unchanged: the worker thread hosts the module; abort or timeout terminates the worker. A trap becomes `analyzer-panic` with the stderr tail. Whole-repository report sections get a 10 minute limit, review calls keep 60 s |

Evidence for each open question in the brief:

- **`fs::canonicalize`** fails with `ENOENT` for every path on WASI (std calls libc
  `realpath`, and wasi-libc's has no working directory). The vendored crates call it at about
  400 sites. `crates/fallow-wasm/src/realpath.rs` defines the `realpath` symbol, which the
  linker prefers to libc's. It resolves symlinks with `read_link` and `symlink_metadata`. No
  vendor patch is needed.
- **rayon without threads**: `worker_pool_builder` is patched (0007) to
  `num_threads(1).use_current_thread()` on WASI. The `ignore` crate's parallel walker spawns
  scoped threads, so discovery uses its sequential walker (0007), and the health churn load runs after
  scoring instead of on a second thread (0007). Thread spawning fails on WASI by design, and the
  engine's per-file stack thread already falls back to running in place.
- **`Command::new("git")`** reaches the report: health runs `rev-parse`, `log -1`,
  `rev-parse --is-shallow-repository`, and `log --numstat` (hotspots, change coupling);
  dead code, architecture and cycles run `rev-parse --git-dir`, `symbolic-ref` and
  `rev-parse --verify` for the default branch. `std::process::Command` is unsupported on WASI
  and `Output` cannot be built, so the engine's git calls go through `fallow_engine::git_process`
  (0008): `std::process` on native targets, a host call on WASI. Nothing is dropped:
  hotspots (367) and change coupling equal native.
- **Cache**: `no_cache` is set and the shim is read-only; tests assert the tree is
  byte-identical (`.git` included) and no `.fallow` exists after every operation.
- **Local `extends`** resolves through the filesystem (`FallowConfig::load`); a remote `extends`
  stays an explicit `remote-extends-unsupported` error, `npm:` too.
- **`node:wasi` in Bun 1.4.4** (the release OpenCode ships, `BUN_BE_BUN=1 opencode-cli`; also
  the 1.4.4 canary): it has `wasiImport` and `start()` but no `getImportObject()`, so the
  imports are `{ wasi_snapshot_preview1: wasi.wasiImport }`. It ignores `stdin`, `stdout` and
  `stderr`, so `fd_read` and `fd_write` are replaced for fds 0 to 2. `proc_exit` is replaced as
  above. No hand-written WASI shim was needed. One defect to know: Bun fails any symlink that
  points outside the preopens with `ENOTCAPABLE`, so a project whose `node_modules` links to a
  directory above the root needs that directory preopened (`extraRoots`); none of the tests,
  and not this repository, does.

Patch queue additions (`vendor/fallow-patches/`): 0007 (no threads on WASI: pool, walker,
churn), 0008 (git through a host call). `crates/api` is now imported.

### Verification without a native reference

The port was checked once against native Fallow 3.43.2 and that comparison is finished. Its
tests, `native-reference.ts` and the `@fallow-cli/fallow-node` dev dependency were deleted on
2026-11-19 (owner rule: no native binary may be downloaded, even by a dev install), and no
snapshot of native output was kept. `package.json` and `bun.lock` are tested never to name
a Fallow package. What verifies our use of Fallow now are hand-written tests with
expectations written against small fixture projects, run on both modules and required to
agree with each other: `src/audit/wasm/fallow-analysis.test.ts` (dead code, cycles,
architecture, duplication, complexity, feature flags, symlinked `node_modules`, local and
remote `extends`, and invariants for this repository only: no error, deterministic, plausible
counts), `src/audit/wasm/fallow-wasm.test.ts` (host: read-only, git refusals, import surface,
helper reuse, termination), `src/audit/fallow-threads.test.ts` (option, module choice,
fallback), and the review layer tests in `src/audit/`. What the removal cost: nothing checks
that a new Fallow version agrees with the previous one on real code; a version bump now
relies on those tests and on reading the changelog.

The one-time A/B result, for the record (Bun 1.4.4 canary and 1.4.4 release). On this repository
and on a fixture whose dependency is reached through `node_modules/dep-a -> ../packages/dep-a`.
Each report is compared whole, field for field, with `elapsed_ms` removed. Counts are from the tree at measurement time.

| Report                         | This repository                                                                                                                            | Fixture                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Dead code                      | identical (12 unused exports, 2 unused types, 6 duplicate exports, 1 unused and 1 unused dev dependency, 2 dev dependencies in production) | identical (orphan file, unused export, unused dependency; `dep-a` resolves through the link) |
| Import cycles                  | identical                                                                                                                                  | identical (one cycle)                                                                        |
| Architecture                   | identical                                                                                                                                  | identical                                                                                    |
| Feature flags                  | identical                                                                                                                                  | identical                                                                                    |
| Duplication report             | identical (191 groups)                                                                                                                     | identical                                                                                    |
| Health                         | identical (771 findings, 367 hotspots, 622 file scores, 126 targets)                                                                       | identical                                                                                    |
| In-memory complexity and clone | same locations, apart from CRAP-only findings                                                                                              | same count and names                                                                         |

Differences from native, all of them intended:

1. CRAP-only complexity findings, and `col`, `param_count`, `crap` and `actions` of
   `HealthFinding`, are absent from the lighter in-memory `complexity` operation the review
   uses. The `health` section (`lz-fallow-report`) has all of them.
2. Native keeps process-wide state: a `change-coupling-skipped` diagnostic from an earlier
   health call on the same root appears in the `workspace_diagnostics` of later sections of
   that process. Each module call starts clean and reports it in health only.
3. The module reads at most 4 MiB per file for the in-memory operations (as before).
4. Run `threads` is 1.

### Timings, this repository, Apple silicon, Bun 1.4.4

| Analysis                             | WebAssembly | Native, `threads: 1` |
| ------------------------------------ | ----------- | -------------------- |
| Dead code                            | 2.1 s       | 1.2 s                |
| Import cycles                        | 1.8 s       | 1.2 s                |
| Architecture                         | 1.8 s       | 1.2 s                |
| Feature flags                        | 1.8 s       | 1.1 s                |
| Duplication report                   | 0.41 s      | 0.24 s               |
| Health (with CSS, hotspots)          | 4.2 s       | 2.9 s                |
| Five-section report (sum)            | 10.3 s      | 6.5 s                |
| First call, worker and module start  | 343 ms      |                      |
| 3-file complexity, warm worker       | 43 ms       |                      |
| Changed-set duplication, warm worker | 544 ms      |                      |

Module: 12.5 MB after `wasm-opt -Oz` (20 MB before), as first measured; see "Build settings"
for the shipped speed build. There is no size budget. Worker RSS 171 MB after those calls. The
five-section total is inside the 15 s budget.

### Build settings (2026-11-19): speed first, no size budget

Owner decision: speed matters more than size. Every combination was built from the same
sources and run on this repository, the five report sections in sequence (dead code, duplication,
health, architecture, feature flags), Bun 1.4.4 canary, quiet Apple silicon machine, three runs
each (the machine drifts by up to 15% between runs, so min and median are both shown):

| `opt-level` | `wasm-opt` | Size    | Five sections, min / median |
| ----------- | ---------- | ------- | --------------------------- |
| `"z"`       | `-Oz`      | 12.5 MB | 13.0 s / 17.8 s (noisy)     |
| `"z"`       | `-O3`      | 12.8 MB | 11.9 s / 11.9 s             |
| `"z"`       | `-O4`      | 12.8 MB | 11.0 s / 11.2 s             |
| `"s"`       | `-Oz`      | 17.2 MB | 9.2 s / 9.4 s               |
| `"s"`       | `-O3`      | 17.3 MB | 9.4 s / 9.5 s               |
| `"s"`       | `-O4`      | 17.3 MB | 8.9 s / 11.9 s (noisy)      |
| `3`         | `-Oz`      | 23.0 MB | 8.5 s / 9.1 s               |
| `3`         | `-O3`      | 23.2 MB | 8.7 s / 8.9 s               |
| `3`         | `-O4`      | 23.2 MB | 8.8 s / 9.4 s               |

LTO stays fat. `opt-level = 3` is about 25% faster than `"z"` and about 5% faster than `"s"`.
The `wasm-opt` level makes no measurable difference once Rust has optimised for speed: five
more interleaved runs of the three `opt-level = 3` modules gave medians of 9.7 s (`-Oz`), 9.7 s
(`-O3`) and 9.2 s (`-O4`) with a spread larger than that. Shipped: `opt-level = 3` and
`wasm-opt -O3`; 23.2 MB. Five-section run on this repository, single run per section, median
of three: dead code 1.8 s, duplication 0.35 s, health 3.9 s, architecture 1.45 s, feature flags
1.4 s, total 8.8 s.

### Threads (`wasm32-wasip1-threads`): shipped, on by default behind `fallowThreads`

Owner decision (2026-11-19): ship the threaded module and turn it on by default, with no
file-count threshold, whatever the measurements say. They are recorded below so the default can
be revisited.

**Setting.** Plugin option `fallowThreads: "on" | "off"` beside `fallowReview`, read in
`src/core/core.ts` (`parseFallowThreads`: anything but `"off"` is `"on"`) and applied with
`setFallowThreads` in `src/audit/wasm-analyzer.ts`; each analysis request carries it. `"off"`
uses the single-threaded module exactly as before and never loads the threaded one.

**Artifacts.** `src/audit/wasm/fallow.wasm` and `fallow-threads.wasm`, both committed, both
described in `ARTIFACT.json`, both copied to `dist/` by `scripts/build-server.ts` and packaged by
`scripts/release-package.ts`, with the helper script `fallow-thread.js` (spawned through
`workerURL`). Both are built by `bun scripts/build-fallow-wasm.ts` (opt-level 3, `wasm-opt -O3`,
23.2 MB each). Patch 0009 keeps rayon's requested pool size when `target_feature = "atomics"`.

**Threads.** The pool is two threads, the constant `MAX_FALLOW_THREADS`. The module imports a
shared `env.memory` (65535 pages up front, 65536 maximum) and `wasi.thread-spawn`; the host grants
at most two spawns per run and refuses the rest (the engine tries one thread per deeply nested
file and then runs it in place). Helper workers belong to the analysis worker and are reused:
when a run ends, the rayon pool shuts down, each helper's `wasi_thread_start` returns and sets a
shared flag, and the next run hands the idle helper a new instance and memory. A helper that has
not returned within 100 ms is terminated. So the wasi-threads model does not force re-creation:
the first run creates two workers and later runs reuse them. Measured on this repository,
duplication: 398 ms with creation, about 300 ms reusing. Idle helpers are unref'd; terminating the
analysis worker (abort or timeout) takes its helpers with it, and a test starts a threaded run in
a child process, cancels it and checks the process exits by itself. Nothing writes to the
analysed tree: every helper has its own read-only WASI instance.

**Safety net.** If shared memory is unavailable, the threaded module fails to load, or a
threaded call traps, that call runs again on the single-threaded module, every later call in the
process does too, and the reason is logged once (`Fallow threaded analysis unavailable; using
the single-threaded module`). A helper that traps while the main thread waits cannot be seen from
outside; the request's timeout ends such a run (it then falls under the usual timeout error).
Tests: option parsing and default, "off" never loads the threaded module, an injected failing
and an injected trapping threaded module fall back, abort terminates helpers, the bundled worker
serves both modules, `test/runner/recovery.test.ts` passes with threads on.

**End to end, off versus on.** Through the real analyzer (worker, request, report) in a fresh
process per cell, median of the runs shown (two for the first three corpora, one for the larger),
Apple silicon, Bun 1.4.4 canary. "First tiny call" is a one-file complexity request on a cold
process: worker, module compile and, with threads on, helper start. "Review" is the shape of a
per-task review: complexity of 10 files twice, a changed-set duplication, and dead code twice.
Peak RSS is the whole process.

| Corpus (files)                  | Threads | First tiny call | Dead code, warm | Health | Five sections | Review | Peak RSS |
| ------------------------------- | ------- | --------------- | --------------- | ------ | ------------- | ------ | -------- |
| This repository (~700)          | off     | 0.07 s          | 1.75 s          | 4.28 s | 9.5 s         | 4.0 s  | 1.11 GB  |
|                                 | on      | 0.06 s          | 1.51 s          | 3.71 s | 8.3 s         | 3.4 s  | 1.05 GB  |
| Real tree (~6k incl. `.d.ts`)   | off     | 0.06 s          | 1.92 s          | 3.54 s | 10.6 s        | 5.3 s  | 1.44 GB  |
|                                 | on      | 0.07 s          | 1.71 s          | 3.36 s | 9.5 s         | 4.6 s  | 1.49 GB  |
| `src/` x 5 (~3.0k)              | off     | 0.07 s          | 6.2 s           | 9.9 s  | 31.7 s        | 14.7 s | 2.50 GB  |
|                                 | on      | 0.08 s          | 6.5 s           | 10.1 s | 30.2 s        | 13.6 s | 2.86 GB  |
| `src/` x 17 (~10k)              | off     | 0.07 s          | 21.1 s          | 33.6 s | 101.5 s       | 46.8 s | 4.90 GB  |
|                                 | on      | 0.09 s          | 22.2 s          | 36.4 s | 107.6 s       | 46.1 s | 5.50 GB  |
| small `src/` files x 124 (~30k) | off     | 0.07 s          | 26.5 s          | 41.9 s | 123.1 s       | 58.0 s | 3.11 GB  |
|                                 | on      | 0.10 s          | 27.7 s          | 44.5 s | 126.8 s       | 60.2 s | 5.99 GB  |

Reading it: with threads on, up to about 6k files the analyses are 8 to 15% faster; around 3k
the two are level; from 10k files on threads on are 0 to 6% slower and use 12 to 90% more
memory. Cold start costs the same either way (tens of milliseconds). 30k full-size files do not
run on either module (wasm32 memory). Revisit the default if large projects matter more than
the 650 to 6k file ones the review mostly sees. The bare-module comparison made before the decision
(directly on the modules, one thread against two) saw no speedup at any size, so the gain
above is small and may come from work moving off the analysis worker's own thread; it was not
investigated further.

#### Module-level A/B, before the decision

Module-level A/B (2026-11-19), run before the decision below: the threaded module was rebuilt (`opt-level = 3`, `wasm-opt -O3`, 23.2 MB),
with the host refusing helper threads beyond the pool (hard cap 2), and compared with the
single-threaded module on corpora up to 30k files. Reports from both modules were identical
(dead code compared whole, `elapsed_ms` removed). Wall time is the median of the runs listed;
peak RSS is the largest seen, from `/usr/bin/time -l` on a process that ran the five sections
in sequence. Five sections = dead code, duplication, health, architecture, feature flags.

| Corpus                                                                         | Files | Runs | Threads | Dead code     | Health | Five sections | Peak RSS |
| ------------------------------------------------------------------------------ | ----- | ---- | ------- | ------------- | ------ | ------------- | -------- |
| This repository                                                                | ~700  | 3    | 1       | 1.8 s         | 3.9 s  | 8.8 s         | 0.98 GB  |
|                                                                                |       | 2    | 2       | 1.9 s         | 3.8 s  | 9.0 s         | 1.25 GB  |
| Real: happy-dom, OpenTelemetry, Redis client, zod (copied from `node_modules`) | ~6.1k | 2    | 1       | 1.9 s         | 3.2 s  | 9.6 s         | 0.94 GB  |
|                                                                                |       | 2    | 2       | 1.9 s         | 3.1 s  | 9.4 s         | 1.56 GB  |
| This repository's `src/` x 5                                                   | ~3.0k | 2    | 1       | 6.7 s         | 9.8 s  | 30.5 s        | 1.86 GB  |
|                                                                                |       | 2    | 2       | 6.8 s         | 10.5 s | 32.2 s        | 3.45 GB  |
| `src/` x 17                                                                    | ~10k  | 2    | 1       | 20.9 s        | 34.0 s | 101.3 s       | 4.37 GB  |
|                                                                                |       | 2    | 2       | 21.6 s        | 35.7 s | 108.6 s       | 5.27 GB  |
| `src/` files under 6 KB x 124                                                  | ~30k  | 1    | 1       | 27.1 s        | 36.8 s | 119.6 s       | 3.37 GB  |
|                                                                                |       | 1    | 2       | 25.7 s        | 44.1 s | 143.3 s       | 6.79 GB  |
| `src/` x 51 (full-size files)                                                  | ~30k  | 1    | 1 and 2 | out of memory |        |               |          |

Measured on the bare modules, two threads are not faster beyond noise (one dead-code run at 30k is 5% quicker, its health
run 20% slower), and use 1.3 to 2 times the memory. Duplication, the most parallel looking phase,
is no faster either. The cause was not proven. The two helper threads ran (the host granted
both) but CPU time equalled the single-threaded run, so the work stayed effectively serial. The
likely suspects are one global allocator lock (the Rust and `wasi-libc` allocator is a single
heap shared by all threads, and tokenising and parsing allocate constantly) and the host
serving every file read through one JavaScript WASI implementation per thread. Neither was
tested; a per-thread allocator would be the first thing to try.

Limits found on the way, which matter more than threads:

- **wasm32 memory.** Linear memory ends at 4 GiB. The single-threaded module analyses 10k
  full-size files (peak RSS 4.4 GB) and 30k small files (3.4 GB), and runs out of memory at
  30k full-size files (`memory allocation of 27157728 bytes failed`). A real tree that includes
  `effect` (a few thousand files with very large type-level sources) fails in `health` asking
  for one 1.6 GB allocation. Failures arrive as `analyzer-panic` with the allocation message.
  Native has no such ceiling; a project beyond it needs a fallback or a smaller scope, which is
  not built.
- **Signed pointers.** Beyond 2 GiB of linear memory the WASI host received negative pointers
  (`byteOffset cannot be negative`). Fixed in `src/audit/fallow-wasi.ts`: every import sees its
  arguments unsigned.
- **Bun and shared memory.** Growing a shared memory traps in Bun 1.4.4 ("Out of bounds
  access"), so a threaded module must start at its final size, and `wasi-libc` then only uses
  the pages the module declares. 4 GiB (minus one page, a full 4 GiB overflows the heap end)
  declared as the initial memory worked.

To retry the build from scratch: see the recipe in `crates/fallow-wasm/.cargo/config.toml`, patch 0009 and `src/audit/fallow-wasi.ts`.

## Memory, streaming and the cache (2026-11-19)

Branch `perf/fallow-memory`. Question from the owner: what eats the memory (about 1.1 GB on this
~700-file repository, 5 to 6 GB at 10k to 30k files, hard ceiling 4 GiB), do we load files more
than once, is the answer a cache, a narrower scope, streaming, islands? Everything below was
measured; the probes (`memstats` feature: allocation counters exported to the host, a host call
trace, and the retention probe op) are in `crates/fallow-wasm`.

### Where the memory is

The 1.1 GB is mostly not the analysis. For one process running the five report sections:

| Part                                                                         | MB                                            |
| ---------------------------------------------------------------------------- | --------------------------------------------- |
| Compiled single-threaded module (JavaScriptCore code for 23 MB of wasm)      | 167 to 194 (134 for the size-optimised build) |
| Compiled threaded module, when threads are on (instead of the single one)    | 107 more than the single, 300 with both       |
| Linear memory of the run in flight (dead code 140 to 159, health 145 to 213) | 140 to 213                                    |
| Linear memory of finished runs not yet collected (up to 3 of them)           | up to 450                                     |
| Bun itself                                                                   | about 60                                      |

Collecting between runs (`Bun.gc(true)` after each request in the worker) cut five whole-project
runs in one process from 627 MB to 466 MB peak. `opt-level = "z"` has the same linear peak as 3
(memory is data, not code) and compiles 60 MB smaller; speed stays the choice.

Inside linear memory, one run on this repository (counting allocator, single-threaded):

| Analysis                               | Linear peak | Peak live bytes | Files read                                                  | Notes                                                 |
| -------------------------------------- | ----------- | --------------- | ----------------------------------------------------------- | ----------------------------------------------------- |
| In-memory complexity                   | 137 MB      | 74 MB           | 750 once                                                    | per file, nothing kept but the answer                 |
| In-memory duplication                  | 121 MB      | 100 MB          | 750 once                                                    | token index of the whole corpus                       |
| Dead code, cycles, architecture, flags | 159 MB      | 88 MB           | 750 once, plus 186 `package.json`                           | live grows with files read, then the graph adds 14 MB |
| Duplication report                     | 107 MB      | 86 MB           | 750 once                                                    |                                                       |
| Health                                 | 213 MB      | 169 MB          | each source 5 to 8 times (69 MB read for 10.6 MB of source) | second structure on top of the dead-code parse        |

Linear memory minus peak live is 17 MB of base (the 16 MiB stack) plus allocator high-water,
about 55 MB here. The allocator is wasi-libc's dlmalloc; it never returns memory within a run,
so linear memory is the high-water mark. Trying `talc` instead gave the identical peak, so the
allocator is not the cost. Result envelopes are small (dead code 40 KB, health 1.7 MB) and
built once. `node_modules` is not parsed: 186 opens are `package.json` files (dependency checks),
not source.

**Does Fallow stream? Yes, per file, and it holds the summaries.** `parse_all_files_with_mode`
(`vendor/fallow/crates/extract/src/lib.rs:267`) runs a closure per file that reads, parses,
extracts and returns a `ModuleInfo`; the source text and the syntax tree die inside that closure,
and at most one file per pool thread is in flight. The `Vec<ParseFileResult>` it returns, and
then the session's `ParsedModuleCache` (`engine/src/session.rs`, `modules: Arc<[ModuleInfo]>`),
keep every `ModuleInfo` for the whole run; the graph is built from them (it adds only 14 MB).
So memory grows with the size of the summaries, which is the observed linear growth, and the
summaries were large: a retention probe parsing 711 files and dropping the source each time held

| Per `ModuleInfo` field | MB (of 80.1) | Share |
| ---------------------- | ------------ | ----- |
| `member_accesses`      | 30.4         | 38%   |
| `security_sinks`       | 24.0         | 30%   |
| `semantic_facts`       | 6.5          | 8%    |
| `complexity`           | 4.0          | 5%    |
| `callee_uses`          | 1.9          | 2%    |
| `line_offsets`         | 1.6          | 2%    |
| everything else        | 11.7         | 15%   |

that is 115 KB per file for 14 KB of source (8.0x), against a transient peak of 415 KB per file
while it is parsed (worst file 63 MB, bounded by the thread count). Health holds a second
structure on top (169 MB live against 88 MB for dead code on this repository; 257 KB per file
against 120 KB at 10k files), which this branch did not locate. Duplication needs every file's
hashed tokens at once (`TokenizedFile` per file, `engine/src/duplication_detector/mod.rs`),
because clone detection is a global index; it cannot stream.

### Repeated work across calls

One task review makes five whole-tree runs (complexity twice, duplication once, dead code
twice), each a fresh instance that re-reads and re-parses: about 4.0 s, 32 MB read, two
dead-code parses of the whole repository. Health re-opens each source 5 to 8 times inside one
run.

### What was changed

| Commit                                       | Change                                                                                                                      |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| analyzer-memory                              | A run that dies on a failed allocation is `analyzer-memory` ("the project is too large for analysis"), not `analyzer-panic` |
| collect between runs                         | `Bun.gc(true)` after each request                                                                                           |
| `.fallow` cache                              | Fallow's own cache in `<root>/.fallow`; the host confines writes to it; seeded across worktrees; see below                  |
| compact modules (patch 0010)                 | Identical `object.member` pairs collapse and the security facts are dropped as each file is extracted                       |
| warm cache reads nothing (patch 0011 + host) | Fingerprints become usable on WASI                                                                                          |

**Compaction.** Patch 0010 (`extract/src/lib.rs`, `compact_module`) runs in the per-file closure.
Identical pairs are one fact (the analyses ask whether a pair occurs; upstream already
de-duplicates template accesses the same way) and the security facts (sinks, tainted bindings,
sanitiser calls, controls, unresolved callees) are dropped unless the config turns a security
rule on (`rules.security-sink` or `security-client-server-leak`, found by loading the config in
`main.rs`); nothing this module reports reads them, and the cache stores modules without them,
so such a config also runs without the cache. All eight analyses give byte-identical reports
(`elapsed_ms` aside) on this repository before and after, and the fixture tests pass on both modules.

Peak linear memory, single-threaded module, no cache, MB (before / after):

| Corpus (files)                 | Dead code            | Health                        | Duplication report            | In-memory complexity |
| ------------------------------ | -------------------- | ----------------------------- | ----------------------------- | -------------------- |
| This repository (~700)         | 159 / 140            | 213 / 145                     | 107 / 107                     | 137 / 137            |
| `src/` x 5 (3.0k)              | 496 / 225            | 896 / 580                     | 425 / 425                     | 171 / 171            |
| `src/` x 17 (10.1k)            | 1589 / 514           | 2996 / 1921                   | 1394 / 1394                   | 282 / 282            |
| small `src/` files x 124 (31k) | 760 / 532            | 1473 / 1226                   | 783 / 783                     | not run              |
| `src/` x 51, full-size (30.4k) | out of memory / 1512 | out of memory / out of memory | out of memory / out of memory | not run              |
| `effect` package (2.9k)        | 85 / 58              | out of memory (css) / same    | not run                       | not run              |

So the 30k full-size corpus now fits for dead code, cycles, architecture and flags; the largest
corpus that fits every analysis is about 10k full-size files (health 1.9 GB, duplication
1.4 GB, both well inside 4 GiB; 20k is an estimate and was not run). Health and duplication at
30k full-size files still exceed 4 GiB.

**`effect` health is not a summary problem.** With `css: true` (the report sections pass it)
health on the `effect` package dies on one 1,593,191,936 byte allocation made after the last file
has been read, when live memory is 64 MB; it is identical before and after, and absent with
`css: false`. It points at the CSS analysis (`engine/src/health/css_analytics`), a structure
quadratic in something near 14,000 items. I did not find it.

### The cache

Fallow's cache (`cache.bin`, `graph-cache.bin`, `churn.bin`, `.gitignore` of `*`) is keyed by
file content hash and by size and time, discards a corrupt or foreign file, evicts the least
recently seen entries beyond its cap (128 MB here, passed as `FALLOW_CACHE_MAX_SIZE`), and ignores
itself, so `git status` stays clean and `git worktree remove` needs no force. It is on for whole-
project analyses up to 12,000 source files; above that it costs more memory than it is worth.
Cold, warm and fresh-worktree numbers on this repository (dead code / health / duplication
report / architecture / feature flags, seconds): no cache 1.7 / 3.8 / 0.32 / 1.4 / 1.4 (8.6 total); cold
1.6 / 3.8 / 0.31 / 0.47 / 0.45 (6.7, the later sections hit the cache of the earlier ones); warm 0.48 / 1.3 / 0.30 /
0.46 / 0.44 (3.0); a fresh clone, cold, same as no cache; a fresh clone seeded by copying
another checkout's `.fallow` 0.62 / 1.3 / 0.31 / 0.49 / 0.43 (entries match by content, not by
path or time).

After compaction (peak linear MB and time, cold run writes the cache, warm run reads it):

| Corpus (files)      | Analysis  | No cache       | Cold, cache on  | Warm          | Cache file |
| ------------------- | --------- | -------------- | --------------- | ------------- | ---------- |
| This repository     | dead code | 2.9 s, 140 MB  | 2.0 s, 140 MB   | 0.43 s, 63 MB | 9 MB       |
|                     | health    | 4.6 s, 145 MB  | 4.4 s, 145 MB   | 1.0 s, 141 MB | 11 MB      |
| `src/` x 5 (3.0k)   | dead code | 8.3 s, 225 MB  | 6.7 s, 382 MB   | 1.1 s, 217 MB | 40 MB      |
|                     | health    | 16.6 s, 580 MB | 14.0 s, 580 MB  | 3.9 s, 567 MB | 46 MB      |
| `src/` x 17 (10.1k) | dead code | 32.8 s, 514 MB | 29.5 s, 1266 MB | 3.1 s, 698 MB | 137 MB     |

Warm runs are four to ten times faster. A cold run that writes the cache holds it decoded and
encoded as well, which is why the bound is 12,000 files.

Before the fingerprint fix a warm run read and hashed every source anyway: std exposes no change
time on WASI, so `SourceFingerprint::is_trustworthy_without_content` was never true and the
engine's "unchanged file contributes its cached summary without being read" path
(`extract/src/lib.rs:488`) never ran. Bun also answers a stat by path in whole milliseconds
(with float noise) and a stat of an open file in nanoseconds, so the two views of one file never
matched. The host now reports the later of modification and change time as the modification time,
rounded for a path stat and cut for an open file, to whole milliseconds; the module treats that as
the change time (patch 0011). A warm run now reads no source file (tested: zero source bytes read
on the second run). A file whose size and time are unchanged but whose content differs would be
missed; the change time folded into the modification time and Fallow's three-second settle window
guard against that as they do natively. A cache cannot be trusted across a config that turns the
security rules on, so that config runs without it.

**The review.** Candidate and base trees seed from each other and from the canonical checkout
(`cacheSeed`, `cachePublish`); the canonical checkout receives the candidate's cache after a run,
so later fresh worktrees start warm. Writing into the canonical checkout's `.fallow` is the one
place outside the analysed tree that is written; it is the same ignored directory. One task review
(complexity x2, changed-set duplication, dead code x2 on this repository), fresh worktree and a
fresh base clone each time: cache off 4.1 s; cache on, first review 3.3 s (the base tree is seeded
from the candidate); second and third review, fresh worktrees seeded from the canonical checkout
2.2 s. Peak RSS equal. A literal single wasm run per review was not built: with the cache the
repeated parses are cache hits, and the remaining cost per extra run is discovery, hashing and the
graph pass (0.4 s each), against a bundle that would have to be written as a new vendored entry
point.

### Scoping per task, and what cannot be scoped

| Analysis            | Needs                               | Scoped?                                                                                                                                                                                                                                                                                                                              |
| ------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Complexity          | the changed files only              | yes, already (in-memory op reads only the named files: 137 MB at 750 files because the config and project are loaded, 282 MB at 10k)                                                                                                                                                                                                 |
| Duplication         | changed files against the corpus    | the corpus must be tokenised (global index); not scoped; 0.3 s at 700 files, 1.4 GB at 10k; the engine's token cache gave no measurable gain (1.89 s warm against 1.93 cold at 3k)                                                                                                                                                   |
| Dead code, cycles   | the whole module graph              | not limited: an export is unused only if nothing anywhere imports it, and a cycle can close through any file; a "reachable component of the changed files" misses importers. Served instead from the cached graph and summaries, with only changed files re-extracted: that is what the cache above does (0.43 s warm against 2.9 s) |
| Architecture, flags | the same graph / the same summaries | same                                                                                                                                                                                                                                                                                                                                 |
| Health              | the same, plus churn and scores     | same; also reads each source repeatedly, which the cache removes                                                                                                                                                                                                                                                                     |

### Islands

Streaming made them optional for dead code (the 30k full-size case fits). They would still be
needed for health and duplication beyond about 15k full-size files, and for any single analysis
beyond 4 GiB. Design, not built: a workspace's packages (package.json `workspaces`,
pnpm-workspace.yaml, tsconfig references) each run as a root of their own, in parallel up to the
thread cap, each with its own 4 GiB and allocator. What can be merged soundly from independent
runs: import cycles inside a package, unused and unlisted dependencies of a package, complexity,
and duplication within a package. What cannot: an unused export, unused file or unresolved
import that depends on another package (a package's export used only by a sibling would be
reported unused). A stitch step needs each island's export and import summary; that is the
engine's own graph input and is not exposed. The merged result would carry
`cross_package_findings: "not-computed"` and list the finding kinds it left out, never a silent
omission. A single huge package with no boundaries has no fallback beyond the memory error: it
is reported as `analyzer-memory` once per review.

### Not explained, not done

- The extra structure health holds (about 140 KB per file at 10k files).
- The 1.59 GB allocation in `effect` health with CSS.
- Duplication's index (1.4 GB at 10k files) is not compacted: it needs a rewrite of the detector.
- `member_accesses` is still 38% of what remains; interning the strings would shrink it further
  but changes a type used across the crates.
- Warm-run memory still includes decoding the whole cache file; the cache has no lazy
  per-entry load.

## Open questions for the owner

Decided on 2026-11-19 and folded into the design:

| Topic                   | Decision                                                                                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Config source           | A repo Fallow config is honoured first and alone; else the LAZERS project config; the Architect may set it                                                                           |
| Contract                | Changes, with the wording under "Contract change"                                                                                                                                    |
| Shape of the check      | A review whose findings ride the existing repair attempt with any failing checks; Fallow alone never rejects a task                                                                  |
| Who fixes               | The agent that wrote the code, before its task is done. No time-based sweep and no after-integration report                                                                          |
| Worsened complexity     | A concern for the Architect, not feedback                                                                                                                                            |
| Waiver                  | A Fallow suppression comment with a reason                                                                                                                                           |
| Dead code at task level | A note for the Architect                                                                                                                                                             |
| Vendoring               | Import script with an allowlist and a patch queue                                                                                                                                    |
| Built artifact          | `fallow.wasm` is committed; CI rebuilds and compares the hash                                                                                                                        |
| Upstreaming             | Patches stay private for now                                                                                                                                                         |
| Pin                     | Latest tag, `v3.43.2`                                                                                                                                                                |
| Clean first             | Before dogfooding: zero dead-code findings or each dispositioned, the import cycle removed, no clone group over 20 lines outside tests, the three functions over cognitive 300 split |

Decided later on 2026-11-19 (owner), replacing the earlier "dead code off without a config" rule and
the open question "No config: dead code off until a config exists, or report it with a caveat?":

| Topic                   | Decision                                                                                                                                                                                                                                                                                                         |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No config               | There is no "defaults" mode. Every project needs a Fallow config (repo file first and alone, else the LAZERS project config). Without one, nothing is silently skipped: submission is refused                                                                                                                    |
| Gate                    | With `fallowReview: "on"`, `lz-submit-task` and `lz-submit-plan` return the typed `FALLOW_CONFIG_REQUIRED` result (project, what is missing, next tools, `nothingQueued: true`) before anything is stored; `startTask` throws the same code. `fallowReview: "off"` has no gate. A validation result, not a state |
| Work already queued     | The first dispatch holds the plan with reason `FALLOW_CONFIG_REQUIRED: ...` (existing hold path to the Architect, family `fallow-config-required`, actions run/reconcile/cancel); the tick releases the hold through the same `running` transition once a config exists                                          |
| What the review is      | `fallow audit` itself, in the WebAssembly module (the engine's own attribution, tiers, test-file exemption, diff-risk rules, dependency scoping). The runtime runs it as `verify:fallow-audit` after the mechanical fix and the authored checks                                                                  |
| Result                  | One typed package (`FallowPackage`) from the engine report through receipt, repair prompt, Architect notice and `lz-fallow-audit`; the engine JSON is validated strictly, so a re-pinned engine that adds a field, enum value or finding list fails a test                                                       |
| Warnings                | Go to the worker in the one repair (consider-fixing, with a one-line reason if left). Inherited findings are context. After the repair the audit runs again and each finding is fixed, remaining or suppressed (reason read only from a Fallow suppression comment), shown to the Architect                      |
| Duplication severity    | The engine's: an introduced clone group warns (the audit fails only on a duplication threshold). The earlier LAZERS rule that introduced duplication fails the review is dropped                                                                                                                                 |
| Dead code at task level | Introduced dead code, dependency and cycle findings are audit findings per task, like the official audit. Risk: a task may add an export that a later task in the plan consumes, so a per-task dead-code error can ask a worker to delete it; the Architect order and the one-repair limit bound it              |
| Config authoring        | `lz-fallow-config` modes `suggest` (engine `fallow list` data plus package.json, scans) and `dry-run` (whole repository, unsaved candidate), `lz-fallow-config-set` (reason required, who/when stored, append-only). Guidance in `src/architect.md`                                                              |

Still open:

1. **Plan-level findings.** When the combined check finds a clone that two
   tasks each added, the plan outcome names the task that added each
   instance. Should the runtime send it back to that task's worker itself, or
   leave that to the Architect (planned)?

## Follow-ups noticed, not part of this plan

- `scripts/release-package.ts` copies `processor.js`, `repo-worker.js` and
  `decision-worker.js` but not `transition-indexes-worker.js`, which
  `scripts/build-server.ts` builds and `src/runner/transition-indexes.ts`
  spawns.

#### Phase 2 (results)

The review and the three exploration tools now default to `defaultFallowAnalyzer`
(`src/audit/wasm-analyzer.ts`), which is `wasmFallowAnalyzer`.

- **In WASM:** `complexity` and `duplication`, served by `src/audit/fallow-worker.ts`
  (one worker thread, spawned lazily through `workerURL`, one request at a time). The
  worker lists files (`git ls-files -z --cached --others --exclude-standard`, else a walk
  that skips dot-directories and `node_modules`), reads them, refuses any path whose
  realpath leaves the root, and passes paths and contents to the module. A trap returns
  `analyzer-panic` with `lastPanic()`. Abort or the 60 s timeout terminates the worker; the
  next request spawns a new one.
- **Stays native:** `deadCode` (needs module resolution and plugin discovery over a real
  filesystem, see Phase 1), `lz-fallow-report` (the durable five-section scan), and any
  call whose config has a local or `npm:` `extends` (`extends-unsupported`: the call
  falls back to native when it loads, otherwise the error surfaces).
- **Protocol:** request `{ id, kind, root, files?, changed?, configName?, configText?, options? }`,
  response `{ id, ok: true, report }` or `{ id, error: { code, message } }`; the worker posts
  `{ ready: true }` once the module is instantiated.
- **Fields WASM does not produce** (filled with 0 or a fixed value, none read by the review
  or the tools): `col`, `param_count`, `crap`, `coverage_pct`, `actions` on findings;
  `start_col`, `end_col`, `spread` on clones; `files_with_clones`, `total_tokens`,
  `duplicated_tokens` in stats. CRAP-only findings are absent.
- **Native ignores `files`** for health and duplication, so the native review always
  analysed the whole root. WASM honours it: complexity reads only the changed files;
  duplication keeps the whole root as corpus and reports groups touching the changed files.
- **Shipping:** `dist/fallow-worker.js` and `dist/fallow.wasm` are built by `build:server`
  and found through `wasmURL`; the release package now also carries
  `dist/transition-indexes-worker.js`, which was built and spawned but never packaged.
- **Measured:** a 10-file changed check through the worker (complexity and duplication
  requests, queued) on this repository: 488 ms for the first call including worker spawn and
  module instantiation, 278 to 302 ms afterwards. It is bounded by tokenizing the whole
  corpus for duplication (Phase 1), not by the 10 files.

**Changed-file duplication is the full run, filtered.** Upstream's focused detection
(`find_duplicates_touching_files_with_defaults`, and the native binding's `changedSince`)
prunes the corpus to candidate files and can group the same code differently: on this
repository it reported one clone as five instances at 55 tokens where the full run reports
two at 64. The module therefore always runs the full detection and keeps the groups that
touch the changed files; the focus path was removed from patch 0005.

- An accepted plan cannot be cancelled. Probe plans `c959a3c6` and `7b7432f1`
  are accepted and must never be integrated; they have no supported exit.
- A retried task can be scheduled in the shared checkout behind stale
  reservations, and the runtime refuses a workspace-mode change after
  execution has started. LZ-241's retry was stuck that way until it was
  resubmitted as a fresh plan.
- Five legacy attempts have held reservations since 2026-11-05.
- `lz-verify-task` returned `unavailable` twice for the Architect ("All fibers
  interrupted without error"): local inference failed. Not investigated.
- The repair worker asked which of the task and the review wins even when the
  task said to keep the flagged code and finish without asking.
- Reproducible build of `fallow.wasm` from a second checkout is unconfirmed.
- `src/submission.test.ts` has two failing tests that predate this work.
- The plan-review implementer removed a clone from its own new file after a
  WASM-versus-native clone parity test failed on it. The suite passes, but why
  that clone shape made the two analyzers disagree is not explained.
- The plan-level review found nothing live; cross-task clones, dead code and
  cycles are covered by tests only.

## Complexity pass, 2026-11-19

Measured with the WebAssembly analyzer (`defaultFallowAnalyzer.complexity`, every function at
cognitive 60 or more, no `.fallow/` written). Branch `refactor/complexity-pass`; every change
is behaviour-preserving: helpers cut along the existing phases, with each transaction
boundary, effect-journal write, await order and XState transition unchanged.

| Function                                 | File (before)                                        | Cognitive before | After    |
| ---------------------------------------- | ---------------------------------------------------- | ---------------- | -------- |
| `messageEvents`                          | `src/trajectory/read.ts:283`                         | 185              | below 20 |
| `recordNativeEvent`                      | `src/progress/recorder.ts:1864`                      | 177              | below 20 |
| `reconcileEffect`                        | `src/runner/runtime.ts:11106`                        | 134              | below 20 |
| `runRetainedVerificationChecks`          | `src/runner/retained-verification-execution.ts:608`  | 107              | below 20 |
| `inspectTrajectory`                      | `src/trajectory/read.ts:866`                         | 107              | below 20 |
| `runCommandOnce`                         | `src/runner/runtime.ts:3565`                         | 104              | 20       |
| `reconcileMessageIn`                     | `src/progress/recorder.ts:2393`                      | 103              | below 20 |
| `reconcileTerminalRetainedVerifications` | `src/runner/retained-verification-execution.ts:1736` | 98               | below 20 |
| `verify`                                 | `src/runner/runtime.ts:10119`                        | 80               | below 20 |

The largest new helper is 23 (`readAttemptSessions`; `nativeStepFact` and
`reconcileAssistantStepIn` are 22). `runCommandOnce` is the one orchestrator left at 20.
The duplication check on each changed file reports no new clone group; `runtime.ts` went
from 18 groups to 12 and `retained-verification-execution.ts` from 4 to 2.

### Second batch

The six functions the first batch skipped for ownership, plus the next runner tier. Same method.

| Function            | File (before)                               | Cognitive before | After                        |
| ------------------- | ------------------------------------------- | ---------------- | ---------------------------- |
| `buildSnapshot`     | `src/tasks/scheduling-read.ts:247`          | 121              | below 30                     |
| `readCapture`       | `src/models/observation-ledger-read.ts:506` | 119              | below 25                     |
| `refresh`           | `src/tasks/panel-state.ts:448`              | 119              | below 30 (`TaskPanelState`)  |
| `calculateScenario` | `src/models/market-range.ts:1009`           | 110              | 32                           |
| `refresh`           | `src/radar/state.ts:113`                    | 106              | below 30 (`refreshPass` 43)  |
| `buildSnapshotData` | `src/models/decision-read.ts:951`           | 102              | below 30 (`buildCohorts` 48) |
| `advanceAttempt`    | `src/runner/runtime.ts:9753`                | 97               | below 45                     |
| `cancelWorkers`     | `src/runner/runtime.ts:7660`                | 90               | below 40                     |
| `session`           | `src/runner/native.ts:473`                  | 85               | 46                           |
| `cleanupWorktrees`  | `src/runner/worktree-cleanup.ts:536`        | 85               | below 30                     |

Every target is at or below 50. Behaviour is unchanged: the same awaits in the same order, the same
transactions and effect-journal writes, and the load-time properties of the models readers
(memoized parsing, JS-side projection, one bounded read per table) are untouched. The duplication
check reports no new clone group in any changed file; four copies of the
`git worktree list --porcelain` parsing now share `registeredWorktreePaths` in
`src/runner/artifacts.ts`. `src/runner/check-settlement.test.ts` pins the receipt, tick and
forget-activity order of `settleMatchedCheck` for both check kinds.

Still over cognitive 60 after both batches, none of them at 100:

| Function              | File                                                       | Cognitive |
| --------------------- | ---------------------------------------------------------- | --------- |
| `refresh`             | `src/radar/monitor-state.ts:232`                           | 84        |
| `<arrow>`             | `src/runner/runtime.ts:6121`                               | 82        |
| `visit`               | `src/observability/live-read.ts:59`                        | 80        |
| `execute`             | `src/verification/opencode/native-interaction-main.ts:674` | 80        |
| `step`                | `src/runner/runtime.ts:7346`                               | 76        |
| `createFlowModel`     | `src/radar/flow-model.ts:163`                              | 75        |
| `routeEvidenceByCall` | `src/models/valuation.ts:208`                              | 73        |
| `callView`            | `src/trajectory-panel/panel.tsx:1167`                      | 72        |
| `withOwnedResources`  | `src/verification/resources/lifecycle.ts:55`               | 71        |
| `outputFromCapture`   | `src/models/observation-ledger-read.ts:2110`               | 70        |
