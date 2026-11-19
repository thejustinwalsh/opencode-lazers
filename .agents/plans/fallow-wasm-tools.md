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
crates/fallow-wasm/            our binding crate (cdylib, wasm-bindgen)
scripts/vendor-fallow.ts       import or update: fetch pin, copy allowlist, apply patches
scripts/build-fallow-wasm.ts   cargo build → wasm-bindgen → wasm-opt → artifact + manifest
src/audit/wasm/                built fallow.wasm, JS glue, ARTIFACT.json
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
| `lz-fallow-check`     | The review function itself          | `{}` for the caller's changed files, or `{ paths: string[] }`                                     | `{ clean: boolean, introduced: Finding[], concerns: Finding[], thresholds }`                                                       | Implementor, Auditor, Architect |
| `lz-fallow-dupes`     | `dupes` / `detectDuplication`       | `{ paths?, mode?, minTokens?, minLines?, limit, offset }`                                         | `{ groups: [{ id, lines, tokens, instances: [{ file, startLine, endLine }], moreInstances }], total, duplicationPct, nextOffset }` | Auditor, Architect              |
| `lz-fallow-health`    | `health` / `computeComplexity`      | `{ paths?, sort: "cognitive" \| "cyclomatic" \| "lines", limit, offset }`                         | `{ functions: [{ file, line, name, cyclomatic, cognitive, lines, exceeded }], total, thresholds, nextOffset }`                     | Auditor, Architect              |
| `lz-fallow-dead-code` | `dead-code` / `detectDeadCode`      | `{ paths?, kinds?: ("file" \| "export" \| "type" \| "dependency" \| "member")[], limit, offset }` | `{ findings: [{ id, kind, file, line, name }], total, nextOffset }`                                                                | Auditor, Architect              |
| `lz-fallow-report`    | All five sections, durable (exists) | `{ taskID?, phase? }` (drop `threads`: one thread in WASM)                                        | Unchanged `AuditScanOutput`                                                                                                        | Auditor, Architect              |

```ts
// Finding, as returned by lz-fallow-check and written into the review receipt
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
| Worker dispatched               | None                                                                                                                                  |                                              |                                                                            | `src/implementor.md` gains three lines: the review runs when you finish, its limits, `lz-fallow-check`                           |
| Worker mid-task                 | Complexity and duplication on its changed files                                                                                       | Agent tool `lz-fallow-check`, optional       | Read-only preview of what the runtime's review will report                 | Findings and a `next` instruction                                                                                                |
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
- **Any worker**, with `lz-fallow-check`: seeing the findings before it
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
explained; size, start time, check time and memory are measured and written
into this plan against the budgets; a failed budget is reported, not hidden.

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

Parity against native 3.43.2 (`src/audit/wasm/fallow-parity.test.ts`, all passing):

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
| `fallow.wasm` after `wasm-opt -Oz` | 8 MB    | 4.86 MB (4,859,933 bytes)                                                                                                                      | pass   |
| Worker start to module ready       | 300 ms  | 15 ms (first call 5 ms)                                                                                                                        | pass   |
| Changed-file check, 10 files       | 2 s p95 | 235 ms p50, 370 to 465 ms p95 for complexity and duplication; with reading 647 files and building the `Project`, 255 ms p50, 410 to 500 ms p95 | pass   |
| Whole-repository duplication       | 15 s    | 221 ms p50, 225 to 238 ms p95; whole-repository complexity 1.4 s                                                                               | pass   |
| Worker memory (recorded, no limit) | n/a     | wasm linear memory 98.6 MB; worker RSS about 220 MB after the run                                                                              | n/a    |

The module is built for size (`opt-level = "z"`, fat LTO). At `opt-level = 3` it was
8.83 MB (over the 8 MB budget) and about twice as fast (changed check 175 ms p50,
whole-repository duplication 165 ms). The size-optimised build is committed because every
budget holds with it; the speed build is one line in `crates/fallow-wasm/Cargo.toml`.
A changed-file check re-tokenizes the whole corpus (the cost is the corpus, not the 10
files), so it is about as slow as a full run; a token cache across calls would remove that.

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

Still open:

1. **No config.** Dead code off until a config exists (planned), or report it
   with a caveat?
2. **Plan-level findings.** When the combined check finds a clone that two
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
