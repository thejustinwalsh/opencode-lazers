import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { Window } from "happy-dom"
import { build } from "vite"
import solid from "vite-plugin-solid"
import { mkdir, rm } from "node:fs/promises"
import { fileURLToPath, pathToFileURL } from "node:url"
import type {
  ComparisonChartPoint,
  ComparisonChartTheme,
} from "../../src/models/comparison-chart.tsx"

type DOMEntry = typeof import("./fixtures/dom-entry.ts")
type RenderedOption = {
  textStyle?: { fontFamily?: string }
  xAxis?: Array<{ axisLabel?: { fontFamily?: string } }>
  series?: Array<{
    id?: string
    data?: Array<{ value?: number[]; configurationID?: string; symbolSize?: number } | number[]>
    smooth?: boolean
  }>
}

const outputDirectory = fileURLToPath(
  new URL("../../node_modules/.cache/models-chart-dom-test", import.meta.url),
)
const dom = new Window({ url: "https://models-chart.localhost" })
const previousGlobals = new Map<string, PropertyDescriptor | undefined>()
const sizes = new WeakMap<object, { width: number; height: number }>()
const cleanups: Array<() => void> = []
let browser: DOMEntry

class TestResizeObserver {
  static instances: TestResizeObserver[] = []
  observed: Element[] = []
  disconnected = 0
  constructor(readonly callback: () => void) {
    TestResizeObserver.instances.push(this)
  }
  observe(element: Element) {
    this.observed.push(element)
  }
  disconnect() {
    this.disconnected++
    this.observed = []
  }
  trigger() {
    this.callback()
  }
}

const theme: ComparisonChartTheme = {
  surface: "rgb(10, 11, 12)",
  text: "rgb(230, 230, 230)",
  mutedText: "rgb(150, 150, 150)",
  grid: "rgb(50, 50, 50)",
  accent: "rgb(150, 140, 240)",
  fontFamily: "Native UI",
  monoFontFamily: "Native Mono",
}
const points: ComparisonChartPoint[] = [
  {
    configurationID: "cfg:opaque/one::high|exact",
    groupID: "group:opaque/one",
    label: "Luna · Max",
    tokensPerAcceptedTask: 12_345.5,
    currentMarketUSDPerAcceptedTask: 0.123456,
    observationCount: 1,
    acceptedTaskCount: 1,
    partial: false,
  },
  {
    configurationID: "cfg:opaque/two",
    groupID: "group:opaque/two",
    label: "Qwen",
    tokensPerAcceptedTask: 25_000,
    currentMarketUSDPerAcceptedTask: 0.09,
    observationCount: 8,
    acceptedTaskCount: 8,
    partial: false,
  },
  {
    configurationID: "cfg:opaque/three",
    groupID: "group:opaque/three",
    label: "Sonnet",
    tokensPerAcceptedTask: 40_000,
    currentMarketUSDPerAcceptedTask: 0.48,
    observationCount: 10,
    acceptedTaskCount: 10,
    partial: false,
  },
]

function size(element: object, width: number, height: number) {
  sizes.set(element, { width, height })
}

async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt++)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  expect(predicate()).toBe(true)
}

beforeAll(async () => {
  const names = [
    "window",
    "document",
    "self",
    "Node",
    "Element",
    "HTMLElement",
    "HTMLDivElement",
    "SVGElement",
    "Document",
    "DocumentFragment",
    "Text",
    "Event",
    "MouseEvent",
    "KeyboardEvent",
    "MutationObserver",
    "DOMParser",
    "customElements",
    "navigator",
    "location",
    "getComputedStyle",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "ResizeObserver",
  ] as const
  for (const name of names) {
    previousGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    const value =
      name === "ResizeObserver"
        ? TestResizeObserver
        : name === "requestAnimationFrame"
          ? dom.requestAnimationFrame.bind(dom)
          : name === "cancelAnimationFrame"
            ? dom.cancelAnimationFrame.bind(dom)
            : name === "getComputedStyle"
              ? dom.getComputedStyle.bind(dom)
              : (dom as unknown as Record<string, unknown>)[name]
    Object.defineProperty(globalThis, name, {
      configurable: true,
      enumerable: true,
      writable: true,
      value,
    })
  }
  const prototype = dom.HTMLElement.prototype
  for (const property of ["clientWidth", "clientHeight"] as const) {
    Object.defineProperty(prototype, property, {
      configurable: true,
      get(this: HTMLElement) {
        const current = sizes.get(this) ?? { width: 640, height: 360 }
        return property === "clientWidth" ? current.width : current.height
      },
    })
  }
  prototype.getBoundingClientRect = function (this: HTMLElement) {
    const current = sizes.get(this) ?? { width: 640, height: 360 }
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: current.width,
      bottom: current.height,
      width: current.width,
      height: current.height,
      toJSON: () => ({}),
    } as unknown as DOMRect
  } as unknown as typeof prototype.getBoundingClientRect

  await rm(outputDirectory, { recursive: true, force: true })
  await mkdir(outputDirectory, { recursive: true })
  await build({
    configFile: false,
    resolve: { conditions: ["browser", "development", "module"] },
    plugins: [solid()],
    build: {
      outDir: outputDirectory,
      emptyOutDir: true,
      minify: false,
      lib: {
        entry: fileURLToPath(new URL("./fixtures/dom-entry.ts", import.meta.url)),
        formats: ["es"],
        fileName: "models-chart-dom-test",
      },
      rolldownOptions: { output: { codeSplitting: false } },
    },
  })
  browser = (await import(
    pathToFileURL(`${outputDirectory}/models-chart-dom-test.js`).href
  )) as DOMEntry
})

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  dom.document.body.replaceChildren()
})

afterAll(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  await dom.happyDOM.close()
  for (const [name, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else Reflect.deleteProperty(globalThis, name)
  }
  await rm(outputDirectory, { recursive: true, force: true })
})

test("real Solid SVG rendering retains exact accessible selection IDs across data updates", async () => {
  const container = dom.document.createElement("main")
  dom.document.body.append(container)
  const selections: string[] = []
  const [data, setData] = browser.createSignal({
    points,
    frontierConfigurationIDs: [points[0]!.configurationID, points[1]!.configurationID],
    selectedConfigurationID: points[0]!.configurationID as string | null,
  })
  const dispose = browser.render(
    () =>
      browser.createComponent(browser.ComparisonChart, {
        get points() {
          return data().points
        },
        get frontierConfigurationIDs() {
          return data().frontierConfigurationIDs
        },
        get selectedConfigurationID() {
          return data().selectedConfigurationID
        },
        theme,
        onSelect: (configurationID: string) => selections.push(configurationID),
      }),
    container as unknown as HTMLElement,
  )
  cleanups.push(dispose)
  await until(() => container.querySelector("[xmlns='http://www.w3.org/2000/svg']") !== null)
  const originalSVG = container.querySelector("[xmlns='http://www.w3.org/2000/svg']")
  expect(originalSVG).not.toBeNull()
  expect(container.querySelectorAll("[d]").length).toBeGreaterThan(0)
  const chartHost = container.querySelector("[role='img']")!
  const chart = browser.getComparisonChartInstance(chartHost as unknown as HTMLElement)!
  const selectedMarker = () =>
    Array.from(container.querySelectorAll("[d]")).find((path) =>
      path.getAttribute("transform")?.startsWith("matrix(7,"),
    )
  const originalMarker = selectedMarker()
  expect(originalMarker).toBeDefined()
  const exact = points[0]!.configurationID
  const button = container.querySelector(`button[data-configuration-id="${exact}"]`)
  expect(button?.getAttribute("aria-pressed")).toBe("true")
  expect(button?.getAttribute("aria-label")).toContain("12,345.5 tokens per accepted task")
  expect(button?.getAttribute("aria-label")).toContain("$0.123456 current market USD")
  button?.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }))
  expect(selections).toEqual([exact])

  const changedQwen = { ...points[1]!, tokensPerAcceptedTask: 26_000 }
  setData({
    points: [points[0]!, changedQwen, points[2]!],
    frontierConfigurationIDs: [changedQwen.configurationID, points[2]!.configurationID],
    selectedConfigurationID: changedQwen.configurationID,
  })
  await until(() => {
    const option = chart.getOption() as unknown as RenderedOption
    const scatter = option.series?.find((series) => series.id === "observations")
    const frontier = option.series?.find((series) => series.id === "authoritative-frontier")
    const qwen = scatter?.data?.find(
      (datum) => !Array.isArray(datum) && datum.configurationID === changedQwen.configurationID,
    )
    return (
      !Array.isArray(qwen) &&
      qwen?.value?.[0] === 26_000 &&
      qwen.symbolSize === 14 &&
      frontier?.data?.length === 2
    )
  })
  const changed = chart.getOption() as unknown as RenderedOption
  const scatter = changed.series?.find((series) => series.id === "observations")
  expect(scatter?.data?.map((datum) => !Array.isArray(datum) && datum.symbolSize)).toEqual([
    10, 14, 10,
  ])
  expect(changed.series?.find((series) => series.id === "authoritative-frontier")?.data).toEqual([
    [26_000, 0.09],
    [40_000, 0.48],
  ])
  expect(chart.convertToPixel({ seriesId: "observations" }, [26_000, 0.09])).toEqual(
    expect.arrayContaining([expect.any(Number), expect.any(Number)]),
  )
  expect(selectedMarker()).toBeDefined()
  expect(selectedMarker()?.outerHTML).not.toBe(originalMarker?.outerHTML)
  expect(container.querySelector("[xmlns='http://www.w3.org/2000/svg']")).toBe(originalSVG)
  expect(container.querySelectorAll("[xmlns='http://www.w3.org/2000/svg']")).toHaveLength(1)
  expect(container.textContent).toContain("Qwen")
  expect(container.textContent).not.toContain("No plottable observations")
})

test("real ECharts SVG uses literal observations and only straight segments between frontier points", async () => {
  const host = dom.document.createElement("div")
  dom.document.body.append(host)
  size(host, 720, 400)
  const adapter = new browser.ComparisonChartAdapter(host as unknown as HTMLElement, () => {})
  try {
    expect(
      adapter.update(
        {
          points,
          frontierConfigurationIDs: [points[2]!.configurationID, points[0]!.configurationID],
        },
        theme,
      ),
    ).toBe(true)
    await until(() => host.querySelectorAll("[d]").length > 0)
    const rendered = adapter.chart.getOption() as unknown as RenderedOption
    const scatter = rendered.series?.find((series) => series.id === "observations")
    const frontier = rendered.series?.find((series) => series.id === "authoritative-frontier")
    expect(scatter?.data?.map((datum) => !Array.isArray(datum) && datum.value)).toEqual([
      [12_345.5, 0.123456],
      [25_000, 0.09],
      [40_000, 0.48],
    ])
    expect(frontier?.data).toEqual([
      [12_345.5, 0.123456],
      [40_000, 0.48],
    ])
    expect(frontier?.smooth).toBe(false)
    const frontierPath = Array.from(host.querySelectorAll("[d]")).find((path) =>
      Boolean(path.getAttribute("stroke-dasharray")),
    )
    expect(frontierPath).toBeDefined()
    expect(frontierPath?.getAttribute("d")).toMatch(/^M[^CQSA]+L/i)
    expect(frontierPath?.getAttribute("d")).not.toMatch(/[CQS]/i)
    expect(
      adapter.chart.convertToPixel({ seriesId: "observations" }, [12_345.5, 0.123456]),
    ).toEqual(expect.arrayContaining([expect.any(Number), expect.any(Number)]))

    adapter.update(
      { points: [points[0]!], frontierConfigurationIDs: [points[0]!.configurationID] },
      theme,
    )
    await until(() =>
      Array.from(host.querySelectorAll("[d]"))
        .filter((path) => Boolean(path.getAttribute("stroke-dasharray")))
        .every((path) => !path.getAttribute("d")),
    )
    const singleton = adapter.chart.getOption() as unknown as RenderedOption
    expect(
      singleton.series?.find((series) => series.id === "authoritative-frontier")?.data,
    ).toEqual([])
  } finally {
    adapter.dispose()
  }
})

test("actual tooltip renders markup-like model labels as literal text without injected elements", async () => {
  const host = dom.document.createElement("div")
  dom.document.body.append(host)
  size(host, 480, 320)
  const label = '<img src=x onerror="alert(1)"> A&B "Qwen" <script>alert(2)</script>'
  const adapter = new browser.ComparisonChartAdapter(host as unknown as HTMLElement, () => {})
  try {
    adapter.update({ points: [{ ...points[0]!, label }], frontierConfigurationIDs: [] }, theme)
    adapter.chart.dispatchAction({ type: "showTip", seriesId: "observations", dataIndex: 0 })
    await until(() => host.textContent?.includes(label) === true)
    expect(host.textContent).toContain(label)
    expect(host.querySelector("img")).toBeNull()
    expect(host.querySelector("script")).toBeNull()
    expect(host.querySelector("[onerror]")).toBeNull()
    expect(host.innerHTML).toContain("&lt;img src=x onerror=")
    expect(host.innerHTML).toContain("A&amp;B")
  } finally {
    adapter.dispose()
  }
})

test("adapter owns one instance and completely disposes theme, resize and listener lifecycle", () => {
  const host = dom.document.createElement("div")
  dom.document.body.append(host)
  size(host, 480, 320)
  host.style.setProperty("--surface-base", "rgb(1, 2, 3)")
  host.style.setProperty("--text-strong", "rgb(240, 240, 240)")
  host.style.setProperty("--text-weak", "rgb(120, 120, 120)")
  host.style.setProperty("--border-weak-base", "rgb(40, 40, 40)")
  host.style.setProperty("--border-selected", "rgb(100, 90, 220)")
  host.style.fontFamily = "Host Sans"
  const nativeTheme = browser.resolveNativeComparisonChartTheme(
    host as unknown as HTMLElement,
    "Reactive UI",
    "Reactive Mono",
  )
  expect(nativeTheme.surface).toBe("rgb(1, 2, 3)")
  expect(nativeTheme.fontFamily).toBe("Reactive UI")
  expect(nativeTheme.monoFontFamily).toBe("Reactive Mono")

  const window = dom.document.defaultView!
  type Listener = (...args: unknown[]) => unknown
  const originalAdd = Reflect.get(window, "addEventListener") as Listener
  const originalRemove = Reflect.get(window, "removeEventListener") as Listener
  let resizeListeners = 0
  Reflect.set(window, "addEventListener", (kind: unknown, ...args: unknown[]) => {
    if (kind === "resize") resizeListeners++
    return Reflect.apply(originalAdd, window, [kind, ...args])
  })
  Reflect.set(window, "removeEventListener", (kind: unknown, ...args: unknown[]) => {
    if (kind === "resize") resizeListeners--
    return Reflect.apply(originalRemove, window, [kind, ...args])
  })

  const adapter = new browser.ComparisonChartAdapter(host as unknown as HTMLElement, () => {})
  const ownedChart = adapter.chart
  let setOptions = 0
  let resizes = 0
  const setOption = ownedChart.setOption.bind(ownedChart)
  ownedChart.setOption = ((...parameters: Parameters<typeof ownedChart.setOption>) => {
    setOptions++
    return setOption(...parameters)
  }) as typeof ownedChart.setOption
  const resize = ownedChart.resize.bind(ownedChart)
  ownedChart.resize = ((...parameters: Parameters<typeof ownedChart.resize>) => {
    resizes++
    return resize(...parameters)
  }) as typeof ownedChart.resize

  try {
    expect(Object.is(TestResizeObserver.instances.at(-1)?.observed[0], host)).toBe(true)
    expect(resizeListeners).toBe(1)
    adapter.update({ points, frontierConfigurationIDs: [] }, nativeTheme)
    expect(adapter.chart).toBe(ownedChart)
    expect(setOptions).toBe(1)
    expect((ownedChart.getOption() as unknown as RenderedOption).textStyle?.fontFamily).toBe(
      "Reactive UI",
    )
    adapter.update(
      {
        points: [points[1]!],
        frontierConfigurationIDs: [],
        selectedConfigurationID: points[1]!.configurationID,
      },
      { ...nativeTheme, fontFamily: "Changed UI", monoFontFamily: "Changed Mono" },
    )
    const changed = ownedChart.getOption() as unknown as RenderedOption
    expect(changed.textStyle?.fontFamily).toBe("Changed UI")
    expect(changed.xAxis?.[0]?.axisLabel?.fontFamily).toBe("Changed Mono")
    expect(adapter.chart).toBe(ownedChart)
    expect(setOptions).toBe(2)

    const observer = TestResizeObserver.instances.at(-1)!
    size(host, 700, 380)
    observer.trigger()
    expect(resizes).toBe(3)
    size(host, 0, 0)
    expect(adapter.resize()).toBe(false)
    observer.trigger()
    expect(resizes).toBe(3)

    adapter.dispose()
    expect(adapter.disposed).toBe(true)
    expect(observer.disconnected).toBe(1)
    expect(resizeListeners).toBe(0)
    expect(ownedChart.isDisposed()).toBe(true)
    expect(adapter.update({ points, frontierConfigurationIDs: [] }, nativeTheme)).toBe(false)
    expect(adapter.resize()).toBe(false)
    expect(setOptions).toBe(2)
    expect(resizes).toBe(3)
    adapter.dispose()
    expect(observer.disconnected).toBe(1)
  } finally {
    adapter.dispose()
    Reflect.set(window, "addEventListener", originalAdd)
    Reflect.set(window, "removeEventListener", originalRemove)
  }
})
