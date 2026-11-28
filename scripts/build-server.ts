import { copyFileSync, watch } from "node:fs"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))

/**
 * Bundles LAZERS' own source into dist/server.js (the package's server entry) plus the
 * worker scripts it spawns beside it. Dependencies stay external so the host and Node
 * resolution keep one shared copy and native assets keep working. OpenCode then watches a
 * single file, and source edits do not reload live plugins until this build runs.
 */
export const serverEntries = [
  ["src/index.ts", "server.js"],
  ["src/context/processor.ts", "processor.js"],
  ["src/context/repo-worker.ts", "repo-worker.js"],
  ["src/models/decision-worker.ts", "decision-worker.js"],
  ["src/runner/transition-indexes-worker.ts", "transition-indexes-worker.js"],
  ["src/audit/fallow-worker.ts", "fallow-worker.js"],
  ["src/code-review/structural/difftastic-worker.ts", "difftastic-worker.js"],
  ["src/audit/fallow-thread.ts", "fallow-thread.js"],
  ["src/streams/reader-worker.ts", "reader-worker.js"],
  ["src/trajectory/effort-worker.ts", "effort-worker.js"],
  ["src/retention/retention-reader-worker.ts", "retention-reader-worker.js"],
] as const

export const serverAssets = ["fallow.wasm", "fallow-threads.wasm", "difftastic.wasm.gz"] as const

const serverAssetSources = {
  "fallow.wasm": "src/audit/wasm/fallow.wasm",
  "fallow-threads.wasm": "src/audit/wasm/fallow-threads.wasm",
  "difftastic.wasm.gz": "src/code-review/structural/difftastic.wasm.gz",
} satisfies Record<(typeof serverAssets)[number], string>

export async function buildServer() {
  for (const [entry, file] of serverEntries) {
    const result = await Bun.build({
      entrypoints: [`${root}${entry}`],
      outdir: `${root}dist`,
      naming: file,
      target: "bun",
      format: "esm",
      packages: "external",
      external: ["bun:sqlite"],
    })
    if (!result.success) throw new AggregateError(result.logs, `Server build failed: ${entry}`)
  }
  // The workers load these modules beside their bundles through wasmURL.
  for (const module of serverAssets)
    copyFileSync(`${root}${serverAssetSources[module]}`, `${root}dist/${module}`)
}

if (import.meta.main) {
  await buildServer()
  if (process.argv.includes("--watch")) {
    let timer: ReturnType<typeof setTimeout> | undefined
    watch(`${root}src`, { recursive: true }, () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        buildServer().then(
          () => console.log("dist/server.js rebuilt"),
          (error) => console.error(error),
        )
      }, 150)
    })
    console.log("Watching src; each rebuild reloads live plugins")
    await new Promise(() => {})
  }
}
