# software-mansion/runntime: requirements for an external PR

Snapshot taken 2026-11-19. Default branch `main`. Repo: https://github.com/software-mansion/runntime (public, MIT, not archived). Read-only research; nothing was opened, commented or forked.

## 1. Contribution rules

| Item                      | Finding                                                                                                                                                                                                                                                   | Source                                                                                       |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| CONTRIBUTING.md           | Absent at repo root (root listing has no such file).                                                                                                                                                                                                      | `gh api repos/software-mansion/runntime/contents`                                            |
| CODE_OF_CONDUCT           | Absent at root and in `.github/`.                                                                                                                                                                                                                         | same listings                                                                                |
| PR template               | Present. Sections: Description, breaking change (yes/no), type of change (bug, feature, docs, performance, other), testing instructions, screenshots, related issues, checklist (self-review, comments, docs updated, no new warnings), additional notes. | `.github/pull_request_template.md`                                                           |
| Issue templates           | `bug-report.yml`, `feature-request.yml`. Feature form asks for Area (Zoo / Core / Not sure), problem, proposed solution, benefits.                                                                                                                        | `.github/ISSUE_TEMPLATE/`, `.github/ISSUE_TEMPLATE/feature-request.yml`                      |
| CLA / DCO sign-off        | None found. No DCO trailer rule in any file read.                                                                                                                                                                                                         | Root listing; `AGENTS.md`                                                                    |
| Commit convention         | Conventional Commits, header max 120 chars. Scopes named in AGENTS: `core`, `zoo`, `docs`. Enforced by commitlint on the commit-msg hook.                                                                                                                 | `commitlint.config.js`; `AGENTS.md` ("How to build and verify"); `lefthook.yml` (commit-msg) |
| Changelog / changeset     | No changeset tool or CHANGELOG at root. Version bumps are separate PRs (e.g. #89 `chore: bump package.json to v0.2.0`, #135 bump to v0.3.0).                                                                                                              | Root listing; `gh pr list` merged set                                                        |
| Licence                   | MIT.                                                                                                                                                                                                                                                      | `LICENSE.md`; `packages/runntime/package.json` `license`                                     |
| Agent guidance            | `AGENTS.md` and `.claude/skills/{code-style,testing}/SKILL.md` describe house style for humans and AI tools alike.                                                                                                                                        | `AGENTS.md`; `.claude/skills/`                                                               |
| AI-assisted contributions | No written policy found in CONTRIBUTING, README, or docs. The repo itself ships AI guidance (AGENTS.md, skills) and an open draft PR adds a `pr-review` skill (#132).                                                                                     | `AGENTS.md`; PR #132                                                                         |

## 2. CI

Workflows in `.github/workflows/`:

| Workflow                        | Triggers                                                                                     | Runs                                                                                                                                                                                  | Notes                                                                                                                                          |
| ------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `ci.yml` (job `lint-and-build`) | push main; PR to `main` or `docs`; merge_group; manual                                       | `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm --filter runntime test:unit`, `pnpm --filter runntime run build`. Node 24, ubuntu-latest. | Every job has `if: github.repository == 'software-mansion/runntime'`. Comment: "Node tests only: the runners have no GPU for the gpu project." |
| `docs-build-check.yml`          | push main; PR to `main`/`docs` when `apps/docs/**`, `packages/runntime/**` or itself changes | `pnpm --filter docs... run build`                                                                                                                                                     | Path-filtered.                                                                                                                                 |
| `python-tools.yml`              | PR to `main`/`docs` when `tools/python/**` changes                                           | `uv run --locked pytest` in `tools/python`                                                                                                                                            | Path-filtered.                                                                                                                                 |
| `npm-publish.yml`               | manual only (`workflow_dispatch`)                                                            | npm publish of `packages/runntime` via a pinned Software Mansion action, OIDC                                                                                                         | Dry-run default true.                                                                                                                          |
| `publish_docs.yml`              | push to `docs`                                                                               | docs build and push to gh-pages                                                                                                                                                       | Docs deploy happens from `docs` branch, not `main`.                                                                                            |

- GPU/WebGPU tests (`*.gpu.test.ts`, `pnpm --filter runntime test:gpu`, Vitest browser mode with Playwright Chromium) are NOT in CI. AGENTS.md: "local only, CI has no GPU". Contributors must run them locally before pushing kernel changes (`.claude/skills/testing/SKILL.md`).
- Required checks: not determined (branch protection not readable with this token). The `merge_group` trigger suggests a merge queue exists.
- Fork PR approval setting: not determined. `gh api .../actions/permissions` returned 403 (no repo read permission for that endpoint with this token). The `if: github.repository == ...` guard means fork PRs run on fork-owned runs only for the upstream repo event, which is a constraint to verify by checking the Actions settings in the GitHub UI.
- Supported runtimes: Node `>=22` (root `package.json` engines); CI uses Node 24. Browsers: WebGPU needed. README lists Chrome, Edge, Safari 26 and newer; React Native via react-native-webgpu and Electron (`README.md`, "IMPORTANT: ruNNtime needs WebGPU").

## 3. Maintainer behaviour

Last 20 merged PRs (from `gh pr list --state merged --limit 20`): all authored by upstream members or collaborators (chmjkb, xxpopielxx). No external author in that window.

- Size: additions range 1 to 18,607 (#136 generated docs). Median about 280 additions (computed from the 20 values). Typical merged PR is a single feature or fix of 20–500 lines; larger ones are feature-plus-tests (e.g. #104 +341, #102 +360, #97 +1,458, #95 +1,461).
- Splitting: Large work is split into series. Example: Higgs Audio codec split into encoder (#95) and decoder (#102), then int8/int4 loading (#104). Quantizer split into #80, #81, #82, #93, #96, #97. Evidence of split requests: PR #101 changes requested by xxpopielxx (`pulls/101/reviews`, 2026-11-17).
- External contributors, history: iwoplaza (CONTRIBUTOR association) had 4 PRs, all merged or closed (#55, #56, #59, #84). #84 merged 2026-11-10 after approval by chmjkb the same day. Other external authors, maciekstosio (#112, open, no reviews) and MiniX16 (#120, open, approved by chmjkb 2026-11-17, not merged), show that external PRs can get approval but may wait.
- Author association across 100 PRs: chmjkb 68 (COLLABORATOR), xxpopielxx 30 (MEMBER), iwoplaza 4 (CONTRIBUTOR), piaskowyk 1 (MEMBER), maciekstosio 1 (NONE), MiniX16 1 (NONE).
- Review turnaround (created to merged, from the 20-PR list): many within hours (#133: 3h; #135: 13 min; #107: 1.6 h); some days (#101: 6.5 days with changes requested; #105: 7 days; #98: 9 days). Median roughly 1–3 days.
- Draft PRs: several long-running drafts exist (#85 from piaskowyk, opened 2026-10-28; #128, #130, #132 by chmjkb).

Open PRs (overlap themes marked *):

| #   | Author       | Summary                                                                                             |
| --- | ------------ | --------------------------------------------------------------------------------------------------- |
| 137 | chmjkb       | docs: Try it yourself demo for TTS with Reverb presets (*voice)                                     |
| 134 | xxpopielxx   | test: Moonshine tiny and base parity                                                                |
| 132 | chmjkb       | draft: pr-review skill and AGENTS.md tightening                                                     |
| 131 | chmjkb       | feat(tools): quantize any float weight in checkpoint layout (*packaging/quant)                      |
| 130 | chmjkb       | draft: rope pair layout, EmbeddingGemma 2 q/k                                                       |
| 128 | chmjkb       | draft: sdpa score scale                                                                             |
| 127 | chmjkb       | perf: compile pipelines without blocking warm-up (*model load)                                      |
| 125 | xxpopielxx   | test: EmbeddingGemma 2 parity                                                                       |
| 124 | chmjkb       | feat(core): nn.FusedLinear for zoo attention projections                                            |
| 120 | MiniX16      | fix(core): std.intdiv for flat indices (external, approved, unmerged; ties to issue #57 and #121)   |
| 116 | xxpopielxx   | test: MobileNetV4 parity                                                                            |
| 115 | xxpopielxx   | test: parity tests vs PyTorch, MiniLM first                                                         |
| 112 | maciekstosio | feat(core): publish runntime/core as experimental entry point (*packaging; external, no review yet) |
| 111 | chmjkb       | test: video frame, encoder option and leak tests (*caching/leaks)                                   |
| 85  | piaskowyk    | draft: Gemma 3 and Qwen 3 text generation                                                           |

Open issues overlapping the themes:

| #   | Summary                                                                                                   |
| --- | --------------------------------------------------------------------------------------------------------- |
| 129 | encodeEstimateDepth throws when first call lands in another model's warm-up (*model sharing across calls) |
| 122 | EmbeddingGemma 2 image resize vs reference int16 weights                                                  |
| 121 | GPU tests on Linux run on SwiftShader (*WebGPU device)                                                    |
| 118 | Constant folding: load-time weight precompute on GPU (*caching)                                           |
| 117 | createImageClassifier resize bicubic vs linear                                                            |
| 113 | Python quantizer cannot write Conv1d/ConvTranspose1d (*packaging/quant)                                   |
| 103 | PyTorch-style nn.Transformer in core                                                                      |
| 87  | Winograd gains per conv model                                                                             |
| 70  | Load quantized weights from plain int format and pack at load (*caching/quant)                            |
| 68  | Leak checks for a call that throws halfway (*model sharing/lifecycle)                                     |
| 67  | Leak-check routes without subgroups (*WebGPU device features)                                             |
| 66  | Leak checks for every zoo model (*lifecycle)                                                              |
| 63  | Pool: evict unused free buckets on its own (*caching/buffer pool)                                         |
| 42  | Make embedding task a model-agnostic option                                                               |

No open PR or issue matches "omni", "LFM", or "tarball" (keyword search on the repo returned nothing). Voice coverage exists upstream as TTS (Reverb #133 merged, demo #137 open; a remote `feat/echo-tts` branch exists). Shared/omni model use across tabs or workers: no upstream issue or PR found. A remote branch `@chmjkb/d1-omni` exists with no PR.

## 4. Roadmap and policy

- No ROADMAP or stated contribution policy file found. README says the zoo API is for "just work"; `runntime/core` "is not yet exposed to the public" (`README.md`, Quickstart section). PR #112 proposes exposing core as experimental, so core exposure is an open direction, not a settled policy.
- Docs index says the library is "PyTorch-style building blocks for on-device AI in the browser" (`apps/docs/src/content/docs/_index.mdx`).
- The README "Created by Software Mansion" section mentions contributing to open-source software in a generic sense, not a contribution process (`README.md`, around line 174).
- Maintainers want: small focused diffs, reuse over new abstraction, no fallbacks, no dead code, delete over bypass (`.claude/skills/code-style/SKILL.md`, "Scope").
- Tests: bug fixes need a failing case first; kernels need a GPU suite mirroring their path; expected values from math or PyTorch/HF, not from our own output (`.claude/skills/testing/SKILL.md`).

## 5. Project structure and standards

- pnpm 11.10.0 monorepo (`package.json` `packageManager`). Workspaces `packages/*`, `apps/*`, tools/python (uv).
- `packages/runntime`: library. Entry points `runntime/zoo` and `runntime/zoo/transformers` only (`packages/runntime/package.json` `exports`). Build: tsdown to `dist`; `dist` not checked in.
- Lint: ESLint flat config with typescript-eslint and `@eslint/js` recommended, `prefer-const` with destructuring all, unused vars warn with `_` ignore pattern (`eslint.config.js`). `pnpm lint` uses `--max-warnings=0` at root (`package.json`).
- Format: Prettier, `singleQuote: true`, `printWidth: 100` (`.prettierrc`). CI runs `pnpm format:check`.
- Typecheck: `tsc --noEmit` per package (`packages/runntime/package.json`).
- Hooks: Lefthook pre-commit (Prettier write, ESLint report-only, typecheck), commit-msg commitlint (`lefthook.yml`). Hooks are skippable; CI repeats the checks.
- Tests: Vitest. `*.test.ts` in Node (`pnpm --filter runntime test:unit`); `*.gpu.test.ts` in Chromium via Playwright (local only). Tests mirror `src` under `packages/runntime/test`. Config `packages/runntime/vitest.config.ts`.
- Docs: Astro Starlight app in `apps/docs`. API reference under `/api/` generated by `starlight-typedoc` from exports and doc comments; do not hand-edit (`AGENTS.md`). Code samples are ` ```ts twoslash ` and are type-checked against the built library in the docs build.
- Error codes: a thrown user-visible error is a `RunntimeError` with a code; a new code also goes in `apps/docs/src/content/docs/zoo/error-handling.mdx` (`.claude/skills/code-style/SKILL.md`).
- Versioning: semver in `packages/runntime/package.json` (currently 0.3.0). Bumps are separate `chore:` PRs. Publish is a manual workflow.
- Docs branch: work lands on `main`; a docs fix goes to `docs` then merged back. Both use merge commits, never squash (`AGENTS.md`). This matters for merge style: a series of PRs may be merged with merge commits, not squash.
- README is the source; `scripts/sync-readme.mjs` copies it into the package on prepack. Edit root README only.
- Node tests and build must pass in CI; GPU tests run locally by the author.

## 6. Upstream activity since 2026-11-01

- 21 commits on `main` since 2026-11-01 (GitHub commits API, first page of 100, one page only).
- Areas touched: `zoo` (Higgs Audio codec encoder/decoder, Reverb TTS, EmbeddingGemma 2, transformer module naming, warmUp option, ModelLoadOptions, encode* APIs), `core` (quantized weights, QuantTensor, Conv1d on quant, perf for tiled matmuls and flash attention, imageToChw clamp), `tools` (Python quantizer), `docs` (exporting weights guide), `chore` (version bumps, README).
- Pace: about 5 commits a week on main, bursts on 2026-11-10 (5 commits) and 2026-11-13 (4). Two maintainers did most of this. Latest on 2026-11-19 (v0.3.0 bump #135, Reverb #133).
- Base will move under a long-lived fork branch: expect frequent rebases or merges against main. Open PRs touch `zoo` and `core` quant and load paths (#131, #124, #127, #130), which overlap the quant/load areas our `lazers-shared-omni` branch would also touch.

## 7. Could not determine

1. Required status checks and branch protection rules (no read permission for branch protection with the token used).
2. Whether fork PR workflows need maintainer approval to run (`actions/permissions` and `fork-pr-contributor-approval` returned HTTP 403).
3. Whether a merge queue is active (the `merge_group` trigger suggests yes; not confirmed).
4. Who merged the last 20 PRs (`mergedBy` not fetched).
5. Whether maintainers have an unwritten policy on AI-assisted PRs (none written; the repo's own AGENTS.md suggests AI-assisted development is normal for maintainers, but no rule for outsiders was found).
6. Exact upstream review turnaround statistics beyond the sampled PRs.
7. Whether upstream intends to add LFM or any omni-model support, and whether shared model use across tabs/workers is wanted. No issue, PR, roadmap or code mention found.
8. Whether `gh` search results missed issues or PRs (search returned sparse hits for some keywords; full listing was limited to 100 open and 200 total PRs).
9. Remote branch `feat/echo-tts` and `@chmjkb/d1-omni` content; only names were listed, not read.
