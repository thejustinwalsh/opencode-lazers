import { mkdir, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

const destination = new URL("../dist/", import.meta.url)
const result = await Bun.build({
  entrypoints: [fileURLToPath(new URL("../src/radar/elk-worker.cjs", import.meta.url))],
  target: "node",
  format: "cjs",
  external: ["node:worker_threads"],
})
if (!result.success) throw new AggregateError(result.logs, "ELK worker bundling failed")
const output = result.outputs[0]
if (!output) throw new Error("ELK worker bundling produced no output")
const source = await output.text()
if (process.argv.includes("--stdout")) {
  process.stdout.write(source)
} else {
  await mkdir(destination, { recursive: true })
  await writeFile(new URL("radar-layout-worker.cjs", destination), source)
  console.log("Bundled ELK and its worker-thread adapter for the Desktop main process")
}
