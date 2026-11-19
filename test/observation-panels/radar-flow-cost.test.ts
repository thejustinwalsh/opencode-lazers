import { afterAll, expect, test } from "bun:test"
import { Window } from "happy-dom"
import solid from "vite-plugin-solid"
import { build } from "vite"
import { mkdir, rm } from "node:fs/promises"
import { fileURLToPath, pathToFileURL } from "node:url"

type Entry = {
  mountRadar(
    view: "monitor" | "map" | "flow",
    container: HTMLElement,
  ): { dispose(): void; refresh(): void }
}
const guiRoot = fileURLToPath(new URL("../../src/gui.tsx", import.meta.url))
const entry = fileURLToPath(new URL("./fixtures/radar-flow-cost-entry.tsx", import.meta.url))
const outputDirectory = fileURLToPath(
  new URL("../../node_modules/.cache/radar-flow-cost-test", import.meta.url),
)
let viteBuild: Promise<void> | undefined
async function loadEntry() {
  installGlobals()
  viteBuild ??= (async () => {
    await rm(outputDirectory, { recursive: true, force: true })
    await mkdir(outputDirectory, { recursive: true })
    await build({
      configFile: false,
      resolve: { conditions: ["browser", "development", "module"] },
      define: { __LAZERS_RADAR_WORKER_SOURCE__: JSON.stringify("") },
      plugins: [solid()],
      build: {
        outDir: outputDirectory,
        emptyOutDir: true,
        minify: false,
        lib: { entry, formats: ["es"], fileName: "radar-flow-cost" },
        rolldownOptions: { output: { codeSplitting: false } },
      },
    })
  })()
  await viteBuild
  return (await import(pathToFileURL(`${outputDirectory}/radar-flow-cost.js`).href)) as Entry
}
afterAll(async () => {
  await viteBuild
  await rm(outputDirectory, { recursive: true, force: true })
})
void guiRoot

const globals = [
  "window",
  "document",
  "Node",
  "Element",
  "HTMLElement",
  "SVGElement",
  "Document",
  "DocumentFragment",
  "Text",
  "Event",
  "MouseEvent",
  "KeyboardEvent",
  "MutationObserver",
  "customElements",
  "navigator",
  "location",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
] as const

const sharedDom = new Window({ url: "http://localhost" })
function installGlobals() {
  for (const name of globals)
    Object.defineProperty(globalThis, name, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: (sharedDom as unknown as Record<string, unknown>)[name],
    })
}
async function withDom<T>(run: (dom: Window) => Promise<T>) {
  return run(sharedDom)
}

/** Element nodes inserted or removed, and attribute writes, while `run` executes. */
async function mutations(dom: Window, root: Element, run: () => Promise<void>) {
  const counts = { added: 0, removed: 0, attributes: 0, text: 0 }
  const kinds = new Map<string, number>()
  const observer = new dom.MutationObserver((records) => {
    for (const record of records) {
      // The pulse layer is driven by requestAnimationFrame, which happy-dom fires without a
      // display clock; its writes are measured separately.
      if ((record.target as unknown as Element).closest?.(".lazers-radar-flow-pulses")) continue
      for (const node of record.addedNodes)
        if (node.nodeType === 1) {
          const element = node as unknown as Element
          const name = `${element.parentElement?.getAttribute("class") ?? ""} > ${element.tagName}.${element.getAttribute("class") ?? ""}`
          kinds.set(name, (kinds.get(name) ?? 0) + 1)
        }
      if (record.type === "childList") {
        counts.added += [...record.addedNodes].filter((node) => node.nodeType === 1).length
        counts.removed += [...record.removedNodes].filter((node) => node.nodeType === 1).length
      } else if (record.type === "attributes") counts.attributes++
      else counts.text++
    }
  })
  observer.observe(root as never, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true,
  })
  await run()
  await new Promise((resolve) => setTimeout(resolve, 0))
  observer.disconnect()
  if (process.env.RADAR_COST_DEBUG) console.info("ADDED", Object.fromEntries(kinds))
  return counts
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

for (const view of ["flow", "map", "monitor"] as const)
  test(`${view}: a no-change live update and the one-second clock recreate no nodes`, async () => {
    const host = await loadEntry()
    await withDom(async (dom) => {
      const container = dom.document.createElement("div") as unknown as HTMLElement
      dom.document.body.append(container as never)
      const mounted = host.mountRadar(view, container)
      await sleep(30)
      const nodes = container.querySelectorAll("*").length
      expect(nodes).toBeGreaterThan(20)
      const update = await mutations(dom, container as never, async () => {
        for (let i = 0; i < 3; i++) {
          mounted.refresh()
          await sleep(20)
        }
      })
      const clock = await mutations(dom, container as never, async () => {
        await sleep(2_300)
      })
      console.info(`RADAR-COST ${view}`, { nodes, update, clock })
      expect(update.added + update.removed).toBe(0)
      expect(clock.added + clock.removed).toBe(0)
      mounted.dispose()
    })
  })

test("flow: no SMIL, one pulse layer, and a live update between frames leaves pulses where they are", async () => {
  const host = await loadEntry()
  await withDom(async (dom) => {
    const container = dom.document.createElement("div") as unknown as HTMLElement
    dom.document.body.append(container as never)
    const mounted = host.mountRadar("flow", container)
    await sleep(30)
    expect(container.querySelectorAll("animateMotion")).toHaveLength(0)
    const layer = container.querySelector(".lazers-radar-flow-pulses")!
    expect(container.querySelectorAll(".lazers-radar-flow-pulses")).toHaveLength(1)
    // Wait for pulses to be on the wires (the first emission is phased within one interval).
    for (let i = 0; i < 400 && layer.querySelectorAll("circle").length === 0; i++) await sleep(10)
    const dots = () =>
      [...layer.querySelectorAll("circle")]
        .map((dot) => dot.getAttribute("transform"))
        .filter((value) => value !== "translate(-20 -20)")
    await sleep(300)
    const before = dots()
    expect(before.length).toBeGreaterThan(0)
    // Synchronous updates cannot be separated by a frame: every pulse stays exactly in place.
    mounted.refresh()
    mounted.refresh()
    expect(dots()).toEqual(before)
    mounted.dispose()
  })
})
