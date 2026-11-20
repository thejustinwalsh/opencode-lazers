# docs(zoo): add the LFM3 chat and audio pages

Branch `upstream/09-docs` (1 commit, `1d5c3b3`). Base in the stack: `upstream/08-d1`
(needs 4 and 5c for the APIs the samples call; 6 and 7 for `generate` and `voice`).

## Description

`apps/docs/src/content/docs/zoo/lfm3-chat.mdx` and `lfm3-audio.mdx`, each with a type-checked
`ts twoslash` sample (`createLfm3Chat` on the original and Q4_K_M weights; `createLfm3Audio` for
transcription, speech with a selectable voice, and text from one shared backbone), the README task
row (Chat) and sidebar entries (`astro.config.mjs`: the chat page in the sidebar, `/zoo/lfm3-audio`
added to the zoo topic list). The D1 page ships with part 8.

The API reference pages under `/api/` are **not** touched: they are generated from the doc comments by
`starlight-typedoc`.

## Introduces a breaking change?

- [ ] Yes
- [x] No

## Type of change

- [x] Documentation update (improves or adds clarity to existing documentation)

## Public API added

None.

## Testing instructions

```sh
pnpm install --frozen-lockfile
pnpm typecheck && pnpm lint && pnpm format:check
pnpm --filter runntime test:unit          # 77 files, 1353 tests
pnpm build         # tsdown + docs: the twoslash samples are type-checked against the built library
```

The docs build passed (docs build includes all pages). No GPU.

## GPU tests run locally

None (documentation). M2 Pro (16-core GPU), 32 GB, macOS 27.2; Playwright Chromium `chromium-1248`, headless, `--enable-unsafe-webgpu`;
Node v26.9.0, pnpm 11.10.0 (CI uses Node 24).

## Deliberately not included

- Benchmark numbers: none are claimed on these pages (AGENTS: numbers come from measured runs only).
- `playground/lfm3` (fork-only demo).

## Known limits

- **Docs flow.** Upstream publishes the docs site from the `docs` branch: work lands on `main`, then
  `main` is merged into `docs` with a merge commit. This part is meant to go to `main` with the code
  it documents; a later fix to a live page goes to `docs` first. The maintainers may prefer these
  pages to follow the first release containing 4 and 5c.
- The audio page describes behaviour of parts that were not re-qualified on a GPU in this tree (see
  5b and 5c).

## Checklist

- [x] I have performed a self-review of my code
- [x] I have commented my code, particularly in hard-to-understand areas
- [x] I have updated the documentation accordingly
- [x] My changes generate no new warnings

## Additional notes

Commit: `docs(zoo): add the LFM3 chat and audio pages`.
