# ruNNtime LFM3 selectable speech voice contribution

Adds `Lfm3SpeechOptions.voice` (`{ language?, gender? }`, typed) and a lower-level
`systemPrompt` override to `Lfm3Audio.speak`. Default behavior is unchanged:
"Perform TTS in American English using a female voice." A British English female
voice produces "Perform TTS in British English using a female voice." An explicit
`systemPrompt` wins over `voice`. Empty `systemPrompt`/`voice.language` and an
unknown `voice.gender` fail with `INVALID_ARGUMENT` before queueing. Also exports
`lfm3SpeechSystemPrompt`, `Lfm3SpeechVoice` and `Lfm3SpeechPromptOptions` from the
prompt module, and `Lfm3SpeechVoice` from `runntime/zoo`.

## Identity

- Fork: `https://github.com/thejustinwalsh/runntime`, branch `lazers-voice`,
  fast-forwarded into `lazers-shared-omni`.
- Base: `68e9e608dda71aad6c41263d435ed262d2a32de3` (release `lazers-omni-68e9e60`).
- Tip: `a3718c80f959b8e86d1b2abf056fb578f532aeb9`, `feat(zoo): selectable LFM3 speech voice`.
- Release: `lazers-omni-a3718c8`, asset
  `https://github.com/thejustinwalsh/runntime/releases/download/lazers-omni-a3718c8/runntime-0.2.0-a3718c8.tgz`
  (SHA-256 `9be9c3c9dbaa6bcaa76f99626c98e0459e6b2077529c448d64518f9050719c21`).

## Evidence

Retained: unit (60 files, 1193 tests), typecheck, build and package listing.
GPU and model-weight tests were not run; the change only alters the system
prompt text of the TTS chat framing, covered by the prompt-framing unit tests in
`packages/runntime/test/zoo/lfm3/audio/prompts.test.ts`. No audible
verification of the British voice has been made.

Verify with `bun scripts/verify-runntime-contribution.ts --stage lfm3-voice`
(optionally `--repository <runntime checkout>`).
