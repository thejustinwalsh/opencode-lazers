import { parentPort } from "node:worker_threads"
import { processRepositorySnapshot, type RepoProcessingInput } from "./repo-processor.ts"

if (!parentPort) throw new Error("Repository snapshot processor requires a worker thread")

const port = parentPort
port.on("message", async (input: RepoProcessingInput) => {
  try {
    await processRepositorySnapshot(input)
    port.postMessage({ ok: true })
  } catch (error) {
    port.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  } finally {
    port.close()
  }
})
