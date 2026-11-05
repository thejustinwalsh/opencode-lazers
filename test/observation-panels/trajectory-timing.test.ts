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
    result: "passed",
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
    const trajectoryStore = createReactiveStore({ projects: {} as Record<string, unknown> })
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
    expect(trajectoryCSS).toContain("min-width: 24px")
    expect(trajectoryCSS).toContain("@media (max-width: 380px)")
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
        container.querySelectorAll(".lazers-trajectory-check-row").length === 10 &&
        statusCalls > 0,
    )
    const markerStarting = (label: string) =>
      [...container.querySelectorAll<HTMLButtonElement>(".lazers-trajectory-check-marker")].find(
        (button) => button.getAttribute("aria-label")?.startsWith(label),
      )
    const checkRows = (name: string) =>
      [...container.querySelectorAll<HTMLButtonElement>(".lazers-trajectory-check-row")].filter(
        (button) => button.textContent?.includes(`bun test ${name}`),
      )
    const checkRow = (name: string) => checkRows(name)[0]

    const intervalForPlan = (id: string) => {
      const row = [
        ...container.querySelectorAll<HTMLElement>(".lazers-trajectory-plan-checks"),
      ].find((candidate) => candidate.textContent?.includes(`Plan check · ${id}`))!
      return row.querySelector<HTMLElement>(".lazers-trajectory-check-interval")!
    }
    for (const [id, [startedAt, endedAt]] of Object.entries(pairs)) {
      const interval = intervalForPlan(id)
      expect(interval.hidden).toBe(false)
      expect(Number.parseFloat(interval.style.width)).toBeGreaterThan(0)
      expect(interval.getAttribute("aria-hidden")).toBe("true")
      expect(Number.parseFloat(interval.style.width)).toBeCloseTo(
        ((endedAt - startedAt) / 2_400_000) * 100,
        12,
      )
    }
    const attemptInterval = container.querySelector<HTMLElement>(
      ".lazers-trajectory-attempt .lazers-trajectory-check-interval",
    )!
    expect(attemptInterval.hidden).toBe(false)
    expect(attemptInterval.dataset.point).toBe("false")
    expect(Number.parseFloat(attemptInterval.style.left)).toBeCloseTo(
      ((pairs.models[0] - attemptStart) / 2_400_000) * 100,
      12,
    )
    expect(Number.parseFloat(attemptInterval.style.width)).toBeCloseTo(
      ((pairs.models[1] - pairs.models[0]) / 2_400_000) * 100,
      12,
    )
    const missingRow = [
      ...container.querySelectorAll<HTMLElement>(".lazers-trajectory-plan-checks"),
    ].find((candidate) => candidate.textContent?.includes("Plan check · missing"))!
    expect(missingRow.querySelector(".lazers-trajectory-check-marker")).toBeNull()
    expect(intervalForPlan("missing").hidden).toBe(true)
    expect(container.querySelectorAll(".lazers-trajectory-check-row").length).toBe(10)
    expect(intervalForPlan("equal").dataset.point).toBe("true")
    expect(Number.parseFloat(intervalForPlan("equal").style.width)).toBe(0)
    for (const id of ["start-only", "end-only"]) {
      expect(intervalForPlan(id).hidden).toBe(false)
      expect(intervalForPlan(id).dataset.point).toBe("true")
      expect(Number.parseFloat(intervalForPlan(id).style.width)).toBe(0)
    }

    const planQualityMarker = markerStarting("Select plan check quality")!
    planQualityMarker.click()
    await until(
      () => markerStarting("Select plan check quality")?.getAttribute("aria-pressed") === "true",
    )
    let qualityRows = checkRows("quality")
    expect(qualityRows).toHaveLength(2)
    expect(qualityRows[0]?.getAttribute("aria-pressed")).toBe("true")
    expect(qualityRows[1]?.getAttribute("aria-pressed")).toBe("false")
    expect(container.querySelector(".lazers-trajectory-inspector h3")?.textContent).toBe(
      "bun test quality",
    )
    let timing = container.querySelector<HTMLElement>(
      '.lazers-trajectory-metadata [role="status"]',
    )!
    expect(timing.textContent).toBe("Elapsed duration · 240 ms")
    expect(container.querySelector(".lazers-trajectory-payload")?.hasAttribute("open")).toBe(false)
    let metadata = container.querySelector(
      ".lazers-trajectory-inspector .lazers-trajectory-metadata",
    )!
    expect(metadata.textContent).toContain("1793792604802 Unix ms")
    expect(metadata.textContent).toContain("1793792605042 Unix ms")
    expect(metadata.textContent).toContain("Timing source · Recorded verification receipt")

    qualityRows[1]!.click()
    await until(() => checkRows("quality")[1]?.getAttribute("aria-pressed") === "true")
    const attemptQualityMarker = markerStarting("Select check quality")!
    expect(attemptQualityMarker.getAttribute("aria-pressed")).toBe("true")
    expect(markerStarting("Select plan check quality")?.getAttribute("aria-pressed")).toBe("false")
    expect(container.querySelector(".lazers-trajectory-inspector h3")?.textContent).toBe(
      "Attempt 1 · bun test quality",
    )
    expect(container.querySelector(".lazers-trajectory-id")?.textContent).toContain(
      taskID.slice(0, 8),
    )
    expect(container.querySelector(".lazers-trajectory-inspector")?.textContent).toContain(
      "Attempt check · completed",
    )
    expect(container.querySelector(".lazers-trajectory-session-link")?.textContent).toContain(
      "Open worker session",
    )
    container.querySelector<HTMLButtonElement>(".lazers-trajectory-session-link")!.click()
    expect(openedTabs.at(-1)).toEqual([
      { server: "timing-server", id: workerSessionID },
      { focus: true },
    ])
    timing = container.querySelector('.lazers-trajectory-metadata [role="status"]')!
    expect(timing.textContent).toBe("Elapsed duration · 1.076 s (1076 ms)")
    expect(timing.getAttribute("aria-live")).toBe("polite")

    checkRows("quality")[0]!.click()
    await until(
      () => markerStarting("Select plan check quality")?.getAttribute("aria-pressed") === "true",
    )
    checkRow("missing")!.click()
    await until(() => checkRow("missing")?.getAttribute("aria-pressed") === "true")
    expect(
      container.querySelector('.lazers-trajectory-metadata [role="status"]')?.textContent,
    ).toBe("Duration unavailable · Neither start nor end time was recorded.")
    expect(container.querySelector(".lazers-trajectory-inspector")?.textContent).toContain(
      "Start · unavailable",
    )
    expect(container.querySelector(".lazers-trajectory-inspector")?.textContent).toContain(
      "End · unavailable",
    )
    checkRow("equal")!.click()
    await until(() => checkRow("equal")?.getAttribute("aria-pressed") === "true")
    expect(
      container.querySelector('.lazers-trajectory-metadata [role="status"]')?.textContent,
    ).toBe("Elapsed duration · 0 ms")
    checkRow("start-only")!.click()
    await until(() => checkRow("start-only")?.getAttribute("aria-pressed") === "true")
    expect(
      container.querySelector('.lazers-trajectory-metadata [role="status"]')?.textContent,
    ).toBe("Duration unavailable · End time was not recorded.")
    metadata = container.querySelector(".lazers-trajectory-inspector .lazers-trajectory-metadata")!
    expect(metadata.textContent).toContain("1793792609000 Unix ms")
    expect(metadata.textContent).toContain("End · unavailable")
    checkRow("end-only")!.click()
    await until(() => checkRow("end-only")?.getAttribute("aria-pressed") === "true")
    expect(
      container.querySelector('.lazers-trajectory-metadata [role="status"]')?.textContent,
    ).toBe("Duration unavailable · Start time was not recorded.")
    metadata = container.querySelector(".lazers-trajectory-inspector .lazers-trajectory-metadata")!
    expect(metadata.textContent).toContain("Start · unavailable")
    expect(metadata.textContent).toContain("1793792610000 Unix ms")
    checkRow("reversed")!.click()
    await until(() => checkRow("reversed")?.getAttribute("aria-pressed") === "true")
    expect(container.querySelector('.lazers-trajectory-metadata [role="alert"]')?.textContent).toBe(
      "Duration unavailable · The recorded end time precedes the start time; duration is unavailable.",
    )
    expect(
      container
        .querySelector('.lazers-trajectory-metadata [role="alert"]')
        ?.getAttribute("aria-live"),
    ).toBe("assertive")
    metadata = container.querySelector(".lazers-trajectory-inspector .lazers-trajectory-metadata")!
    expect(metadata.textContent).toContain("1793792608000 Unix ms")
    expect(metadata.textContent).toContain("1793792607000 Unix ms")

    qualityRows = checkRows("quality")
    qualityRows[1]!.click()
    await until(
      () => markerStarting("Select check quality")?.getAttribute("aria-pressed") === "true",
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
    expect(capturedEvents()).toHaveLength(1)
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
    await until(
      () =>
        statusCalls > beforeStatusCalls &&
        container
          .querySelector('.lazers-trajectory-metadata [role="status"]')
          ?.textContent?.includes("1126 ms") === true,
    )
    expect(markerStarting("Select check quality")?.getAttribute("aria-pressed")).toBe("true")
    expect(markerStarting("Select plan check quality")?.getAttribute("aria-pressed")).toBe("false")
    expect(container.querySelector(".lazers-trajectory-inspector h3")?.textContent).toBe(
      "Attempt 1 · bun test quality",
    )
    expect(capturedEvents()[0]?.querySelector("time")?.textContent).toBe(initialHistoryTime)
    expect(container.querySelector(".lazers-trajectory-capture-note")?.textContent).toBe(
      initialCaptureMetadata,
    )

    capturedEvents()[0]!.click()
    const eventHeading = () =>
      [...container.querySelectorAll<HTMLElement>(".lazers-trajectory-inspector-heading")].find(
        (heading) => heading.querySelector("h3")?.textContent === "VERIFY · accepted",
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

    const loadMore = [...historyDetails.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.includes("Load more activity"),
    )!
    loadMore.click()
    await until(() => capturedEvents().length === 2)
    expect(historyCalls).toEqual([undefined, "captured-page-two"])
    expect(container.querySelector(".lazers-trajectory-capture-note")?.textContent).toBe(
      initialCaptureMetadata,
    )

    const selectedEventTime = eventHeading()?.querySelector(
      ".lazers-trajectory-result",
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
    expect(eventHeading()?.querySelector(".lazers-trajectory-result")?.textContent).toBe(
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
