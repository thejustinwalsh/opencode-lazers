import { afterAll, expect, test } from "bun:test"
import { Window } from "happy-dom"
import { build } from "vite"
import solid from "vite-plugin-solid"
import { mkdir, rm } from "node:fs/promises"
import { fileURLToPath, pathToFileURL } from "node:url"
import { labelTones } from "./tone.ts"
import { detailsKitStyles } from "./styles.ts"

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
  new URL("../../node_modules/.cache/details-kit-dom-test", import.meta.url),
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
      entry: fileURLToPath(new URL("./fixtures/entry.tsx", import.meta.url)),
      formats: ["es"],
      fileName: "entry",
    },
    rolldownOptions: { output: { codeSplitting: false } },
  },
})
const { mountKit } = (await import(
  pathToFileURL(`${outputDirectory}/entry.js`).href
)) as typeof import("./fixtures/entry.tsx")

const container = dom.document.createElement("div")
dom.document.body.append(container)
const dispose = mountKit(container as unknown as HTMLElement)
afterAll(() => {
  dispose()
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete (globalThis as Record<string, unknown>)[name]
  }
  dom.happyDOM.abort()
})
const q = <T extends Element>(selector: string) => container.querySelector(selector) as T | null
const all = (selector: string) => [...container.querySelectorAll(selector)]

test("a stat row with no values is not rendered; empty columns are dropped, four at most", () => {
  expect(q("#stats-empty")?.children.length).toBe(0)
  const stats = all("#stats-some .lazers-kit-stat")
  expect(stats.map((s) => s.querySelector("dt")?.textContent)).toEqual([
    "Age",
    "Calls",
    "Model",
    "Extra",
  ])
  expect(
    q<HTMLElement>("#stats-some .lazers-kit-stats")?.style.getPropertyValue("--lazers-kit-columns"),
  ).toBe("4")
})

test("labels carry their tone, and every tone has a hue rule", () => {
  expect(all("#label .lazers-kit-label").map((l) => l.getAttribute("data-lazers-tone"))).toEqual([
    "warning",
    "critical",
  ])
  for (const tone of labelTones) expect(detailsKitStyles).toContain(`data-lazers-tone="${tone}"`)
})

test("kit styles use no hex colors", () => {
  expect(detailsKitStyles).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
})

test("progress renders passed, current and later; the final step may be green", () => {
  const lists = all("#progress .lazers-kit-progress")
  expect([...lists[0]!.children].map((li) => li.getAttribute("data-state"))).toEqual([
    "passed",
    "current",
    "later",
  ])
  expect(lists[0]!.children[1]!.getAttribute("data-lazers-tone")).toBe("warning")
  expect(lists[0]!.children[1]!.getAttribute("aria-current")).toBe("step")
  expect(lists[1]!.children[1]!.getAttribute("data-lazers-tone")).toBe("success")
})

test("the lane draws a bounded number of ticks for thousands, and marks the failure", () => {
  const ticks = [...all("#lane .lazers-kit-lane")[0]!.querySelectorAll(".lazers-kit-tick")]
  expect(ticks.length).toBeLessThanOrEqual(100)
  expect(ticks.filter((t) => t.getAttribute("data-failed") === "true")).toHaveLength(1)
  // No text and no captions inside the lane; detail comes from hover and the accessible name.
  expect(q("#lane .lazers-kit-lane-captions")).toBeNull()
  const lanes = all("#lane .lazers-kit-lane")
  for (const lane of lanes) expect(lane.textContent).toBe("")
  expect(lanes[0]!.getAttribute("aria-label")).toMatch(/^Activity: 5000 calls from 12:58/)
})

test("lane hover detail: one mark, a cluster, a quiet stretch, and the aria summary", () => {
  const lane = all("#lane .lazers-kit-lane")[1]!
  const clock = (ms: number) =>
    new Date(new Date(2026, 0, 1, 12, 58).getTime() + ms).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    })
  const tips = [...lane.querySelectorAll("[data-tip]")].map((node) => node.getAttribute("data-tip"))
  expect(tips).toContain(`Read · ${clock(0)} · 1.5s`)
  expect(tips).toContain(`Search · ${clock(60_000)} · failed`)
  expect(tips).toContain(`2 calls · ${clock(120_000)} – ${clock(121_000)}`)
  expect(tips.some((tip) => tip?.startsWith("19h") && tip.includes(" idle · "))).toBe(true)
  // The quiet stretch is a bare break: fixed width, no text.
  const idle = lane.querySelector(".lazers-kit-lane-idle") as unknown as HTMLElement
  expect(idle.style.width).toBe("20px")
  expect(idle.textContent).toBe("")
  expect(lane.getAttribute("aria-label")).toMatch(
    /^Quiet: 5 calls from .+, last activity .+, idle 19h/,
  )
  // The track exposes its start and end.
  expect(lane.getAttribute("data-tip")).toContain(clock(0))
  // Keyboard: the lane takes focus and Arrow keys step through marks and stretches.
  expect(lane.getAttribute("tabindex")).toBe("0")
  lane.dispatchEvent(
    new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }) as never,
  )
  expect(lane.querySelectorAll('[data-active="true"]')).toHaveLength(1)
})

test("coverage, rows, disclosures and identifiers are omitted when empty", () => {
  expect(q("#coverage-empty")?.children.length).toBe(0)
  expect(q("#coverage .lazers-kit-coverage-caption")?.textContent).toBe(
    "3 calls priced" + "no price",
  )
  expect(q("#rows-empty")?.children.length).toBe(0)
  expect(all("#rows .lazers-kit-row")).toHaveLength(3)
  expect(q("#rows .lazers-kit-rows-head")?.textContent).toBe("ToolTime")
  expect(q("#disc-count0")?.children.length).toBe(0)
  expect(q("#disc-when")?.children.length).toBe(0)
  expect(q("#ids-empty")?.children.length).toBe(0)
  expect(all("#ids .lazers-kit-id")).toHaveLength(1)
})

test("a disclosure shows `· count`, toggles aria-expanded and mounts its body only when open", () => {
  const toggle = q<HTMLButtonElement>("#disc .lazers-kit-disclosure-toggle")!
  expect(toggle.textContent).toContain("Events")
  expect(toggle.textContent).toContain("· 165")
  expect(toggle.getAttribute("aria-expanded")).toBe("false")
  expect(q("#disc .lazers-kit-disclosure-body")).toBeNull()
  toggle.click()
  expect(toggle.getAttribute("aria-expanded")).toBe("true")
  expect(q("#disc .lazers-kit-disclosure-body")?.textContent).toBe("BODY")
})

test("the callout reveals raw detail from its Details link", () => {
  const toggle = q<HTMLButtonElement>("#callout .lazers-callout-toggle")!
  const raw = q<HTMLElement>("#callout .lazers-callout-raw")!
  expect(q("#callout .lazers-callout-text")?.textContent).toContain("Interrupted.")
  expect(raw.hidden).toBe(true)
  toggle.click()
  expect(raw.hidden).toBe(false)
  expect(toggle.getAttribute("aria-expanded")).toBe("true")
})

test("a Rows table is one grid: its rows are subgrids, so the header and every row share columns", () => {
  // Each row as its own grid sized `auto` and `fr` columns apart: the header of a table whose last
  // column held a button sat over different columns than its rows.
  const rule = (selector: string) =>
    new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`).exec(detailsKitStyles)?.[1] ?? ""
  expect(rule(".lazers-kit-rows")).toContain("grid-template-columns: var(--lazers-kit-columns)")
  expect(rule(".lazers-kit-row")).toContain("grid-template-columns: subgrid")
  expect(rule(".lazers-kit-row")).toContain("grid-column: 1 / -1")
})
