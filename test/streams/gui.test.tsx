import { afterAll, beforeAll, expect, test } from "bun:test"
import { Window } from "happy-dom"
import solid from "vite-plugin-solid"
import { build } from "vite"
import { fileURLToPath, pathToFileURL } from "node:url"
import { createStreamsService, type StreamsService } from "../../src/streams/rpc.ts"
import type { StreamsTransport } from "../../src/streams/gui.ts"
import { seedItems, testPool, type SeededDatabase } from "../../src/streams/test-harness.ts"
import type { ReaderPool } from "../../src/streams/pool.ts"

const dom = new Window({ url: "https://streams.localhost" })
const globals = [
  "window",
  "document",
  "Node",
  "Element",
  "HTMLElement",
  "Document",
  "DocumentFragment",
  "Text",
  "Event",
  "MouseEvent",
  "navigator",
] as const
const previous = new Map<string, PropertyDescriptor | undefined>()
let mount!: typeof import("./dom-entry.tsx").harness
let seeded: SeededDatabase
let pool: ReaderPool

beforeAll(async () => {
  seeded = seedItems(500)
  pool = testPool(seeded.path)
  for (const name of globals) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, value: dom[name] })
  }
  const outDir = fileURLToPath(new URL("../../node_modules/.cache/streams-dom", import.meta.url))
  await build({
    configFile: false,
    logLevel: "silent",
    resolve: { conditions: ["browser", "development", "module"] },
    plugins: [solid()],
    build: {
      outDir,
      emptyOutDir: true,
      minify: false,
      lib: {
        entry: fileURLToPath(new URL("./dom-entry.tsx", import.meta.url)),
        formats: ["es"],
        fileName: "streams-dom",
      },
      rolldownOptions: { output: { codeSplitting: false } },
    },
  })
  mount = (
    (await import(
      pathToFileURL(`${outDir}/streams-dom.js`).href
    )) as typeof import("./dom-entry.tsx")
  ).harness
}, 120_000)
afterAll(async () => {
  for (const [name, descriptor] of previous)
    descriptor
      ? Object.defineProperty(globalThis, name, descriptor)
      : delete (globalThis as never as Record<string, unknown>)[name]
  await pool.close()
  seeded.close()
})

const tick = async () => {
  for (let i = 0; i < 5; i++) await Bun.sleep(5)
}
const until = async (condition: () => boolean) => {
  for (let i = 0; i < 200 && !condition(); i++) await Bun.sleep(10)
}

/** The server service behind an in-process transport, counting what the GUI asks of it. */
function wire(service: StreamsService) {
  const calls: string[] = []
  const listeners = new Set<(event: never) => void>()
  const transport: StreamsTransport = {
    open: async (input) => (calls.push("open"), service.open(input as never)),
    slide: async (stream, delta) => (
      calls.push(`slide ${delta}`),
      service.slide({ stream, delta })
    ),
    seek: async (stream, anchor) => (calls.push("seek"), service.seek({ stream, anchor })),
    read: async (stream) => (calls.push("read"), service.read({ stream })),
    touch: async (stream) => service.touch({ stream }),
    close: async (stream) => (calls.push("close"), void service.close({ stream })),
    onChanged: (listener) => (
      listeners.add(listener as never),
      () => void listeners.delete(listener as never)
    ),
  }
  return { transport, calls }
}

const open = async () => {
  const root = dom.document.createElement("main")
  dom.document.body.append(root)
  const service = createStreamsService({ pool, changed: () => {} })
  const { transport, calls } = wire(service)
  const api = mount(root as never, transport, { filter: {}, order: "id", window: 100 })
  await until(() => root.querySelectorAll("li").length > 0)
  return { root, service, calls, api }
}
const titles = (root: Element) => [...root.querySelectorAll("li")].map((li) => li.textContent)

test("a window of 100 renders 50 visible rows, and scrolling by 25 calls slide(25) once", async () => {
  const { root, calls, api, service } = await open()
  expect(titles(root).length).toBe(50)
  expect(titles(root)[0]).toBe("item 1 é")
  expect(root.querySelector('[aria-label="range"]')!.textContent).toBe("0/100/400")
  ;[...root.querySelectorAll("button")]
    .find((b) => b.textContent === "scroll")!
    .dispatchEvent(new dom.MouseEvent("click", { bubbles: true }))
  await until(() => titles(root)[0] === "item 26 é")
  expect(calls.filter((c) => c.startsWith("slide"))).toEqual(["slide 25"])
  expect(titles(root)[49]).toBe("item 75 é")
  expect(root.querySelector('[aria-label="range"]')!.textContent).toBe("25/100/375")
  api.dispose()
  await tick()
  expect(service.size).toBe(0)
})

test("changing the options reopens the stream and closes the old one; cleanup closes the last", async () => {
  const { root, calls, api, service } = await open()
  api.setOptions({ filter: { group: "g1" }, order: "newest", window: 20 })
  await until(() => titles(root)[0] !== "item 1 é")
  expect(calls.filter((c) => c === "open").length).toBe(2)
  expect(calls).toContain("close")
  expect(service.size).toBe(1)
  expect(titles(root).length).toBe(20)
  expect(titles(root)[0]).toBe("item 499 é")
  api.dispose()
  await tick()
  expect(service.size).toBe(0)
})

test("readWindow reads one window and closes its stream", async () => {
  const service = createStreamsService({ pool, changed: () => {} })
  const { transport, calls } = wire(service)
  const { readWindow } = await import("../../src/streams/gui.ts")
  const { sourceRef } = await import("../../src/streams/source.ts")
  const { itemColumns } = await import("../../src/streams/test-source.ts")
  const rows = await readWindow(
    transport,
    sourceRef({ name: "test.items", columns: itemColumns }),
    {
      filter: {},
      order: "id",
      window: 7,
    },
  )
  expect(rows).toHaveLength(7)
  expect(rows[0]!.title).toBe("item 1 é")
  expect(calls).toEqual(["open", "close"])
  expect(service.size).toBe(0)
})
