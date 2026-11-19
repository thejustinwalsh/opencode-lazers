import { fileURLToPath } from "node:url"
import { setFallowThreads, wasmFallowAnalyzer } from "../wasm-analyzer.ts"

/** Child of fallow-memory.test.ts: prints the process's resident MB after each of five analyses. */
const root = fileURLToPath(new URL("../../..", import.meta.url))
setFallowThreads("off")
for (let i = 0; i < 5; i++) {
  await wasmFallowAnalyzer.deadCode({ root, timeoutMs: 120_000 })
  console.log(Math.round(process.memoryUsage().rss / 1048576))
}
process.exit(0)
