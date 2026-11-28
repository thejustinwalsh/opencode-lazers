# Structural comparison producer API

`createStructuralDiffService()` runs Difftastic 0.71.0 in an isolated WASI worker and returns
validated Oaink-shaped alignment, changed-token and head-comment ranges. The producer owns source
reads; runtime comparison performs no filesystem or Git access.

Import the public API from `opencode-lazers/code-review/structural`. `bun run build:server` bundles
that entry with its worker and copies the checked-in WASM asset beside it; the package export keeps
its TypeScript source as the type entry.

```ts
const service = createStructuralDiffService()
const result = await service.compare(
  {
    identity: {
      comparisonID: "task:task-id",
      sourceID: "sha256-of-comparison-and-exact-sources",
    },
    request: { path: "src/example.ts", base: baseText, head: headText },
  },
  { signal },
)

if (result) render(result.identity, result.diff)
```

`comparisonID` is the stable key for the view. `sourceID` must identify the immutable comparison
inputs, including both revisions, paths and source contents. Requests for different file paths under
one comparison run concurrently; a newer source for the same path aborts only that file's older
worker and resolves its promise to `undefined` instead of returning an obsolete diff. An
`AbortSignal` cancels the current request and rejects with its abort reason. Timeouts and
analyzer/load failures resolve to a line-based diff with an explicit `degraded` reason, computed in
an isolated worker where possible, so callers can keep ordinary source review available. The
service retains no completed result or per-run WASM memory; only the compiled module is cached.

`null` means a source file is absent; `""` means it exists but is empty. `alignedLines` and hunk line
numbers are 1-based; token and comment columns are UTF-16, zero-based and end-exclusive. The
`engineVersion` field records the bundled Difftastic release, including on degraded results.
