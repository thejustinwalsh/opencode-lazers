# Gitleaks comparison provider

`index.ts` exports the public captured-snapshot API. The reader supplies immutable base/head
content, changed-file inventory, and changed-line ranges; the provider does not accept filesystem
paths or read a worktree. Missing content and ranges remain degraded or unclassified, not clean.
The worker runs pinned Gitleaks 8.30.1 in WASI and projects findings before returning them to the
host. Raw matched values stay inside detector memory.

## Build and verify

Build requires Go 1.26.1, Binaryen `wasm-opt` 129, and Bun:

```sh
bun scripts/build-gitleaks-wasm.ts
bun test --timeout 120000 src/code-review/providers/gitleaks/
bun scripts/verify-gitleaks-parity.ts
```

The parity command builds a development-only native `gore2regex` oracle. Runtime execution uses
only the packaged WASM and worker; it does not download or invoke native Gitleaks.

The shared server bundle consumes `GITLEAKS_SERVER_ENTRIES` and `GITLEAKS_SERVER_ASSETS` from
`build-contribution.ts`: `gitleaks-worker.js` and `gitleaks.wasm` are copied beside
`dist/server.js`. The provider contributes those paths without changing the shared build registry.

## Provenance and licenses

`UPSTREAM.json` records the Gitleaks 8.30.1 commit and minimal WASI patches.
`wasm/ARTIFACT.json` records the source digest, toolchain, WASI imports, binary digest, and
transitive Go module notices. Gitleaks' MIT license, dependency notices, and the Go runtime's BSD
notice are under `licenses/gitleaks/`.
