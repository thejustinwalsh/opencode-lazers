import { wasmFallowAnalyzer } from "../wasm-analyzer.ts"

/**
 * Child process of fallow-wasm.test.ts: starts a whole-repository analysis with threads on,
 * cancels it and returns. The process must then exit by itself, which it cannot if a helper
 * thread or the analysis worker were still running.
 */
const controller = new AbortController()
setTimeout(() => controller.abort("probe"), 700)
await wasmFallowAnalyzer.deadCode({ root: process.argv[2]!, signal: controller.signal }).then(
  () => console.log("finished before the cancel"),
  (error: Error) => console.log(error.message),
)
