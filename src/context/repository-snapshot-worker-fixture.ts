import { writeFileSync } from "node:fs"
import { parentPort } from "node:worker_threads"

if (!parentPort) throw new Error("Repository snapshot worker fixture requires a worker thread")

parentPort.on("message", (input: { sourceFile: string }) => {
  writeFileSync(input.sourceFile, "unpublished partial source")
})
