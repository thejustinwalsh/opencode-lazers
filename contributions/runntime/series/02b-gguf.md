# feat(core): add a GGUF v3 weight reader

Branch `upstream/02b-gguf` (1 commit, `e134216`). Base in the stack: `upstream/02a-quant-offsets`
(it needs the offsets of part 2a, because Q4_K tensors decode to ints, scales and offsets).

## Description

`fromGguf(source, { fileBytes, sha256, cache?, cacheId?, signal? })` loads a GGUF v3 file as a lazy
state dict. `parseGgufHeader(source, fileBytes)` reads the header alone.

- Types decoded: F16 and F32 (floats), Q8_0 and Q6_K (quantized, scale only), Q4_K (scale and offset
  per group of 32). Nothing is read until a tensor is used.
- The whole file is read once and hashed (incremental SHA-256) against the pinned digest before any
  tensor is exposed, so a wrong or truncated file fails with `CHECKPOINT_MISMATCH` instead of
  producing wrong logits.
- Typed key-value metadata is `LazyStateDict.ggufMetadata`, apart from safetensors' string metadata.
- Why: Liquid publishes LFM3-Omni as GGUF (Q4_K_M language file, Q8_0 audio projector). Converting
  through safetensors would mean hosting a derivative artifact; reading the published file keeps one
  source of truth and a digest to pin.

## Introduces a breaking change?

- [ ] Yes
- [x] No

## Type of change

- [x] New feature (change which adds functionality)

## Public API added

Core only (not a published entry): `fromGguf`, `parseGgufHeader`, types `GgufIndex`,
`GgufTensorInfo`, `GgufTensorType`; `LazyStateDict.ggufMetadata`. Each has a doc comment with units,
defaults and the `RunntimeError` codes it throws.

`Sha256` (`core/weights/sha256.ts`) is **internal**: it is not exported from `core/index.ts` and its
doc comment says so. It exists because SubtleCrypto digests one buffer and these files do not fit in
memory; `gguf.ts` and its test import it by path.

## Testing instructions

```sh
pnpm install --frozen-lockfile
pnpm typecheck && pnpm lint && pnpm format:check
pnpm --filter runntime test:unit          # 60 files, 1267 tests
pnpm build
```

- `test/core/weights/gguf.test.ts` builds GGUF bytes by hand (header, metadata, tensor table,
  aligned payloads) and checks: one aligned payload start for every tensor entry, decoding of F16,
  Q4_K (all groups, affine minima kept), Q6_K (codes unpacked to signed int8 with signed group
  scales) and Q8_0 (codes and one F16 scale per 32-value block), header rejection cases
  (`it.each`), and a mismatched digest refused before any tensor is exposed.
- `test/core/weights/sha256.test.ts` checks the incremental hash against Node's `crypto`.
- No GPU test: this part never touches a GPU. Pure Node, runs in CI.

## GPU tests run locally

Nothing GPU here. `pnpm exec vitest run --project gpu test/core` on this branch: 40 files, 1799
passed, 15 expected fail, 0 failed. M2 Pro (16-core GPU), 32 GB, macOS 27.2; Playwright Chromium `chromium-1248`, headless, `--enable-unsafe-webgpu`;
Node v26.9.0, pnpm 11.10.0 (CI uses Node 24).

## Deliberately not included

- Other GGUF types (Q5__, Q2_K, IQ_): the loader refuses them with `CHECKPOINT_MISMATCH`.
- Row-range reads of a tensor (`rows()`): they arrive with the embedding streaming change in part 6,
  whose only caller needs them.
- Any model that uses the reader (part 4).

## Known limits

- Hashing reads the whole file once per load. For the 1.1 GB language file that is a full read
  before the first tensor is used; `cache` + `cacheId` avoids a second download, not the hash.
- Header limit 64 MiB.

## Checklist

- [x] I have performed a self-review of my code
- [x] I have commented my code, particularly in hard-to-understand areas
- [x] I have updated the documentation accordingly
- [x] My changes generate no new warnings

## Additional notes

Commit: `feat(core): add a GGUF v3 weight reader`.
