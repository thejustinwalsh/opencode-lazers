import { copyFileSync, watch } from "node:fs"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))

/**
 * Bundles LAZERS' own source into dist/server.js (the package's server entry) plus the two
 * worker scripts it spawns beside it. Dependencies stay external so the host and Node
 * resolution keep one shared copy and native assets keep working. OpenCode then watches a
 * single file, and source edits do not reload live plugins until this build runs.
 */
const entries = [
  ["src/index.ts", "server.js"],
  ["src/context/processor.ts", "processor.js"],
  ["src/context/repo-worker.ts", "repo-worker.js"],
  ["src/models/decision-worker.ts", "decision-worker.js"],
  ["src/runner/transition-indexes-worker.ts", "transition-indexes-worker.js"],
  ["src/audit/fallow-worker.ts", "fallow-worker.js"],
  ["src/audit/fallow-thread.ts", "fallow-thread.js"],
] as const

export async function buildServer() {
  for (const [entry, file] of entries) {
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
  // The fallow worker loads these modules beside itself through wasmURL.
  for (const module of ["fallow.wasm", "fallow-threads.wasm"])
    copyFileSync(`${root}src/audit/wasm/${module}`, `${root}dist/${module}`)
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
