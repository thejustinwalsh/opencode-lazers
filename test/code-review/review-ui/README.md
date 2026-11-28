# Review renderer harness

Verifies the Review panel's renderer outside OpenCode: the Solid `ReviewCodeView` adapter, the Pierre
fork, its inlined highlight workers, the host-token theme and selection, over real Difftastic results.

```sh
bun test/code-review/review-ui/generate.ts            # 3b054165 and 172ba874 by default; or base..head ranges
bunx portless@latest run --name lazers-review-harness bunx vite --config test/code-review/review-ui/vite.config.ts
```

Open `https://lazers-review-harness.localhost:1355/#w=420&mode=dark` (hash: `w` width in px, `mode`
light|dark, `split=1`, `wrap=1`, `fallback=<path>` to draw a file as a line diff; reload after a hash
change). `window.__review` exposes the handle, `setMode`, `setSplit`, `setWrap`, `expand(id, context)`
(replace a file with a taller rendering), `textSelection()`, `workers()` and `dispose()`.

`host-tokens.css` holds OpenCode Desktop's default light and dark token values. Generated input goes to
`node_modules/.cache/review-ui-harness/` and is not committed.
