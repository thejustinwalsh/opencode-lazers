// Pierre's highlight workers for the Review panel. The fork ships a portable worker: one ES module
// with no static imports, inlined here as text and started from a blob URL, so the single-file
// plugin bundle needs no second asset. Languages and the theme resolve on the main thread and are
// sent to the workers. If the host refuses the worker, Pierre highlights on the main thread.
import { getOrCreateWorkerPoolSingleton, terminateWorkerPoolSingleton } from "@pierre/diffs/worker"
import type { WorkerPoolManager } from "@pierre/diffs/worker"
import workerSource from "@pierre/diffs/worker/worker-portable.js?raw"
import { HOST_SYNTAX_THEME, registerHostSyntaxTheme } from "./theme.ts"

let url: string | undefined
let pool: WorkerPoolManager | undefined
let users = 0

/** The shared pool, created on first use; release it with the function this returns. */
export function acquireHighlighter(): { pool: WorkerPoolManager | undefined; release(): void } {
  registerHostSyntaxTheme()
  users++
  if (!pool && typeof Worker === "function" && typeof Blob === "function") {
    try {
      url ??= URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }))
      const source = url
      pool = getOrCreateWorkerPoolSingleton({
        poolOptions: {
          workerFactory: () =>
            new Worker(source, { type: "module", name: "lazers-review-highlight" }),
          onWorkerError: (event) => event.preventDefault(),
        },
        highlighterOptions: {
          theme: { dark: HOST_SYNTAX_THEME, light: HOST_SYNTAX_THEME },
          preferredHighlighter: "shiki-js",
          langs: [],
        },
      })
    } catch {
      pool = undefined
    }
  }
  let released = false
  return {
    pool,
    release() {
      if (released) return
      released = true
      if (--users > 0) return
      terminateWorkerPoolSingleton()
      pool = undefined
      if (url) URL.revokeObjectURL(url)
      url = undefined
    },
  }
}
