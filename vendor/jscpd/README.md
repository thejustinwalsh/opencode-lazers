# jscpd source pin

This directory contains the upstream `cpd-core` 0.1.20 and `cpd-tokenizer`
0.1.19 crates from jscpd 5.4.0, commit
`b6f832c62cf02b574ea9cf24e013cfeb17366a35`. `UPSTREAM.json` records the source
and license.

Only those content/tokenization crates are vendored. The OpenCode adapter in
`crates/jscpd-wasm` supplies immutable file contents and projects clone
locations; it does not include upstream filesystem walking, reporting,
downloading, daemon or model-backed semantic code. No upstream source patch is
currently required. Run `RUSTUP_TOOLCHAIN=1.99.0 bun scripts/build-jscpd-wasm.ts`
to compile the target and refresh the pinned artifact.
