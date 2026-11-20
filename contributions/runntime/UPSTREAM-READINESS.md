# ruNNtime: what is left before the upstream pull request

Surveyed 2026-11-19, read-only. Fork `thejustinwalsh/runntime` branch `lazers-shared-omni` at `a3718c8`;
upstream `software-mansion/runntime` `main` at `087964a` (v0.3.0). Nothing was opened, pushed or changed.

## Where we stand

| Fact                                   | Value                                                                                               |
| -------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Fork ahead / behind upstream           | 30 commits ahead, 9 behind; merge base `79cb8b5` (2026-11-10)                                       |
| Size of the fork's work                | 120 files, +21,750 / -179                                                                           |
| Merge with upstream today              | conflicts in 9 files (list below)                                                                   |
| Upstream's typical merged pull request | median about 280 added lines; large work lands as a series                                          |
| Upstream pull request checks           | frozen install, typecheck, lint (`--max-warnings=0`), `format:check`, unit tests, build, on Node 24 |
| WebGPU tests                           | not in upstream CI; run locally                                                                     |
| Checks run on the fork head so far     | `tsc --noEmit` only (clean). Lint, format, unit, GPU, build: not run in this survey                 |
| Pull requests from us upstream         | none, ever                                                                                          |

One pull request of 21,750 lines will not be reviewed. The work has to go up as a series.

## Blockers

1. **Commit identity.** Only 3 of the 30 commits carry `Justin Walsh <contact.me@thejustinwalsh.com>`.
   16 are `tjw@Mac.localdomain`, 1 is `tjw@tjw.local`, 7 are `lazers-worker <lazers-worker@local>`,
   3 are an upstream collaborator's (`chmjkb`). The fork branch is recorded by SHA and tree in
   `contributions/runntime/*/manifest.json`, so it must not be rewritten. The upstream series is therefore
   cut as **new commits on new branches from `upstream/main`**, authored with the configured identity, and
   each branch's final tree is compared against the fork to prove nothing was lost.
2. **The D1 port is not ours to submit.** Commits `4e887c8`, `e63a4bd`, `68f3a12` are `chmjkb`'s and live
   upstream on the unmerged branch `@chmjkb/d1-omni`. Our D1 commits (lifetime fixes, pinned GPU vectors,
   Q8 loader) sit on top of it. Either that branch lands first, or we offer our fixes to its author as
   commits onto it. This needs a conversation with the maintainers before any D1 pull request.
3. **Base has moved.** Upstream added 9 commits (prefetching tiled matmuls, flash attention, module
   renames, Reverb text to speech, v0.3.0). Conflicts: `core/gpu/dispatch/conv.ts`,
   `core/graph/ops/conv/conv1d.ts`, `core/graph/ops/matmul.ts`, `core/kernels/matmul/matmulQuantTiled.ts`,
   `core/nn/layers.ts`, `core/nn/loadStateDict.ts`, `core/weights/safetensors.ts`,
   `test/core/kernels/matmul/quantW.ts`, `test/core/nn/loadStateDict.test.ts`. Four open upstream pull
   requests (#131, #124, #127, #130) touch the same quantisation and load paths, so expect to merge again.
4. **Two stages are recorded as unfinished in our own ledger.** `omni-published-audio` is
   `incomplete-not-acceptance`; `omni-desktop` is "incomplete and unqualified"; `omni-sol-cleanup` still
   says model runs are pending. `lfm3-base-audio` is named in the verifier but has no directory. These must
   be qualified or explicitly dropped from the series.
5. **Full checks have not been run on the head.** Lint, format, unit, GPU and build on `a3718c8`, and again
   on each series branch after it is cut from `upstream/main`.

## Work to do, in order

| #   | Item                                                                                                                                                                                                                                                     | Why                                                                                                        | Size             |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------- |
| 1   | Open an upstream issue or discussion proposing the series (GGUF weights, LFM3 chat, Omni audio, shared backbone, voice) and asking about the D1 branch                                                                                                   | No one upstream has raised any of this; a 9-part series from an outside contributor should not arrive cold | S, owner's words |
| 2   | Run the full check set on `a3718c8` and record results                                                                                                                                                                                                   | Know what is red before splitting                                                                          | S                |
| 3   | Merge `upstream/main` into a fresh integration branch on the fork; resolve the 9 conflicts; rerun unit and GPU tests; cut a new fork release; bump the LAZERS pin                                                                                        | LAZERS should run on what we are about to propose, and version moves 0.2.0 → 0.3.0                         | M                |
| 4   | Split into the series below, each a branch from `upstream/main`, authored with the configured identity                                                                                                                                                   | Reviewable size, clean authorship                                                                          | L                |
| 5   | Document every new public name: `fromGguf`, `parseGgufHeader`, `depthwiseConv1d`, `gluConv1d`, `Embedding`, `Sha256` (and decide whether `Sha256` is public at all). API docs are generated by typedoc, so this is doc comments, not hand-written pages  | Upstream rule: generated API docs, no undocumented exports                                                 | S                |
| 6   | Add direct tests where only indirect cover exists: `core/gpu/buffers.ts`, `core/gpu/readbackQueue.ts`, `core/graph/evalCore.ts` (+99/-76), `zoo/d1/image.ts`, `zoo/lfm3/gguf.ts`                                                                         | Upstream house style: tests mirror `src`                                                                   | M                |
| 7   | Clear the fixtures: `test/zoo/lfm3/liquid-reference.json` (+6,288 lines), `playground/d1/reference-vectors.json`, `playground/d1/public/cats.jpg`. Record where each came from and under what licence; shrink or generate where possible                 | Redistribution of model-derived reference data and an image                                                | S                |
| 8   | Decide what stays out: playground demos (snake, webcam, triage, mod), the bench page, the fixed port in `playground/d1/vite.config.mjs`, the `packed-consumer.mjs` scripts                                                                               | Product demos, not library code; upstream prefers small diffs and no dead code                             | S                |
| 9   | Fold the refactor-then-revert pair (`c5f288c` fused logits readback, `fa0aad9` drops it) so the series never shows the abandoned approach                                                                                                                | Review noise                                                                                               | S                |
| 10  | Commit messages to upstream's linter: Conventional Commits, header ≤ 120 characters                                                                                                                                                                      | Enforced by commitlint                                                                                     | S                |
| 11  | State in each pull request which GPU tests were run locally, on what hardware and browser                                                                                                                                                                | GPU tests are not in upstream CI                                                                           | S                |
| 12  | Keep `contributions/runntime/` in step: add a stage for the upstream merge, and extend `scripts/verify-runntime-contribution.ts` to cover `omni-sol-cleanup`, `omni-desktop` and `upstream-composition`, which it does not check today; run the verifier | Our own record must still prove what LAZERS ships                                                          | M                |

## Proposed series

Each row is one pull request against `upstream/main`. Later rows depend on earlier ones.

| #   | Pull request                                                                               | Fork commits it draws from                           | Depends on               |
| --- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------- | ------------------------ |
| 1   | core: 1-D convolution ops and the depthwise kernel                                         | parts of `f31f725`, `51a86bf`                        | —                        |
| 2   | core: GGUF weight reader (`fromGguf`, `parseGgufHeader`, quantised tensor types, checksum) | parts of `f31f725`, `b824c95`, `68e9e60`             | —                        |
| 3   | core: `Embedding` module; evaluation and readback-queue changes                            | parts of `e8a4604`, `dac33a8`, `fa0aad9`             | —                        |
| 4   | zoo: LFM3 streaming chat, original and published Q4_K_M weights                            | `e8a4604`, `b824c95`                                 | 2, 3                     |
| 5   | zoo: Omni audio in and out                                                                 | `f31f725` … `abee814`, cleanup `1a20e80` … `4bec710` | 1, 2, 4                  |
| 6   | zoo: one shared Omni backbone for text and audio; tied embedding rows streamed from GGUF   | `15d64e0`, `68e9e60`                                 | 5                        |
| 7   | zoo: selectable speech voice                                                               | `a3718c8`                                            | 5                        |
| 8   | zoo: D1 lifetime fixes, pinned GPU vectors, Q8 loader                                      | `dac33a8`, `735fbd9`, `8225016`, `f394a74`           | upstream's own D1 branch |
| 9   | docs: LFM3 chat and audio pages (to upstream's `docs` flow)                                | docs pages                                           | 4, 5                     |

Rows 4 to 7 are still large (the audio model alone is about 1,900 lines). Expect the maintainers to ask
for further splits; the order above keeps each one independently testable.

## Decisions that are yours

1. Do you want to open the conversation upstream first (item 1), and in whose words?
2. D1: wait for the collaborator's branch, offer our fixes onto it, or leave D1 out of the first series?
3. Unfinished stages (`omni-published-audio`, `omni-desktop`): qualify them now, or submit only what is
   already accepted in our ledger?
4. Playground demos and the bench page: offer them, or keep them fork-only?
5. Do the 7 `lazers-worker` commits get re-authored as you in the new series? (They were produced by
   LAZERS workers on your machine; upstream has no stated policy on AI-assisted contributions.)

## Not determined

- Whether a fork's pull request needs maintainer approval before CI runs, and which checks are required
  (the Actions API refused the query).
- Whether the maintainers want shared-model use, the voice model, or GGUF support at all.
- Lint, format, unit, GPU and build status of `a3718c8`.
- Whether the release tarball matches the lockfile integrity value (not downloaded).
- Redistribution terms of the reference fixtures.
- Whether `scripts/verify-runntime-contribution.ts` passes on the current records (not run).

Sources: `git` and `gh` read-only queries against both repositories on 2026-11-19; the commit-by-commit
table and the upstream rules are in the survey notes this file was written from.
