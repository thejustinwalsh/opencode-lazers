import { copyFileSync, existsSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const worker = join(root, "src/code-review/providers/jscpd/jscpd-worker.ts")
const wasm = join(root, "src/code-review/providers/jscpd/jscpd.wasm")
const output = join(root, "dist")

export async function buildJscpdWorker() {
  if (!existsSync(wasm))
    throw new Error("jscpd.wasm is missing; run `bun run build:jscpd-wasm` first.")
  await mkdir(output, { recursive: true })
  const result = await Bun.build({
    entrypoints: [worker],
    outdir: output,
    naming: "jscpd-worker.js",
    target: "bun",
    format: "esm",
    packages: "external",
    external: ["bun:sqlite"],
  })
  if (!result.success) throw new AggregateError(result.logs, "jscpd worker bundle failed to build.")
  copyFileSync(wasm, join(output, "jscpd.wasm"))
}

if (import.meta.main) await buildJscpdWorker()
