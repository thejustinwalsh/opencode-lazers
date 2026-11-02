import { expect, test } from "bun:test"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import * as gui from "@opencode/plugin/gui"
import * as effect from "effect"
import type { MainContext } from "@opencode/plugin/gui/main"
import type { RadarLayoutInput, RadarLayoutResult } from "./layout-ipc.ts"

test("Desktop's filename-free bundle evaluator registers and runs the self-contained ELK worker", async () => {
  const worker = await Bun.build({
    entrypoints: [fileURLToPath(new URL("./elk-worker.cjs", import.meta.url))],
    target: "node",
    format: "cjs",
    external: ["node:worker_threads"],
  })
  expect(worker.success).toBe(true)
  const source = await worker.outputs[0]!.text()
  const bundle = await Bun.build({
    entrypoints: [fileURLToPath(new URL("./layout-main.ts", import.meta.url))],
    target: "node",
    format: "cjs",
    external: ["effect", "@opencode/plugin/gui"],
    define: { __LAZERS_RADAR_WORKER_SOURCE__: JSON.stringify(source) },
  })
  expect(bundle.success).toBe(true)
  const exported: {
    exports: { setupRadarLayoutMain?: (ctx: MainContext) => () => Promise<void> }
  } = {
    exports: {},
  }
  // OpenCode 2.2.5 evaluates main bundles with precisely these three arguments.
  const native = createRequire(import.meta.url)
  new Function("require", "module", "exports", await bundle.outputs[0]!.text())(
    (name: string) => {
      if (name === "@opencode/plugin/gui") return gui
      if (name === "effect") return effect
      return native(name)
    },
    exported,
    exported.exports,
  )
  let layout:
    | ((input: RadarLayoutInput, caller: { signal: AbortSignal }) => Promise<RadarLayoutResult>)
    | undefined
  let disposed = false
  const context = {
    provide(_token: unknown, methods: { layout: NonNullable<typeof layout> }) {
      layout = methods.layout
      return { dispose: () => (disposed = true) }
    },
  } as unknown as MainContext
  const cleanup = exported.exports.setupRadarLayoutMain!(context)
  expect(layout).toBeDefined()
  try {
    const result = await layout!(
      {
        key: "native-bundle",
        scopeKey: "project",
        groups: [{ id: "runtime", label: "Runtime", width: 100, height: 20 }],
        nodes: [{ id: "scheduler", group: "runtime", width: 140, height: 80 }],
        edges: [],
      },
      { signal: new AbortController().signal },
    )
    expect(result.nodes.map((node) => node.id)).toEqual(["scheduler"])
    expect(result.workerThreadId).toBeGreaterThan(0)
    expect(result.width).toBeGreaterThan(0)
  } finally {
    await cleanup()
  }
  expect(disposed).toBe(true)
})
