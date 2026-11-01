import { copyFile, mkdir } from "node:fs/promises"

const destination = new URL("../dist/", import.meta.url)
await mkdir(destination, { recursive: true })
await copyFile(
  new URL("../src/radar/elk-worker.cjs", import.meta.url),
  new URL("../dist/radar-layout-worker.cjs", import.meta.url),
)
console.log("Packaged ELK's worker-thread adapter for the Desktop main process")
