import { runOwnedTestProcess } from "./owned-test-process.ts"

process.stdout.write(`owner:${process.pid}\n`)

await runOwnedTestProcess(
  [
    process.execPath,
    "-e",
    "process.stdout.write('nested:' + process.pid + '\\n'); setInterval(() => {}, 1000)",
  ],
  {
    timeoutMs: 60_000,
    processGroup: "inherited",
  },
)
