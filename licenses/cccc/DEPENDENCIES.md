# cccc WASM dependency notices

The module uses pinned cccc 1.7.0 sources and its Rust dependency graph. The
upstream commit, repository, license, and patch list are recorded in
`vendor/cccc/UPSTREAM.json`; the exact Rust package versions are in
`crates/cccc-wasm/Cargo.lock`.

`LICENSE` carries cccc's MIT notice. `THIRD-PARTY-NOTICES.txt` records the SPDX
expression for every registry or Git dependency in the lockfile and reproduces
the license text files present in those locked source archives. Twenty-five
archives declare an SPDX license in their Cargo manifest but contain no license
text file; their crate name, version, and declared expression are recorded
without substituting a guessed notice.

The Rust standard library is linked into the WASM module. Its upstream 1.99.0
copyright inventory and Apache-2.0/MIT license texts are in `rust-std/`.

The npm release includes this directory. Native cccc binaries, Rust, WASI SDK,
and `wasm-opt` are build-time tools, not shipped runtime dependencies.
