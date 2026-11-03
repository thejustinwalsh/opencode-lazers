import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { Window } from "happy-dom"
import { build } from "vite"
import solid from "vite-plugin-solid"
import type { EChartsType } from "echarts/core"
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
let defaultSize = { width: 640, height: 360 }
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

function renderedMarker(host: HTMLElement, chart: EChartsType, point: ComparisonChartPoint) {
  const pixel = chart.convertToPixel({ seriesId: "observations" }, [
    point.tokensPerAcceptedTask,
    point.currentMarketUSDPerAcceptedTask,
  ]) as number[]
  return Array.from(host.querySelectorAll("svg path[transform]")).find((path) => {
    const values = path
      .getAttribute("transform")
      ?.match(/^matrix\(([^)]+)\)$/)?.[1]
      ?.split(",")
      .map(Number)
    return (
      values?.length === 6 &&
      Math.abs(values[4]! - pixel[0]!) < 0.001 &&
      Math.abs(values[5]! - pixel[1]!) < 0.001
    )
  })
}

function requiredMarkerTransform(
  host: HTMLElement,
  chart: EChartsType,
  point: ComparisonChartPoint,
) {
  const marker = renderedMarker(host, chart, point)
  expect(marker).toBeDefined()
  return marker!.getAttribute("transform")!
}

function markerScale(transform: string) {
  return Number(/^matrix\(([^,]+)/.exec(transform)?.[1])
}

function renderedFrontierEndpoints(host: HTMLElement) {
  const path = Array.from(host.querySelectorAll("svg path[stroke-dasharray]")).find((candidate) =>
    candidate.getAttribute("d")?.startsWith("M"),
  )
  const commands = Array.from(
    path?.getAttribute("d")?.matchAll(/([ML])\s*([+-]?[\d.]+)\s+([+-]?[\d.]+)/g) ?? [],
  )
  if (commands.length < 2) return undefined
  const first = commands[0]!
  const last = commands.at(-1)!
  return [
    [Number(first[2]), Number(first[3])],
    [Number(last[2]), Number(last[3])],
  ]
}

function frontierMatches(
  host: HTMLElement,
  chart: EChartsType,
  frontierPoints: readonly ComparisonChartPoint[],
) {
  const actual = renderedFrontierEndpoints(host)
  if (!actual || frontierPoints.length < 2) return false
  const expected = [frontierPoints[0]!, frontierPoints.at(-1)!].map(
    (point) =>
      chart.convertToPixel({ seriesId: "observations" }, [
        point.tokensPerAcceptedTask,
        point.currentMarketUSDPerAcceptedTask,
      ]) as number[],
  )
  return actual.every(
    (endpoint, index) =>
      Math.abs(endpoint[0]! - expected[index]![0]!) < 0.001 &&
      Math.abs(endpoint[1]! - expected[index]![1]!) < 0.001,
  )
}

function expectFrontierEndpoints(
  host: HTMLElement,
  chart: EChartsType,
  frontierPoints: readonly ComparisonChartPoint[],
) {
  const actual = renderedFrontierEndpoints(host)
  expect(actual).toBeDefined()
  const expected = [frontierPoints[0]!, frontierPoints.at(-1)!].map(
    (point) =>
      chart.convertToPixel({ seriesId: "observations" }, [
        point.tokensPerAcceptedTask,
        point.currentMarketUSDPerAcceptedTask,
      ]) as number[],
  )
  for (const index of [0, 1]) {
    expect(actual![index]![0]).toBeCloseTo(expected[index]![0]!, 3)
    expect(actual![index]![1]).toBeCloseTo(expected[index]![1]!, 3)
  }
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
        const current = sizes.get(this) ?? defaultSize
        return property === "clientWidth" ? current.width : current.height
      },
    })
  }
  prototype.getBoundingClientRect = function (this: HTMLElement) {
    const current = sizes.get(this) ?? defaultSize
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

test("real Solid SVG rendering separately updates marker coordinates, frontier and accessible selection", async () => {
  const previousDefaultSize = defaultSize
  defaultSize = { width: 480, height: 320 }
  cleanups.push(() => {
    defaultSize = previousDefaultSize
  })
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
  const chartHost = container.querySelector("[role='img']") as unknown as HTMLElement
  const chart = browser.getComparisonChartInstance(chartHost)!
  const originalSVG = container.querySelector("[xmlns='http://www.w3.org/2000/svg']")
  expect(originalSVG).not.toBeNull()
  expect(originalSVG?.getAttribute("width")).toBe("480")
  expect(originalSVG?.getAttribute("height")).toBe("320")
  expect(chartHost.getAttribute("role")).toBe("img")
  expect(chartHost.getAttribute("aria-label")).toContain("12,345.5 tokens per accepted task")
  const descriptionID = chartHost.getAttribute("aria-describedby")
  const description = container.querySelector(`[id="${descriptionID}"]`)
  expect(description?.textContent).toContain("12,345.5 tokens per accepted task")
  expect(chartHost.getAttribute("style")).toContain("overflow: hidden")

  const buttonFor = (configurationID: string) =>
    container.querySelector(
      `button[data-configuration-id="${configurationID}"]`,
    ) as unknown as HTMLButtonElement | null
  const exact = points[0]!.configurationID
  expect(buttonFor(exact)?.getAttribute("aria-pressed")).toBe("true")
  expect(buttonFor(exact)?.getAttribute("aria-label")).toContain(
    "12,345.5 tokens per accepted task",
  )
  expect(buttonFor(exact)?.getAttribute("aria-label")).toContain("$0.123456 current market USD")
  buttonFor(exact)?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  expect(selections).toEqual([exact])

  const originalQwen = points[1]!
  const originalQwenTransform = requiredMarkerTransform(chartHost, chart, originalQwen)
  const originalSelectedTransform = requiredMarkerTransform(chartHost, chart, points[0]!)
  expect(markerScale(originalQwenTransform)).toBe(5)
  expect(markerScale(originalSelectedTransform)).toBe(7)
  expectFrontierEndpoints(chartHost, chart, [points[0]!, originalQwen])

  const changedQwen = { ...points[1]!, tokensPerAcceptedTask: 26_000 }
  const changedPoints = [points[0]!, changedQwen, points[2]!]
  setData({ ...data(), points: changedPoints })
  await until(() => {
    const marker = renderedMarker(chartHost, chart, changedQwen)
    return marker !== undefined && marker.getAttribute("transform") !== originalQwenTransform
  })
  const changedQwenTransform = requiredMarkerTransform(chartHost, chart, changedQwen)
  expect(changedQwenTransform).not.toBe(originalQwenTransform)
  expect(markerScale(changedQwenTransform)).toBe(5)
  expect(requiredMarkerTransform(chartHost, chart, points[0]!)).toBe(originalSelectedTransform)
  expectFrontierEndpoints(chartHost, chart, [points[0]!, changedQwen])

  const frontierBefore = renderedFrontierEndpoints(chartHost)
  setData({
    ...data(),
    frontierConfigurationIDs: [changedQwen.configurationID, points[2]!.configurationID],
  })
  await until(() => frontierMatches(chartHost, chart, [changedQwen, points[2]!]))
  const frontierAfter = renderedFrontierEndpoints(chartHost)
  expect(frontierAfter).not.toEqual(frontierBefore)
  expectFrontierEndpoints(chartHost, chart, [changedQwen, points[2]!])

  const originalThirdTransform = requiredMarkerTransform(chartHost, chart, points[2]!)
  expect(markerScale(originalSelectedTransform)).toBe(7)
  expect(markerScale(originalThirdTransform)).toBe(5)
  setData({ ...data(), selectedConfigurationID: points[2]!.configurationID })
  await until(() => {
    const selected = renderedMarker(chartHost, chart, points[2]!)
    const deselected = renderedMarker(chartHost, chart, points[0]!)
    return (
      markerScale(selected?.getAttribute("transform") ?? "") === 7 &&
      markerScale(deselected?.getAttribute("transform") ?? "") === 5
    )
  })
  const deselectedTransform = requiredMarkerTransform(chartHost, chart, points[0]!)
  const selectedTransform = requiredMarkerTransform(chartHost, chart, points[2]!)
  expect(deselectedTransform).not.toBe(originalSelectedTransform)
  expect(selectedTransform).not.toBe(originalThirdTransform)
  expect(markerScale(deselectedTransform)).toBe(5)
  expect(markerScale(selectedTransform)).toBe(7)
  expect(buttonFor(points[0]!.configurationID)?.getAttribute("aria-pressed")).toBe("false")
  expect(buttonFor(points[2]!.configurationID)?.getAttribute("aria-pressed")).toBe("true")

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
    adapter.chart.dispatchAction({ type: "showTip", seriesIndex: 0, dataIndex: 0 })
    const visibleTooltip = () =>
      Array.from(host.children).find((child) => {
        if (child.tagName !== "DIV") return false
        const style = dom.getComputedStyle(child)
        return (
          style.position === "absolute" &&
          style.display === "block" &&
          style.visibility !== "hidden" &&
          style.opacity !== "0" &&
          child.textContent?.includes(label) === true
        )
      })
    await until(() => visibleTooltip() !== undefined)
    const tooltip = visibleTooltip()
    expect(tooltip).toBeDefined()
    expect(dom.getComputedStyle(tooltip!).display).toBe("block")
    expect(tooltip!.textContent).toContain(label)
    expect(tooltip!.querySelector("img")).toBeNull()
    expect(tooltip!.querySelector("script")).toBeNull()
    expect(tooltip!.querySelector("[onerror]")).toBeNull()
    expect(tooltip!.innerHTML).toContain("&lt;img src=x onerror=")
    expect(tooltip!.innerHTML).toContain("A&amp;B")
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
