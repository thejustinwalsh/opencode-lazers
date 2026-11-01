# Stable live Trajectory history — verification record

2026-11-01. Task LZ-36, revision 1.

## Automated evidence

- Focused: `bun test src/trajectory src/observability test/trajectory test/trajectory-panel test/observability` — 60 passed, 0 failed.
- Full: `bun test` — 401 passed, 0 failed across 78 files.
- Quality: `bun run verify` — formatting, lint, and typecheck passed.
- GUI build: `bun run build:gui` succeeded. Output: `dist/gui-experimental.cjs`, SHA-256 `9fa6968ef4c8eeae6d0755bdbbc78d7bf5a2c13360a103f9ccb54e74e397a779`. Build emitted the existing Vite inline-dynamic-import and ONNX `import.meta` warnings.
- `git diff --check` passed.

## Context-read measurement

Using the two-session fixture, page size 2, ten completed live-status reads, three cached history continuations, same-sequence tool completion, then explicit recapture:

| Phase | Full-session reads (`session.get` + native context path) | Metadata-only reads | Context messages | Captured events | Loaded events |
| --- | ---: | ---: | ---: | ---: | ---: |
| Initial capture | 2 | 0 | 10 | 14 | 2 |
| Ten statuses + three continuations | 0 additional | 20 | 0 additional | unchanged | 8, unique and in capture order |
| Explicit recapture | 2 additional | 0 | 10 | 15, including the updated progress fact | 2 events in the read probe; panel-state test retains the prior 8-event loaded union |

The native adapter test separately asserts that metadata-only status calls `session.get` and never `session.context`. The read tests also assert updated model/usage/check facts and same-sequence progress completion, while captured history remains unchanged until recapture.

## Mounted Desktop acceptance — pending

No mounted OpenCode Desktop observation was performed. The browser bridge returned `[browser.disconnected] No desktop browser is connected to this session`; therefore the exact-artifact disclosure/scroll/paging continuity gate remains open. The build checksum above identifies the artifact to mount. Automated source and state tests are not a substitute for that observation.
