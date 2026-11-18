import { expect, test } from "bun:test"
import { Window } from "happy-dom"
import solid from "vite-plugin-solid"
import { build } from "vite"
import { mkdir, rm } from "node:fs/promises"
import { fileURLToPath, pathToFileURL } from "node:url"
import { ObservationChangeTracker } from "../../src/observability/changes.ts"
import { ObservationReads } from "../../src/observability/read.ts"
import type { TrajectoryHost } from "../../src/trajectory/native.ts"
import { makeFixture, taskID } from "../trajectory/fixture.ts"
import {
  lz137Route,
  lz137ValuationProvider,
  prepareLz137RetainedData,
} from "./lz137-market-fixture.ts"

const outputDirectory = fileURLToPath(
  new URL("../../node_modules/.cache/targeted-trajectory-dom-test", import.meta.url),
)
const cursorSecret = new Uint8Array(32).fill(31)

async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 150 && !predicate(); attempt++)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  expect(predicate()).toBe(true)
}

test("a task target renders its scoped report timeline without a broad snapshot", async () => {
  const fixture = makeFixture()
  prepareLz137RetainedData(fixture)
  const dom = new Window({ url: "https://targeted-trajectory.localhost" })
  Object.defineProperty(dom.window, "innerWidth", { configurable: true, value: 360 })
  const globalNames = [
    "window",
    "document",
    "Node",
    "Element",
    "HTMLElement",
    "HTMLButtonElement",
    "HTMLDivElement",
    "HTMLDetailsElement",
    "Document",
    "DocumentFragment",
    "Text",
    "Event",
    "MouseEvent",
    "KeyboardEvent",
    "PointerEvent",
    "MutationObserver",
    "customElements",
    "navigator",
    "location",
    "getComputedStyle",
    "requestAnimationFrame",
    "cancelAnimationFrame",
  ] as const
  const previousGlobals = new Map<string, PropertyDescriptor | undefined>()
  for (const name of globalNames) {
    previousGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: (dom as unknown as Record<string, unknown>)[name],
    })
  }
  const previousResizeObserver = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver")
  const browserDocument = dom.document as unknown as Document
  class TestResizeObserver {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element) {
      this.callback(
        [{ contentRect: { width: 220 } } as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      )
      void target
    }
    disconnect() {}
    unobserve() {}
  }
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: TestResizeObserver,
  })

  let disposeSetup: (() => void) | undefined
  let disposePanel: (() => void) | undefined
  let snapshotCalls = 0
  let historyCalls = 0
  let latestHistoryReport: Record<string, unknown> | undefined
  let forcedHistoryLimit: number | undefined
  let expireContinuations = false
  try {
    const guiRoot = fileURLToPath(new URL("../../src/gui.tsx", import.meta.url))
    const entry = fileURLToPath(
      new URL("../observation-panels/fixtures/trajectory-dom-entry.ts", import.meta.url),
    )
    await rm(outputDirectory, { recursive: true, force: true })
    await mkdir(outputDirectory, { recursive: true })
    const inferenceRuntimeModule = "\0lazers-targeted-render-unused-inference-runtime"
    let replacedInferenceRuntime = false
    await build({
      configFile: false,
      resolve: { conditions: ["browser", "development", "module"] },
      define: { __LAZERS_RADAR_WORKER_SOURCE__: JSON.stringify("") },
      plugins: [
        solid(),
        {
          name: "targeted-render-unused-inference-runtime",
          enforce: "pre",
          resolveId(source, importer) {
            if (source !== "./webgpu/runtime.ts" || importer !== guiRoot) return
            replacedInferenceRuntime = true
            return inferenceRuntimeModule
          },
          load(id) {
            if (id !== inferenceRuntimeModule) return
            return `export function createInferenceRuntime() {
              throw new Error("The inference runtime is not used by this Trajectory panel test")
            }`
          },
        },
      ],
      build: {
        outDir: outputDirectory,
        emptyOutDir: true,
        minify: false,
        lib: { entry, formats: ["es"], fileName: "targeted-trajectory-dom-test" },
        rolldownOptions: { output: { codeSplitting: false } },
      },
    })

    const {
      gui,
      createReactiveStore,
      createTestUI,
      registryTokens,
      setupGui,
      trajectoryPanelRegistration,
      mountTrajectoryPanel,
      trajectoryViewCache,
    } = await import(pathToFileURL(`${outputDirectory}/targeted-trajectory-dom-test.js`).href)
    expect(replacedInferenceRuntime).toBe(true)

    const marketRoute = lz137Route
    const marketModel = {
      providerID: marketRoute.providerID,
      id: marketRoute.modelID,
      variant: marketRoute.variant,
    }
    const host: TrajectoryHost = {
      session: async (id) => {
        const session = await fixture.host.session(id)
        if (!session) return null
        if (id !== "ses-failed") return session
        return {
          ...session,
          model: marketModel,
          messages: session.messages?.map((message) => {
            const record = message as { model?: unknown }
            return record.model ? { ...message, model: marketModel } : message
          }) as never,
        }
      },
      status: async (id) => {
        const session = fixture.sessions.get(id)
        return session
          ? { ...session, messages: null, messageStatus: "not-read", messageError: null }
          : null
      },
    }
    const taskValuationProvider = lz137ValuationProvider({ withStrictOpenCodePrice: true })
    const tracker = new ObservationChangeTracker(fixture.repository, cursorSecret, "project")
    tracker.initialize()
    fixture.store.atomic((db) =>
      db
        .query(
          `INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at)
           SELECT ?,NULL,1,'UNRELATED','{}',5000+CAST(key AS INTEGER) FROM json_each(?)`,
        )
        .run(fixture.receipt.planID, JSON.stringify(Array.from({ length: 10_001 }, (_, i) => i))),
    )
    const reads = new ObservationReads(
      fixture.store,
      host,
      "project",
      cursorSecret,
      undefined,
      taskValuationProvider,
    )
    // S8-2: bounded broad history does not change the panel's targeted-only reads.
    const snapshot = reads.snapshot({ kind: "project", sessionID: "ses-owner" }, tracker)
    expect(snapshot.transitions).toHaveLength(10_000)
    expect(snapshot.coverage?.transitionsTruncated).toBe(true)
    const reference = fixture.repository.referenceFor(taskID)!
    const target = {
      requestID: "targeted-render-request",
      taskID,
      reference,
      projectID: "project",
      projectDirectory: fixture.directory,
    }
    const client = {
      location: {
        get: async () => ({ project: { canonical: fixture.directory, id: "project" } }),
      },
      rpc: () => ({
        snapshot: async (input: { scope: Parameters<typeof reads.snapshot>[0] }) => {
          snapshotCalls++
          return reads.snapshot(input.scope, tracker)
        },
        trajectory: async (input: {
          scope: Parameters<typeof reads.trajectory>[0]["scope"]
          taskID: string
          limit: number
          cursor?: string
        }) => {
          return reads.trajectory(input, tracker)
        },
        trajectoryHistory: async (input: {
          scope: Parameters<typeof reads.trajectoryHistory>[0]["scope"]
          taskID: string
          limit: number
          cursor?: string
        }) => {
          historyCalls++
          if (input.cursor && expireContinuations)
            throw {
              type: "trajectory_history_unavailable",
              message: "Trajectory history expired; recapture explicitly",
              data: { reason: "expired", recovery: "recapture" },
            }
          const response = await reads.trajectoryHistory(
            { ...input, limit: forcedHistoryLimit ?? input.limit },
            tracker,
          )
          latestHistoryReport = response.report
          return response
        },
        trajectoryStatus: async (input: Parameters<typeof reads.trajectoryStatus>[0]) =>
          reads.trajectoryStatus(input, tracker),
      }),
      event: {
        subscribe: ({ signal }: { signal: AbortSignal }) =>
          (async function* () {
            if (!signal.aborted)
              await new Promise<void>((resolve) =>
                signal.addEventListener("abort", () => resolve(), { once: true }),
              )
            if (!signal.aborted) yield { type: "server.connected" }
          })(),
      },
    }
    const trajectoryStore = createReactiveStore({
      projects: {
        [fixture.directory]: {
          scope: "project",
          selectedTaskID: taskID,
          selectedReference: reference,
          target,
          selectedKind: "",
          selectedRecordID: "",
          split: 56,
        },
      },
    })
    const modelsStore = createReactiveStore({ projects: {} })
    const registrations: Array<{ token: unknown; value: unknown }> = []
    const session = {
      id: "ses-owner",
      location: { directory: fixture.directory },
      directory: fixture.directory,
      server: { id: "targeted-render-server", connected: true, client },
    }
    const context = {
      id: "lazers",
      app: { platform: "web" },
      signal: new AbortController().signal,
      ui: createTestUI(),
      appearance: { mode: () => "dark", font: () => "monospace" },
      add: (token: unknown, value: unknown) => registrations.push({ token, value }),
      sessions: { current: () => session, list: () => [session] },
      layout: { open: () => {} },
      stores: {
        modelsView: () => modelsStore,
        trajectoryView: () => trajectoryStore,
      },
      tabs: { open: () => {} },
      screen: {
        file: {
          resolve: (path: string) => path,
          absolute: () => false,
          selection: { set: () => {} },
        },
      },
      links: { open: () => {} },
      system: { copy: async () => {} },
    }
    disposeSetup = setupGui(gui, context)
    const panel = trajectoryPanelRegistration(registrations)
    expect(registrations.some((entry) => entry.token === registryTokens.Panel)).toBe(true)
    expect(panel).toBeDefined()
    const container = browserDocument.createElement("main")
    browserDocument.body.append(container)
    const mounted = mountTrajectoryPanel(panel!, context, session, container)
    disposePanel = mounted.dispose

    await until(
      () =>
        container.querySelector(".lazers-trajectory-heading")?.textContent ===
          fixture.repository.get(taskID)!.proposal.objective &&
        container.querySelectorAll(".lazers-trajectory-attempt").length === 2 &&
        container.querySelectorAll(".lazers-trajectory-check-marker").length > 0,
    )
    expect(snapshotCalls).toBe(0)
    expect(historyCalls).toBeGreaterThan(0)
    const costCell = container.querySelector(".lazers-trajectory-cost")
    const costRow = costCell?.getAttribute("title") ?? ""
    expect(latestHistoryReport).toMatchObject({
      effort: {
        recordedCost: { apiEquivalentTotalUsd: 0.03197324 },
        marketEquivalentCost: {
          observedUsageEstimate: { valueUSD: 0.01598662 },
        },
      },
    })
    expect(costRow).toContain("Current-market observed-usage estimate")
    expect(costRow).toContain("$0.01598662 estimate")
    expect(costRow).not.toContain("$0.03197324")
    // The cell shows a short value over a muted label; the exact figure sits in its tooltip.
    expect(costCell?.querySelector("b")?.textContent).toBe("$0.016")
    expect(costCell?.querySelector("span")?.textContent).toBe("market cost")
    // The summary names the price source and date; generation and freshness sit behind the disclosure.
    expect(container.querySelector(".lazers-trajectory-coverage")?.textContent).toMatch(
      /^OpenRouter prices · \w+ \d+$/,
    )
    expect(container.querySelector(".lazers-trajectory-valuation")?.textContent).toContain(
      "OpenRouter · generation 5 · average · current freshness",
    )
    expect(container.textContent).not.toMatch(/Unix ms|unknown|not recorded|unavailable/i)
    // One row for pricing and estimate details, summarised by source and date.
    const valuation = container.querySelectorAll(".lazers-trajectory-valuation")
    expect(valuation).toHaveLength(1)
    expect(valuation[0]!.querySelector("summary")?.textContent).toMatch(
      /^Estimate basis and prices\s*OpenRouter · \w+ \d+$/,
    )
    expect(valuation[0]!.textContent).toContain("Retained calls · 19")
    expect(container.textContent).not.toContain("Pricing coverage and provenance")
    // The timeline opens fitted: no horizontal scroll until the person zooms in.
    expect(container.querySelector(".lazers-trajectory-scroll")?.getAttribute("data-zoomed")).toBe(
      "false",
    )
    expect(container.querySelector(".lazers-trajectory-cost span")?.textContent).toBe("market cost")
    expect(container.textContent).toContain(
      "Estimate basis · deduplicated-retained-token-usage-at-published-current-rates",
    )
    expect(container.textContent).toContain("Strict-index API equivalent · $0.03197324 · OpenCode")
    expect(container.textContent).toContain("0.0000001")
    expect(container.textContent).toContain("Recovery gaps · 2")
    expect(container.textContent).not.toContain("$0 subtotal")
    expect(container.textContent).not.toContain("Cost unavailable")
    expect(container.querySelector(".lazers-trajectory-axis")).not.toBeNull()
    const measuredSegment = [
      ...container.querySelectorAll<HTMLElement>(".lazers-trajectory-segment"),
    ].find((segment) => Number.parseFloat(segment.style.width) > 0)
    expect(measuredSegment).toBeDefined()
    expect(measuredSegment?.dataset.start).toBe("recorded")
    expect(measuredSegment?.dataset.end).toBe("recorded")
    expect(container.querySelector(".lazers-trajectory-plot svg")).toBeNull()
    expect(container.querySelector(".lazers-trajectory-attempt-state")).toBeNull()
    for (const segment of container.querySelectorAll(".lazers-trajectory-segment"))
      expect(segment.classList.contains("lazers-trajectory-rail")).toBe(true)
    // Marks are transparent hit targets; their shapes are drawn by one glyph layer per lane.
    for (const mark of container.querySelectorAll(
      ".lazers-trajectory-lane .lazers-trajectory-mark",
    ))
      expect(mark.querySelector(".lazers-trajectory-rail")).toBeNull()
    for (const lane of container.querySelectorAll(".lazers-trajectory-lane"))
      expect(lane.querySelector(".lazers-trajectory-glyphs")).not.toBeNull()
    for (const glyph of container.querySelectorAll(".lazers-trajectory-glyph"))
      expect(["tick", "span", "run"]).toContain(glyph.getAttribute("data-shape") ?? "")
    // One state glyph and word in the head; no copy icon, zoom label or Checks list.
    expect(
      container.querySelector(".lazers-trajectory-line1 .lazers-trajectory-state"),
    ).not.toBeNull()
    expect(container.querySelector(".lazers-trajectory-copy")).toBeNull()
    expect(container.querySelector(".lazers-trajectory-zoom-level")).toBeNull()
    expect(container.querySelector(".lazers-trajectory-check-list")).toBeNull()
    expect(container.textContent).not.toContain("No file calls")
    expect(measuredSegment?.title).toContain("Report model-activity interval:")
    expect(measuredSegment?.title).not.toContain("WORKER_STARTED")
    const attemptOptions = [
      ...container.querySelectorAll<HTMLElement>('.lazers-trajectory-attempt[role="option"]'),
    ]
    expect(
      attemptOptions.map((option) => option.getAttribute("aria-label")?.split(", ")[0]),
    ).toEqual(["Attempt 1", "Attempt 2"])
    expect(
      attemptOptions.map((option) => option.getAttribute("aria-label")?.split(", ")[1]),
    ).toEqual(["failed", "accepted"])
    expect(
      attemptOptions.map((option) =>
        option.querySelector(".lazers-trajectory-segment")?.getAttribute("data-outcome"),
      ),
    ).toEqual(["failed", "succeeded"])
    expect(
      [...container.querySelectorAll<HTMLElement>(".lazers-trajectory-check-marker")].some(
        (marker) => marker.getAttribute("aria-label")?.includes("attempt-check"),
      ),
    ).toBe(true)
    // The header model and timing follow the selected attempt.
    attemptOptions[0]!.click()
    await until(() => attemptOptions[0]!.getAttribute("aria-selected") === "true")
    expect(container.querySelector(".lazers-trajectory-attempt-menu")?.textContent).toContain(
      "Attempt 1",
    )
    attemptOptions[1]!.click()
    await until(() =>
      container.querySelector(".lazers-trajectory-attempt-menu")?.textContent?.includes("Attempt 2")
        ? true
        : false,
    )
    expect(attemptOptions[0]!.getAttribute("aria-selected")).toBe("false")

    // Switching to another panel tab and back re-mounts the panel: the last loaded trajectory is
    // on screen at once, with no skeleton, and refreshes in place.
    disposePanel?.()
    const remounted = browserDocument.createElement("main")
    browserDocument.body.append(remounted)
    disposePanel = mountTrajectoryPanel(panel!, context, session, remounted).dispose
    expect(remounted.querySelector(".lazers-trajectory-heading")?.textContent).toBe(
      fixture.repository.get(taskID)!.proposal.objective,
    )
    expect(remounted.querySelectorAll(".lazers-trajectory-attempt").length).toBe(2)
    expect(remounted.querySelector(".lazers-panel-loading")).toBeNull()
    expect(remounted.textContent).not.toContain("Loading this trajectory")
    trajectoryViewCache.clear()

    // An expired continuation surfaces beside the pagination controls with its recovery.
    disposePanel?.()
    forcedHistoryLimit = 2
    expireContinuations = true
    const pagedContainer = browserDocument.createElement("main")
    browserDocument.body.append(pagedContainer)
    disposePanel = mountTrajectoryPanel(panel!, context, session, pagedContainer).dispose
    const recapture = (root: ParentNode) =>
      [...root.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "Recapture history",
      )
    const coverage = () => pagedContainer.querySelector(".lazers-trajectory-coverage-line")
    // Pages continue on their own; an expired continuation surfaces beside the count with its
    // recovery, and there is never a manual Load more.
    await until(() => coverage()?.querySelector('[role="alert"]') != null)
    expect(coverage()?.querySelector('[role="alert"]')?.textContent).toContain(
      "Captured history has expired. Recapture history to continue.",
    )
    expect(recapture(coverage()!)).toBeDefined()
    expect(pagedContainer.textContent).not.toContain("Load more")
    expireContinuations = false
    recapture(coverage()!)!.click()
    await until(() => coverage()?.querySelector('[role="alert"]') == null)
    await until(() => coverage()?.textContent?.includes("events") === true)
    expect(coverage()?.textContent).not.toContain("loading the rest")

    trajectoryViewCache.clear()
    // No task chosen: a title and scope picker, one statement with its action, recent tasks that
    // open on click. There is no split and no inspector until a trajectory is loaded.
    disposePanel?.()
    trajectoryStore.update((draft: { projects: Record<string, unknown> }) => {
      draft.projects[fixture.directory] = {
        scope: "project",
        selectedTaskID: null,
        selectedReference: null,
        target: null,
        selectedKind: "",
        selectedRecordID: "",
        split: 56,
      }
    })
    const emptyContainer = browserDocument.createElement("main")
    browserDocument.body.append(emptyContainer)
    disposePanel = mountTrajectoryPanel(panel!, context, session, emptyContainer).dispose
    await until(() => emptyContainer.querySelectorAll(".lazers-trajectory-recent-row").length > 0)
    expect(emptyContainer.querySelector(".lazers-trajectory-panel-title")?.textContent).toBe(
      "Trajectory",
    )
    expect(emptyContainer.querySelector(".lazers-trajectory-empty b")?.textContent).toBe(
      "Pick a task",
    )
    expect(emptyContainer.querySelector(".lazers-trajectory")?.getAttribute("data-split")).toBe(
      "false",
    )
    expect(emptyContainer.querySelector(".lazers-trajectory-separator")).toBeNull()
    expect(emptyContainer.querySelector(".lazers-trajectory-inspector")).toBeNull()
    expect(emptyContainer.querySelector(".lazers-trajectory-timeline")).toBeNull()
    emptyContainer.querySelector<HTMLButtonElement>(".lazers-trajectory-recent-row")!.click()
    await until(() => emptyContainer.querySelector(".lazers-trajectory-heading") !== null)
    expect(emptyContainer.querySelector(".lazers-trajectory")?.getAttribute("data-split")).toBe(
      "true",
    )
    expect(emptyContainer.querySelector(".lazers-trajectory-separator")).not.toBeNull()
  } finally {
    disposePanel?.()
    disposeSetup?.()
    await rm(outputDirectory, { recursive: true, force: true })
    for (const [name, descriptor] of previousGlobals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
    if (previousResizeObserver)
      Object.defineProperty(globalThis, "ResizeObserver", previousResizeObserver)
    else Reflect.deleteProperty(globalThis, "ResizeObserver")
    dom.happyDOM.abort()
    fixture.close()
  }
})
