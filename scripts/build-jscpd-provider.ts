import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { buildJscpdWorker } from "./build-jscpd-worker.ts"

const root = fileURLToPath(new URL("..", import.meta.url))
const output = join(root, "dist")

export async function buildJscpdProvider() {
  await buildJscpdWorker()
  await mkdir(output, { recursive: true })
  const result = await Bun.build({
    entrypoints: [join(root, "src/code-review/providers/jscpd/provider.ts")],
    outdir: output,
    naming: "jscpd-provider.js",
    target: "bun",
    format: "esm",
    packages: "external",
    external: ["bun:sqlite"],
  })
  if (!result.success)
    throw new AggregateError(result.logs, "The bundled jscpd provider failed to build.")
}

if (import.meta.main) await buildJscpdProvider()
