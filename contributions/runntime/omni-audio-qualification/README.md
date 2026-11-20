# Omni audio qualification harness: what ran, on what, and what remains

Evidence for the ruNNtime fork branch `upstream/10-audio-qualification` (pushed to `origin`, the
fork `thejustinwalsh/runntime`; stacked on `upstream/09-docs` at `1d5c3b3`). Nothing was sent
upstream; no pull request, issue or comment. This directory is not committed.

Tip under test: `ddb0a88892f9eaef058b3a2489f011577f0d7c78`, clean tree. Ten commits on top of
`1d5c3b3` (patches in `patches/`, made with `git format-patch`).

## What was run

| Item      | Value                                                                                                                          |
| --------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Machine   | MacBook Pro, Apple M2 Pro, 32 GB, macOS 27.2                                                                                   |
| Browser   | Playwright Chromium (`chromium-1248`, reports HeadlessChrome/156), headless, `--enable-unsafe-webgpu`                          |
| WebGPU    | vendor `apple`, architecture `metal-3`, features `core-features-and-limits`, `shader-f16`, `subgroups`                         |
| Toolchain | Node v26.9.0, pnpm 11.10.0, Vitest 5.0.4, Playwright 1.64.0, TypeGPU ^0.12.5                                                   |
| Weights   | `LFM3-Omni-2B-Q4_K_M.gguf` `9f8d30e9d4fd7a9349d586e077988229b3ca0a0e4ad730897563d1eccc9893e2` (hashed by the script each run)  |
|           | `mmproj-LFM3-Omni-2B-Q8_0.gguf` `8a25f9d1931244429de404fccacfb7fb933970a36aa5688d2f5069f29c6b27b1`                             |
|           | `lfm3-tokenizer.json` `41927bd314d17d7d7fadb44e10cd0919f7b71528d7741596d8cbd15c6945ec44`                                       |
| Engine    | Liquid WebGPU bundle `77821949412f5dd6d60e37f22415f0e71454e65f6a73928529c6fbec0f2cf2cb` plus one getter (digest `8dbbedff...`) |
| Network   | none: the page's `fetch` and `XMLHttpRequest` refuse any other origin; every result lists `blocked: []`                        |

Command (from `packages/runntime` of the fork worktree):

```sh
node test/zoo/lfm3/audio-qualification.mjs \
  --mode audio-roundtrip --mode audio-streaming --mode audio-input --mode audio-memory \
  --mode audio-public --mode audio-liquid-reference --mode audio-liquid-roundtrip \
  --out results/final-all-ddb0a88.json
```

All seven modes passed; exit 0. `pnpm test:audio` with no `--mode` runs the first four. Gates at
the tip (`logs/gates-ddb0a88.log`): `pnpm typecheck`, `pnpm lint`, `pnpm format:check`,
`pnpm --filter runntime test:unit` (79 files, 1370 tests), `pnpm build` all pass. Each earlier
commit was checked for typecheck, lint, format and unit tests (`logs/checkpoints.log`). The first six
commits show `format FAIL` there only because that worktree held the generated, git-excluded
`test/.weights/lfm3-engine-instrumented.js` before `1bd6774` told Prettier to ignore `.weights`; a clean
checkout has no such file. The `build` gate was run at the tip only.

## Results

Round trip, `speak` then `transcribe`, 8 fixed sentences x 4 voices (`results/final-all-ddb0a88.json`,
seed 1234): 32 of 32 exact, word error rate 0 in every voice. Over three seeds (1234, 7, 99991; 96
items; `results/roundtrip-3-seeds-deb7692.json`, repeated with the same transcripts and the same single miss by an
earlier run, `roundtrip-3-seeds-measurement-f26a16b.json`): mean 0.0015, max 0.1429, 95 exact. The single miss is
seed 99991, british-female, "Please turn left at the next street." heard as "...next treat."

| Voice           | Seed 1234 | Seed 7 | Seed 99991 |
| --------------- | --------: | -----: | ---------: |
| american-female |         0 |      0 |          0 |
| american-male   |         0 |      0 |          0 |
| british-female  |         0 |      0 |     0.0179 |
| british-male    |         0 |      0 |          0 |

Variance: the same seed gives identical samples (`streaming-determinism`) and identical transcripts
across runs; the limits in `thresholds.ts` (mean 0.01, item 2/7) come from the 96-item measurement.
Timings (seed 1234, 32 items): speech generation 2.1 s mean for 3.2 s of audio (0.66 of real time),
transcription 0.49 s mean, model load plus warm-up 28 to 34 s from local files (3.39 GB read, the
hash pass included). Levels: peak 0.34 to 0.64, RMS 0.049 to 0.094, no clipped sample.

GPU memory: 1.825 GB after load. Twelve speak and transcribe cycles over eight sentences end between
1.843 and 1.886 GB; the second pass over the same sentences differs from the first by at most 6 KB.
After `dispose` no storage buffer remains and 0.52 MB stays in TypeGPU's root cache. Before the fix
below the same cycles grew from 1.967 to 2.175 GB in six cycles (`results/memory-before-trim-fix.json`
against `results/memory-after-trim-fix-12-cycles.json`).

Pinned Liquid engine (`audio-liquid-reference`), the same numbers as retained run 30: audio encoder
69,632 values, RMS error 5.49e-05, max 7.90e-04, cosine 0.99999963; depth-decoder codes
`[927,603,1912,689,1200,399,91,1621,736,1100,1467,1745]` match exactly; codec PCM 1,920 values,
RMS error 2.32e-05, cosine 0.99998899. Liquid's own round trip (`audio-liquid-roundtrip`): both frozen
clips transcribed exactly, its speech (seed 1234) hashes `9d265662...` and `751feb32...` equal run 26's,
and its transcriber recovers both requests. `audio-public`: the two system-voice clips transcribe
exactly through the public runner; depth 1 and 3 speech; abort recovery; no storage buffer after dispose.

Streaming and recovery: chunks add up to the result; early `break`, `cancel()` and an aborted signal
reject with `EXECUTION_FAILED`, free their buffers (GPU bytes equal before and after) and the next
speech is sample-identical; a cancelled queued request does not disturb the running one or the one
behind it; `finishReason: 'length'` at `maxAudioFrames`; a 71-word text stops at 256 frames (20.48 s) as
`length` with 61 words heard; invalid options throw before queueing; `dispose` mid-stream rejects.
Input: the transcript is unchanged at 51,200, 64,000, 64,001, 128,000 and 128,001 samples; a 29.4 s
clip of eight sentences padded to the 512,000-sample maximum transcribes exactly (0 of 71 words
wrong, 3.4 s) and 512,001 samples is rejected `INVALID_ARGUMENT`; 24 kHz speech through
`resampleAudio` and through `decodeAudio` of a 24 kHz WAV both transcribe exactly; a spoken
"What is the capital of France?" is heard exactly and answered "Paris".

## Defect found and fixed

`createLfm3Audio` trimmed its executor pool only after warm-up, so each distinct clip or prompt length
left a set of pooled buffers (chat sessions trim after every call). Fix: `executor.trim()` after each
queued operation, commit `bff786d`, with the memory assertion that exposed it. It logically belongs to
`upstream/05c-omni-audio-runner` (the file `src/zoo/tasks/audio/lfm3.ts` arrives there); it is on
`upstream/10-audio-qualification` because that branch is pushed history.

## Observations that are not verdicts

- Silence and noise are transcribed as plausible speech: 3 s of silence gave "Okay, so I'm going to go
  ahead and.", a 50 ms tone "You". Not compared with Liquid's engine, so not known to be a divergence.
- "12345" spoken, then transcribed, gave "184 thief."; "Un café très tranquille." and "Hi." round-trip.
  Digit strings were not compared with Liquid either.
- 24 kHz speech read as 16 kHz without resampling still transcribed exactly (a 1.5x slowdown); the
  earlier ledger story that direct 24 kHz input fails is not reproduced here.
- One `pnpm --filter runntime test:unit` run failed while a GPU run shared the machine; it passed on
  rerun and in the gate log. It matches the known 5 s default timeout flake under load.
- `roundtrip-3-seeds-deb7692.json` records `dirty: true`: a test file was edited while it ran; the
  edit was a new streaming test, not used by that mode.

## Missing pieces, as found (the answer to "not run / incomplete")

The earlier claim that these tests "need Liquid's engine and frozen audio inputs, which this machine
does not have" was wrong on both counts.

| Test or check                                                                                       | Proves                                                                                                                      | Needs                                                                                                      | On this machine?                                                                                                                               | Class        | How it runs now                    |
| --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ---------------------------------- |
| `audio/{frontend,codec,sampling,prompts,projector,model,public}.test.ts`, `tasks/audio/*.test.ts`   | Shapes, direct-DFT mel for one frame, inverse-DFT overlap-add, seeded draws, prompts, projector schema, mocks of the runner | Nothing                                                                                                    | Yes                                                                                                                                            | a            | `pnpm --filter runntime test:unit` |
| `audio/qualification/frontendSignals.test.ts` (new)                                                 | Mel on sines, chirp, impulses, silence, clipped sine against a direct-DFT reference over several frames                     | Nothing                                                                                                    | Yes                                                                                                                                            | b            | same                               |
| `audio/qualification/wer.test.ts` (new)                                                             | The scoring itself                                                                                                          | Nothing                                                                                                    | Yes                                                                                                                                            | b            | same                               |
| `audio-qualification.gpu.test.ts`, modes `audio-roundtrip`, `-streaming`, `-input`, `-memory` (new) | Speech and transcription with every voice, recovery paths, limits, sample rates, GPU memory                                 | The GGUF pair, tokenizer; speech inputs come from the model with a fixed seed                              | Yes                                                                                                                                            | a/b          | `pnpm test:audio`                  |
| `public-audio.gpu.test.ts` (mode `audio`)                                                           | Public runner on two system-voice clips, depth 1 and 3, abort recovery                                                      | Frozen clips `quick-brown-fox.wav`, `turn-left-next-street.wav`; it fetched the tokenizer from the network | Weights yes; clips regenerate byte for byte with `say -v Samantha -r 175` and `afconvert` (hashes match run records); tokenizer override added | b            | `--mode audio-public`              |
| `audio-reference.gpu.test.ts` (mode `liquid-reference`)                                             | Encoder, depth codes, codec PCM against Liquid's engine                                                                     | Engine bundle (sha256 above), engine plus one getter, frozen clip, GGUF pair                               | Yes: `.cache/lfm3-engine.js` in the LAZERS repo has the pinned hash                                                                            | c, but local | `--mode audio-liquid-reference`    |
| `liquid-reference.gpu.test.ts` with audio capture                                                   | Liquid's own ASR and TTS round trip on the clips                                                                            | Same, plus a capture server to retain speech (made optional)                                               | Yes                                                                                                                                            | c, but local | `--mode audio-liquid-roundtrip`    |
| Native speech transcribed by Liquid (`VITE_LFM3_NATIVE_SPEECH_URL`)                                 | Cross-engine intelligibility of our speech                                                                                  | A WAV of our speech served to the page, hence a capture server                                             | Not run                                                                                                                                        | c            | Not wired; see below               |
| End-to-end PCM or code-frame parity of a whole utterance against Liquid                             | Same codes for the same seed over a full utterance                                                                          | Both engines in one page, our codes exposed                                                                | Not run; no public hook for codes                                                                                                              | c            | Not built                          |
| LFM3 base-model modes, D1 `baseline`/`repaired`                                                     | Chat on float weights, D1 float                                                                                             | Float checkpoints of several GB                                                                            | No (not audio)                                                                                                                                 | -            | Out of scope; not downloaded       |

## Class (c): the external engine

- What it is: Liquid's browser WebGPU library `Lfm3OmniForConditionalGeneration.js`, the file of the
  Hugging Face Space `LiquidAI/LFM3-Omni-2B-WebGPU` at revision `9c2fb176f4c222da394e8037d3c0d0837f70b978`
  (source: `contributions/runntime/lfm3-base-chat` and the LAZERS commit `b3b47fc0`, which records the
  Space URL and the hash). Not native: it runs in the same Chromium on the same GPU. A copy is at
  `opencode-lazers/.cache/lfm3-engine.js`, 1.6 MB, hash verified.
- How it was used: `liquid-reference.json` (chat vectors) and run 30 came from this bundle, loaded by
  URL, with a getter `get reference(){return this.#e}` inserted before `get generation_config(){...}` so
  the inner model is reachable. The script verifies the hash and that the anchor occurs once.
- Licence: the bundle carries no licence text (no match for "licen[cs]e") and the repository records none.
  The Space metadata was not read because that needs the network. Redistribution into the MIT fork is
  therefore not established; the harness never stores the bundle, it reads it from `test/.weights/`.
- Frozen clips: Apple's `Samantha` voice output; regenerated on macOS 27.2 they hash exactly as the
  retained ones. Not committed; the script regenerates them and refuses a differing hash. A different
  macOS build may produce different bytes.
- What only the engine can show: parity of the encoder, depth codes and codec (done above), and
  what Liquid's own speech sounds like to its own transcriber (done). Two further checks would need
  more build work, not downloads: cross-engine transcription of our speech and a full-utterance code
  comparison. If parity with the engine is required for those, no weaker check substitutes for them.
- Nothing was downloaded, built or installed for this.

## What remains unproven

- Perceptual quality: no listening; word error rate through the model's own transcriber is the
  measure. A model that transcribes its own speech correctly can still sound wrong.
- Non-model speech: only two clips from one synthetic system voice; no natural speech, accents, noise or
  other languages beyond one French phrase.
- One machine, one browser, one GPU family; no second adapter, no Windows or Linux.
- Q4_K_M/Q8_0 only; the float checkpoint and the D1 modes need weights we do not have.
- Silence and digit behaviour against Liquid's engine (above).
- Host memory: only the JS heap is recorded; Chromium does not expose GPU process memory.
- `audio-liquid-reference` compares one frame of depth codes and one codec frame, as run 30 did.

## Proposed changes to the ledger (not applied)

`omni-published-audio/partial-manifest.json` status can move from `incomplete-not-acceptance` only
for the items this directory covers; the stage is not accepted as it stands.

- Replace "Independent audio attention, convolution and depth-decoder vectors against Liquid remain
  outstanding" with: encoder, depth codes and codec frame reproduce run 30 exactly at `ddb0a88`
  (`results/final-all-ddb0a88.json`), and note that attention and convolution internals are covered only
  through the encoder output.
- Replace the speech-quality deviation section's open items with the 32 of 32 and 95 of 96 round trips,
  and record that runs 19 to 23 used resampling the harness has since fixed.
- Replace "not run" for the audio parts in `series/README.md` and the 5b, 5c part files with the
  seven modes, and name the new part 10 (`upstream/10-audio-qualification`).
- Add `omni-audio-qualification` to `STAGES` in `scripts/verify-runntime-contribution.ts` with the
  fork base `1d5c3b3` and tip `ddb0a88` and its patches, and record these checks in a manifest with the
  verifier's kinds: `unit` (the 79-file run), `gpu` (`final-all-ddb0a88.json` per mode, exit 0),
  `typecheck`, `lint`, `build`, `parity` (the two Liquid modes), `package` (not produced: needs
  `packed-consumer.mjs`, which lives on `lazers-upstream-0.3`, run against this tip) and `resource`
  (the memory mode). `conversion` has no counterpart here. The verifier requires every listed
  kind with a sha256 of an evidence file and exit code 0, so `package` and `conversion` are what would
  still be missing for the stage to pass.
- Keep the stage's status `incomplete` until `package` exists and the owner decides on the licence
  question for the engine bundle.
