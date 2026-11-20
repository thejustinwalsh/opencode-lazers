# feat(zoo): select the LFM3 speech voice by language and gender

Branch `upstream/07-speech-voice` (1 commit, `b1d371e`). Base in the stack:
`upstream/06-shared-backbone` (only needs 5c).

## Description

`speak()` takes `voice: { language?, gender? }` to build the TTS system instruction, for example
`Perform TTS in British English using a male voice.`, or `systemPrompt` to replace it. Omitted
fields keep the default (American English, female); an explicit `systemPrompt` wins over `voice`.
An empty string or a gender other than `female` or `male` throws `INVALID_ARGUMENT`.

## Introduces a breaking change?

- [ ] Yes
- [x] No

## Type of change

- [x] New feature (change which adds functionality)

## Public API added (`runntime/zoo`)

Type `Lfm3SpeechVoice`; `Lfm3SpeechOptions.voice` and `.systemPrompt`. Documented in the option
comments.

## Testing instructions

```sh
pnpm install --frozen-lockfile
pnpm typecheck && pnpm lint && pnpm format:check
pnpm --filter runntime test:unit          # 72 files, 1332 tests
pnpm build
```

Node: `prompts.test.ts` checks that the default prompt is unchanged with no voice, the instruction
text built from a typed voice, and that an explicit `systemPrompt` overrides the voice.

## GPU tests run locally

None for this part (prompt text and validation only). M2 Pro (16-core GPU), 32 GB, macOS 27.2; Playwright Chromium `chromium-1248`, headless, `--enable-unsafe-webgpu`;
Node v26.9.0, pnpm 11.10.0 (CI uses Node 24).

## Deliberately not included

Anything beyond the system instruction: no new weights or voice assets.

## Known limits

The instruction is a plain-English string the model follows; the language or dialect strings are not
validated against a list, and whether the model honours an unusual one has not been measured.

## Checklist

- [x] I have performed a self-review of my code
- [x] I have commented my code, particularly in hard-to-understand areas
- [x] I have updated the documentation accordingly
- [x] My changes generate no new warnings

## Additional notes

Commit: `feat(zoo): select the LFM3 speech voice by language and gender`.
