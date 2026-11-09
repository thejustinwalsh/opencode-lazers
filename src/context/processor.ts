import {
  defaultIgnoreList,
  mergeConfigs,
  processFiles,
  runSecurityCheck,
  setLogLevel,
  TokenCounter,
} from "repomix"
import { parentPort } from "node:worker_threads"
type Source = { path: string; content: string; level?: "compress" | "directory-only" }

if (!parentPort) throw new Error("Project index processor requires a worker thread")
const port = parentPort
setLogLevel(-1)
port.postMessage({ patterns: defaultIgnoreList })
port.on("message", async (data: { root: string; files: Source[] }) => {
  const counter = new TokenCounter("o200k_base")
  try {
    await counter.init()
    const suspicious = await runSecurityCheck(data.files, () => {})
    const denied = new Set(suspicious.map((item) => item.filePath))
    const files = data.files.filter((file) => !denied.has(file.path))
    const config = mergeConfigs(
      data.root,
      {
        output: {
          compress: true,
          removeComments: false,
          removeEmptyLines: false,
          showLineNumbers: false,
          fileSummary: false,
          directoryStructure: false,
        },
        ignore: {
          useGitignore: false,
          useDotIgnore: false,
          useDefaultPatterns: false,
          customPatterns: [],
        },
      },
      {},
    )
    const processed = await processFiles(files, config, () => {})
    const tokens = counter.countTokens(JSON.stringify(processed))
    if (tokens > 256000)
      throw new Error("Index exceeds 256,000 packed tokens; narrow the project selection")
    port.postMessage({
      ok: true,
      files: processed,
      denied: [...denied],
      tokens,
      repomix: "1.18.1",
      encoding: "o200k_base",
    })
  } catch (error) {
    port.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) })
  } finally {
    counter.free()
    port.close()
  }
})
