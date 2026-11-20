import { afterAll, expect, test } from "bun:test"
import { Window } from "happy-dom"
import { build } from "vite"
import solid from "vite-plugin-solid"
import { mkdir, rm } from "node:fs/promises"
import { fileURLToPath, pathToFileURL } from "node:url"

const dom = new Window({ url: "http://localhost/" })
const globalNames = ["window", "document", "HTMLElement", "Node", "Element", "Event"] as const
const previous = new Map<string, PropertyDescriptor | undefined>()
for (const name of globalNames) {
  previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
  Object.defineProperty(globalThis, name, {
    configurable: true,
    enumerable: true,
    writable: true,
    value: (dom as unknown as Record<string, unknown>)[name],
  })
}
const outputDirectory = fileURLToPath(
  new URL("../node_modules/.cache/panel-status-dom-test", import.meta.url),
)
await rm(outputDirectory, { recursive: true, force: true })
await mkdir(outputDirectory, { recursive: true })
await build({
  configFile: false,
  logLevel: "silent",
  resolve: { conditions: ["browser", "development", "module"] },
  plugins: [solid()],
  build: {
    outDir: outputDirectory,
    emptyOutDir: true,
    minify: false,
    lib: {
      entry: fileURLToPath(new URL("./fixtures/panel-status-entry.tsx", import.meta.url)),
      formats: ["es"],
      fileName: "entry",
    },
    rolldownOptions: { output: { codeSplitting: false } },
  },
})
const { mountStatus } = (await import(
  pathToFileURL(`${outputDirectory}/entry.js`).href
)) as typeof import("./fixtures/panel-status-entry.tsx")

const container = dom.document.createElement("div")
dom.document.body.append(container)
const mounted = mountStatus(container as unknown as HTMLElement)
afterAll(() => {
  mounted.dispose()
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete (globalThis as Record<string, unknown>)[name]
  }
  dom.happyDOM.abort()
})
const details = () => container.querySelector("details") as unknown as HTMLDetailsElement | null
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5))

test("the failure Details stays open while the status refreshes through loading and back", async () => {
  expect(details()).not.toBeNull()
  details()!.open = true
  details()!.dispatchEvent(new dom.Event("toggle") as unknown as Event)
  await tick()
  mounted.setLoading(true)
  await tick()
  expect(container.querySelector("details")).toBeNull()
  mounted.setLoading(false)
  await tick()
  expect(details()?.open).toBe(true)
  mounted.setError("Trajectory history exceeds the size")
  await tick()
  expect(details()?.open).toBe(true)
})
