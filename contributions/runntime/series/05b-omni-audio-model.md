# feat(zoo): add the LFM3-Omni audio model on TypeGPU

Branch `upstream/05b-omni-audio-model` (1 commit, `37a03f2`). Base in the stack:
`upstream/05a-omni-audio-frontend` (needs 1 for `depthwiseConv1d`, 2b for GGUF, 3 for the CPU
embedding, 4 for the chat tokenizer and backbone).

## Description

`Lfm3AudioModel` (`zoo/lfm3/audio/model.ts`) is the audio side of LFM3-Omni on core ops:

- a 17-layer audio encoder with short convolutions (`depthwiseConv1d`) and attention in layers
  2, 5, 8, 11, 14, 15 and 16, plus the downsampler and the projector into the language width;
- the depth decoder: 12 codebooks of 2,017 codes (2,016 plus end of audio) predicted per audio frame;
- the LiquidCodec head (hidden 512, 6 output frames per code).

Weights come from Liquid's published Q8_0 projector GGUF (`mmproj-LFM3-Omni-2B-Q8_0.gguf`,
506,842,528 bytes, SHA-256 `8a25f9d1...`), loaded through `fromGguf` after the projector's tensor
layout is validated (5a). The file's identity joins the Q4_K_M one in `zoo/lfm3/gguf.ts`.
Zero-padding of a quantized projection (the codebook heads and the codec output) refuses a weight
with per-group offsets instead of dropping them.

## Introduces a breaking change?

- [ ] Yes
- [x] No

## Type of change

- [x] New feature (change which adds functionality)

## Public API added

None (`Lfm3AudioModel` and the pinned-source record are internal; the public runner is 5c).

## Testing instructions

```sh
pnpm install --frozen-lockfile
pnpm typecheck && pnpm lint && pnpm format:check
pnpm --filter runntime test:unit          # 70 files, 1324 tests
pnpm build
```

- Node: `test/zoo/lfm3/audio/model.test.ts` checks that each depth codebook is padded into a head
  projection of 2,020 rows (2,017 rounded up to a multiple of 4) and that a codebook carrying
  per-group offsets is refused rather than padded without them.
- GPU: `test/zoo/lfm3/audio-reference.gpu.test.ts` compares encoder outputs, depth logits and codec
  spectra with Liquid's engine on pinned inputs. It needs the Liquid engine module and audio
  fixtures (`VITE_LFM3_LIQUID_ENGINE_URL`, `..._MODEL_URL`, `..._PROJECTOR_URL`,
  `..._AUDIO_INPUT_BASE_URL`) and is skipped otherwise.

## GPU tests run locally

M2 Pro (16-core GPU), 32 GB, macOS 27.2; Playwright Chromium `chromium-1248`, headless, `--enable-unsafe-webgpu`;
Node v26.9.0, pnpm 11.10.0 (CI uses Node 24). The audio reference test **was not run**: the engine module and frozen audio inputs are not
available on this machine. The model is exercised end to end only through part 5c's public runner
tests, which are also opt-in. Nothing in this part was run on a GPU here; the branch is verified by
typecheck, lint, format, unit tests and build.

## Deliberately not included

The public runner (5c), the shared backbone (6), the voice option (7), docs.

## Known limits

- **Not qualified on this machine.** The merge with upstream v0.3.0 did not re-run the LFM3 audio
  suites. Treat this part as unverified on a GPU until `audio-reference.gpu.test.ts` is run with the
  engine.
- The audio encoder needs `shader-f16` (the public runner refuses a device without it).
- About 1,500 lines in one file; the encoder, depth decoder and codec could be split further.

## Checklist

- [x] I have performed a self-review of my code
- [x] I have commented my code, particularly in hard-to-understand areas
- [x] I have updated the documentation accordingly
- [x] My changes generate no new warnings

## Additional notes

Commit: `feat(zoo): add the LFM3-Omni audio model on TypeGPU`.
