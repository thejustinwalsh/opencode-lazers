import { mergeConfigs, processFiles, runSecurityCheck, setLogLevel, TokenCounter } from "repomix"
import { parentPort } from "node:worker_threads"
type Source = { path: string; content: string; level?: "compress" | "directory-only" }

if (!parentPort) throw new Error("Source context processor requires a worker thread")
const port = parentPort
setLogLevel(-1)
/** Tree-sitter outlines for the few files a task names. One message in, one result out. */
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
    port.postMessage({ ok: true, files: processed, denied: [...denied] })
  } catch (error) {
    port.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) })
  } finally {
    counter.free()
    port.close()
  }
})
