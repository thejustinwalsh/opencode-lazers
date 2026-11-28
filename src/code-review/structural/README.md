# Structural comparison producer API

`createStructuralDiffService()` runs Difftastic 0.71.0 in an isolated WASI worker and returns
validated Oaink-shaped alignment, changed-token and head-comment ranges. The producer owns source
reads; runtime comparison performs no filesystem or Git access.

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
inputs, including both revisions, paths and source contents. A new request for the same
`comparisonID` aborts the old worker; its promise resolves to `undefined` instead of returning an
obsolete diff. An `AbortSignal` cancels the current request and rejects with its abort reason.
Timeouts and analyzer/load failures resolve to a line-based diff with an explicit `degraded` reason,
so callers can keep ordinary source review available. The service retains no completed result or
per-run WASM memory; only the compiled module is cached.

`null` means a source file is absent; `""` means it exists but is empty. `alignedLines` and hunk line
numbers are 1-based; token and comment columns are UTF-16, zero-based and end-exclusive. The
`engineVersion` field records the bundled Difftastic release, including on degraded results.
