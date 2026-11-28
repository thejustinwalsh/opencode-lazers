# Difftastic WASM provenance

The engine source is Difftastic 0.71.0 from
[`Wilfred/difftastic`](https://github.com/Wilfred/difftastic), commit
`b7d119e90ac9f972f03f69508da765dacd302c0c`, recorded in
[`vendor/difftastic/UPSTREAM.json`](../../vendor/difftastic/UPSTREAM.json). Its MIT notice is
preserved as [`DIFFTASTIC-MIT.txt`](DIFFTASTIC-MIT.txt).

The local WASM adaptation keeps Difftastic's parser and diff algorithm and adds:

- the `wasm` Cargo feature and a JSON-in/JSON-out content entry point in
  `vendor/difftastic/src/wasm.rs`;
- CLI-only module, allocator and Rayon gates so the WASI build has no CLI, directory traversal,
  jemalloc or runtime thread pool;
- the thin C ABI wrapper in `crates/difftastic-wasm/`, which is built for `wasm32-wasip1`;
- reproducible build metadata in `src/code-review/structural/ARTIFACT.json`.

The Kotlin and Smali generated parser sources are included by the upstream Difftastic revision.
The LaTeX `parser.c` and `tree_sitter/parser.h` are regenerated with tree-sitter-cli 0.24.4 from
`latex-lsp/tree-sitter-latex` commit
`1e4e30342b7a3b3a24886a632fbac53035d98871`, matching the checked-in `grammar.json` and
`node-types.json`. The parser MIT notices are preserved under the matching `parser-*` directories.
The Janet grammar source is included in that upstream revision. Its vendored package manifests do
not state a license, so the separate upstream `sogaiu/tree-sitter-janet-simple` `COPYING.txt`
notice, which declares CC0 1.0, is preserved as `parser-tree-sitter-janet-simple/CC0-1.0.txt`.

Resolved Cargo package versions and their published license/notice files are indexed in
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md); the exact dependency graph is pinned by
`crates/difftastic-wasm/Cargo.lock`. No Oaink source or license is incorporated into the engine or
runtime package; the separately authorized Oaink fixtures remain under `test/`.
