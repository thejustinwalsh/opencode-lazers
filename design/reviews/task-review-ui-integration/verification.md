# Retained Review UI foundation: verification

Checked 2026-11-28 at candidate composition `8a3cc45d7a2bfba51a02225359e116004ecbe1f8`. The three external UI commits remain in history:

- `46a8346a7464cbf25d2785fda9e5025fc53756ec` — vendor the Pierre renderer fork.
- `122455c08c86ded86ddb169b1cf2c00ba42920cc` — task semantic review panel.
- `4682e414f27f69917c6bde275fe893468feed54c` — renderer browser harness.

The vendored `pierre-diffs-1.5.2-oaink.6.tgz` SHA-256 matches
`licenses/pierre/PROVENANCE.md`: `08cc410890eb44ab4822d70bab9ae8ecb16137d8eed65a8263a77df4ae9e4da9`.

## Automated checks

- `bun run verify` — passed, including repository format, lint auto-fix, bounded-read/show-read checks, and TypeScript (`1,424` files, no type errors). Lint emitted warnings in unrelated existing files.
- `bun test --timeout 120000 src/code-review/ui/` — 78 passed, 0 failed across 8 files. Existing tests cover exact source identity fields, ignoring analysis for a different comparison, side/range selection, pinned quote/note construction, and composer routing/attachment without sending.
- `bun test --timeout 120000 src/code-review/comparisons/ src/code-review/structural/` — 24 passed, 0 failed across 2 files.
- `bun run build:gui` — passed: Vite transformed 1,172 modules; `dist/gui-experimental.cjs` is 18,095,836 bytes (18,095.83 kB; 3,250.56 kB gzip). The bundle verifier evaluated the plugin without a renderer-process global. The portable highlight worker is present inline in this single bundle.
- `shasum -a 256 vendor/pierre/pierre-diffs-1.5.2-oaink.6.tgz` — matched the recorded provenance hash.

The generated renderer harness used its default commit fixtures: 15 files (13 Difftastic results, 2 line fallbacks for unsupported lockfile languages). In Chromium, the 420px dark and 360px light unified views and an 840px light split/wrapped view rendered without page-level horizontal overflow. Selecting a source line mapped to its base-side path and line; expanding a collapsed hunk increased the scroll content. The harness reported its highlight worker pool working and initialized. The accessibility snapshot exposed the named `Harness` region, but its hunk-expansion buttons appeared without accessible names.

## Not established by these checks

- The GUI entrypoint registers the panel, but this is not a regular OpenCode Desktop walkthrough or activation check.
- `rpcReviewTransport` does not provide structural analysis; its files use the line-diff fallback. No semantic entrypoint or symbol-section navigation is wired.
- Integrated/landed comparison selection is not wired: lineage is optional on the transport and absent from the RPC implementation.
- UI draft tests cover local quote/note construction and attachment, not the future server `prepareDraft` operation. Durable discussion threads and discussion RPCs are not integrated.
- Architect discussion uses the task's stored Architect session; no project Architect fallback exists when it is absent.
- Source reads are chunked in 500-line requests but read the full selected file, not a bounded viewport window; bounded Live reads are unverified.
- The panel attempts a blob module worker when available and falls back to Pierre's main-thread highlighter if worker setup fails. The harness initialized the worker, but OpenCode Desktop worker/CSP policy and the fallback path were not exercised.
- The unnamed hunk-expansion controls need accessibility review in the assembled host panel.
