# zoo: one LFM3 backbone for chat and audio, tied embedding rows from the GGUF

Branch `upstream/06-shared-backbone` (2 commits: `8d00183`, `6b8d0b0`). Base in the stack:
`upstream/05c-omni-audio-runner`.

## Description

1. `feat(zoo): share one LFM3 backbone between chat and audio`
   `createLfm3Audio` builds one language backbone for transcription, speech and text. The runner
   gains `generate()`, the chat session over that backbone, so an app that speaks, transcribes and
   chats loads the language weights once instead of once per runner. `createLfm3Omni` and `Lfm3Omni`
   name the combined runner. The audio output queue is generic over text and sample chunks.
2. `perf(zoo): stream tied LFM3 embedding rows from the GGUF instead of decoding the table`
   The Q4_K_M file ties the token embedding to the output head. Decoding it into a CPU f32 table
   would keep a full-size float copy of a quantized weight in memory, so a GGUF load now reads only
   the rows a prompt looks up. `fromGguf` returns a `GgufStateDict` with `rows(name, start, count)`,
   `readGgufEmbeddingRows` decodes the distinct requested rows (reads bounded to 16 at a time), and
   the LM head shards read their rows from the file. `Lfm3Backbone.embedTokens` becomes async and
   takes the abort signal.

## Introduces a breaking change?

- [ ] Yes
- [x] No

(`embedTokens` is internal to the backbone object; the public `createLfm3Chat` is unchanged.)

## Type of change

- [x] New feature (change which adds functionality)
- [x] Performance (kernel tuning, graph building, anything related to performance): memory

## Public API added (`runntime/zoo`)

`Lfm3Audio.generate`, `createLfm3Omni`, `Lfm3Omni`. In core (not published): `GgufStateDict`,
`readGgufEmbeddingRows` with doc comments.

## Testing instructions

```sh
pnpm install --frozen-lockfile
pnpm typecheck && pnpm lint && pnpm format:check
pnpm --filter runntime test:unit          # 72 files, 1329 tests
pnpm build
```

- Node: `speak.test.ts` generates text and speech through one stub backbone and checks it is disposed
  once. `gguf.test.ts`: a lookup of repeated, out-of-order Q4 rows reads exactly the two requested
  byte ranges and returns `int * scale + offset` (expected values from the block layout), and a bad
  row range is refused.
- GPU, chat on the Q4_K_M GGUF (streaming path changed): see below.

## GPU tests run locally

M2 Pro (16-core GPU), 32 GB, macOS 27.2; Playwright Chromium `chromium-1248`, headless, `--enable-unsafe-webgpu`;
Node v26.9.0, pnpm 11.10.0 (CI uses Node 24). On this part and again on the tip of the stack:

| Run                                               | Result                      |
| ------------------------------------------------- | --------------------------- |
| native-reference (Q4_K_M, pinned Liquid vectors)  | 1 passed                    |
| q4 public                                         | 1 passed (267 s under load) |
| q4-recovery                                       | 1 passed                    |
| `vitest run --project gpu test/zoo/lfm3` (no env) | 2 passed, 7 skipped         |

The audio-mode suites were not run (see 5b and 5c).

## Deliberately not included

The voice option (7). No memory or load-time numbers are claimed: none were measured for this
series (upstream asks for an A/B report for `core` and zoo changes that affect performance; the
tied-embedding change is a memory change, so one should be added before review).

## Known limits

- Row reads go through the same range source as the rest of the load; each lookup of a new token id
  is a small range read (up to 16 in flight).
- `generate()` on the audio runner is serialized with `speak()` and `transcribe()`.

## Checklist

- [x] I have performed a self-review of my code
- [x] I have commented my code, particularly in hard-to-understand areas
- [x] I have updated the documentation accordingly
- [x] My changes generate no new warnings

## Additional notes

Commit boundaries follow the two changes so either can be reviewed alone.
