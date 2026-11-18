import { expect, test } from "bun:test"
import { Window } from "happy-dom"
import solid from "vite-plugin-solid"
import { build } from "vite"
import { mkdir, rm } from "node:fs/promises"
import { fileURLToPath, pathToFileURL } from "node:url"
import type {
  SnapshotResponse,
  TrajectoryHistoryResponse,
  TrajectoryResponse,
} from "../../src/observability/contract.ts"

const projectID = "timing-project"
const taskID = "11111111-1111-4111-8111-111111111111"
const planID = "22222222-2222-4222-8222-222222222222"
const attemptID = "33333333-3333-4333-8333-333333333333"
const ownerSessionID = "ses-timing-owner"
const workerSessionID = "ses-timing-worker"
const directory = "/workspace/trajectory-timing"
const attemptStart = 1_793_790_533_400
const pairs = {
  sources: [1_793_792_603_400, 1_793_792_603_688],
  models: [1_793_792_603_707, 1_793_792_604_783],
  quality: [1_793_792_604_802, 1_793_792_605_042],
  build: [1_793_792_605_061, 1_793_792_607_233],
} as const

function until(predicate: () => boolean) {
  return (async () => {
    for (let attempt = 0; attempt < 200 && !predicate(); attempt++)
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(predicate()).toBe(true)
  })()
}

function boundary(eventSequence: number) {
  return {
    repositoryVersion: eventSequence,
    sourceRevision: 1,
    sourceFingerprint: "a".repeat(64),
    nativeRevision: 1,
    eventSequence,
    transitionSequence: 1,
  }
}

type CheckSpec = {
  id: string
  scope: "plan" | "attempt"
  startedAt: number | null
  endedAt: number | null
}

const planCheckSpecs: CheckSpec[] = [
  ...Object.entries(pairs).map(([id, [startedAt, endedAt]]) => ({
    id,
    scope: "plan" as const,
    startedAt,
    endedAt,
  })),
  { id: "equal", scope: "plan", startedAt: 1_793_792_608_000, endedAt: 1_793_792_608_000 },
  { id: "start-only", scope: "plan", startedAt: 1_793_792_609_000, endedAt: null },
  { id: "end-only", scope: "plan", startedAt: null, endedAt: 1_793_792_610_000 },
  { id: "missing", scope: "plan", startedAt: null, endedAt: null },
  { id: "reversed", scope: "plan", startedAt: 1_793_792_608_000, endedAt: 1_793_792_607_000 },
]
/** The axis ends at the last recorded time, not at the next tick step. */
const axisSpan =
  Math.max(
    ...planCheckSpecs.flatMap((spec) => [spec.startedAt, spec.endedAt]).filter((t) => t !== null),
  ) - attemptStart
const attemptCheckSpec: CheckSpec = {
  id: "quality",
  scope: "attempt",
  startedAt: pairs.models[0],
  endedAt: pairs.models[1],
}

function checkRecord(spec: CheckSpec) {
  return {
    id: spec.id,
    scope: spec.scope,
    attemptID: spec.scope === "attempt" ? attemptID : null,
    state: "completed",
    result: spec.id === "reversed" ? "failed" : "passed",
    command: `bun test ${spec.id}`,
    startedAt: spec.startedAt,
    endedAt: spec.endedAt,
    timingBasis: "Recorded verification receipt check.startedAt/check.endedAt",
    exitCode: 0,
    timedOut: false,
    unchanged: false,
    stdout: `Recorded output for ${spec.id}`,
    stderr: null,
    error: null,
  }
}

const planChecks = planCheckSpecs.map(checkRecord)

function event(id: string, at: number, text: string) {
  return {
    id,
    at,
    sequence: id === "captured-first" ? 1 : 2,
    planID,
    taskID,
    attemptID,
    kind: "runner-transition",
    event: "VERIFY",
    from: "verifying",
    to: "accepted",
    text,
  }
}

function makeReport(attemptEndedAt: number | null, events: ReturnType<typeof event>[]) {
  return {
    schemaVersion: 1,
    task: {
      id: taskID,
      reference: "LZ-7",
      revision: 1,
      status: "accepted",
      specification: { objective: "Show recorded verification timing precisely" },
    },
    plans: [{ id: planID, checks: planChecks }],
    attempts: [
      {
        id: attemptID,
        planID,
        number: 1,
        state: "accepted",
        sessionID: workerSessionID,
        startedAt: attemptStart,
        intervals: {
          attempt: {
            startedAt: attemptStart,
            endedAt: attemptEndedAt,
            basis: "Recorded attempt lifecycle endpoints",
          },
          modelActivity: {
            startedAt: attemptStart,
            endedAt: attemptEndedAt,
            basis: "Recorded worker activity endpoints",
          },
        },
        admittedModel: { providerID: "openai", id: "gpt-6-luna", variant: "high" },
        observedCurrentModel: null,
        toolCount: { value: 3, source: "recorded worker tools" },
        checks: [checkRecord({ ...attemptCheckSpec, endedAt: attemptEndedAt })],
      },
    ],
    effort: {
      acceptedAt: null,
      firstAttemptAt: attemptStart,
      tokenUsage: {
        measuredSubtotal: {
          uncachedInput: 10,
          cacheRead: 0,
          cacheWrite: 0,
          output: 5,
          reasoning: 0,
        },
        total: null,
        knownSessions: 1,
        totalSessions: 1,
        unknownAttempts: [],
      },
      toolCalls: { count: 3 },
      recordedCost: { apiEquivalentTotalUsd: null },
    },
    coverage: {
      availableSessionContexts: 1,
      unavailableSessionContexts: 0,
      fullSessionHistory: "available",
      compacted: false,
      ongoing: false,
      attemptsWithoutRecordedSessions: 0,
    },
    trajectory: {
      page: 1,
      limit: 1,
      totalEvents: 2,
      events,
      nextCursor: "captured-page-two" as string | null,
      hasMore: true,
    },
  }
}

function makeSnapshot(eventSequence: number) {
  const checks = [...planCheckSpecs, attemptCheckSpec].map((spec, index) => ({
    id: `effect-${index}-${spec.id}`,
    planID,
    taskID: spec.scope === "plan" ? null : taskID,
    attemptID: spec.scope === "attempt" ? attemptID : null,
    checkID: spec.id,
    scope: spec.scope,
    state: "completed",
    startedAt: spec.startedAt,
    endedAt: spec.endedAt,
    exitCode: 0,
    timingBasis: "Recorded verification receipt check.startedAt/check.endedAt",
  }))
  return {
    projectID,
    scope: { kind: "session", sessionID: ownerSessionID },
    boundary: boundary(eventSequence),
    plans: [
      {
        id: planID,
        title: "Verification timing",
        nodes: [
          {
            taskID,
            revision: 1,
            objective: "Show recorded verification timing precisely",
            ordinal: 0,
            state: "accepted",
          },
        ],
      },
    ],
    unplannedTasks: [],
    attempts: [
      {
        id: attemptID,
        planID,
        taskID,
        number: 1,
        state: "accepted",
        startedAt: attemptStart,
        endedAt: null,
        timingBasis: "Recorded attempt reservation start; end unavailable",
        executions: [
          {
            startedAt: attemptStart,
            endedAt: null,
            startSequence: 1,
            endSequence: null,
            timingBasis: "Recorded worker start; end unavailable",
          },
        ],
      },
    ],
    checks,
  } as unknown as SnapshotResponse
}

test("registered Trajectory panel renders proportional check intervals and precise selected timing", async () => {
  const dom = new Window({ url: "http://localhost" })
  Object.defineProperty(dom.window, "innerWidth", { configurable: true, value: 360 })
  const browserDocument = dom.document as unknown as Document
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

  const guiRoot = fileURLToPath(new URL("../../src/gui.tsx", import.meta.url))
  const entry = fileURLToPath(new URL("./fixtures/trajectory-dom-entry.ts", import.meta.url))
  const outputDirectory = fileURLToPath(
    new URL("../../node_modules/.cache/trajectory-panel-dom-test", import.meta.url),
  )
  const inferenceRuntimeModule = "\0lazers-test-unused-inference-runtime"
  let replacedInferenceRuntime = false
  let disposeSetup: (() => void) | undefined
  const mounts: Array<{ dispose(): void }> = []
  try {
    await rm(outputDirectory, { recursive: true, force: true })
    await mkdir(outputDirectory, { recursive: true })
    await build({
      configFile: false,
      resolve: { conditions: ["browser", "development", "module"] },
      define: { __LAZERS_RADAR_WORKER_SOURCE__: JSON.stringify("") },
      plugins: [
        solid(),
        {
          name: "test-unused-inference-runtime",
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
        lib: { entry, formats: ["es"], fileName: "trajectory-panel-dom-test" },
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
    } = await import(pathToFileURL(`${outputDirectory}/trajectory-panel-dom-test.js`).href)
    expect(replacedInferenceRuntime).toBe(true)

    let changeSubscriber:
      | ((
          event: { type: string; location?: { directory: string }; data?: unknown } | undefined,
        ) => void)
      | undefined
    let publishedSequence = 1
    let attemptEnd = pairs.models[1]
    let capturedAt = 1_793_792_604_000
    const historyCalls: Array<string | undefined> = []
    // Later captured pages stay in flight until released, so streaming can be observed.
    let releasePageTwo: () => void = () => {}
    const pageTwoGate = new Promise<void>((resolve) => {
      releasePageTwo = resolve
    })
    let statusCalls = 0
    const capturedEventRecords = [
      event("captured-first", 1_793_792_603_400, "captured worker transition payload"),
      event("captured-second", 1_793_792_607_233, "captured second page payload"),
    ]
    const client = {
      location: {
        get: async () => ({ project: { canonical: directory, id: projectID } }),
      },
      rpc: () => ({
        snapshot: async () => makeSnapshot(publishedSequence),
        trajectoryHistory: async (input: {
          scope: { kind: "session"; sessionID: string }
          taskID: string
          cursor?: string
        }) => {
          historyCalls.push(input.cursor)
          if (input.cursor) await pageTwoGate
          if (!input.cursor) capturedAt += historyCalls.length === 1 ? 0 : 1_000
          const index = input.cursor ? 1 : 0
          const report = makeReport(
            attemptEnd,
            index === 0 ? [capturedEventRecords[0]!] : [capturedEventRecords[1]!],
          )
          report.trajectory = {
            ...report.trajectory,
            page: index + 1,
            nextCursor: index === 0 ? "captured-page-two" : null,
            hasMore: index === 0,
          }
          return {
            schemaVersion: 1,
            projectID,
            scope: { kind: "session", sessionID: ownerSessionID },
            boundary: boundary(publishedSequence),
            capturedAt,
            expiresAt: capturedAt + 60_000,
            eventIDs: capturedEventRecords.map((item) => item.id),
            report,
          } as unknown as TrajectoryHistoryResponse
        },
        trajectoryStatus: async () => {
          statusCalls++
          return {
            schemaVersion: 1,
            projectID,
            scope: { kind: "session", sessionID: ownerSessionID },
            boundary: boundary(publishedSequence),
            report: makeReport(attemptEnd, [
              event("live-update", 1_793_792_608_000, "live status is not captured history"),
            ]),
          } as unknown as TrajectoryResponse
        },
      }),
      event: {
        subscribe: ({ signal }: { signal: AbortSignal }) =>
          (async function* () {
            while (!signal.aborted) {
              const next = await new Promise<
                { type: string; location?: { directory: string }; data?: unknown } | undefined
              >((resolve) => {
                changeSubscriber = resolve
                signal.addEventListener("abort", () => resolve(undefined), { once: true })
              })
              if (!next) return
              yield next
            }
          })(),
      },
    }
    const registrations: Array<{ token: unknown; value: unknown }> = []
    const openedTabs: unknown[][] = []
    const modelsStore = createReactiveStore({ projects: {} })
    // The view already holds this task: a panel with no task context asks the person to pick.
    const trajectoryStore = createReactiveStore({
      projects: {
        [directory]: {
          scope: "session",
          selectedTaskID: taskID,
          selectedReference: null,
          target: null,
          selectedKind: "",
          selectedRecordID: "",
          split: 56,
        },
      } as Record<string, unknown>,
    })
    const stores = {
      modelsView: () => modelsStore,
      trajectoryView: () => trajectoryStore,
    }
    const session = {
      id: ownerSessionID,
      location: { directory },
      directory,
      server: { id: "timing-server", connected: true, client },
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
      stores,
      tabs: { open: (...args: unknown[]) => openedTabs.push(args) },
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
    const trajectoryPanel = trajectoryPanelRegistration(registrations)
    expect(trajectoryPanel).toBeDefined()
    expect(trajectoryPanel?.list({ open: [] })).toEqual([])
    expect(trajectoryPanel?.list({ open: ["trajectory"] })).toMatchObject([
      { id: "trajectory", title: "Trajectory", closable: "hover" },
    ])
    expect(typeof trajectoryPanel?.render).toBe("function")

    const trajectoryCSS = registrations.find(
      (entry) =>
        entry.token === registryTokens.Style &&
        typeof entry.value === "string" &&
        entry.value.includes(".lazers-trajectory {"),
    )?.value as string | undefined
    expect(trajectoryCSS).toBeDefined()
    expect(trajectoryCSS).toContain("min-width: 0")
    expect(trajectoryCSS).toContain("overflow-wrap: anywhere")
    expect(trajectoryCSS).toContain("@container lazers-trajectory (max-width: 380px)")
    expect(trajectoryCSS).not.toContain("@media (max-width")
    expect(trajectoryCSS).toContain(".lazers-trajectory-inspector")
    const style = browserDocument.createElement("style")
    style.textContent = trajectoryCSS ?? ""
    browserDocument.head.append(style)

    const container = browserDocument.createElement("main")
    container.style.width = "360px"
    browserDocument.body.append(container)
    const mounted = mountTrajectoryPanel(trajectoryPanel!, context, session, container)
    mounts.push(mounted)
    await until(
      () =>
        container.querySelector(".lazers-trajectory-heading")?.textContent ===
          "Show recorded verification timing precisely" &&
        container.querySelectorAll(".lazers-trajectory-check-marker").length > 0,
    )
    // Opening reads the captured history once; no status read follows until a change arrives.
    expect(statusCalls).toBe(0)
    expect(container.querySelector(".lazers-trajectory-axis-caption")?.textContent).toBe(
      "Live · following",
    )
    expect(container.querySelector(".lazers-trajectory-capture-stamp")).toBeNull()
    // The inspector never shows raw milliseconds or placeholder words for missing facts.
    const inspectorText = () =>
      container.querySelector(".lazers-trajectory-inspector")!.textContent!
    const noRawFacts = () => {
      for (const banned of [/Unix ms/, /unknown/i, /not recorded/i, /unavailable/i, /\d{13}/])
        expect(inspectorText()).not.toMatch(banned)
    }
    const markerStarting = (label: string) =>
      [...container.querySelectorAll<HTMLElement>(".lazers-trajectory-check-marker")].find(
        (marker) => marker.getAttribute("aria-label")?.startsWith(label),
      )
    // Checks are chosen on the Checks lane: one keyboard-selectable marker per placed check.
    const checkRows = (name: string) =>
      [...container.querySelectorAll<HTMLElement>(".lazers-trajectory-check-marker")].filter(
        (marker) => new RegExp(`check ${name},`).test(marker.getAttribute("aria-label") ?? ""),
      )
    const checkRow = (name: string) => checkRows(name)[0]
    const selected = (marker: HTMLElement | undefined) =>
      marker?.getAttribute("aria-selected") === "true"

    const intervalForPlan = (id: string) =>
      [
        ...container.querySelectorAll<HTMLElement>(
          '.lazers-trajectory-checks .lazers-trajectory-check-marker[data-scope="plan"]',
        ),
      ].find((candidate) => candidate.dataset.checkId === id)
    for (const [id, [startedAt, endedAt]] of Object.entries(pairs)) {
      const interval = intervalForPlan(id)!
      expect(Number.parseFloat(interval.style.width)).toBeGreaterThan(0)
      expect(Number.parseFloat(interval.style.width)).toBeCloseTo(
        ((endedAt - startedAt) / axisSpan) * 100,
        12,
      )
    }
    const attemptInterval = container.querySelector<HTMLElement>(
      '.lazers-trajectory-checks .lazers-trajectory-check-marker[data-scope="attempt"]',
    )!
    expect(attemptInterval.dataset.point).toBe("false")
    expect(Number.parseFloat(attemptInterval.style.left)).toBeCloseTo(
      ((pairs.models[0] - attemptStart) / axisSpan) * 100,
      12,
    )
    expect(Number.parseFloat(attemptInterval.style.width)).toBeCloseTo(
      ((pairs.models[1] - pairs.models[0]) / axisSpan) * 100,
      12,
    )
    // A check with neither endpoint has no place on the time axis, so it has no mark.
    expect(intervalForPlan("missing")).toBeUndefined()
    expect(markerStarting("Plan check missing")).toBeUndefined()
    expect(intervalForPlan("equal")!.dataset.point).toBe("true")
    expect(Number.parseFloat(intervalForPlan("equal")!.style.width)).toBe(0)
    for (const id of ["start-only", "end-only"]) {
      expect(intervalForPlan(id)!.dataset.point).toBe("true")
      expect(Number.parseFloat(intervalForPlan(id)!.style.width)).toBe(0)
    }
    // Marks are drawn by one glyph layer on the lane; a failed check is red there.
    const checkGlyphs = [
      ...container.querySelectorAll<HTMLElement>(
        ".lazers-trajectory-checks .lazers-trajectory-glyph",
      ),
    ]
    expect(checkGlyphs.length).toBeGreaterThan(0)
    for (const glyph of checkGlyphs) {
      expect(glyph.classList.contains("lazers-trajectory-rail")).toBe(true)
      expect(["tick", "span", "run"]).toContain(glyph.dataset.shape ?? "")
    }
    expect(checkGlyphs.some((glyph) => glyph.dataset.failed === "true")).toBe(true)
    expect(Number.parseFloat(intervalForPlan("reversed")!.style.width)).toBe(0)
    expect(intervalForPlan("reversed")!.dataset.result).toBe("failed")
    expect(container.querySelectorAll(".lazers-trajectory-check-endpoint")).toHaveLength(1)
    expect(markerStarting("Plan check reversed")?.getAttribute("aria-label")).toContain("Failed")
    expect(
      container.querySelector('[data-track="checks"] [role="listbox"]')?.getAttribute("style"),
    ).toBeNull()
    expect(container.querySelector(".lazers-trajectory-plot svg")).toBeNull()
    expect(trajectoryCSS).toContain("--trajectory-row")
    expect(trajectoryCSS).toContain(".lazers-trajectory-rail")
    expect(trajectoryCSS).not.toContain("--trajectory-check-rows")
    // Every placed check is a keyboard option in one Checks track.
    const checkTrack = container.querySelector<HTMLElement>(
      '[data-track="checks"] [role="listbox"]',
    )!
    expect(checkTrack.getAttribute("aria-orientation")).toBe("horizontal")
    expect(
      [...checkTrack.querySelectorAll('[role="option"]')].filter(
        (option) => option.getAttribute("tabindex") === "0",
      ),
    ).toHaveLength(1)

    const planQualityMarker = markerStarting("Plan check quality")!
    planQualityMarker.click()
    await until(
      () => markerStarting("Plan check quality")?.getAttribute("aria-selected") === "true",
    )
    expect(checkRows("quality")).toHaveLength(2)
    expect(selected(markerStarting("Plan check quality"))).toBe(true)
    expect(selected(markerStarting("Attempt 1 check quality"))).toBe(false)
    const command = () => container.querySelector(".lazers-trajectory-command")?.textContent
    const duration = () =>
      container.querySelector(".lazers-trajectory-inspector-heading .lazers-trajectory-duration")
        ?.textContent
    const facts = () => container.querySelector(".lazers-trajectory-facts")?.textContent ?? ""
    const timingSource = () =>
      [...container.querySelectorAll<HTMLDetailsElement>(".lazers-trajectory-payload")].find(
        (details) => details.querySelector("summary")?.textContent?.startsWith("Timing source"),
      )
    expect(command()).toBe("bun test quality")
    // The reference arrives with the report; the view store supplied none.
    expect(container.querySelector(".lazers-trajectory-line1")?.textContent).toContain("LZ-7")
    expect(duration()).toBe("240ms")
    expect(container.querySelector(".lazers-trajectory-payload")?.hasAttribute("open")).toBe(false)
    expect(facts()).toContain("Started")
    expect(facts()).toContain("Ended")
    expect(timingSource()?.textContent).toContain("Recorded verification receipt")
    noRawFacts()

    markerStarting("Attempt 1 check quality")!.click()
    await until(() => selected(markerStarting("Attempt 1 check quality")))
    const attemptQualityMarker = markerStarting("Attempt 1 check quality")!
    expect(attemptQualityMarker.getAttribute("aria-selected")).toBe("true")
    expect(markerStarting("Plan check quality")?.getAttribute("aria-selected")).toBe("false")
    expect(attemptQualityMarker.getAttribute("tabindex")).toBe("0")
    expect(command()).toBe("bun test quality")
    // The reference arrives with the report; the view store supplied none.
    expect(container.querySelector(".lazers-trajectory-line1")?.textContent).toContain("LZ-7")
    expect(container.querySelector(".lazers-trajectory-line1")?.textContent).not.toContain(
      taskID.slice(0, 8),
    )
    expect(container.querySelector(".lazers-trajectory-kind")?.textContent).toBe("Check · exit 0")
    expect(container.querySelector(".lazers-trajectory-outcome")?.textContent).toContain("Passed")
    expect(facts()).toContain("into the attempt")
    // The worker session opens from the reference menu, which offers it for this selection.
    container.querySelector<HTMLButtonElement>(".lazers-trajectory-task-menu button")!.click()
    const sessionItem = [
      ...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ].find((item) => item.textContent === "Open worker session")
    expect(sessionItem).toBeDefined()
    sessionItem!.click()
    expect(openedTabs.at(-1)).toEqual([
      { server: "timing-server", id: workerSessionID },
      { focus: true },
    ])
    expect(duration()).toBe("1.1s")
    noRawFacts()

    const press = (key: string) =>
      checkTrack.dispatchEvent(
        new browserDocument.defaultView!.KeyboardEvent("keydown", { key, bubbles: true }),
      )
    const laneOrder = [...checkTrack.querySelectorAll<HTMLElement>('[role="option"]')]
    press("Home")
    await until(() => laneOrder[0]?.getAttribute("aria-selected") === "true")
    expect(laneOrder[0]?.getAttribute("tabindex")).toBe("0")
    const firstHeading = command()
    press("ArrowRight")
    await until(() => laneOrder[1]?.getAttribute("aria-selected") === "true")
    expect(laneOrder[0]?.getAttribute("aria-selected")).toBe("false")
    expect(command()).not.toBe(firstHeading)

    markerStarting("Plan check quality")!.click()
    await until(
      () => markerStarting("Plan check quality")?.getAttribute("aria-selected") === "true",
    )
    // A missing optional fact removes its row; it is never spelled out as "unavailable".
    noRawFacts()
    checkRow("equal")!.click()
    await until(() => selected(checkRow("equal")))
    expect(duration()).toBe("0ms")
    checkRow("start-only")!.click()
    await until(() => selected(checkRow("start-only")))
    expect(duration()).toBeUndefined()
    expect(facts()).toContain("Started")
    expect(facts()).not.toContain("Ended")
    noRawFacts()
    checkRow("end-only")!.click()
    await until(() => selected(checkRow("end-only")))
    expect(duration()).toBeUndefined()
    expect(facts()).not.toContain("Started")
    expect(facts()).toContain("Ended")
    checkRow("reversed")!.click()
    await until(() => selected(checkRow("reversed")))
    expect(duration()).toBeUndefined()
    // The data defect is reported once, behind the Timing source disclosure.
    expect(timingSource()?.textContent).toContain("precedes the start time")

    markerStarting("Attempt 1 check quality")!.click()
    await until(
      () => markerStarting("Attempt 1 check quality")?.getAttribute("aria-selected") === "true",
    )
    const historyDetails = container.querySelector<HTMLDetailsElement>(
      ".lazers-trajectory-activity",
    )!
    historyDetails.open = true
    const capturedEvents = () => [
      ...container.querySelectorAll<HTMLButtonElement>(
        ".lazers-trajectory-activity-list .lazers-trajectory-event",
      ),
    ]
    // Opening loads one captured page; the rest streams in the background with no Load more.
    expect(capturedEvents()).toHaveLength(1)
    await until(() => historyCalls.length === 2)
    expect(historyCalls).toEqual([undefined, "captured-page-two"])
    expect(container.querySelector(".lazers-trajectory-coverage-line")?.textContent).toContain(
      "1 of 2 events",
    )
    expect(container.querySelector(".lazers-trajectory-coverage-line")?.textContent).toContain(
      "loading the rest",
    )
    expect(
      container.querySelector(".lazers-trajectory-progress")?.getAttribute("aria-valuenow"),
    ).toBe("1")
    expect(container.querySelector(".lazers-trajectory-unloaded")).not.toBeNull()
    expect(container.textContent).not.toContain("Load more")
    // Streaming draws no idle breaks: unloaded time is not idle time.
    expect(container.querySelector(".lazers-trajectory-idle")).toBeNull()
    const initialHistoryTime = capturedEvents()[0]!.querySelector("time")?.textContent
    const initialCaptureMetadata = container.querySelector(
      ".lazers-trajectory-capture-note",
    )?.textContent
    expect(initialCaptureMetadata).toContain("Captured")

    const beforeStatusCalls = statusCalls
    attemptEnd += 50
    publishedSequence = 2
    const publish = changeSubscriber
    expect(publish).toBeDefined()
    publish?.({
      type: "rpc.lazers.observability.changed",
      location: { directory },
      data: {
        projectID,
        sequence: publishedSequence,
        repositoryVersion: 2,
        sourceRevision: 1,
        nativeRevision: 1,
        cause: "runner",
        resnapshotRequired: false,
      },
    })
    await until(() => statusCalls > beforeStatusCalls && duration() === "1.1s")
    expect(markerStarting("Attempt 1 check quality")?.getAttribute("aria-selected")).toBe("true")
    expect(markerStarting("Plan check quality")?.getAttribute("aria-selected")).toBe("false")
    expect(command()).toBe("bun test quality")
    // The reference arrives with the report; the view store supplied none.
    expect(container.querySelector(".lazers-trajectory-line1")?.textContent).toContain("LZ-7")
    expect(capturedEvents()[0]?.querySelector("time")?.textContent).toBe(initialHistoryTime)
    expect(container.querySelector(".lazers-trajectory-capture-note")?.textContent).toBe(
      initialCaptureMetadata,
    )

    capturedEvents()[0]!.click()
    const eventHeading = () =>
      [...container.querySelectorAll<HTMLElement>(".lazers-trajectory-inspector-heading")].find(
        (heading) =>
          heading.querySelector(".lazers-trajectory-kind")?.textContent === "VERIFY · accepted",
      )
    await until(() => eventHeading() !== undefined)
    expect(capturedEvents()[0]?.getAttribute("aria-pressed")).toBe("true")
    let payload = container.querySelector<HTMLDetailsElement>(".lazers-trajectory-payload")!
    payload.open = true
    expect(payload.querySelector("pre")?.textContent).toContain(
      "captured worker transition payload",
    )
    expect(container.querySelector(".lazers-trajectory-inspector")?.textContent).not.toContain(
      "live status is not captured history",
    )

    expect(capturedEvents()).toHaveLength(1)
    releasePageTwo()
    await until(() => capturedEvents().length === 2)
    expect(historyCalls).toEqual([undefined, "captured-page-two"])
    expect(container.querySelector(".lazers-trajectory-unloaded")).toBeNull()
    expect(container.querySelector(".lazers-trajectory-progress")).toBeNull()
    expect(container.querySelector(".lazers-trajectory-coverage-line")?.textContent).toContain(
      "2 events",
    )
    expect(container.querySelector(".lazers-trajectory-capture-note")?.textContent).toBe(
      initialCaptureMetadata,
    )

    const selectedEventTime = eventHeading()?.querySelector(
      ".lazers-trajectory-duration",
    )?.textContent
    const recapture = container.querySelector<HTMLButtonElement>(
      ".lazers-trajectory-capture-note button",
    )!
    recapture.click()
    await until(
      () =>
        historyCalls.length >= 4 &&
        container.querySelector(".lazers-trajectory-capture-note")?.textContent !==
          initialCaptureMetadata,
    )
    expect(historyCalls).toEqual([undefined, "captured-page-two", undefined, "captured-page-two"])
    expect(capturedEvents()).toHaveLength(2)
    expect(eventHeading()).toBeDefined()
    expect(eventHeading()?.querySelector(".lazers-trajectory-duration")?.textContent).toBe(
      selectedEventTime,
    )
    payload = container.querySelector<HTMLDetailsElement>(".lazers-trajectory-payload")!
    payload.open = true
    expect(payload.querySelector("pre")?.textContent).toContain(
      "captured worker transition payload",
    )
  } finally {
    mounts.forEach((mount) => mount.dispose())
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
  }
})
