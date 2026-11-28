# jscpd provider

`provider.ts` is the comparison provider API. It accepts complete captured base and
head inventories plus a stable `comparisonID`; it never opens a worktree or
returns clone text. Every result carries that identity and jscpd 5.4.0 metadata.
The pinned WASM artifact is produced from the source in `vendor/jscpd/`.

## Build and verify

```sh
RUSTUP_TOOLCHAIN=1.99.0 bun scripts/build-jscpd-wasm.ts
bun scripts/build-jscpd-provider.ts
RUSTUP_TOOLCHAIN=1.99.0 bun scripts/verify-jscpd-parity.ts
bun test --timeout 120000 src/code-review/providers/jscpd/
```

`build-jscpd-provider.ts` emits `dist/jscpd-provider.js`, its OpenCode-owned
`dist/jscpd-worker.js`, and the adjacent `dist/jscpd.wasm`. The full server
packaging entry for this increment is `bun scripts/build-plugin-server.ts`;
it invokes the common server build and then the provider-owned build. The
protected shared worker registrar remains unchanged for Architect composition.
The provider bundle smoke test loads the emitted public entry and exercises its
worker and WASM asset together.

## Captured configuration

The portable contract consumes detector mode, token normalization, format
selection and custom format mappings, file/code ignore patterns, cross-format
groups, size/line limits, gap/AST thresholds, `.ignore`/`.gitignore`/Git exclude
contents, and local/isolation filters. Captured ignore files are evaluated in
the worker; the provider never reads a checkout. Oaink's fixed
`**/node_modules/**` and `**/.git/**` CLI ignore list overrides config-file
`ignore` globs. Unknown config keys are returned by name in side coverage and
make the comparison partial instead of being silently treated as supported.
Filesystem walking, symlink following, blame, baseline/reporting options and
model-backed semantic analysis are not part of this provider.

Parity requires the independently verified macOS ARM64 jscpd 5.4.0 executable
at `.cache/jscpd-release-oracle/jscpd` or `JSCPD_RELEASE_CLI`. The verifier checks
the executable SHA-256 and version, runs its JSON reporter against isolated
captured fixtures, and deletes its source-bearing temporary reports. The native
binary is a development oracle only; runtime execution remains WASM and the
bundled worker.

The package includes the upstream and newly used dependency license texts under
`licenses/jscpd/`; `ARTIFACT.json` records the upstream commit, crate versions,
target, imports, and reproducible build inputs.
