# feat(zoo): add LFM3-Omni 2B streaming chat on original and Q4_K_M weights

Branch `upstream/04-lfm3-chat` (1 commit, `a7948f1`). Base in the stack: `upstream/03-embedding-eval`
(needs part 1 for the short convolutions, 2b for GGUF, 3 for the CPU embedding).

## Description

`createLfm3Chat(model?, loadOptions?)` runs the text backbone of Liquid AI's LFM3-Omni 2B on WebGPU:
24 layers mixing short convolutions (kernel 7) with full and sliding-window (256) attention, cached
state, 128k context.

- `generate(messages, { maxNewTokens?, signal? })` streams stable text deltas (async iterable) and
  resolves `result` with the text, input and completion token counts and `finishReason`
  (`stop` | `length`). `cancel()` and an `AbortSignal` stop it. `reset()` drops the cached state,
  `dispose()` cancels work and releases the weights.
- Two weight sources, both from Liquid's repositories at pinned revisions: the original BF16
  safetensors (`models.lfm3.LFM3_OMNI_2B.DEFAULT`) and the published Q4_K_M GGUF (`...Q4_K_M`),
  whose size and SHA-256 are checked through `fromGguf` before use.
- Tokenizer on tokenizers.js with the chat template and the audio special tokens.
- No weights are hosted by this project.

## Introduces a breaking change?

- [ ] Yes
- [x] No

## Type of change

- [x] New feature (change which adds functionality)

## Public API added (`runntime/zoo`)

`createLfm3Chat`, types `Lfm3ChatModel`, `Lfm3ChatOptions`, `Lfm3ChatSession`, `Lfm3Generation`,
`Lfm3GenerationResult`, `Lfm3Message`; `models.lfm3.LFM3_OMNI_2B.{DEFAULT, Q4_K_M}`.

## Testing instructions

```sh
pnpm install --frozen-lockfile
pnpm typecheck && pnpm lint && pnpm format:check
pnpm --filter runntime test:unit          # 64 files, 1293 tests
pnpm build
cd packages/runntime
pnpm exec vitest run --project gpu test/zoo/lfm3     # 2 pass, 4 skipped without weights or env
# weights are served from test/.weights (symlinks; the tests do not download anything)
W=/test/.weights
VITE_LFM3_QUALIFICATION_MODE=native-reference VITE_LFM3_MODEL_URL=$W/LFM3-Omni-2B-Q4_K_M.gguf \
  pnpm exec vitest run --project gpu test/zoo/lfm3/native-reference.gpu.test.ts
VITE_LFM3_QUALIFICATION_MODE=q4 VITE_LFM3_MODEL_URL=$W/LFM3-Omni-2B-Q4_K_M.gguf \
  VITE_LFM3_TOKENIZER_URL=$W/lfm3-tokenizer.json \
  pnpm exec vitest run --project gpu test/zoo/lfm3/public.gpu.test.ts
VITE_LFM3_QUALIFICATION_MODE=q4-recovery VITE_LFM3_MODEL_URL=$W/LFM3-Omni-2B-Q4_K_M.gguf \
  VITE_LFM3_TOKENIZER_URL=$W/lfm3-tokenizer.json \
  pnpm exec vitest run --project gpu test/zoo/lfm3/recovery.gpu.test.ts
```

- Node (CI runs these): `session.test.ts` (ordered streaming, EOS, length finish, incomplete
  characters held back, cancel and reset of queued and in-flight work, failure propagation and
  recovery, stream-only early break), `tokenizer.test.ts` (pinned special ids, template, audio
  placeholder, moved stop token), `stateDictHooks.test.ts` (checkpoint filtering, RoPE row order,
  GGUF name mapping, wrong-architecture metadata, packed MLP pair), `gguf.test.ts` (the pinned source
  record is well-formed and matches the reference fixture).
- GPU `native-reference.gpu.test.ts`: hidden states at four token positions and greedy tokens for
  three prompts, against vectors produced by Liquid's own engine (`liquid-reference.json`): cosine at
  least 0.998 and absolute error at most 0.25. The expected values come from the reference engine,
  not from this code. `public.gpu.test.ts`: load through the public entry (pre-aborted load, bad
  source, streaming, abort, dispose, buffer accounting). `recovery.gpu.test.ts`: recovery after
  failures. Also `model-lifecycle`, `cache-parity` and `fused-readback-recovery`.

## GPU tests run locally

M2 Pro (16-core GPU), 32 GB, macOS 27.2; Playwright Chromium `chromium-1248`, headless, `--enable-unsafe-webgpu`;
Node v26.9.0, pnpm 11.10.0 (CI uses Node 24).

| Run                                               | Result                                                                           |
| ------------------------------------------------- | -------------------------------------------------------------------------------- |
| `vitest run --project gpu test/zoo/lfm3` (no env) | 2 passed, 4 skipped                                                              |
| native-reference, Q4_K_M GGUF                     | 1 passed (about 30 s)                                                            |
| q4 public                                         | 1 passed (87 s on an idle machine, 218 to 267 s while other work shared the GPU) |
| q4-recovery                                       | 1 passed (45 to 55 s)                                                            |

Not run: the base-model modes (`base`, `cache-parity`): the original BF16 safetensors is not on this
machine.

## Deliberately not included

- Audio (parts 5 to 7), the shared backbone and tied-embedding streaming (part 6): in this part the
  tied embedding is decoded to a CPU table at load.
- Docs pages (part 9), and the fork's playground demo.
- `packed-consumer.mjs`, a script the fork uses to qualify a packed tarball.
- Hosting or converting any weights.

## Known limits

- **Fixture `test/zoo/lfm3/liquid-reference.json` (6,288 lines, most of this part's size).**
  Reference vectors from Liquid's engine at revision `9c2fb176f4c222da394e8037d3c0d0837f70b978`
  (engine SHA-256 `77821949...`) run on the pinned GGUF files, for three one-token-answer prompts.
  It was produced by `test/zoo/lfm3/liquid-reference.gpu.test.ts` (part 5c), an opt-in generator that
  drives the pinned engine; the fork's records hold the evidence (`omni-published-chat`). The model weights are
  under the LFM Open License v1.0; the repository history states no licence for the derived numbers
  or for the engine, so redistribution under MIT is **not established**. It needs the owner's or
  Liquid's confirmation, or the fixture can be shrunk to one prompt.
- One machine, one browser.

## Checklist

- [x] I have performed a self-review of my code
- [x] I have commented my code, particularly in hard-to-understand areas
- [x] I have updated the documentation accordingly
- [x] My changes generate no new warnings

## Additional notes

The `projector` block of `liquid-reference.json` is used by the audio tests in part 5c.
