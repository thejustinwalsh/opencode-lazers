import { createHash } from "node:crypto"
import { performance } from "node:perf_hooks"

const start = performance.now()
const { mergeConfigs, searchFiles, collectFiles, processFiles, runSecurityCheck, TokenCounter } =
  await import("repomix")
const importMs = performance.now() - start
const root = "/Users/tjw/Documents/ChatGPT/opencode-lazers"
const config = mergeConfigs(
  root,
  {},
  {
    include: [
      "src/**/*.ts",
      "src/**/*.tsx",
      "src/**/*.md",
      "src/**/*.css",
      "test/**/*.ts",
      "README.md",
      "AGENTS.md",
      "package.json",
    ],
    input: { maxFileSize: 524288 },
    output: { git: { sortByChanges: false, includeDiffs: false, includeLogs: false } },
  },
)
const found = await searchFiles(root, config, undefined, true)
const { rawFiles, skippedFiles } = await collectFiles(found.filePaths, root, config)
const suspicious = await runSecurityCheck(rawFiles)
const blocked = new Set(suspicious.map((f) => f.filePath))
const files = rawFiles.filter((f) => !blocked.has(f.path))
const counter = new TokenCounter("o200k_base")
await counter.init()
const selected = new Set([
  "src/tools.ts",
  "src/submission.ts",
  "src/storage.ts",
  "src/task.ts",
  "src/tools.test.ts",
  "src/storage.test.ts",
  "test/proposal.ts",
])
const focused = files.filter((f) => selected.has(f.path))
function metrics(items: { path: string; content: string }[]) {
  const text = items.map((f) => `File: ${f.path}\n${f.content}`).join("\n\n")
  return {
    files: items.length,
    bytes: Buffer.byteLength(text),
    tokens: counter.countTokens(text),
    sourceHash: createHash("sha256").update(text).digest("hex"),
  }
}
const full = metrics(files)
const subset = metrics(focused)
const compressionStart = performance.now()
const compressed = await processFiles(
  focused,
  mergeConfigs(
    root,
    {},
    {
      output: {
        compress: true,
        git: { sortByChanges: false, includeDiffs: false, includeLogs: false },
      },
    },
  ),
  () => {},
)
const outline = metrics(compressed)
const results = {
  date: new Date().toISOString(),
  version: "1.18.1",
  runtime: Bun.version,
  runtimeRevision: Bun.revision,
  executable: process.execPath,
  purpose:
    "Local context-size feasibility probe for the task-submission boundary; not an accepted-task quality or cost benchmark",
  tokenizer: "o200k_base",
  importMs: Math.round(importMs),
  elapsedMs: Math.round(performance.now() - start),
  compressionMs: Math.round(performance.now() - compressionStart),
  excludedSuspicious: suspicious.length,
  skippedFiles,
  fullSourceAndTests: full,
  selectedSubmissionSourceAndTests: subset,
  selectedStructuralOutline: outline,
  selectionReduction: 1 - subset.tokens / full.tokens,
  compressionReductionOnSelection: 1 - outline.tokens / subset.tokens,
  limitation:
    "Original snippets and structural outlines convey different evidence. Smaller inputs do not establish equivalent task quality, lower total usage, provider cache hits, accepted-task throughput or dollar savings.",
  sources: focused.map((f) => ({
    path: f.path,
    sha256: createHash("sha256").update(f.content).digest("hex"),
  })),
}
counter.free()
await Bun.write("/private/tmp/lazers-repomix-context-probe.json", JSON.stringify(results, null, 2))
console.log(JSON.stringify(results, null, 2))
