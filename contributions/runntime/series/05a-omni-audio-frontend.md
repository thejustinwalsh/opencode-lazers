# feat(zoo): add the LFM3-Omni audio frontend, projector layout, codec and sampler

Branch `upstream/05a-omni-audio-frontend` (1 commit, `d6ba5bb`). Base in the stack:
`upstream/04-lfm3-chat`.

Part 5 of the original table (about 1,900 lines of audio model plus runner) is split into 5a, 5b and
5c so each can be reviewed alone. 5a has no model and no weights.

## Description

Pure TypeScript building blocks for LFM3-Omni audio, each with Node tests:

- `frontend.ts`: the 16 kHz, 400-point FFT, hop 160, 128-bin log-mel frontend, frame and token
  counts, and the inverse FFT the codec uses.
- `projector.ts`: validation of the pinned audio-projector GGUF metadata and tensor layout
  (`validateLfm3AudioProjector(index)` over a `GgufIndex`).
- `codec.ts`: overlap-add synthesis of LiquidCodec's predicted spectrum frames to 24 kHz samples.
- `sampling.ts`: Liquid's seeded draw stream, MaskGIT codebook order and reveal sizes, and the
  PCG-hashed Gumbel-max sampler for depth codes.
- `prompts.ts`: the transcription and speech chat prompts and their token ids.

## Introduces a breaking change?

- [ ] Yes
- [x] No

## Type of change

- [x] New feature (change which adds functionality)

## Public API added

None. Nothing new is exported from `runntime/zoo`; the modules are internal and used by 5b and 5c.

## Testing instructions

```sh
pnpm install --frozen-lockfile
pnpm typecheck && pnpm lint && pnpm format:check
pnpm --filter runntime test:unit          # 69 files, 1322 tests
pnpm build
```

Node tests (CI runs them): `frontend.test.ts` (Liquid's 2 to 32 s graph sizes and three
convolutional strides, a finite 128-band Slaney log-mel matrix in mel-major order, a tonal input
distinct from silence, and a match with a direct-DFT reference of the Slaney power frontend written
in the test), `projector.test.ts` (pinned dimensions, missing or wrong-format tensors, unsupported
version, unexpected metadata), `codec.test.ts` (six 1280-point frames overlap-add to one 1920-sample
frame, a match with an independent direct inverse-DFT overlap-add reference, malformed input
refused, streaming equals batch), `sampling.test.ts` (draw order, the `[4, 4, 4]` schedule,
Gumbel-max selection, greedy at zero temperature), `prompts.test.ts` (ASR and TTS framing, one audio
start marker).

## GPU tests run locally

None for this part (no GPU code). M2 Pro (16-core GPU), 32 GB, macOS 27.2; Playwright Chromium `chromium-1248`, headless, `--enable-unsafe-webgpu`;
Node v26.9.0, pnpm 11.10.0 (CI uses Node 24).

## Deliberately not included

The audio model (5b), the public runner (5c), anything exported.

## Known limits

This part adds modules that nothing calls yet. They are separated for review size; if the
maintainers prefer no unused code, merge 5a into 5b.

## Checklist

- [x] I have performed a self-review of my code
- [x] I have commented my code, particularly in hard-to-understand areas
- [x] I have updated the documentation accordingly
- [x] My changes generate no new warnings

## Additional notes

Commit: `feat(zoo): add the LFM3-Omni audio frontend, projector layout, codec and sampler`.
