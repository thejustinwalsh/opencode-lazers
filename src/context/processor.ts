import { mergeConfigs, processFiles, runSecurityCheck, setLogLevel, TokenCounter } from "repomix"
type Source = { path: string; content: string; level?: "compress" | "directory-only" }

declare const self: {
  onmessage: (event: MessageEvent<{ root: string; files: Source[] }>) => Promise<void>
  postMessage: (value: unknown) => void
  close: () => void
}
setLogLevel(-1)
self.onmessage = async (event: MessageEvent<{ root: string; files: Source[] }>) => {
  const counter = new TokenCounter("o200k_base")
  try {
    await counter.init()
    const suspicious = await runSecurityCheck(event.data.files, () => {})
    const denied = new Set(suspicious.map((item) => item.filePath))
    const files = event.data.files.filter((file) => !denied.has(file.path))
    const config = mergeConfigs(
      event.data.root,
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
    self.postMessage({
      ok: true,
      files: processed,
      denied: [...denied],
      tokens,
      repomix: "1.18.1",
      encoding: "o200k_base",
    })
  } catch (error) {
    self.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) })
  } finally {
    counter.free()
    self.close()
  }
}
