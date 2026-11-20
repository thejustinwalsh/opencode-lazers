# 437f56ea — fallow-wasm-threads

No additional actionable finding established; the cancellation probe's surviving coverage gap is recorded in `9261988a-terminate-probe.md`.

## Checked and sound

- Reviewed exact range `a93c3e40..437f56ea`: thread host/worker, module fallback, analyzer wiring, Rust pool patch, build/release and changed tests.
- Server build and release inventory include `fallow-thread.js` and both single/threaded WASM artifacts.
- Threaded failure falls back to the single-threaded module and disables later threaded attempts; `off` avoids loading the threaded module.
- Helper workers have read-only host imports and cannot recursively spawn helpers.
- Run cleanup terminates helpers still inside the module; completed reusable helpers are unreferenced while idle.
- Native Fallow package is removed from dependencies; the changed production path uses WASM.

## Not reviewed

- No WASM rebuild, parity run or actual thread-termination experiment; broad tests analyze repositories and write outside the permitted directory.
- Did not independently prove compiled binaries match all vendored Rust source or benchmark the engine patch's semantic/throughput equivalence.
