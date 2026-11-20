# ruNNtime upstream series: stack, results and completeness proof

Cut 2026-11-19/20 from `lazers-upstream-0.3` (`f439502`, the fork's work merged with upstream v0.3.0,
`upstream/main` = `087964a`). Twelve new branches on the fork `thejustinwalsh/runntime` (`origin`),
each cut from the previous, the first from `upstream/main`. Nothing was opened, commented or pushed
upstream; no tag, no release. `lazers-shared-omni`, `lazers-upstream-0.3` and `main` are untouched.

Authorship: every commit is a new commit under `Justin Walsh <contact.me@thejustinwalsh.com>`
(plain `git commit`, signing as configured, no AI trailer; all 21 commits show a valid signature
and pass commitlint, header at most 86 characters). The exception is the three D1 port commits by
`chmjkb`, brought by `git cherry-pick` with their authorship kept.

## The stack

The nine-part table became twelve branches. Reasons: part 2 split offsets (2a) from GGUF (2b) as the
readiness note suggested, because the offsets edit `matmulQuantTiled`, the kernel other open pull
requests also change; part 3 stays one branch but is three commits; part 5 (about 5,000 lines with
tests) split into units (5a), model (5b) and runner (5c). Parts 1, 4, 6 to 9 are as in the table.
One dependency the table missed: part 4 needs part 1 (the short convolutions use
`depthwiseConv1d`); part 8 (D1) needs part 3 and part 2a, not part 7. The order is linear for review.

| #   | Branch                                         | Base            |         Commits | Lines + / -                        | Unit tests     | GPU tests run locally                                                                 |
| --- | ---------------------------------------------- | --------------- | --------------: | ---------------------------------- | -------------- | ------------------------------------------------------------------------------------- |
| 1   | `upstream/01-conv1d` (`85bd12c`)               | `upstream/main` |               1 | +268 / -1                          | 58 files, 1246 | `test/core`: 1795 pass, 15 expected fail                                              |
| 2a  | `upstream/02a-quant-offsets` (`13949d5`)       | 01              |               1 | +271 / -44                         | 58 files, 1249 | `test/core`: 1799 pass, 15 expected fail                                              |
| 2b  | `upstream/02b-gguf` (`e134216`)                | 02a             |               1 | +1098 / -0                         | 60 files, 1267 | `test/core`: 1799 pass, 15 expected fail                                              |
| 3   | `upstream/03-embedding-eval` (`bc06765`)       | 02b             |               3 | +634 / -168                        | 60 files, 1272 | `test/core` + `test/zoo/leaks`: 1822 pass, 15 expected fail                           |
| 4   | `upstream/04-lfm3-chat` (`a7948f1`)            | 03              |               1 | +9187 / -0 (6,288 are the fixture) | 64 files, 1293 | LFM3: none-mode 2 pass / 4 skip; native-reference, q4 public, q4-recovery 1 pass each |
| 5a  | `upstream/05a-omni-audio-frontend` (`d6ba5bb`) | 04              |               1 | +1401 / -0                         | 69 files, 1322 | none needed                                                                           |
| 5b  | `upstream/05b-omni-audio-model` (`37a03f2`)    | 5a              |               1 | +1497 / -2                         | 70 files, 1324 | reference test needs Liquid's engine: not run                                         |
| 5c  | `upstream/05c-omni-audio-runner` (`aadd3ee`)   | 5b              |               1 | +2134 / -2                         | 72 files, 1327 | LFM3 none-mode 2 pass / 7 skip; audio modes not run                                   |
| 6   | `upstream/06-shared-backbone` (`6b8d0b0`)      | 5c              |               2 | +312 / -74                         | 72 files, 1329 | native-reference, q4 public, q4-recovery 1 pass each                                  |
| 7   | `upstream/07-speech-voice` (`b1d371e`)         | 06              |               1 | +108 / -6                          | 72 files, 1332 | not applicable (Node only)                                                            |
| 8   | `upstream/08-d1` (`61bc951`)                   | 07              | 7 (3 by chmjkb) | +4619 / -0                         | 77 files, 1353 | D1 Q8: 1 pass, other D1 modes need the float checkpoint: not run                      |
| 9   | `upstream/09-docs` (`1d5c3b3`)                 | 08              |               1 | +134 / -1                          | 77 files, 1353 | docs build only                                                                       |

Lines are `git diff --shortstat <base> <branch>`. Totals for the stack against `upstream/main`: 122
files, +21,579 / -214 (the fork's content was 121 files, +21,809 / -209).

Every branch, on its own tip: `pnpm typecheck`, `pnpm lint` (`--max-warnings=0`), `pnpm format:check`,
`pnpm --filter runntime test:unit` and `pnpm build` (tsdown plus the docs build with twoslash) all
pass. The branch-by-branch logs are in `/private/tmp/claude-501/-Users-tjw-Documents-ChatGPT-opencode-lazers/b47493ed-6bdc-45ea-82fa-61d28bfbfe2d/scratchpad/s/` (`*.checks.log`, `*.gpu.log`); a reboot clears them. Two runs hit a 5 s timeout on
one Node test (`stateDictHooks.test.ts`, "fuses the MLP gate/up pair into one packed projection")
while other work was loading the machine; it passes on rerun and in every final run above. Its
timeout is the vitest default; raising it for that test is a separate decision.

GPU environment: MacBook Pro, Apple M2 Pro (16-core GPU), 32 GB, macOS 27.2; Playwright Chromium
`chromium-1248`, headless, `--enable-unsafe-webgpu`; Node v26.9.0, pnpm 11.10.0. Upstream CI runs
none of the GPU tests. Weights are the symlinks under `packages/runntime/test/.weights`; nothing was
downloaded. On the tip of the stack (`upstream/09-docs`): `test/core` + `test/zoo/leaks` 43 files,
1822 passed, 15 expected fail; D1 Q8 1 passed; LFM3 native-reference, q4 public (about 4.5 min while
the machine was loaded) and q4-recovery 1 passed each. `scripts/reload-safe.ts` showed a verification running; I waited the 10-minute bound, then proceeded
as instructed, and later runs shared the machine with a worker (this is why the q4 public run took 3
to 4.5 minutes instead of 87 seconds).

LFM3 env: `VITE_LFM3_QUALIFICATION_MODE` (`native-reference` | `q4` | `q4-recovery`),
`VITE_LFM3_MODEL_URL=/test/.weights/LFM3-Omni-2B-Q4_K_M.gguf`,
`VITE_LFM3_TOKENIZER_URL=/test/.weights/lfm3-tokenizer.json`. D1: `VITE_D1_Q8_QUALIFICATION_MODE=q8`,
`VITE_D1_Q8_MODEL_URL`, `VITE_D1_Q8_TOKENIZER_URL`, `VITE_D1_Q8_ARTIFACT_SHA256`.

## Not run, and why

- Everything audio on a GPU (5b reference test, 5c `audio` and `liquid-reference` modes): they need
  Liquid's engine module and frozen audio inputs, not present. The fork's ledger records the
  published-audio stage as incomplete. The audio parts are verified by typecheck, lint, format, Node
  tests and build only.
- LFM3 base-model modes (`base`, `cache-parity`) and D1 `baseline` / `repaired` / `correction`: they
  need the original float checkpoints (several GB), not present.

## Completeness proof

`git diff upstream/09-docs lazers-upstream-0.3 --stat` (26 files, +750 / -515). `+` lines exist only in
the fork; `-` lines exist only in the stack. Every difference is one of:

| Kind                                  | Files                                                                                                                                                                                                                                                                                                                                                                | Why                                                                                                            |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Fork-only, left out on purpose        | `playground/lfm3/{index.html,main.ts,vite.config.mjs}`, `test/zoo/d1/packed-consumer.mjs`, `test/zoo/lfm3/packed-consumer.mjs`, and the "Verify the packed package" section of `apps/docs/.../zoo/d1.mdx` (+14)                                                                                                                                                      | LFM3 demo and the packed-tarball scripts are fork qualification tooling; the docs section described the script |
| Doc comments added (readiness item 5) | `core/graph/ops/conv/conv1d.ts` (`depthwiseConv1d`), `core/graph/ops/matmul.ts` (`offsets`), `core/nn/layers.ts` (`Embedding.forward`), `core/weights/gguf.ts` (`fromGguf`, `parseGgufHeader`, types, `GgufStateDict`, `readGgufEmbeddingRows`), `core/weights/sha256.ts`, `zoo/lfm3/audio/{prompts,sampling}.ts` (file headers)                                     | Every new public name documented; `Sha256` marked internal                                                     |
| Concern fixes                         | `core/kernels/matmul/matmulQuantTiled.ts` (+ its GPU test): offsets with a custom scale layout throw; `zoo/d1/stateDictHooks.ts` (+ test): row remap and stack refuse offsets; `zoo/lfm3/audio/model.ts` (+ `model.test.ts`): padding refuses offsets                                                                                                                | Merge concerns 1 and 2                                                                                         |
| Direct tests added (readiness item 6) | `test/core/gpu/buffers.gpu.test.ts`, `test/core/gpu/readbackQueue.gpu.test.ts`, `test/core/graph/evalCore.test.ts`, `test/zoo/d1/image.test.ts`, `test/zoo/lfm3/gguf.test.ts`, `test/zoo/lfm3/audio/model.test.ts`; additions to `layers.test.ts` (Linear offsets, Embedding offsets), `transforms.test.ts` (`dequantize` adds offsets), `d1/stateDictHooks.test.ts` | Mirror `src`; expected values from the math                                                                    |

Not in the diff, and therefore identical to the fork: every other file, including the D1
port commits' playground files (`playground/d1/*` identical to `lazers-upstream-0.3`, which is why
`vite.config.mjs` with the fixed port and `cats.jpg` are in the series: they are the collaborator's
own files, see part 8).

The fold of `c5f288c` (fused logits readback) and `fa0aad9` (its removal) needed no work: the final
tree has no trace of the abandoned approach and no branch commit mentions it. The tree-level equality
is checked by the command above, not by replaying the fork history.

## Left out of the series (fork-only)

- `playground/lfm3/*` (demo page).
- **Exception, not left out:** the D1 playground demos (snake, webcam, triage, mod) and the bench page
  are **in** the stack, only because they sit inside the collaborator's cherry-picked commits
  (`1a9a1a8`, `9a0b58c`), which the brief asked to keep with their authorship. They are not ours; drop
  those two commits if the maintainers do not want demos.
- `playground/d1/vite.config.mjs` fixed port (5199): the collaborator's file, same caveat.
- `test/zoo/d1/packed-consumer.mjs` and `test/zoo/lfm3/packed-consumer.mjs`, and the docs section about
  them.

## Fixtures

| Fixture                                             | In  | Source                                                                                                                                                                                                                                                            | Licence, as far as the history shows                                                                                                                                                             |
| --------------------------------------------------- | --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `test/zoo/lfm3/liquid-reference.json` (6,288 lines) | 04  | Liquid's engine at `9c2fb176f4c222da394e8037d3c0d0837f70b978` (SHA-256 `77821949...`) run on the pinned `LFM3-Omni-2B-Q4_K_M.gguf` (`3d29af2a...`) for three prompts, by `liquid-reference.gpu.test.ts`; evidence in `contributions/runntime/omni-published-chat` | Weights: LFM Open License v1.0 (Liquid AI). No licence for the derived numbers or the engine appears in the history. **Not established; flag.** Used by `public.gpu` and `native-reference.gpu`. |
| `playground/d1/reference-vectors.json` (228 lines)  | 08  | transformers 5.22.2, torch 2.15.0, float32 CPU, `LiquidAI/d1-omni-600M` revision `02b55d7...`; generator `contributions/runntime/d1-reference/reference.py` (not in the series)                                                                                   | Same: LFM Open License v1.0 on the weights, nothing on the derived numbers. **Flag.** Used by `q8.gpu` and `qualification.gpu`.                                                                  |
| `playground/d1/public/cats.jpg` (173 KB)            | 08  | Added by `chmjkb`'s `e63a4bd`, no source or licence in the history                                                                                                                                                                                                | **Unsourced; flag.** No test uses it; only the collaborator's demos do. Dropping `1a9a1a8` and `9a0b58c` removes it.                                                                             |

## Merge concerns, fixed or disclosed

| #   | Concern                                                      | Outcome                                                                                                                                                                                                                                                         |
| --- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `quantRows` / `padQuantizedRows` drop offsets                | **Fixed by refusing**: D1's row remap and stack, and the audio model's padding, throw instead of silently losing offsets; a test each. Carrying offsets through them is not needed by any shipped checkpoint (D1 is symmetric Q8; the audio projector is Q8_0). |
| 2   | Offsets only on the default scale layout                     | **Fixed by refusing**: `createMatmulQuantTiledPipeline` throws if a custom `scaleAt` and `hasOffset` are combined; GPU test. Nothing combines them.                                                                                                             |
| 3   | `Embedding` differs on gpu and cpu                           | **Disclosed** (part 3, and on the class doc comment). Unifying either way costs memory or a new kernel.                                                                                                                                                         |
| 4   | Open PRs #131, #124, #127, #130 touch the same paths         | **Disclosed** (parts 2a, 3). Another merge is likely; 2a is the part most exposed.                                                                                                                                                                              |
| 5   | Upstream's `dequantize` ignored offsets (found in the merge) | **Fixed** in 2a with a test.                                                                                                                                                                                                                                    |
| 6   | One machine, one browser                                     | Disclosed in every part.                                                                                                                                                                                                                                        |

## Things the owner should decide

- Whether to keep the collaborator's playground commits (`1a9a1a8`, `9a0b58c`) in part 8.
- The two derived-numbers fixtures and `cats.jpg` (above).
- No memory or time numbers exist for the tied-embedding streaming change (part 6); upstream's testing
  guide asks for an A/B report on performance changes, so measure before review or label it as
  unmeasured.
- Whether to mention AI assistance: upstream has no written policy; 7 of the fork's commits were
  produced by LAZERS workers. The stack's commits are all new and authored by you.
- Audio is the least verified part: decide whether to offer 5b/5c at all before the maintainers can run
  the reference test with Liquid's engine.

## Rebuild or verify

```sh
git fetch origin 'refs/heads/upstream/*:refs/remotes/origin/upstream/*'
git diff origin/upstream/09-docs lazers-upstream-0.3 --stat        # the table above
for b in 01-conv1d 02a-quant-offsets 02b-gguf 03-embedding-eval 04-lfm3-chat 05a-omni-audio-frontend \
         05b-omni-audio-model 05c-omni-audio-runner 06-shared-backbone 07-speech-voice 08-d1 09-docs; do
  git checkout origin/upstream/$b && pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint \
    && pnpm format:check && pnpm --filter runntime test:unit && pnpm build
done
```
