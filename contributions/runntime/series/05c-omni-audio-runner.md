# feat(zoo): add createLfm3Audio for transcription and streamed speech

Branch `upstream/05c-omni-audio-runner` (1 commit, `aadd3ee`). Base in the stack:
`upstream/05b-omni-audio-model`.

## Description

`createLfm3Audio(model?, loadOptions?)` loads the published Q4_K_M language file and Q8_0 audio
projector (both size- and digest-checked) and returns:

- `transcribe(audio, { maxNewTokens?, signal? })`: 16 kHz mono PCM (2 to 32 s) to text.
- `speak(text, { maxAudioFrames?, temperature?, depthPasses?, seed?, signal? })`: streamed 24 kHz mono
  PCM chunks as codec frames arrive; `result` resolves with the samples, frame count and
  `finishReason`; `cancel()` and an `AbortSignal` stop it.
- `dispose()` stops queued and in-flight work and releases both models.
- `sources`: the exact source identities used; no weight conversion happens.

Calls are serialized. Failed loads, failed or aborted generations release their buffers, and a queued
speech failure does not leak into the next call.

## Introduces a breaking change?

- [ ] Yes
- [x] No

## Type of change

- [x] New feature (change which adds functionality)

## Public API added (`runntime/zoo`)

`createLfm3Audio`, types `Lfm3Audio`, `Lfm3AudioModel`, `Lfm3SpeechGeneration`, `Lfm3SpeechOptions`,
`Lfm3SpeechResult`, `Lfm3TranscriptionOptions`. All have doc comments; defaults and limits are in the
option comments (256 speech frames by default, at most 1,024; transcription 256 tokens by default).

## Testing instructions

```sh
pnpm install --frozen-lockfile
pnpm typecheck && pnpm lint && pnpm format:check
pnpm --filter runntime test:unit          # 72 files, 1327 tests
pnpm build
cd packages/runntime && pnpm exec vitest run --project gpu test/zoo/lfm3    # 2 pass, 7 skipped
```

- Node: `test/zoo/lfm3/audio/public.test.ts` (a pre-aborted load reads neither source),
  `test/zoo/tasks/audio/speak.test.ts` (with a stub backbone: early break of a speech stream cancels
  without an unhandled rejection and the next call works; a failed speech result rejects and its
  already-queued successor still runs).
- GPU (opt-in, need weights and audio fixtures): `public-audio.gpu.test.ts` (mode `audio`: frozen
  audio inputs through the public entry, buffer accounting) and `liquid-reference.gpu.test.ts`
  (the opt-in generator of Liquid's reference data: teacher-forced vectors and deterministic answers
  from the pinned engine, which produced `liquid-reference.json` in part 4; needs the engine).

## GPU tests run locally

M2 Pro (16-core GPU), 32 GB, macOS 27.2; Playwright Chromium `chromium-1248`, headless, `--enable-unsafe-webgpu`;
Node v26.9.0, pnpm 11.10.0 (CI uses Node 24). `vitest run --project gpu test/zoo/lfm3` with no environment: 2 passed, 7 skipped. The
audio-mode suites (`VITE_LFM3_QUALIFICATION_MODE=audio`, `liquid-reference`) **were not run**: the
frozen audio-input route and the engine module are not available here.

## Deliberately not included

`generate()` on the audio runner and the `createLfm3Omni` alias (6), the voice option (7), the docs
page (9), the fork's playground.

## Known limits

- **Audio is not qualified in this tree.** The fork's own ledger records the published-audio stage as
  incomplete (not an acceptance), and the post-merge runs did not include audio. Parity of
  transcription and speech with Liquid's engine has not been demonstrated on the v0.3.0 base.
- This runner loads its own language backbone; part 6 shares one with chat.
- Needs `shader-f16`; throws `UNSUPPORTED_DEVICE` without it.
- Input is bounded to 32 s of 16 kHz audio.

## Checklist

- [x] I have performed a self-review of my code
- [x] I have commented my code, particularly in hard-to-understand areas
- [x] I have updated the documentation accordingly
- [x] My changes generate no new warnings

## Additional notes

Commit: `feat(zoo): add createLfm3Audio for transcription and streamed speech`.
