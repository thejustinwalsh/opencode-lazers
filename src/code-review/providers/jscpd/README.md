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

The package includes `licenses/jscpd/MIT.txt`; `ARTIFACT.json` records the
upstream commit, crate versions, target, imports, and reproducible build inputs.
