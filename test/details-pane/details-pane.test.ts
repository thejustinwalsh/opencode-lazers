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
  new URL("../../node_modules/.cache/details-pane-dom-test", import.meta.url),
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
      entry: fileURLToPath(new URL("./fixtures/entry.ts", import.meta.url)),
      formats: ["es"],
      fileName: "entry",
    },
    rolldownOptions: { output: { codeSplitting: false } },
  },
})
const { mountPane } = (await import(
  pathToFileURL(`${outputDirectory}/entry.js`).href
)) as typeof import("./fixtures/entry.ts")

afterAll(() => {
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete (globalThis as Record<string, unknown>)[name]
  }
  dom.happyDOM.abort()
})

function mount(initial?: { open?: boolean; size?: number }) {
  const container = dom.document.createElement("div")
  dom.document.body.append(container)
  const pane = mountPane(container as unknown as HTMLElement, initial)
  const q = <T extends Element>(selector: string) => container.querySelector(selector) as T | null
  return { container, pane, q }
}

test("collapsed by default: a header bar with the empty text and no body", () => {
  const { pane, q } = mount()
  expect(q(".lazers-details-body")).toBeNull()
  expect(q(".lazers-details-header")?.textContent).toBe("Nothing selected")
  expect(q(".lazers-details-actions")).toBeNull()
  expect(q(".lazers-details-chevron")?.getAttribute("aria-expanded")).toBe("false")
  expect(q(".lazers-details-top")?.textContent).toBe("TOP")
  pane.dispose()
})

test("the chevron toggles the body and aria-expanded; the body is the scroll region", () => {
  const { pane, q } = mount()
  const chevron = q<HTMLButtonElement>(".lazers-details-chevron")!
  chevron.click()
  expect(pane.open()).toBe(true)
  expect(chevron.getAttribute("aria-expanded")).toBe("true")
  const body = q<HTMLElement>(".lazers-details-body")!
  expect(body.textContent).toBe("BODY")
  expect(body.id).toBe(chevron.getAttribute("aria-controls") ?? "")
  // The body holds the content; the bar is a sibling of it, not inside the scrolling element.
  expect(body.contains(q(".lazers-details-bar"))).toBe(false)
  expect(q(".lazers-details-pane")?.firstElementChild).toBe(q(".lazers-details-bar"))
  expect(body.classList.contains("test-body")).toBe(true)
  chevron.click()
  expect(pane.open()).toBe(false)
  expect(q(".lazers-details-body")).toBeNull()
  pane.dispose()
})

test("selecting does not open the pane; it fills the header and shows the actions", () => {
  const { pane, q } = mount()
  pane.setSelected("LZ-1")
  expect(pane.open()).toBe(false)
  expect(q(".lazers-details-header")?.textContent).toBe("Selected LZ-1")
  expect(q(".lazers-details-actions")?.textContent).toBe("ACTION")
  pane.setSelected(undefined)
  expect(q(".lazers-details-header")?.textContent).toBe("Nothing selected")
  expect(q(".lazers-details-actions")).toBeNull()
  expect(pane.events).toEqual([])
  pane.dispose()
})

test("an open pane stays open across selection changes", () => {
  const { pane, q } = mount({ open: true })
  pane.setSelected("A")
  pane.setSelected("B")
  pane.setSelected(undefined)
  expect(q(".lazers-details-body")).not.toBeNull()
  expect(q(".lazers-details-header")?.textContent).toBe("Nothing selected")
  pane.dispose()
})

test("double-clicking the bar toggles; double-clicking a button does not", () => {
  const { pane, q } = mount()
  const dbl = () => new dom.window.MouseEvent("dblclick", { bubbles: true }) as unknown as Event
  q(".lazers-details-bar")!.dispatchEvent(dbl())
  expect(pane.open()).toBe(true)
  q(".lazers-details-chevron")!.dispatchEvent(dbl())
  expect(pane.open()).toBe(true)
  pane.dispose()
})

test("the handle is a focusable horizontal separator; keys resize and Enter toggles", () => {
  const { container, pane, q } = mount({ open: true, size: 0.45 })
  const handle = q<HTMLElement>(".lazers-details-resize")!
  expect(handle.getAttribute("role")).toBe("separator")
  expect(handle.getAttribute("aria-orientation")).toBe("horizontal")
  expect(handle.tabIndex).toBe(0)
  expect(handle.getAttribute("aria-valuenow")).toBe("45")
  const root = q<HTMLElement>(".lazers-details")!
  root.getBoundingClientRect = () => ({ top: 0, height: 600 }) as DOMRect
  const key = (name: string) =>
    handle.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: name, bubbles: true }) as unknown as Event,
    )
  key("ArrowUp")
  expect(pane.size()).toBeCloseTo(0.5)
  expect(handle.getAttribute("aria-valuenow")).toBe("50")
  key("ArrowDown")
  key("ArrowDown")
  expect(pane.size()).toBeCloseTo(0.4)
  key("Enter")
  expect(pane.open()).toBe(false)
  void container
  pane.dispose()
})

test("dragging the top edge up opens; dragging below 72 px of body collapses", () => {
  const { pane, q } = mount()
  const root = q<HTMLElement>(".lazers-details")!
  root.getBoundingClientRect = () => ({ top: 0, height: 600 }) as DOMRect
  q<HTMLElement>(".lazers-details-bar")!.getBoundingClientRect = () => ({ top: 568 }) as DOMRect
  const handle = q<HTMLElement>(".lazers-details-resize")!
  const pointer = (type: string, clientY: number) =>
    handle.dispatchEvent(
      new dom.window.MouseEvent(type, { clientY, bubbles: true }) as unknown as Event,
    )
  pointer("pointerdown", 570)
  pointer("pointermove", 300)
  pointer("pointerup", 300)
  expect(pane.open()).toBe(true)
  expect(pane.size()).toBeGreaterThan(0.3)
  pointer("pointerdown", 300)
  pointer("pointermove", 560)
  pointer("pointerup", 560)
  expect(pane.open()).toBe(false)
  pane.dispose()
})

test("size is the last expanded height: collapsing never overwrites it, opening restores it", () => {
  const { pane, q } = mount({ open: true, size: 0.6 })
  const root = q<HTMLElement>(".lazers-details")!
  root.getBoundingClientRect = () => ({ top: 0, height: 600 }) as DOMRect
  q<HTMLElement>(".lazers-details-bar")!.getBoundingClientRect = () => ({ top: 300 }) as DOMRect
  const handle = q<HTMLElement>(".lazers-details-resize")!
  const pointer = (type: string, clientY: number) =>
    handle.dispatchEvent(
      new dom.window.MouseEvent(type, { clientY, bubbles: true }) as unknown as Event,
    )
  // Drag far below the snap threshold: collapsed, with the 0.6 height kept, not the drag value.
  pointer("pointerdown", 300)
  pointer("pointermove", 590)
  pointer("pointerup", 590)
  expect(pane.open()).toBe(false)
  expect(pane.size()).toBe(0.6)
  // Chevron, keyboard and double-click collapse keep it and every open restores it.
  const chevron = q<HTMLButtonElement>(".lazers-details-chevron")!
  chevron.click()
  expect([pane.open(), pane.size()]).toEqual([true, 0.6])
  chevron.click()
  expect([pane.open(), pane.size()]).toEqual([false, 0.6])
  handle.dispatchEvent(
    new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as Event,
  )
  expect([pane.open(), pane.size()]).toEqual([true, 0.6])
  q(".lazers-details-bar")!.dispatchEvent(
    new dom.window.MouseEvent("dblclick", { bubbles: true }) as unknown as Event,
  )
  expect([pane.open(), pane.size()]).toEqual([false, 0.6])
  expect(q<HTMLElement>(".lazers-details")!.style.getPropertyValue("--details-size")).toBe("0.6")
  pane.dispose()
})
