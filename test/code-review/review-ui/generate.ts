// Builds the verification harness input from real history: every file of a commit range, both
// texts, and the bundled Difftastic WASM engine's structural diff of each pair.
//   bun test/code-review/review-ui/generate.ts [base] [head] [more ranges as base..head]
import { mkdir, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { createStructuralDiffService } from "../../../src/code-review/structural/index.ts"

const root = fileURLToPath(new URL("../../..", import.meta.url))
const out = fileURLToPath(
  new URL("../../../node_modules/.cache/review-ui-harness", import.meta.url),
)
const ranges = process.argv.slice(2).length
  ? process.argv.slice(2).map((range) => range.split(".."))
  : [
      ["3b054165^", "3b054165"],
      ["172ba874^", "172ba874"],
    ]

const git = (...args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" })
  return result.exitCode === 0 ? result.stdout.toString() : null
}

const service = createStructuralDiffService()
const files = []
for (const [base, head] of ranges as [string, string][]) {
  const names = git("diff", "--name-status", "--no-renames", base, head) ?? ""
  for (const line of names.trim().split("\n").filter(Boolean)) {
    const [status, path] = line.split("\t") as [string, string]
    const baseText = status === "A" ? null : git("show", `${base}:${path}`)
    const headText = status === "D" ? null : git("show", `${head}:${path}`)
    const started = performance.now()
    const result = await service.compare({
      identity: { comparisonID: `${base}..${head}`, sourceID: `${base}..${head}:${path}` },
      request: { path, base: baseText, head: headText },
    })
    files.push({
      range: `${base}..${head}`,
      path,
      status,
      base: baseText,
      head: headText,
      diff: result?.diff,
      ms: Math.round(performance.now() - started),
    })
    console.log(
      `${status} ${path} ${result?.diff.engine}${result?.diff.degraded ? ` (${result.diff.degraded})` : ""} ${files.at(-1)!.ms} ms`,
    )
  }
}
await mkdir(out, { recursive: true })
await writeFile(`${out}/data.json`, JSON.stringify({ files }))
console.log(`${files.length} files → ${out}/data.json`)
process.exit(0)
