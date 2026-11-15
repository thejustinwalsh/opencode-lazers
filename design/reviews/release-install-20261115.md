# Release package install — 2026-11-15

Build the archive with `bun run package:release v0.1.0 /path/to/output`.
The pack step builds the GUI, includes the server source and Desktop bundle,
and installs the resulting archive without lifecycle scripts in an empty Bun
project. The archive is 2.34 MB; the model files download on first use.

OpenCode Desktop 2.2.6 loaded the archive installed under `node_modules`
through one entry in a fresh global `plugins` configuration. The entry
pointed directly to the installed package. It did not use the development
checkout or a wrapper plugin. The clean instance registered Architect,
returned an empty page from `lazers.tasks.query`, and loaded the GUI runtime.
With empty model caches, Omni returned “Hello” (17 input tokens, two output
tokens) and D1 returned 0.9992196 for the test System One question. The final
download candidate contains the same runtime files as the Desktop-tested
archive; the rebuild changed only the README.

Local verification: `bun run verify`, the GUI build, `actionlint`, and 143
WebGPU and Radar packaging tests passed. The GitHub workflow was validated
locally; this checkout has no GitHub remote and no release was published.
