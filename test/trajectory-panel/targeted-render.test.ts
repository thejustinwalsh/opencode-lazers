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
      taskValuationProvider,
    )
    // Broad history volume does not change the panel's targeted-only reads.
    const snapshot = reads.snapshot({ kind: "project", sessionID: "ses-owner" }, tracker)
    // The snapshot reads no plan-level transition: unrelated volume truncates nothing.
    expect(snapshot.coverage?.transitionsTruncated).toBe(false)
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
          open: true,
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
    expect(latestHistoryReport).toMatchObject({
      effort: {
        recordedCost: { apiEquivalentTotalUsd: 0.03197324 },
        marketEquivalentCost: {
          observedUsageEstimate: { valueUSD: 0.01598662 },
        },
      },
    })
    // The recorded failed check is selected: the pane shows that check and nothing of the attempt.
    const callPane = container.querySelector('.lazers-trajectory-pane-body[data-pane="call"]')
    expect(callPane).not.toBeNull()
    expect(callPane!.querySelector(".lazers-trajectory-crumb button")?.textContent).toMatch(
      /Attempt \d/,
    )
    expect(callPane!.textContent).not.toMatch(/Rates|Events|Cost|Coverage|Summary/)
    expect(container.querySelector('[data-pane="attempt"]')).toBeNull()
    // Selecting the attempt shows its report, once.
    container.querySelectorAll<HTMLElement>('.lazers-trajectory-attempt[role="option"]')[1]!.click()
    await until(() => container.querySelector('[data-pane="attempt"]') !== null)
    const pane = container.querySelector('.lazers-trajectory-pane-body[data-pane="attempt"]')
    expect(pane).not.toBeNull()
    const stat = (label: string) =>
      [...pane!.querySelectorAll(".lazers-kit-stat")]
        .find((item) => item.querySelector("dt")?.textContent === label)
        ?.querySelector("dd")
    // One figure at two decimals, no "market cost" caption, no second price figure.
    expect(stat("Cost")?.textContent).toMatch(/^\$0\.02/)
    expect(pane!.textContent).not.toContain("market cost")
    expect(pane!.textContent).not.toContain("$0.016")
    expect(pane!.textContent).not.toContain("0.03197324")
    expect(stat("Tokens")?.textContent).toMatch(/ in · .* out$/)
    // The summary names the price source and date; the rates are a table behind Rates.
    expect(pane!.textContent).toMatch(/OpenRouter prices · \w+ \d+/)
    const disclosure = (label: string) =>
      [...pane!.querySelectorAll<HTMLElement>(".lazers-kit-disclosure")].find((item) =>
        item.querySelector(".lazers-kit-disclosure-toggle")?.textContent?.startsWith(label),
      )
    const toggle = (label: string) =>
      disclosure(label)!.querySelector<HTMLButtonElement>(".lazers-kit-disclosure-toggle")!
    expect(
      [...pane!.querySelectorAll(".lazers-kit-disclosure-toggle")].map((item) =>
        item.textContent
          ?.replace(/\s+/g, " ")
          .trim()
          .replace(/\s*·\s*\d+$/, ""),
      ),
    ).toEqual(expect.arrayContaining(["Rates", "Events", "Identifiers"]))
    toggle("Rates").click()
    await until(() => disclosure("Rates")!.querySelector(".lazers-kit-rows") !== null)
    expect(disclosure("Rates")!.textContent).toContain("$0.10")
    expect(
      disclosure("Rates")!.querySelectorAll(".lazers-trajectory-note").length,
    ).toBeLessThanOrEqual(4)
    // Identifiers hold ids and hashes; nowhere else.
    expect(pane!.textContent).not.toMatch(/snapshot|current-price-index|uncachedInput/)
    toggle("Identifiers").click()
    await until(() => disclosure("Identifiers")!.querySelector(".lazers-kit-ids") !== null)
    expect(disclosure("Identifiers")!.textContent).toContain("Price index")
    // Event names are translated; the raw name stays in the row's payload.
    toggle("Events").click()
    await until(() => pane!.querySelectorAll(".lazers-trajectory-event").length > 0)
    expect(pane!.querySelector(".lazers-trajectory-activity-list")!.textContent).not.toMatch(
      /[A-Z]+_[A-Z_]+|worker-[a-z-]+|runner-[a-z]+/,
    )
    expect(container.textContent).not.toMatch(/Unix ms|unknown|not recorded|unavailable/i)
    expect(container.textContent).not.toContain("Pricing coverage and provenance")
    // A call shows only itself: its command, numbers, its place in the attempt and a way back.
    const toolMark = container.querySelector<HTMLElement>('[data-track="tools"] [role="option"]')
    expect(toolMark).not.toBeNull()
    toolMark!.click()
    await until(() => container.querySelector('[data-pane="call"]') !== null)
    const call = container.querySelector('[data-pane="call"]')!
    expect(container.querySelector('[data-pane="attempt"]')).toBeNull()
    expect(call.textContent).not.toMatch(/Rates|Events|Coverage|Summary|Cost|Calls/)
    expect(call.querySelector(".lazers-trajectory-crumb button")?.textContent).toMatch(/Attempt \d/)
    expect(call.querySelector(".lazers-kit-tick[data-selected='true']")).not.toBeNull()
    expect(container.querySelector(".lazers-trajectory-position")?.textContent).toMatch(
      /^\d+ \/ \d+$/,
    )
    expect(container.querySelector(".lazers-details-header")?.textContent).toMatch(
      /Succeeded|Failed|Running/,
    )
    // Disclosures with nothing in them are not rendered.
    for (const toggle of call.querySelectorAll(".lazers-kit-disclosure-toggle"))
      expect(toggle.textContent).not.toMatch(/·\s*0$/)
    expect(container.textContent).not.toMatch(/Unix ms|unknown|not recorded|unavailable/i)
    call.querySelector<HTMLButtonElement>(".lazers-trajectory-crumb button")!.click()
    await until(() => container.querySelector('[data-pane="attempt"]') !== null)
    // The timeline opens fitted: no horizontal scroll until the person zooms in.
    expect(container.querySelector(".lazers-trajectory-scroll")?.getAttribute("data-zoomed")).toBe(
      "false",
    )
    // Timeline navigation: buttons, pinch/ctrl-wheel, keyboard and expand share one view state.
    const timelineRoot = container.querySelector<HTMLElement>(".lazers-trajectory-timeline")!
    const plot = container.querySelector<HTMLElement>(".lazers-trajectory-scroll")!
    const zoomOf = () =>
      Number.parseFloat(
        container
          .querySelector<HTMLElement>(".lazers-trajectory")!
          .style.getPropertyValue("--trajectory-zoom"),
      )
    const button = (label: string) =>
      container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
    expect(button("Timeline fits the panel").disabled).toBe(true)
    expect(
      button("Timeline fits the panel").querySelector("[data-icon]")?.getAttribute("data-icon"),
    ).toBe("fit")
    expect(
      button("Expand timeline to window").querySelector("[data-icon]")?.getAttribute("data-icon"),
    ).toBe("expand")
    const wheel = (init: WheelEventInit) => {
      // happy-dom's WheelEvent drops modifier and delta fields, so set them on a plain event.
      const event = new dom.window.Event("wheel", { bubbles: true, cancelable: true })
      Object.assign(event, { ctrlKey: false, deltaX: 0, deltaY: 0, deltaMode: 0, clientX: 0 }, init)
      plot.dispatchEvent(event as unknown as Event)
      return event
    }

    const pinch = wheel({ ctrlKey: true, deltaY: -40, clientX: 100 })
    expect(pinch.defaultPrevented).toBe(true)
    await until(() => zoomOf() > 1)
    expect(plot.getAttribute("data-zoomed")).toBe("true")
    const zoomedAfterPinch = zoomOf()
    plot.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        key: "0",
        bubbles: true,
        cancelable: true,
      }) as unknown as Event,
    )
    await until(() => zoomOf() === 1)
    // Fitted, a plain wheel is the page's: not consumed.
    expect(wheel({ deltaY: 30 }).defaultPrevented).toBe(false)
    expect(zoomedAfterPinch).toBeGreaterThan(1)
    plot.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        key: "+",
        bubbles: true,
        cancelable: true,
      }) as unknown as Event,
    )
    await until(() => zoomOf() > 1)
    button("Fit timeline to panel").click()
    await until(() => zoomOf() === 1)
    // Expand keeps the same timeline element and state; Close and Escape return it inline.
    button("Expand timeline to window").click()
    await until(() => timelineRoot.getAttribute("data-expanded") === "true")
    expect(container.querySelector(".lazers-trajectory-timeline")).toBe(timelineRoot)
    expect(timelineRoot.getAttribute("role")).toBe("dialog")
    // 8a10ed88-1: with a selection, the expanded timeline offers a way to its details.
    button("Inspect selection and close").click()
    await until(() => timelineRoot.getAttribute("data-expanded") === "false")
    await until(
      () => document.activeElement === container.querySelector(".lazers-trajectory-inspector"),
    )
    button("Expand timeline to window").click()
    await until(() => timelineRoot.getAttribute("data-expanded") === "true")
    button("Close expanded timeline").click()
    await until(() => timelineRoot.getAttribute("data-expanded") === "false")
    expect(timelineRoot.getAttribute("role")).toBe("region")
    button("Expand timeline to window").click()
    await until(() => timelineRoot.getAttribute("data-expanded") === "true")
    timelineRoot.dispatchEvent(new dom.window.Event("close") as unknown as Event)
    await until(() => timelineRoot.getAttribute("data-expanded") === "false")
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
    // With no task the details pane is still there: one collapsed bar saying nothing is selected.
    expect(emptyContainer.querySelector(".lazers-details-header")?.textContent).toBe(
      "No call selected",
    )
    expect(
      emptyContainer.querySelector(".lazers-details-chevron")?.getAttribute("aria-expanded"),
    ).toBe("false")
    expect(emptyContainer.querySelector(".lazers-trajectory-inspector")).toBeNull()
    expect(emptyContainer.querySelector(".lazers-trajectory-timeline")).toBeNull()
    emptyContainer.querySelector<HTMLButtonElement>(".lazers-trajectory-recent-row")!.click()
    await until(() => emptyContainer.querySelector(".lazers-trajectory-heading") !== null)
    // Loading a trajectory does not open the pane; it stays one collapsed bar.
    expect(emptyContainer.querySelector(".lazers-details-resize")).not.toBeNull()
    expect(emptyContainer.querySelector(".lazers-trajectory-inspector")).toBeNull()
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
