# cccc comparison provider

The public API is exported as `opencode-lazers/code-review/cccc` after
`bun run build:cccc-wasm`. Its snapshot reader supplies immutable base/head
content by comparison ID; no worktree path is opened or persisted by this
provider. Results retain the comparison ID, revisions, source locations, both
complexity measures, and explicit coverage or failure states.

The build emits `dist/code-review-cccc.js`, its OpenCode-owned worker,
`dist/cccc.wasm`, and `src/code-review/providers/cccc/wasm/ARTIFACT.json`.
Those assets are included by `bun run package:release`. Build the optimized
module with Rust 1.99.0, the `wasm32-wasip1` target, `wasm-opt` 129, and an
installed WASI SDK 34. The build discovers
`~/.local/share/wasi-sdk/34.0` (or `/opt/wasi-sdk`) by default; set
`WASI_SDK_PATH` to override it:

```sh
RUSTUP_TOOLCHAIN=1.99.0 bun run build:cccc-wasm
```

`scripts/verify-cccc-parity.ts` builds the pinned native cccc CLI as a
development-only oracle and compares all 21 language adapters with the
packaged WASM API. Native tools are not bundled or used at runtime.

The module calls upstream cccc 1.7.0 `analyze_source` adapters and reuses
LAZERS' buffered read-only WASI host. Only sanitized function labels, measured
values, parse-error counts/lines, paths, and comparison coordinates leave the
worker; source text and parser messages do not. `licenses/cccc/` contains the
upstream notice, locked dependency notices, and provenance.
