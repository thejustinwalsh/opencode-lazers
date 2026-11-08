import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { Window } from "happy-dom"
import { build } from "vite"
import solid from "vite-plugin-solid"
import type { EChartsType } from "echarts/core"
import { mkdir, rm } from "node:fs/promises"
import { fileURLToPath, pathToFileURL } from "node:url"
import type {
  ComparisonChartPoint,
  ComparisonChartReference,
  ComparisonChartTheme,
} from "../../src/models/comparison-chart.tsx"
import { ModelDecisionReferenceEstimateSchema } from "../../src/models/reference-estimate.ts"
import type { ModelDecisionReferenceEstimate } from "../../src/models/reference-estimate.ts"

type DOMEntry = typeof import("./fixtures/dom-entry.ts")
type RenderedOption = {
  grid?: Array<{ left?: number; right?: number; top?: number; bottom?: number }>
  textStyle?: { fontFamily?: string }
  xAxis?: Array<{
    name?: string
    splitNumber?: number
    axisLabel?: { fontFamily?: string; fontSize?: number; hideOverlap?: boolean }
  }>
  yAxis?: Array<{
    name?: string
    splitNumber?: number
    axisLabel?: {
      fontFamily?: string
      fontSize?: number
      hideOverlap?: boolean
      formatter?: (value: number) => string
    }
  }>
  series?: Array<{
    id?: string
    data?: Array<
      | {
          name?: string
          value?: number[]
          configurationID?: string
          symbolSize?: number
          markKind?: string
          label?: {
            show?: boolean
            formatter?: string
            position?: string
            align?: string
            distance?: number
          }
        }
      | number[]
    >
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
    route: { providerID: "openai", modelID: "luna-1", variant: "max" },
    marketSource: "openrouter",
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

function referenceEstimate(
  status: "exact" | "conditional" | "partial",
): ModelDecisionReferenceEstimate {
  const route = { providerID: "openai", modelID: "reference-model", variant: "high" }
  const common = {
    basis: "openrouter-published-model-reference-cost-per-accepted-task" as const,
    route,
    acceptedTaskCount: 3,
    numeratorUSD: null,
    numeratorRangeUSD: null,
    valueUSDPerAcceptedTask: null,
    rangeUSDPerAcceptedTask: null,
    knownSubtotalUSD: null,
    knownSubtotalRangeUSD: null,
    knownSubtotalUSDPerAcceptedTask: null,
    knownSubtotalRangeUSDPerAcceptedTask: null,
    identityStatus: "exact" as const,
    provenance: {
      source: "openrouter-models" as const,
      policyRevision: 1,
      availability: "available" as const,
      access: "configured" as const,
      snapshotID: "33333333-3333-4333-8333-333333333333",
      generation: 2,
      retrievedAt: "2026-11-05T12:00:00.000Z",
      sourceURL: "https://openrouter.ai/api/v1/models",
      recordID: "openai/reference-model",
      recordIndex: 0,
      freshness: "current" as const,
    },
    coverage: {
      categories: {
        uncachedInput: {
          tokens: 10_000,
          status: "observed" as const,
          rateCoverage: "complete" as const,
        },
        output: { tokens: 1_000, status: "observed" as const, rateCoverage: "complete" as const },
        reasoning: {
          tokens: 0,
          status: "observed" as const,
          rateCoverage: "not-required" as const,
        },
        cacheRead: {
          tokens: 0,
          status: "observed" as const,
          rateCoverage: "not-required" as const,
        },
        cacheWrite: {
          tokens: 0,
          status: "observed" as const,
          rateCoverage: "not-required" as const,
        },
      },
      retries: {
        status: status === "partial" ? ("partial" as const) : ("complete" as const),
        attemptCount: 4,
        failedAttemptCount: 1,
        retryAttemptCount: 1,
        attemptsWithCompleteUsage: status === "partial" ? 3 : 4,
        failedAttemptsWithCompleteUsage: 1,
        retryAttemptsWithCompleteUsage: 1,
      },
      attribution: {
        status: status === "partial" ? ("partial" as const) : ("complete" as const),
        relatedTaskCount: 3,
        unknownRouteTaskCount: status === "partial" ? 1 : 0,
        relatedSessionCount: 4,
        matchedRouteSessionCount: 3,
        includedSessionCount: 3,
        otherRouteSessionCount: 0,
        mixedRouteSessionCount: 0,
        unknownRouteSessionCount: status === "partial" ? 1 : 0,
        sharedSessionCount: 0,
        unattributedSessionCount: 0,
      },
    },
    reasons: status === "partial" ? (["missing-rate"] as const) : [],
  }
  if (status === "exact")
    return ModelDecisionReferenceEstimateSchema.parse({
      ...common,
      status,
      numeratorUSD: 0.0000000000369,
      valueUSDPerAcceptedTask: 0.0000000000123,
    })
  if (status === "conditional")
    return ModelDecisionReferenceEstimateSchema.parse({
      ...common,
      status,
      numeratorRangeUSD: { minimum: 0.00000012, maximum: 0.00000036 },
      rangeUSDPerAcceptedTask: { minimum: 0.00000004, maximum: 0.00000012 },
    })
  return ModelDecisionReferenceEstimateSchema.parse({
    ...common,
    status,
    knownSubtotalUSD: 0.00000015,
    knownSubtotalUSDPerAcceptedTask: 0.00000005,
    coverage: {
      ...common.coverage,
      categories: {
        ...common.coverage.categories,
        cacheWrite: { tokens: null, status: "missing", rateCoverage: "missing" },
      },
    },
  })
}

function reference(
  configurationID: string,
  status: "exact" | "conditional" | "partial",
  tokensPerAcceptedTask: number | null,
): ComparisonChartReference {
  return {
    configurationID,
    label: `Reference ${configurationID}`,
    tokensPerAcceptedTask,
    estimate: referenceEstimate(status),
  }
}

function routedRangeReference(
  configurationID: string,
  route: { providerID: string; modelID: string; variant: string | null },
  tokensPerAcceptedTask = 20_000,
) {
  const entry = reference(configurationID, "conditional", tokensPerAcceptedTask)
  entry.label = `GPT-6 Luna · ${route.providerID} / ${route.modelID}${route.variant ? ` · ${route.variant}` : ""}`
  entry.estimate = ModelDecisionReferenceEstimateSchema.parse({ ...entry.estimate, route })
  return entry
}

function pricedRangeReference(configurationID: string, tokens: number) {
  const entry = reference(configurationID, "partial", tokens)
  entry.estimate = ModelDecisionReferenceEstimateSchema.parse({
    ...entry.estimate,
    knownSubtotalUSD: null,
    knownSubtotalRangeUSD: { minimum: 0.00006, maximum: 0.00015 },
    knownSubtotalUSDPerAcceptedTask: null,
    knownSubtotalRangeUSDPerAcceptedTask: { minimum: 0.00002, maximum: 0.00005 },
  })
  return entry
}

function size(element: object, width: number, height: number) {
  sizes.set(element, { width, height })
}

function renderedBadgeBounds(host: unknown, modelLine: string) {
  type SvgElement = {
    tagName: string
    hasAttribute: (name: string) => boolean
    getAttribute: (name: string) => string | null
  }
  type LabelText = SvgElement & {
    textContent: string | null
    parentElement: { children: ArrayLike<SvgElement> } | null
  }
  const svgHost = host as {
    querySelectorAll: (selector: string) => ArrayLike<LabelText>
  }
  const label = Array.from(svgHost.querySelectorAll("svg text")).find(
    (text) => text.textContent?.trim() === modelLine,
  )
  const background = Array.from(label?.parentElement?.children ?? []).find(
    (shape) => shape.tagName === "path" && shape.hasAttribute("paint-order"),
  )
  if (!background) throw new Error(`No rendered selected badge background for ${modelLine}`)
  const transform = /translate\(\s*([-+\d.]+)[ ,]+([-+\d.]+)/.exec(
    background.getAttribute("transform") ?? "",
  )
  const x = transform?.[1]
  const y = transform?.[2]
  const points = [
    ...(background.getAttribute("d") ?? "").matchAll(
      /[ML]\s*([-+\d.]+)[ ,]+([-+\d.]+)|A\s*[-+\d.]+\s+[-+\d.]+\s+[-+\d.]+\s+[-+\d.]+\s+[-+\d.]+\s+([-+\d.]+)\s+([-+\d.]+)/g,
    ),
  ].map((match) => [Number(match[1] ?? match[3]), Number(match[2] ?? match[4])])
  if (!x || !y || points.length < 2)
    throw new Error(`Unable to read rendered selected badge geometry for ${modelLine}`)
  return {
    left: Number(x) + Math.min(...points.map((point) => point[0]!)),
    right: Number(x) + Math.max(...points.map((point) => point[0]!)),
    bottom: Number(y) + Math.max(...points.map((point) => point[1]!)),
  }
}

function expectSelectedBadgeInsidePlot(
  host: unknown,
  chart: RenderedOption,
  viewport: { width: number; height: number },
  modelLine: string,
) {
  const bounds = renderedBadgeBounds(host, modelLine)
  const grid = chart.grid?.[0]
  const plotLeft = Number(grid?.left ?? 0)
  const plotRight = viewport.width - Number(grid?.right ?? 0)
  const plotBottom = viewport.height - Number(grid?.bottom ?? 0)
  expect(bounds.left).toBeGreaterThanOrEqual(plotLeft - 1)
  expect(bounds.right).toBeLessThanOrEqual(plotRight + 1)
  expect(bounds.bottom).toBeLessThan(plotBottom)
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
  expect(chartHost.getAttribute("aria-label")).toContain("12,345.5 actual tokens per accepted task")
  const descriptionID = chartHost.getAttribute("aria-describedby")
  const description = container.querySelector(`[id="${descriptionID}"]`)
  expect(description?.textContent).toContain("12,345.5 actual tokens per accepted task")
  expect(chartHost.getAttribute("style")).toContain("overflow: hidden")

  const buttonFor = (configurationID: string) =>
    container.querySelector(
      `button[data-configuration-id="${configurationID}"]`,
    ) as unknown as HTMLButtonElement | null
  const exact = points[0]!.configurationID
  expect(buttonFor(exact)?.getAttribute("aria-pressed")).toBe("true")
  expect(buttonFor(exact)?.getAttribute("aria-label")).toContain(
    "12,345.5 actual tokens per accepted task",
  )
  expect(buttonFor(exact)?.getAttribute("aria-label")).toContain(
    "canonical current-market value $0.123456 per accepted task",
  )
  expect(buttonFor(exact)?.getAttribute("aria-label")).toContain(
    "exact route openai / luna-1 · max",
  )
  expect(buttonFor(exact)?.getAttribute("title")).toContain("1 accepted task · OpenRouter")
  buttonFor(exact)?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  expect(selections).toEqual([exact])

  chart.dispatchAction({ type: "showTip", seriesIndex: 0, dataIndex: 0 })
  const pointTooltip = () =>
    Array.from(chartHost.children).find((child) => {
      if (child.tagName !== "DIV") return false
      const style = dom.getComputedStyle(
        child as unknown as Parameters<typeof dom.getComputedStyle>[0],
      )
      return (
        style.position === "absolute" &&
        style.display === "block" &&
        style.visibility !== "hidden" &&
        style.opacity !== "0" &&
        child.textContent?.includes("≈$0.123 / accepted task") === true
      )
    })
  await until(() => pointTooltip() !== undefined)
  expect(pointTooltip()?.textContent).toContain("12.3K tokens")
  expect(pointTooltip()?.textContent).not.toContain("0.123456")

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

test("reference-only SVG keeps scalar, conditional interval and subtotal marks honest and selectable", async () => {
  const container = dom.document.createElement("main")
  dom.document.body.append(container)
  const scalar = reference("reference:scalar", "exact", 12_000)
  const conditional = reference("reference:conditional", "conditional", 18_000)
  conditional.label = "GPT-6 Luna · openai / reference-model · high"
  const subtotal = reference("reference:subtotal", "partial", 24_000)
  const subtotalRange = reference("reference:subtotal-range", "partial", 30_000)
  subtotalRange.estimate = ModelDecisionReferenceEstimateSchema.parse({
    ...subtotalRange.estimate,
    knownSubtotalUSD: null,
    knownSubtotalRangeUSD: { minimum: 0.00006, maximum: 0.00015 },
    knownSubtotalUSDPerAcceptedTask: null,
    knownSubtotalRangeUSDPerAcceptedTask: { minimum: 0.00002, maximum: 0.00005 },
  })
  const missingCoordinate = reference("reference:missing-token-coordinate", "partial", null)
  const references = [scalar, conditional, subtotal, subtotalRange, missingCoordinate]
  const selections: string[] = []
  const [selected, setSelected] = browser.createSignal<string | null>(null)
  const dispose = browser.render(
    () =>
      browser.createComponent(browser.ComparisonChart, {
        points: [],
        references,
        frontierConfigurationIDs: references.map((entry) => entry.configurationID),
        get selectedConfigurationID() {
          return selected()
        },
        theme,
        onSelect: (configurationID: string) => {
          selections.push(configurationID)
          setSelected(configurationID)
        },
      }),
    container as unknown as HTMLElement,
  )
  cleanups.push(dispose)
  await until(() => container.querySelector("[xmlns='http://www.w3.org/2000/svg']") !== null)
  const host = container.querySelector("[role='img']") as unknown as HTMLElement
  const chart = browser.getComparisonChartInstance(host)!
  const rendered = chart.getOption() as unknown as RenderedOption
  const series = (id: string) => rendered.series?.find((entry) => entry.id === id)
  expect(series("observations")?.data).toEqual([])
  expect(series("authoritative-frontier")?.data).toEqual([])
  expect(series("openrouter-reference-scalars")?.data).toMatchObject([
    {
      value: [12_000, 0.0000000000123],
      configurationID: scalar.configurationID,
    },
  ])
  expect(series("openrouter-conditional-ranges")?.data).toMatchObject([
    {
      value: [18_000, 0.00000004, 0.00000012],
      configurationID: conditional.configurationID,
    },
  ])
  expect(series("openrouter-reference-subtotals")?.data).toMatchObject([
    {
      value: [24_000, 0.00000005],
      configurationID: subtotal.configurationID,
    },
  ])
  expect(series("openrouter-subtotal-ranges")?.data).toMatchObject([
    {
      value: [30_000, 0.00002, 0.00005],
      configurationID: subtotalRange.configurationID,
    },
  ])
  expect(
    rendered.series
      ?.flatMap((entry) => entry.data ?? [])
      .some(
        (datum) =>
          !Array.isArray(datum) && datum.configurationID === missingCoordinate.configurationID,
      ),
  ).toBe(false)
  expect(container.querySelectorAll("svg path").length).toBeGreaterThan(0)
  expect(host.getAttribute("aria-label")).toContain("OpenRouter model catalog scalar reference")
  expect(host.getAttribute("aria-label")).toContain("conditional range")
  expect(host.getAttribute("aria-label")).toContain("remainder unknown")
  expect(container.querySelector("[aria-label='Chart mark legend']")?.textContent).toContain(
    "Catalog",
  )
  expect(container.querySelector("[aria-label='Chart mark legend']")?.textContent).toContain(
    "Range",
  )
  expect(container.querySelector("[aria-label='Chart mark legend']")?.textContent).toContain(
    "Priced portion",
  )
  expect(
    container
      .querySelector("[aria-label='Chart mark legend']")
      ?.querySelector("[aria-label='OpenRouter model catalog reference estimate']"),
  ).not.toBeNull()
  expect(
    container
      .querySelector("[aria-label='Chart mark legend']")
      ?.querySelector("[aria-label='Priced portion; total and remainder unknown']"),
  ).not.toBeNull()
  expect(container.querySelector("[aria-label='Chart mark legend']")?.textContent).not.toContain(
    "Canonical actual-cohort",
  )

  const disclosure = container.querySelector(
    ".lazers-models-comparison-chart-data",
  ) as unknown as HTMLDetailsElement
  expect(disclosure.querySelector("summary")?.textContent).toContain("Chart data")
  disclosure.open = true
  const buttonFor = (configurationID: string) =>
    container.querySelector(
      `button[data-configuration-id="${configurationID}"]`,
    ) as unknown as HTMLButtonElement
  const conditionalButton = buttonFor(conditional.configurationID)
  expect(conditionalButton.tagName).toBe("BUTTON")
  expect(conditionalButton.tabIndex).toBe(0)
  expect(conditionalButton.getAttribute("aria-pressed")).toBe("false")
  expect(conditionalButton.getAttribute("aria-label")).toContain(
    "OpenRouter model catalog conditional range",
  )
  expect(conditionalButton.getAttribute("aria-label")).toContain(
    "exact route openai / reference-model · high",
  )
  expect(conditionalButton.getAttribute("title")).toContain("GPT-6 Luna")
  expect(conditionalButton.getAttribute("title")).toContain("conditional range")
  expect(conditionalButton.getAttribute("title")).toContain("3 accepted tasks")
  conditionalButton.focus()
  expect((dom.document.activeElement as unknown) === (conditionalButton as unknown)).toBe(true)
  conditionalButton.click()
  expect(selections).toEqual([conditional.configurationID])
  await until(() => buttonFor(conditional.configurationID).getAttribute("aria-pressed") === "true")
  const selectedRangeLabels = () =>
    Array.from(host.querySelectorAll("svg text")).some((label) =>
      label.textContent?.includes("GPT-6 Luna"),
    ) &&
    Array.from(host.querySelectorAll("svg text")).some((label) =>
      label.textContent?.includes("high"),
    )
  await until(() => selectedRangeLabels())
  expect(selectedRangeLabels()).toBe(true)
  expect(
    (chart.getOption() as unknown as RenderedOption).series
      ?.find((entry) => entry.id === "selected-identities")
      ?.data?.some(
        (datum) => !Array.isArray(datum) && datum.configurationID === conditional.configurationID,
      ),
  ).toBe(true)
  expect(buttonFor(missingCoordinate.configurationID).getAttribute("aria-label")).toContain(
    "Not plotted",
  )

  const visibleTooltip = (text: string) =>
    Array.from(host.children).find((child) => {
      if (child.tagName !== "DIV") return false
      const style = dom.getComputedStyle(
        child as unknown as Parameters<typeof dom.getComputedStyle>[0],
      )
      return (
        style.position === "absolute" &&
        style.display === "block" &&
        style.visibility !== "hidden" &&
        style.opacity !== "0" &&
        child.textContent?.includes(text) === true
      )
    })
  const scalarSeries = rendered.series?.findIndex(
    (entry) => entry.id === "openrouter-reference-scalars",
  )
  chart.dispatchAction({ type: "showTip", seriesIndex: scalarSeries, dataIndex: 0 })
  await until(() => visibleTooltip("scalar reference") !== undefined)
  expect(visibleTooltip("scalar reference")?.textContent).toContain("≈$1.23e-11 / accepted task")
  expect(visibleTooltip("scalar reference")?.textContent).toContain("3 accepted tasks")
  expect(visibleTooltip("scalar reference")?.textContent).toContain("OpenRouter")
  expect(visibleTooltip("scalar reference")?.textContent).not.toMatch(/\$0\.00(?:\s|$)/)
  const rangeSeries = rendered.series?.findIndex(
    (entry) => entry.id === "openrouter-conditional-ranges",
  )
  chart.dispatchAction({ type: "showTip", seriesIndex: rangeSeries, dataIndex: 0 })
  await until(() => visibleTooltip("conditional range") !== undefined)
  expect(visibleTooltip("conditional range")?.textContent).toContain(
    "≈$4e-8–$1.2e-7 / accepted task",
  )
  expect(visibleTooltip("conditional range")?.textContent).toContain(
    "GPT-6 Luna · high · exact route openai / reference-model · high",
  )
  const subtotalSeries = rendered.series?.findIndex(
    (entry) => entry.id === "openrouter-reference-subtotals",
  )
  chart.dispatchAction({ type: "showTip", seriesIndex: subtotalSeries, dataIndex: 0 })
  await until(() => visibleTooltip("priced portion") !== undefined)
  expect(visibleTooltip("priced portion")?.textContent).toContain("total unknown")
  expect(visibleTooltip("priced portion")?.textContent).toContain("3 accepted tasks")
  const subtotalRangeSeries = rendered.series?.findIndex(
    (entry) => entry.id === "openrouter-subtotal-ranges",
  )
  chart.dispatchAction({ type: "showTip", seriesIndex: subtotalRangeSeries, dataIndex: 0 })
  await until(() => visibleTooltip("priced portion range") !== undefined)
  expect(visibleTooltip("priced portion range")?.textContent).toContain(
    "≈$0.00002–$0.00005 priced portion / accepted task",
  )
  expect(visibleTooltip("priced portion range")?.textContent).toContain("total unknown")
})

test("selected Luna ranges use readable model-effort labels and retain exact route and mark identity", async () => {
  const host = dom.document.createElement("div")
  host.style.fontSize = "20px"
  dom.document.body.append(host)
  size(host, 330, 190)
  const selections: string[] = []
  const adapter = new browser.ComparisonChartAdapter(host as unknown as HTMLElement, (id) =>
    selections.push(id),
  )
  const observer = TestResizeObserver.instances.at(-1)!
  const routes = [
    { providerID: "openai", modelID: "gpt-6-luna", variant: "max" },
    { providerID: "openrouter", modelID: "openai/gpt-6-luna", variant: "max" },
  ] as const
  const references = routes.map((route, index) =>
    routedRangeReference(`global:route-${index}`, route, index === 0 ? 0 : 20_000),
  )
  const viewports = [
    { width: 330, height: 190 },
    { width: 450, height: 230 },
    { width: 960, height: 320 },
  ]
  const svgLabelTexts = () =>
    Array.from(host.querySelectorAll("svg text")).map((label) => label.textContent?.trim() ?? "")
  const normalizedSvgLabelTexts = () =>
    svgLabelTexts().map((label) => label.replace(/\s+/g, " ").trim())
  const option = () => adapter.chart.getOption() as unknown as RenderedOption
  const visibleTooltip = (routeLabel: string) =>
    Array.from(host.children).find((child) => {
      if (child.tagName !== "DIV") return false
      const style = dom.getComputedStyle(child)
      return (
        style.position === "absolute" &&
        style.display === "block" &&
        style.visibility !== "hidden" &&
        style.opacity !== "0" &&
        child.textContent?.includes(routeLabel) === true
      )
    })

  try {
    for (const viewport of viewports) {
      size(host, viewport.width, viewport.height)
      observer.trigger()
      await until(() => host.querySelector("svg")?.getAttribute("width") === String(viewport.width))

      for (const [index, reference] of references.entries()) {
        adapter.update(
          {
            points: [],
            references,
            frontierConfigurationIDs: [],
            selectedConfigurationID: reference.configurationID,
          },
          theme,
        )
        const selectedName = () =>
          option()
            .series?.find((series) => series.id === "selected-identities")
            ?.data?.find(
              (datum) =>
                !Array.isArray(datum) && datum.configurationID === reference.configurationID,
            )
        const expectedAlignment = index === 0 ? "left" : "right"
        await until(() => {
          const datum = selectedName()
          return (
            !Array.isArray(datum) &&
            typeof datum?.name === "string" &&
            normalizedSvgLabelTexts().some((label) => label.includes("GPT-6 Luna")) &&
            normalizedSvgLabelTexts().includes(datum.label?.formatter?.split("\n")[1] ?? "") &&
            datum.configurationID === reference.configurationID
          )
        })
        const datum = selectedName()
        if (!datum || Array.isArray(datum)) throw new Error("Expected a selected model label")
        const visibleLabel = datum.name!
        expect(visibleLabel).toBe("GPT-6 Luna · max")
        expect(visibleLabel).not.toMatch(/[pme]:/)
        expect(normalizedSvgLabelTexts().some((label) => label.includes("GPT-6 Luna"))).toBe(true)
        const [visibleModelLine, visibleEffortLine] = datum.label?.formatter?.split("\n") ?? []
        expect(visibleModelLine).toContain("GPT-6 Luna")
        expect(visibleEffortLine).toBeTruthy()
        expect(visibleEffortLine?.length).toBeLessThanOrEqual(18)
        expect(normalizedSvgLabelTexts()).toContain(visibleEffortLine!)
        expect(datum).toMatchObject({
          configurationID: reference.configurationID,
          markKind: "selected-identity",
          value: [index === 0 ? 0 : 20_000, 0.00000008],
        })
        expect(datum.label?.position).toBe("top")
        expect(datum.label?.align).toBe(expectedAlignment)
        expectSelectedBadgeInsidePlot(host, option(), viewport, visibleModelLine!)

        const rangeData = option()
          .series?.find((series) => series.id === "openrouter-conditional-ranges")
          ?.data?.find(
            (entry) => !Array.isArray(entry) && entry.configurationID === reference.configurationID,
          )
        expect(rangeData).toMatchObject({
          configurationID: reference.configurationID,
          value: [index === 0 ? 0 : 20_000, 0.00000004, 0.00000012],
          markKind: "reference",
        })

        const route = routes[index]!
        const exactRoute = `${route.providerID} / ${route.modelID} · ${route.variant}`
        const rangeSeriesIndex = option().series?.findIndex(
          (series) => series.id === "openrouter-conditional-ranges",
        )
        adapter.chart.dispatchAction({
          type: "showTip",
          seriesIndex: rangeSeriesIndex,
          dataIndex: index,
        })
        await until(() => visibleTooltip(exactRoute) !== undefined)
        expect(visibleTooltip(exactRoute)?.textContent).toContain("GPT-6 Luna · max")
        expect(visibleTooltip(exactRoute)?.textContent).toContain(`exact route ${exactRoute}`)

        const chartEvents = adapter.chart as unknown as {
          trigger: (event: string, payload: unknown) => void
        }
        chartEvents.trigger("click", { data: { configurationID: reference.configurationID } })
        expect(selections.at(-1)).toBe(reference.configurationID)
      }
    }
  } finally {
    adapter.dispose()
  }
})

test("rendered priced-portion legend uses only the supplied scalar and range keys", async () => {
  const scalar = reference("legend-scalar", "partial", 12_000)
  const range = pricedRangeReference("legend-range", 24_000)
  const cases = [
    { references: [scalar], scalarKey: 1, rangeKey: 0 },
    { references: [range], scalarKey: 0, rangeKey: 1 },
    { references: [scalar, range], scalarKey: 1, rangeKey: 1 },
  ]

  for (const entry of cases) {
    const container = dom.document.createElement("main")
    dom.document.body.append(container)
    const dispose = browser.render(
      () =>
        browser.createComponent(browser.ComparisonChart, {
          points: [],
          references: entry.references,
          frontierConfigurationIDs: [],
          selectedConfigurationID: null,
          theme,
          onSelect: () => {},
        }),
      container as unknown as HTMLElement,
    )
    cleanups.push(dispose)
    await until(() => container.querySelector("[aria-label='Chart mark legend']") !== null)
    const legend = container.querySelector("[aria-label='Chart mark legend']")!
    expect(legend.textContent).toContain("Priced portion")
    expect(
      legend.querySelector("[aria-label='Priced portion; total and remainder unknown']"),
    ).not.toBeNull()
    expect(legend.querySelectorAll(".lazers-models-chart-key-subtotal")).toHaveLength(
      entry.scalarKey,
    )
    expect(legend.querySelectorAll(".lazers-models-chart-key-subtotal-range")).toHaveLength(
      entry.rangeKey,
    )
    expect(legend.querySelectorAll("li")).toHaveLength(1)
  }
})

test("rendered ECharts resize recomputes axis spacing for 330–450px and wide hosts at larger fonts", async () => {
  const host = dom.document.createElement("div")
  host.style.fontSize = "20px"
  dom.document.body.append(host)
  size(host, 330, 190)
  const longEffort = `preview-effort-${"x".repeat(512 - "preview-effort-".length)}`
  const crowdedPoints = [
    {
      ...points[0]!,
      configurationID: "crowded:selected-kimi",
      label: "Kimi K2.5",
      route: { providerID: "moonshotai", modelID: "kimi-k2.5", variant: "thinking" },
      tokensPerAcceptedTask: 20_000,
      currentMarketUSDPerAcceptedTask: 0.1,
    },
    {
      ...points[1]!,
      configurationID: "crowded:nearby-qwen",
      label: "Qwen 7",
      route: {
        providerID: "qwen",
        modelID: "qwen-7",
        variant: longEffort,
      },
      tokensPerAcceptedTask: 20_001,
      currentMarketUSDPerAcceptedTask: 0.000001,
    },
  ]
  const selections: string[] = []
  const adapter = new browser.ComparisonChartAdapter(host as unknown as HTMLElement, (id) =>
    selections.push(id),
  )
  const observer = TestResizeObserver.instances.at(-1)!
  const referenceID = "global:reference-range"
  try {
    adapter.update(
      {
        points: crowdedPoints,
        references: [reference(referenceID, "conditional", 20_000)],
        frontierConfigurationIDs: [crowdedPoints[0]!.configurationID],
        selectedConfigurationID: crowdedPoints[1]!.configurationID,
      },
      theme,
    )
    const svg = () =>
      host.querySelector("svg") as unknown as {
        getAttribute: (name: string) => string | null
        textContent: string | null
      } | null
    const option = () => adapter.chart.getOption() as unknown as RenderedOption
    const tickLabels = () =>
      Array.from(host.querySelectorAll("svg text")).map((label) => label.textContent?.trim() ?? "")
    expect(svg()?.getAttribute("width")).toBe("330")
    expect(svg()?.getAttribute("height")).toBe("190")
    expect(svg()?.textContent).toContain("Tokens / accepted task")
    expect(svg()?.textContent).toContain("USD / task")
    const renderedLabels = () =>
      Array.from(host.querySelectorAll("svg text")).map(
        (label) => label.textContent?.replace(/\s+/g, " ").trim() ?? "",
      )
    const renderedLabelText = renderedLabels().join(" ")
    expect(renderedLabelText).toContain("Kimi K2.5")
    expect(renderedLabelText).toContain("thinking")
    expect(renderedLabelText).toContain("Qwen 7")
    expect(renderedLabelText).toContain("preview")
    const narrow = option()
    expect(narrow.xAxis?.[0]?.splitNumber).toBe(2)
    expect(narrow.yAxis?.[0]?.splitNumber).toBe(2)
    expect(narrow.xAxis?.[0]?.axisLabel?.fontSize).toBe(20)
    expect(narrow.yAxis?.[0]?.axisLabel?.fontSize).toBe(20)
    expect(narrow.grid?.[0]?.left).toBeGreaterThan(72)
    expect(narrow.yAxis?.[0]?.axisLabel?.hideOverlap).toBe(true)
    expect(narrow.yAxis?.[0]?.axisLabel?.formatter?.(0.0000000000123)).toBe("$1.23e-11")
    expect(narrow.yAxis?.[0]?.name).toBe("USD / task")
    expect(tickLabels().filter((label) => label.startsWith("$")).length).toBeGreaterThanOrEqual(2)

    const qwenID = crowdedPoints[1]!.configurationID
    const selectedQwen = () =>
      option()
        .series?.find((series) => series.id === "selected-identities")
        ?.data?.find((datum) => !Array.isArray(datum) && datum.configurationID === qwenID)
    const selectedQwenLabel = selectedQwen()
    if (!selectedQwenLabel || Array.isArray(selectedQwenLabel))
      throw new Error("Expected the selected Qwen identity mark")
    expect(selectedQwenLabel.name).toContain(longEffort)
    expect(selectedQwenLabel.label?.position).toBe("top")
    expect(selectedQwenLabel.label?.distance).toBe(6)
    const badgeText = selectedQwenLabel.label?.formatter ?? ""
    const [badgeModel, badgeEffort] = badgeText.split("\n")
    expect(badgeText.length).toBeLessThanOrEqual(37)
    expect(badgeModel).toContain("Qwen 7")
    expect(badgeEffort).toMatch(/^preview/)
    expect(badgeEffort?.length).toBeLessThanOrEqual(18)
    const svgText = Array.from(host.querySelectorAll("svg text"))
    expect(svgText.some((text) => text.textContent?.includes(badgeModel ?? ""))).toBe(true)
    expect(svgText.some((text) => text.textContent?.includes(badgeEffort ?? ""))).toBe(true)
    const textBaseline = (text: (typeof svgText)[number]) => {
      const translatedY = text
        .getAttribute("transform")
        ?.match(/translate\(\s*[-+\d.]+[ ,]+([-+\d.]+)/)?.[1]
      return Number(translatedY ?? 0) + Number(text.getAttribute("y") ?? 0)
    }
    const assertSelectedBadgeClearsXAxis = () => {
      const currentText = Array.from(host.querySelectorAll("svg text"))
      const selected = selectedQwen()
      const formatter =
        selected && !Array.isArray(selected) ? (selected.label?.formatter ?? "") : ""
      const [currentModel, currentEffort] = formatter.split("\n")
      expect(currentModel).toContain("Qwen 7")
      expect(currentEffort).toMatch(/^preview/)
      expect(currentEffort?.length).toBeLessThanOrEqual(18)
      const badgeBaselines = currentText
        .filter((text) => [currentModel, currentEffort].includes(text.textContent?.trim()))
        .map(textBaseline)
      const xAxisTickBaselines = currentText
        .filter((text) => /^(?:0|\d+(?:\.\d+)?K)$/.test(text.textContent?.trim() ?? ""))
        .map(textBaseline)
      expect(badgeBaselines.length).toBeGreaterThanOrEqual(2)
      expect(xAxisTickBaselines.length).toBeGreaterThanOrEqual(2)
      expect(Math.min(...xAxisTickBaselines) - Math.max(...badgeBaselines)).toBeGreaterThan(20)
    }
    assertSelectedBadgeClearsXAxis()

    size(host, 450, 230)
    observer.trigger()
    await until(() => svg()?.getAttribute("width") === "450")
    const medium = option()
    expect(medium.xAxis?.[0]?.splitNumber).toBeGreaterThan(narrow.xAxis?.[0]?.splitNumber ?? 0)
    expect(svg()?.textContent).toContain("Tokens / accepted task")
    assertSelectedBadgeClearsXAxis()
    expectSelectedBadgeInsidePlot(host, medium, { width: 450, height: 230 }, badgeModel!)

    size(host, 960, 320)
    observer.trigger()
    await until(() => svg()?.getAttribute("width") === "960")
    const wide = option()
    expect(wide.xAxis?.[0]?.splitNumber).toBeGreaterThan(medium.xAxis?.[0]?.splitNumber ?? 0)
    expect(wide.yAxis?.[0]?.splitNumber).toBeGreaterThan(narrow.yAxis?.[0]?.splitNumber ?? 0)
    expect(wide.xAxis?.[0]?.axisLabel?.fontSize).toBe(20)
    expect(wide.yAxis?.[0]?.name).toBe("USD / accepted task")
    expect(svg()?.getAttribute("height")).toBe("320")
    expect(tickLabels().filter((label) => label.startsWith("$")).length).toBeGreaterThanOrEqual(2)
    assertSelectedBadgeClearsXAxis()

    const chartEvents = adapter.chart as unknown as {
      trigger: (event: string, payload: unknown) => void
    }
    chartEvents.trigger("click", { data: { configurationID: referenceID } })
    const observationsIndex = option().series?.findIndex((series) => series.id === "observations")
    const qwenDataIndex = option()
      .series?.find((series) => series.id === "observations")
      ?.data?.findIndex((datum) => !Array.isArray(datum) && datum.configurationID === qwenID)
    adapter.chart.dispatchAction({
      type: "showTip",
      seriesIndex: observationsIndex,
      dataIndex: qwenDataIndex,
    })
    const fullRouteTooltip = () =>
      Array.from(host.children).find(
        (child) => child.tagName === "DIV" && child.textContent?.includes(longEffort),
      )
    await until(() => fullRouteTooltip() !== undefined)
    expect(fullRouteTooltip()?.textContent).toContain(`exact route qwen / qwen-7 · ${longEffort}`)
    chartEvents.trigger("click", { data: { configurationID: qwenID } })
    expect(selections).toEqual([referenceID, qwenID])
  } finally {
    adapter.dispose()
  }
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
  const shortLabel = `${Array.from(label).slice(0, 35).join("")}…`
  const adapter = new browser.ComparisonChartAdapter(host as unknown as HTMLElement, () => {})
  try {
    const { route: _route, ...pointWithoutRoute } = points[0]!
    adapter.update(
      { points: [{ ...pointWithoutRoute, label }], frontierConfigurationIDs: [] },
      theme,
    )
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
          child.textContent?.includes(shortLabel) === true
        )
      })
    await until(() => visibleTooltip() !== undefined)
    const tooltip = visibleTooltip()
    expect(tooltip).toBeDefined()
    expect(dom.getComputedStyle(tooltip!).display).toBe("block")
    expect(tooltip!.textContent).toContain(shortLabel)
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
    expect(setOptions).toBe(3)
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
    expect(setOptions).toBe(3)
    expect(resizes).toBe(3)
    adapter.dispose()
    expect(observer.disconnected).toBe(1)
  } finally {
    adapter.dispose()
    Reflect.set(window, "addEventListener", originalAdd)
    Reflect.set(window, "removeEventListener", originalRemove)
  }
})
