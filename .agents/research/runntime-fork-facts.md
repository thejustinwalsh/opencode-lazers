# ruNNtime fork facts (read-only survey, 2026-11-19)

Fork checkout: `/Users/tjw/Documents/ChatGPT/runntime`. Checked-out branch: `lazers-shared-omni` (unchanged).
Fetch run: `git fetch --all --prune` (remote-tracking refs only; upstream `main` moved, tag `v0.3.0` added).

## 1. Branches, heads, merge base, divergence

| Ref                                                                                            | Head                                       | Note                                        |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------- |
| `upstream/main` (= `upstream/HEAD`, = `gh repo view software-mansion/runntime` default `main`) | `087964a2f664306b7340781e3e0a26bbe7b54165` | `chore: bump package.json to v0.3.0 (#135)` |
| `origin/main` (= `origin/HEAD`, fork default `main`)                                           | `79cb8b564c8aec92474ecdedd8101557497e1c6b` | local `main` equals it                      |
| `lazers-shared-omni` (local, = `origin/lazers-shared-omni`)                                    | `a3718c80f959b8e86d1b2abf056fb578f532aeb9` | 0 ahead/0 behind origin                     |
| `lazers-voice` (local, = `origin/lazers-voice`)                                                | `a3718c8`                                  | identical to `lazers-shared-omni`           |

- Merge base `lazers-shared-omni` with `upstream/main`: `79cb8b564c8aec92474ecdedd8101557497e1c6b` (2026-11-10), i.e. the fork's `main`.
- Ahead/behind: `git rev-list --left-right --count upstream/main...lazers-shared-omni` → `9 30` (9 behind, 30 ahead). GitHub compare `repos/software-mansion/runntime/compare/main...thejustinwalsh:runntime:lazers-shared-omni`: `status=diverged`, `ahead_by=30`, `behind_by=9`, 120 files.
- Upstream commits since merge base (`git log --oneline 79cb8b5..upstream/main`):
  087964a chore: bump package.json to v0.3.0 (#135); 40a776a feat(zoo): add Reverb text to speech (#133); 2350ff0 refactor(zoo): name the transformer models' modules like their checkpoints (#101); 8de7374 fix(zoo): EmbeddingGemma 2 vision/audio from quantized f16 (#99); 43053ee docs: Exporting weights guide (#98); 3c1cf47 perf(core): prefetch tiles in tiled matmuls, flash attention (#105); af0413c feat(zoo): Higgs audio codec encoder int8/int4 (#104); 7170a20 feat(zoo): Higgs codec decoder int8/int4 (#102); 0110ca4 feat(core): Conv1d and ConvTranspose1d on quantized weights (#97).
- Merge conflict check, `git merge-tree --write-tree upstream/main lazers-shared-omni` → exit 1. Conflicted files (9):
  - packages/runntime/src/core/gpu/dispatch/conv.ts
  - packages/runntime/src/core/graph/ops/conv/conv1d.ts
  - packages/runntime/src/core/graph/ops/matmul.ts
  - packages/runntime/src/core/kernels/matmul/matmulQuantTiled.ts
  - packages/runntime/src/core/nn/layers.ts
  - packages/runntime/src/core/nn/loadStateDict.ts
  - packages/runntime/src/core/weights/safetensors.ts
  - packages/runntime/test/core/kernels/matmul/quantW.ts
  - packages/runntime/test/core/nn/loadStateDict.test.ts
- Files touched by both sides (since merge base) that auto-merged: README.md, apps/docs/astro.config.mjs, core/index.ts, core/nn/module.ts, core/weights/transforms.ts, zoo/index.ts, zoo/models.ts, and test files layers.test.ts, transforms.test.ts.
- Other fork branches on origin (not LAZERS pin): `lazers-omni-4bec710` (4bec710), `perf/flash-attention-prefetch`, `docs`, `feat/*`, `@chmjkb/*`, `worktree-embedding-gemma-2`. Upstream carries `@chmjkb/d1-omni` at `68f3a12`, which the fork's D1 commits build on.

## 2. Fork commits ahead of upstream (`git log --reverse 79cb8b5..lazers-shared-omni`, 30 commits)

Author column: `chmjkb` = `chmjkb`; `tjw@Mac.localdomain` = `Justin Walsh <tjw@Mac.localdomain>`; `contact.me@` = `Justin Walsh <contact.me@thejustinwalsh.com>`; `lazers-worker` = `lazers-worker <lazers-worker@local>`.

D1 (Omni D1 port):

| sha     | subject                                                              | author                             | date                   |
| ------- | -------------------------------------------------------------------- | ---------------------------------- | ---------------------- |
| 4e887c8 | feat(zoo): port d1-omni-600M text and image on core ops              | chmjkb                             | 2026-11-05 09:00 +0100 |
| e63a4bd | docs(zoo): add d1-omni playground demos (snake, webcam, triage, mod) | chmjkb                             | 2026-11-05 09:00 +0100 |
| 68f3a12 | chore(zoo): add d1-omni input-throughput bench page                  | chmjkb                             | 2026-11-05 09:01 +0100 |
| dac33a8 | fix(zoo): own D1 execution and upload lifetimes                      | Justin Walsh <tjw@Mac.localdomain> | 2026-11-11 18:12 -0500 |
| 735fbd9 | test(zoo): qualify D1 with pinned GPU vectors                        | tjw@Mac.localdomain                | 2026-11-11 18:13 -0500 |
| 8225016 | fix(zoo): make D1 exceptional cleanup safe                           | tjw@Mac.localdomain                | 2026-11-11 20:59 -0500 |
| fd28773 | Merge commit '79cb8b5…' into @chmjkb/d1-omni                         | tjw@Mac.localdomain                | 2026-11-11 21:10 -0500 |
| f394a74 | feat(zoo): add D1 Omni text Q8 loader                                | tjw@Mac.localdomain                | 2026-11-11 23:02 -0500 |

LFM3 chat:
| e8a4604 | feat(zoo): add original LFM3 streaming chat | tjw@Mac.localdomain | 2026-11-12 12:24 -0500 |
| b824c95 | feat(zoo): add published LFM3 Q4_K_M chat | tjw@Mac.localdomain | 2026-11-12 18:33 -0500 |

Omni audio (LFM3 audio in/out):
| f31f725 | feat(zoo): add Omni audio frontend and GGUF support | tjw@Mac.localdomain | 2026-11-13 06:31 |
| 70bfdbb | feat(zoo): validate Omni audio projector layout | tjw@Mac.localdomain | 2026-11-13 08:08 |
| bf3b7c0 | fix(zoo): match Liquid Omni audio frontend scaling | tjw@Mac.localdomain | 2026-11-13 08:19 |
| 06ca7ba | feat(zoo): validate complete Omni audio tensor layout | tjw@Mac.localdomain | 2026-11-13 08:36 |
| b0f8f27 | test(zoo): retain pinned Omni audio capture harness | tjw@tjw.local | 2026-11-13 10:29 |
| 35117b9 | feat(zoo): add public Omni audio inference | tjw@Mac.localdomain | 2026-11-14 00:28 |
| 4d081aa | fix(test): resample Liquid speech before transcription | tjw@Mac.localdomain | 2026-11-14 01:43 |
| a9d4bb7 | test(zoo): add opt-in Liquid speech level diagnostic | tjw@Mac.localdomain | 2026-11-14 02:16 |
| abee814 | fix(zoo): align Omni audio prompts and sampling | tjw@Mac.localdomain | 2026-11-14 04:41 |

Sol-review cleanup (refactor/fix/test; authored by lazers-worker except 4bec710):
| 1a20e80 | fix(zoo): own audio speech result rejection for stream-only consumers | lazers-worker | 2026-11-14 06:38 |
| 4741eda | refactor(zoo): use grouped rmsNorm, residual post-norms and packed MLP | lazers-worker | 06:39 |
| 51a86bf | refactor(core): move depthwise padLeft to the dimensions uniform | lazers-worker | 06:39 |
| c5f288c | refactor(zoo): fuse LFM3 logits readback into the eval submit | lazers-worker | 06:39 |
| fa0aad9 | fix(zoo): drop pre-submit fused logits readback | lazers-worker | 07:30 |
| 52bfe74 | test(zoo): regress fused-readback recovery and stream-only rejection | lazers-worker | 07:30 |
| 6aa6bbd | test(zoo): cover public audio speak early-break and pending-queue recovery | lazers-worker | 07:50 |
| 4bec710 | test(zoo): cover queued speech failure recovery | tjw@Mac.localdomain | 2026-11-14 10:30 |

Shared backbone, speech voice:
| 15d64e0 | feat(zoo): share the Omni backbone across text and audio | contact.me@ | 2026-11-15 11:35 |
| 68e9e60 | perf(zoo): stream tied Omni embedding rows from GGUF | contact.me@ | 2026-11-15 12:58 |
| a3718c8 | feat(zoo): selectable LFM3 speech voice | contact.me@ | 2026-11-17 16:58 |

Flags:

- Merge commits in range: 1 (`fd28773`, merges upstream `79cb8b5` into `@chmjkb/d1-omni`).
- AI attribution: none. `git log 79cb8b5..lazers-shared-omni --format=%B | grep -i 'co-authored|generated with|claude'` → no matches.
- LAZERS/OpenCode names in commit messages: none (`grep -i 'lazers|opencode'` on full messages → no matches). The author name `lazers-worker` is LAZERS-specific.
- Author identities not `Justin Walsh <contact.me@thejustinwalsh.com>`: 16 commits `tjw@Mac.localdomain`, 1 `tjw@tjw.local` (b0f8f27), 7 `lazers-worker <lazers-worker@local>`, 3 `chmjkb` (4e887c8, e63a4bd, 68f3a12; upstream contributor's work carried in). Canonical identity: 3 commits (15d64e0, 68e9e60, a3718c8).
- Fixups: no `fixup!`/`squash!`/WIP commits. Pairs where a refactor is followed by a revert-like fix: c5f288c then fa0aad9 (`drop pre-submit fused logits readback`).

## 3. Diff vs upstream merge base (`git diff --numstat 79cb8b5 lazers-shared-omni`)

Totals: 120 files, +21750 / -179 (`git diff --stat 79cb8b5 lazers-shared-omni`).

Largest source changes (added/removed): zoo/lfm3/audio/model.ts +1015; zoo/tasks/audio/lfm3.ts +923; core/weights/gguf.ts +687 (new); zoo/lfm3/model.ts +676 (new); zoo/d1/* (decider +285, model +285, stateDictHooks +281, prompt +133, image +190, tokenizer +49) (new); core/weights/sha256.ts +117 (new); core/kernels/conv/depthwiseConv1d.ts +90 (new); core/graph/evalCore.ts +99/-76; core/gpu/eval.ts +55/-8; core/nn/layers.ts +55/-7; zoo/models.ts +55; zoo/index.ts +23.

Build, packaging, dependencies:

- No `package.json` changes in either package (`git diff 79cb8b5 lazers-shared-omni -- '**/package.json'` empty). No new dependencies. Package version stays `0.2.0` in `packages/runntime/package.json` (upstream `main` is `0.3.0`).
- No tsconfig, tsdown, or CI config changes in the 120-file list.
- Playground additions add a Vite config with `server: { port: 5199, strictPort: true }` (`packages/runntime/playground/d1/vite.config.mjs`).

Generated, binary, large data files:

- `packages/runntime/playground/d1/public/cats.jpg` (binary).
- `packages/runntime/test/zoo/lfm3/liquid-reference.json` +6288 (fixture).
- `packages/runntime/playground/d1/reference-vectors.json` +228 (fixture).
- `packages/runntime/test/zoo/lfm3/packed-consumer.mjs` +380 and `test/zoo/d1/packed-consumer.mjs` +191 (consumer scripts).

New public API (from `git diff 79cb8b5 lazers-shared-omni`, exports):

- `packages/runntime/src/core/index.ts` (+3): `conv1d`, `depthwiseConv1d`, `gluConv1d`, `fromGguf`, `parseGgufHeader`, and GGUF types (`GgufIndex`, `GgufTensorInfo`, `GgufTensorType`).
- `packages/runntime/src/zoo/index.ts` (+23): `createD1Decider`, `D1Decider`, `D1DeciderModel`, D1 prompt types (`Answer`, `Question`, `QuestionType`), and LFM3 chat/audio exports (`createLfm3Chat`, `Lfm3Audio` speech options, `LFM3_AUDIO_*` constants).
- `packages/runntime/src/core/nn/module.ts` (+23): `Embedding` class. `packages/runntime/src/core/weights/sha256.ts`: `Sha256` class (not re-exported from core index in the grep).
- `models.lfm3.LFM3_OMNI_2B` and `models.d1.D1_OMNI_600M` entries in `packages/runntime/src/zoo/models.ts`.
- New types: `GgufStateDict`, `CpuQuantizedData`, `Lfm3AudioProjectorConfig`, `TrunkInputs`, and others under `zoo/d1` and `zoo/lfm3`.
- Lfm3 speech option `voice: { language?, gender? }` and `systemPrompt` override on `Lfm3Audio.speak` (commit a3718c8; record: `contributions/runntime/lfm3-voice/README.md`).

LAZERS-specific content in the fork diff:

- `git diff 79cb8b5 lazers-shared-omni | grep -i 'lazers|opencode'` on added lines → no matches. No `0.2.0-<sha>` strings in added lines.
- Author name `lazers-worker` on 7 commits.
- Playground demos (`playground/d1/snake.ts`, `mod.ts`, `triage.ts`, `webcam.ts`, `playground/lfm3/main.ts`) and `apps/docs` D1/LFM3 pages: product-facing demos, not in upstream.
- Fork-only release tags `lazers-omni-*` and `lazers-d1-q8-*` exist only in GitHub releases of the fork (not in code).

## 4. Tests and checks

Test commands (`packages/runntime/package.json`): `test` = `vitest run`; `test:unit` = `vitest run --project unit`; `test:gpu` = `vitest run --project gpu`; `bench:ab` = `node bench/cli.ts`. Root `package.json`: `test` = `pnpm --filter runntime test`; `typecheck` = `pnpm -r run typecheck`; `lint` = `eslint . --max-warnings=0`; `format:check` = `prettier --check .`; `build` = `pnpm -r run build`.

Ran (allowed, under 2 min, on checked-out `lazers-shared-omni`):

- `cd packages/runntime && npx tsc --noEmit` → exit 0. Output: npm warning only.
- Not run: test suites, lint, format, build (commands only).

Fork-added test files (by name; vitest project membership not verified): core: `test/core/graph/ops/conv/depthwiseConv1d.test.ts`, `test/core/weights/gguf.test.ts`, `test/core/weights/sha256.test.ts`; GPU: `test/core/kernels/conv/depthwiseConv1d.gpu.test.ts`; zoo D1: `test/zoo/d1/{prompt,tokenizer,public,stateDictHooks}.test.ts`, `q8.gpu.test.ts`, `qualification.gpu.test.ts`; zoo LFM3: `test/zoo/lfm3/{session,stateDictHooks,tokenizer}.test.ts`, `audio/{codec,frontend,projector,prompts,sampling,public}.test.ts`, GPU tests `audio-reference`, `cache-parity`, `fused-readback-recovery`, `liquid-reference`, `model-lifecycle`, `native-reference`, `public-audio`, `public`, `recovery` (`.gpu.test.ts`); `test/zoo/tasks/audio/speak.test.ts`.
Fork changes to existing tests: `test/core/gpu/eval.gpu.test.ts` (+41/-7), `test/core/kernels/elementwise/elementwiseF32.gpu.test.ts` (+21), `test/core/kernels/matmul/matmulQuantTiled.gpu.test.ts`, `matmulQuantW.gpu.test.ts`, `test/core/nn/loadStateDict.test.ts` (+17/-7), `test/core/weights/transforms.test.ts` (+20), `test/gpu.ts` (+20/-3), `test/core/graph/ops/elementwise.test.ts` (+7).
Source changes with no same-name test file in the fork diff: `src/core/gpu/buffers.ts`, `src/core/gpu/readbackQueue.ts`, `src/core/graph/evalCore.ts` (+99/-76; covered indirectly by `eval.gpu.test.ts`), `src/core/kernels/conv/...` (covered by the depthwise tests), `src/zoo/d1/image.ts` (no `image` test found by name), `src/zoo/lfm3/gguf.ts`.

## 5. Docs

- `README.md` (+1): one table row `Chat | createLfm3Chat | Liquid LFM3-Omni 2B (BF16 and Q4_K_M)`. Only README change.
- `apps/docs/astro.config.mjs` (+3, -1): sidebar entries.
- New pages: `apps/docs/src/content/docs/zoo/d1.mdx` (+105), `zoo/lfm3-audio.mdx` (+59), `zoo/lfm3-chat.mdx` (+72).
- No CHANGELOG file at repo root (glob returned none).
- Undocumented in `apps/docs` or README (grep, 0 hits): `fromGguf`, `parseGgufHeader`, `depthwiseConv1d`, `gluConv1d`, `Sha256`, `Embedding` class, `loadD1Tokenizer`, `createD1TextDecider`. `createD1Decider` has 1 docs hit; `createLfm3Chat` 2 hits; `Lfm3Audio` 1 hit; `voice` 3 hits.
- Contribution records (`contributions/runntime/*/README.md`) are in the LAZERS repo, not the fork.

## 6. LAZERS record: `contributions/runntime/` and verifier

Stage directories (`/Users/tjw/Documents/ChatGPT/opencode-lazers/contributions/runntime/`), patches counted from `patches/`:

| Stage                | Patches  | Base → tip (fork commits)                                   | Status / notes                                                                                                            |
| -------------------- | -------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| d1-reference         | 2        | 68f3a12 → 735fbd9                                           | README: accepted D1 reference; manifest.json present                                                                      |
| d1-safety-correction | 1        | 735fbd9 → 8225016                                           | README: correction on accepted reference                                                                                  |
| d1-q8                | 1        | fd28773 → f394a74                                           | manifest.json; README: Q8 loader, weights not hosted                                                                      |
| lfm3-base-chat       | 1        | f394a74 → e8a4604                                           | manifest.json                                                                                                             |
| omni-published-chat  | 1        | e8a4604 → b824c95                                           | manifest.json                                                                                                             |
| omni-published-audio | 9        | b824c95 → abee814                                           | `partial-manifest.json` status `incomplete-not-acceptance`                                                                |
| omni-sol-cleanup     | 7        | abee814 → 6aa6bbd (ends at 0007)                            | `partial-manifest.json` status `refactor-complete-operator-gpu-checked-model-runs-pending`; `sol-review-status.md`        |
| omni-desktop         | 1        | 0001-queued-speech-failure-recovery (commit 4bec710 series) | `producer-manifest.json` status `partial-not-acceptance`; README: "Status: incomplete and unqualified"                    |
| lfm3-voice           | 1        | 68e9e60 → a3718c8                                           | manifest.json; README: selectable voice                                                                                   |
| upstream-composition | 0        | merge fd28773 review                                        | README: "Ready for integration within the requested D1/upstream composition scope"; `d1-on-upstream.patch`, `checks.json` |
| lfm3-base-audio      | (no dir) | listed in verifier STAGES only                              |                                                                                                                           |

Verifier `scripts/verify-runntime-contribution.ts` (533 lines), unit tests at `scripts/verify-runntime-contribution.test.ts` (exists):

- `STAGES` map (line 9): d1-reference, d1-safety-correction, d1-q8, lfm3-base-chat, lfm3-base-audio, omni-published-chat, omni-published-audio, lfm3-voice. `omni-desktop`, `omni-sol-cleanup`, `upstream-composition` are not in STAGES.
- Manifest: stage must be in STAGES; every check must have `exitCode === 0`; check kind in {unit, gpu, typecheck, lint, build, conversion, parity, package, resource}; each stage requires a set of kinds (e.g. d1-safety-correction: unit, gpu, typecheck, lint; lfm3-voice: unit, typecheck, build, package).
- Evidence: each check file's sha256 must match; path must stay inside the stage directory.
- Chain: base commit must equal the stage's expected base; base commit must exist with the recorded tree; patches must chain by parent; each patch's commit parent and tree must match git history; each patch file sha256 must match; patch "From <sha>" header must equal the recorded commit; patch may touch only the stage's allowed paths.
- Reconstruction: detached checkout of base, apply patches in order, `write-tree` per patch and at the tip, compared to recorded trees.
- Tip: `tip.commit` must equal the last patch commit; `tip.tree` must equal the last patch tree.

Match to fork head: `contributions/runntime/lfm3-voice/manifest.json` records base `68e9e608dda71aad6c41263d435ed262d2a32de3` and patch/tip `a3718c80f959b8e86d1b2abf056fb578f532aeb9`. That equals the `lazers-shared-omni` head and `origin/lazers-shared-omni`. `git merge-base --is-ancestor 68e9e60 lazers-shared-omni` → ancestor. All other stage base/tip commits listed above are ancestors of the fork head (they appear in the 30-commit range).
The verifier was not run (it reconstructs trees in a worktree).

## 7. Releases, pins, PRs, TODOs

Fork releases (`gh release list -R thejustinwalsh/runntime`, all `Pre-release`):

- `lazers-omni-a3718c8`, 2026-11-17, title "LAZERS Omni runtime with selectable speech voice a3718c8"
- `lazers-d1-q8-02b55d7`, 2026-11-15, title "LAZERS modified D1-Omni-600M text Q8"
- `lazers-omni-68e9e60`, 2026-11-15
- `lazers-omni-15d64e0`, 2026-11-15
- `lazers-omni-4bec710`, 2026-11-15

LAZERS pin: `/Users/tjw/Documents/ChatGPT/opencode-lazers/package.json:51` = `https://github.com/thejustinwalsh/runntime/releases/download/lazers-omni-a3718c8/runntime-0.2.0-a3718c8.tgz`. Also `bun.lock:13` and `bun.lock:903` (same URL). Release tag `lazers-omni-a3718c8` is the fork head `a3718c8`.
Stale pins in `.claude/worktrees/*` (e.g. `agent-a1fb3878cc55e4b80/bun.lock`) point to `lazers-omni-68e9e60`. Not the main checkout.

PRs: `gh pr list -R thejustinwalsh/runntime --state all` → none. `gh pr list -R software-mansion/runntime --state all --author thejustinwalsh` → none.

TODO/FIXME/HACK/XXX added by fork: `git diff 79cb8b5...lazers-shared-omni | grep -n "^+.*\(TODO\|FIXME\|HACK\|XXX\)"` → no matches.

## 8. Checkout state

- `git status --short` → clean. `git stash list` → empty.
- `lazers-shared-omni` vs `origin/lazers-shared-omni`: 0 ahead, 0 behind (nothing unpushed).
- `lazers-voice` 0 ahead of origin/lazers-voice? Not checked separately; head equal to `lazers-shared-omni`.
- `main` (local) = `origin/main` = `79cb8b5`, not ahead of origin. It is 9 behind `upstream/main` (merge base).
- Fork branches not in `origin` list: `d1-*`, `lfm3-*`, `omni-*` are LAZERS-side only (contributions dir names), not fork branches.

## Could not determine

- Whether upstream would accept the merge; conflicts listed above, resolution cost not measured.
- Test pass/fail: no vitest suite was run (commands only).
- Lint, format, build: not run.
- Whether `scripts/verify-runntime-contribution.ts` passes on the current records (not run).
- Release tarball contents or sha512 vs `bun.lock` integrity (not downloaded).
- Vitest project membership for each new test file (not read from vitest config).
- Whether `lfm3-base-audio` stage exists in LAZERS (in STAGES, no directory).
- Which fork commits upstream maintainers have seen (no fork-originated PRs exist).
- Whether `@chmjkb` commits are cleared for upstream (authorship and license decision not in repo).
- Whether `playground/` and `apps/docs` D1/LFM3 pages are wanted upstream.
- Whether `liquid-reference.json` / `reference-vectors.json` fixtures carry license or redistribution limits (not checked).
