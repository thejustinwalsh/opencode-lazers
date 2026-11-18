import { expect, test } from "bun:test"
import { Window } from "happy-dom"
import solid from "vite-plugin-solid"
import { build } from "vite"
import { mkdir, rm } from "node:fs/promises"
import { fileURLToPath, pathToFileURL } from "node:url"
import { validProposal } from "../proposal.ts"
import { installTasksLayout } from "./virtual-layout.ts"

/**
 * The Tasks list virtualizes: these tests drive the built panel in Happy DOM with a layout shim
 * (no layout engine here, so the shim gives the list a viewport and rows a height).
 */

const ROW = 32
/** Nothing sits above the tree: the list is task rows only. */
const HEAD = 0

function until(predicate: () => boolean) {
  return (async () => {
    for (let attempt = 0; attempt < 300 && !predicate(); attempt++)
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(predicate()).toBe(true)
  })()
}
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 20))
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`

type Deferred = { promise: Promise<void>; resolve(): void }
function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** Fixture variations; the defaults reproduce the original list. */
type Fixture = {
  /** Beta outranks Alpha: Beta priority 1, Alpha priority 2. */
  prioritized?: boolean
  /** The first two Alpha tasks depend on each other. */
  cycle?: boolean
  /** The first N Alpha tasks have a foreground-active worker. */
  active?: number
  /** The Architect paused dispatch of the Alpha plan. */
  alphaPaused?: boolean
  /** Alpha's first task is ready under a conditional dispatch pause. */
  readyConditionalPause?: boolean
  dependencyPause?: boolean
  betaPaused?: boolean
  /** Task list and detail reads do not identify a task's execution plan. */
  withoutPlanIdentity?: boolean
  /** The topology read fails: Tasks falls back to the scheduling read (if any). */
  topologyUnavailable?: boolean
  /** Serve a scheduling read covering Alpha and Beta. */
  scheduling?: boolean
  /** Alpha's tasks form one dependency chain: every task after the first waits on the one before. */
  alphaChain?: boolean
  /** The N Alpha tasks after the active ones have a worker asking for input (a genuine request). */
  requests?: number
  /** Further titled two-task plans after Beta. */
  extraPlans?: number
  /** Queued pages advertise a next cursor only once opened. */
  queuePagesClosed?: boolean
}

async function withPanel(
  run: (h: Awaited<ReturnType<typeof mountPanel>>) => Promise<void>,
  layout: { paneHeight?: number } = {},
  fixture: Fixture = {},
) {
  const dom = new Window({ url: "http://localhost" })
  Object.defineProperty(dom.window, "innerWidth", { configurable: true, value: 360 })
  const uninstallLayout = installTasksLayout(dom, {
    viewportHeight: 320,
    headHeight: HEAD,
    itemHeights: { task: ROW, loader: ROW },
    ...layout,
  })
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
  const outputDirectory = fileURLToPath(
    new URL(
      `../../node_modules/.cache/tasks-virtual-dom-test-${crypto.randomUUID()}`,
      import.meta.url,
    ),
  )
  let disposeSetup: (() => void) | undefined
  let mounted: { dispose(): void } | undefined
  try {
    const harness = await mountPanel(dom, outputDirectory, fixture)
    disposeSetup = harness.disposeSetup
    mounted = harness.mounted
    await run(harness)
  } finally {
    mounted?.dispose()
    disposeSetup?.()
    await rm(outputDirectory, { recursive: true, force: true })
    for (const name of globalNames) {
      const descriptor = previousGlobals.get(name)
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
    uninstallLayout()
    dom.happyDOM.abort()
  }
}

async function mountPanel(dom: Window, outputDirectory: string, fixture: Fixture) {
  const browserDocument = dom.document as unknown as Document
  const guiRoot = fileURLToPath(new URL("../../src/gui.tsx", import.meta.url))
  const entry = fileURLToPath(new URL("../task-panel/fixtures/tasks-dom-entry.ts", import.meta.url))
  const inferenceRuntimeModule = "\0lazers-test-unused-inference-runtime"
  await mkdir(outputDirectory, { recursive: true })
  await build({
    configFile: false,
    logLevel: "silent",
    resolve: { conditions: ["browser", "development", "module"] },
    define: { __LAZERS_RADAR_WORKER_SOURCE__: JSON.stringify("") },
    plugins: [
      solid(),
      {
        name: "test-unused-inference-runtime",
        enforce: "pre",
        resolveId(source, importer) {
          if (source !== "./webgpu/runtime.ts" || importer !== guiRoot) return
          return inferenceRuntimeModule
        },
        load(id) {
          if (id !== inferenceRuntimeModule) return
          return `export function createInferenceRuntime() { throw new Error("unused") }`
        },
      },
    ],
    build: {
      outDir: outputDirectory,
      emptyOutDir: true,
      minify: false,
      lib: { entry, formats: ["es"], fileName: "tasks-virtual-dom-test" },
      rolldownOptions: { output: { codeSplitting: false } },
    },
  })
  const host = await import(pathToFileURL(`${outputDirectory}/tasks-virtual-dom-test.js`).href)

  const projectID = "tasks-virtual-project"
  const projectDirectory = "/workspace/tasks-virtual"
  const ownerSessionID = "ses-tasks-virtual-owner"
  const proposal = validProposal()

  // Alpha: a long plan. Beta: a fork plan after it (root, two branches, join). Queue: loose tasks.
  let nextID = 1
  const names = new Map<string, string>()
  const make = (name: string) => {
    const id = uuid(nextID++)
    names.set(id, name)
    return id
  }
  const alpha = Array.from({ length: 60 }, (_, index) => make(`Alpha ${index + 1}`))
  const beta = {
    root: make("Beta root"),
    a: make("Beta branch a"),
    b: make("Beta branch b"),
    join: make("Beta join"),
  }
  const betaTasks = [beta.root, beta.a, beta.b, beta.join]
  const queue = Array.from({ length: 90 }, (_, index) => make(`Queue ${index + 1}`))
  const extraPlans = Array.from({ length: fixture.extraPlans ?? 0 }, (_, index) => ({
    id: uuid(9100 + index),
    title: `Gamma ${index + 1} plan`,
    tasks: [make(`Gamma ${index + 1} a`), make(`Gamma ${index + 1} b`)],
  }))
  const activeCount = fixture.active ?? 0
  const active = new Set(alpha.slice(0, activeCount))
  const requests = new Set(alpha.slice(activeCount, activeCount + (fixture.requests ?? 0)))
  const blocked = new Set([beta.a, beta.join])
  const alphaPaused = Boolean(fixture.alphaPaused || fixture.readyConditionalPause)
  const pause = {
    reason: "Paused by Architect for review",
    untilPlans: fixture.dependencyPause || fixture.readyConditionalPause ? [uuid(9555)] : [],
  }
  const stateOf = (taskID: string) =>
    blocked.has(taskID)
      ? "blocked"
      : fixture.readyConditionalPause && taskID === alpha[0]
        ? "ready"
        : "queued"
  const paused = (taskID: string) =>
    Boolean(
      ["queued", "ready"].includes(stateOf(taskID)) &&
      ((alphaPaused && alpha.includes(taskID)) ||
        (fixture.betaPaused && betaTasks.includes(taskID))),
    )
  let queuePagesOpen = !fixture.queuePagesClosed
  const referenceOf = (taskID: string) => `LZ-${[...names.keys()].indexOf(taskID) + 1}`
  const summary = (taskID: string) => ({
    taskID,
    reference: referenceOf(taskID),
    revision: 1,
    status: stateOf(taskID),
    recordedState: stateOf(taskID),
    ...(paused(taskID)
      ? {
          dispatchPause: pause,
          ...(!fixture.withoutPlanIdentity
            ? { dispatchPausePlanID: uuid(alpha.includes(taskID) ? 9001 : 9002) }
            : {}),
        }
      : {}),
    reason: null,
    classification: {
      revision: 1,
      classification: { taxonomy: "task-kind/v1", primaryKind: "feature-implementation" },
      provenance: {
        kind: "embedded",
        sessionID: ownerSessionID,
        createdAt: "2026-11-05T00:00:00.000Z",
      },
    },
    title: names.get(taskID),
    objective: names.get(taskID),
    createdAt: "2026-11-05T00:00:00.000Z",
    sessionID: ownerSessionID,
    matches: [],
  })

  let snapshot = 1
  const queryCalls: Array<{ state?: string; cursor?: string }> = []
  const gates = new Map<string, Deferred>()
  /** `${state}:${cursor}` pages that fail while listed here. */
  const failures = new Set<string>()
  /** `${state}:${cursor}` pages answered with these tasks and next cursor instead. */
  let locationReads = 0
  const pageOverrides = new Map<string, { ids: string[]; nextCursor: string | null }>()
  const pageOf = (ids: string[], nextCursor: string | null, count: number) => ({
    projectDirectory,
    snapshot,
    count,
    tasks: ids.map(summary),
    nextCursor,
    serverTime: "2026-11-05T00:00:00.000Z",
  })
  const query = async (input: { state?: string; cursor?: string }) => {
    queryCalls.push({ state: input.state, cursor: input.cursor })
    const gate = input.cursor ? gates.get(`${input.state}:${input.cursor}`) : undefined
    if (gate) await gate.promise
    if (input.cursor && failures.has(`${input.state}:${input.cursor}`))
      throw new Error("next page unavailable")
    const override = input.cursor ? pageOverrides.get(`${input.state}:${input.cursor}`) : undefined
    if (override) return pageOf(override.ids, override.nextCursor, queue.length)
    if (input.state === "queued") {
      const pageIndex = input.cursor ? Number(input.cursor.split("-")[1]) : 0
      const ids = queue.slice(pageIndex * 30, pageIndex * 30 + 30)
      return pageOf(
        ids,
        pageIndex < 2 && queuePagesOpen ? `queue-${pageIndex + 1}` : null,
        queue.length,
      )
    }
    const ids = [...alpha, ...betaTasks, ...extraPlans.flatMap((plan) => plan.tasks)]
    return pageOf(ids, null, ids.length)
  }
  const node = (taskID: string, ordinal: number) => ({
    taskID,
    reference: referenceOf(taskID),
    revision: 1,
    objective: names.get(taskID),
    ordinal,
    state: stateOf(taskID),
    version: 1,
    reason: null,
    machineVersion: "test-machine",
    machineSupported: true,
    snapshot: null,
    snapshotMatchesState: true,
    waitingOn: [],
  })
  let topologyCalls = 0
  const topology = async () => {
    topologyCalls++
    if (fixture.topologyUnavailable) throw new Error("fixture topology unavailable")
    return topologyResponse()
  }
  const schedulingNode = (taskID: string, ordinal: number, prerequisites: string[]) => ({
    taskID,
    reference: referenceOf(taskID),
    title: names.get(taskID)!,
    objective: names.get(taskID)!,
    ordinal,
    order: ordinal,
    lifecycle: stateOf(taskID),
    decision: paused(taskID) || prerequisites.length ? "waiting" : "eligible",
    reason: paused(taskID) ? pause.reason : null,
    prerequisites,
    waitingOn: prerequisites,
    reservationTaskIDs: [],
  })
  const schedulingRead = async (input: { scope: { kind: string; sessionID: string } }) => ({
    schemaVersion: 1,
    snapshotID: uuid(7001),
    repositoryVersion: snapshot,
    scope: input.scope,
    observedAt: 1,
    coverage: {
      status: "complete",
      planCount: 2,
      coveredPlanCount: 2,
      nodeCount: alpha.length + betaTasks.length,
      coveredNodeCount: alpha.length + betaTasks.length,
      activeReservationCount: 0,
      reservationsComplete: true,
      reason: null,
    },
    next: { status: "none" },
    selectedTaskIDs: [],
    selectionComplete: true,
    plans: [
      {
        planID: uuid(9001),
        planVersion: 1,
        planOrder: 0,
        priority: fixture.prioritized ? 2 : 0,
        title: "Alpha plan",
        lifecycle: "running",
        decision: alphaPaused ? "waiting" : "eligible",
        reason: alphaPaused ? pause.reason : null,
        afterPlans: [],
        nodesComplete: true,
        nodes: alpha.map((taskID, index) =>
          schedulingNode(taskID, index, fixture.alphaChain && index ? [alpha[index - 1]!] : []),
        ),
      },
      {
        planID: uuid(9002),
        planVersion: 1,
        planOrder: 1,
        priority: fixture.prioritized ? 1 : 0,
        title: "Beta plan",
        lifecycle: "running",
        decision: "waiting",
        reason: null,
        afterPlans: [],
        nodesComplete: true,
        nodes: [
          schedulingNode(beta.root, 0, []),
          schedulingNode(beta.a, 1, [beta.root]),
          schedulingNode(beta.b, 2, [beta.root]),
          schedulingNode(beta.join, 3, [beta.a, beta.b]),
        ],
      },
    ],
    nextCursor: null,
  })
  const topologyResponse = () => ({
    schemaVersion: 1,
    projectID,
    scope: { kind: "session", sessionID: ownerSessionID },
    observedAt: "2026-11-05T00:00:00.000Z",
    boundary: {
      repositoryVersion: snapshot,
      sourceRevision: 1,
      sourceFingerprint: "a".repeat(64),
      nativeRevision: 1,
      eventSequence: 1,
    },
    plans: [
      {
        id: uuid(9001),
        revision: 1,
        version: 1,
        state: "queued",
        reason: null,
        title: "Alpha plan",
        afterPlans: [],
        priority: fixture.prioritized ? 2 : 0,
        ...(alphaPaused ? { dispatchPause: pause } : {}),
        nodes: alpha.map(node),
        dependencies: [
          ...(fixture.alphaChain
            ? alpha.slice(1).map((successor, index) => ({ prerequisite: alpha[index]!, successor }))
            : []),
          ...(fixture.cycle
            ? [
                { prerequisite: alpha[1]!, successor: alpha[0]! },
                { prerequisite: alpha[0]!, successor: alpha[1]! },
              ]
            : []),
        ],
      },
      {
        id: uuid(9002),
        revision: 1,
        version: 1,
        state: "queued",
        reason: null,
        title: "Beta plan",
        afterPlans: [],
        priority: fixture.prioritized ? 1 : 0,
        nodes: betaTasks.map(node),
        dependencies: [
          { prerequisite: beta.root, successor: beta.a },
          { prerequisite: beta.root, successor: beta.b },
          { prerequisite: beta.a, successor: beta.join },
          { prerequisite: beta.b, successor: beta.join },
        ],
      },
      ...extraPlans.map((plan) => ({
        id: plan.id,
        revision: 1,
        version: 1,
        state: "queued",
        reason: null,
        title: plan.title,
        afterPlans: [],
        nodes: plan.tasks.map(node),
        dependencies: [],
      })),
    ],
    unplannedTasks: queue.map((taskID) => ({
      taskID,
      title: names.get(taskID),
      status: "queued",
    })),
  })
  const currentActivity = async ({ taskIDs }: { taskIDs: string[] }) => ({
    activities: taskIDs.map((taskID) => ({
      taskID,
      workerSessionID: null,
      attemptID: null,
      foreground: active.has(taskID) ? "active" : "inactive",
      unknownReason: null,
      recordedState: stateOf(taskID),
      waiting: false,
      holdReason: null,
      pendingInput: requests.has(taskID),
      pendingPermissions: 0,
      pendingForms: 0,
      outcome: null,
      observedAt: Date.now(),
    })),
  })
  /** Task IDs whose detail was read, in order. */
  const detailCalls: string[] = []
  const detail = async ({ taskID }: { taskID: string }) => {
    detailCalls.push(taskID)
    return detailOf(taskID)
  }
  const detailOf = (taskID: string) => ({
    status: "found",
    task: {
      schemaVersion: 1,
      id: taskID,
      revision: 1,
      status: "submitted",
      createdAt: "2026-11-05T00:00:00.000Z",
      proposal: { ...proposal, objective: names.get(taskID) },
      provenance: {
        projectID,
        projectDirectory,
        workspaceDirectory: projectDirectory,
        sessionID: ownerSessionID,
        startingRevision: { kind: "unborn" },
      },
    },
    classification: summary(taskID).classification,
    classificationHistory: [summary(taskID).classification],
    advice: null,
    reference: referenceOf(taskID),
    recordedState: stateOf(taskID),
    ...(!fixture.withoutPlanIdentity
      ? {
          execution: {
            ...(paused(taskID) ? { dispatchPause: pause } : {}),
            planID: uuid(alpha.includes(taskID) ? 9001 : 9002),
            taskID,
            state: stateOf(taskID),
            version: 1,
            reason: null,
            waitingOn: [],
          },
        }
      : {}),
    attempts: [],
    activity: [],
  })
  const rpc = {
    query,
    get: detail,
    currentActivity,
    start: async () => ({ status: "existing", planID: uuid(9001), state: "running" }),
  }
  let eventSubscriber: ((event: { type: string; data?: unknown } | undefined) => void) | undefined
  const event = {
    subscribe: ({ signal }: { signal: AbortSignal }) =>
      (async function* () {
        while (!signal.aborted) {
          const next = await new Promise<{ type: string; data?: unknown } | undefined>(
            (resolve) => {
              eventSubscriber = resolve
              signal.addEventListener("abort", () => resolve(undefined), { once: true })
            },
          )
          if (!next) return
          yield next
        }
      })(),
  }
  const client = {
    location: {
      get: async () => {
        locationReads++
        return { project: { canonical: projectDirectory, id: projectID } }
      },
    },
    rpc: (contract: { id?: string }) =>
      contract.id === "lazers.observability"
        ? { topology }
        : contract.id === "lazers.tasks.scheduling" && fixture.scheduling
          ? { read: schedulingRead }
          : rpc,
    event,
  }
  const taskStore = host.createReactiveStore({ projects: {} })
  const registrations: Array<{ token: unknown; value: unknown }> = []
  // The host replaces a session's location object on session updates, fields unchanged.
  const [location, setLocation] = host.createSignal({ directory: projectDirectory })
  // A reconnect gives the same server a new client object.
  const [serverClient, setServerClient] = host.createSignal(client)
  const session = {
    id: ownerSessionID,
    get location() {
      return location()
    },
    directory: projectDirectory,
    server: {
      id: "tasks-server",
      connected: true,
      get client() {
        return serverClient()
      },
    },
  }
  const context = {
    id: "lazers",
    app: { platform: "web" },
    signal: new AbortController().signal,
    ui: (() => {
      const ui = host.createTestUI() as Record<string, unknown>
      ui.IconButton = (props: { label: string; onClick?: (event: MouseEvent) => void }) => {
        const button = browserDocument.createElement("button")
        button.type = "button"
        button.setAttribute("aria-label", props.label)
        button.addEventListener("click", (click) => props.onClick?.(click as MouseEvent))
        return button
      }
      ui.Markdown = (props: { text: string }) => {
        const span = browserDocument.createElement("span")
        span.textContent = props.text
        return span
      }
      ui.Code = (props: { content: string }) => {
        const pre = browserDocument.createElement("pre")
        pre.textContent = props.content
        return pre
      }
      return ui
    })(),
    appearance: { mode: () => "dark", font: () => "monospace" },
    add: (token: unknown, value: unknown) => registrations.push({ token, value }),
    sessions: { current: () => session, list: () => [session] },
    layout: { open: () => {} },
    stores: {
      taskView: () => taskStore,
      modelsView: () => host.createReactiveStore({ projects: {} }),
      trajectoryView: () => host.createReactiveStore({ projects: {} }),
    },
    links: { open: () => {} },
    system: { copy: async () => {} },
    servers: { get: () => ({ connected: true, client }) },
  }
  const disposeSetup = host.setupGui(host.gui, context) as () => void
  const panel = host.taskPanelRegistration(registrations)
  const css = registrations.find(
    (entry) =>
      entry.token === host.registryTokens.Style &&
      typeof entry.value === "string" &&
      entry.value.includes(".lazers-tasks {"),
  )?.value as string
  const style = browserDocument.createElement("style")
  style.textContent = css
  browserDocument.head.append(style)
  const container = browserDocument.createElement("main")
  browserDocument.body.append(container)
  const mounted = host.mountTaskPanel(panel, context, session, container, {
    file: { sync: async () => {}, get: () => undefined, selection: { set: () => {} } },
  }) as { dispose(): void }

  const list = () => container.querySelector<HTMLDivElement>(".lazers-tasks-list")!
  const rows = () => [...container.querySelectorAll<HTMLElement>("[role=treeitem]")]
  const row = (taskID: string) =>
    container.querySelector<HTMLElement>(`[role=treeitem][data-task-id="${taskID}"]`)
  /** The row's own accordion control (a listed row; the first match when a task repeats). */
  const disclosure = (taskID: string) =>
    row(taskID)?.querySelector<HTMLElement>(".lazers-tasks-disclosure") ?? null
  const rowKeys = () => rows().map((item) => item.dataset.itemKey)
  const key = (element: HTMLElement, value: string) =>
    element.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: value, bubbles: true }) as unknown as Event,
    )
  const scrollTo = (top: number) => {
    list().scrollTop = top
    list().dispatchEvent(new dom.window.Event("scroll") as unknown as Event)
  }
  const chooseFilter = (label: string) => {
    const trigger = container.querySelector<HTMLButtonElement>(
      ".lazers-tasks-state-filter button[aria-haspopup=menu]",
    )!
    trigger.click()
    ;[...container.querySelectorAll<HTMLButtonElement>("[role=menuitem]")]
      .find((button) => button.textContent === label)!
      .click()
  }
  const announceChange = () => {
    snapshot++
    eventSubscriber?.({
      type: "rpc.lazers.tasks.changed",
      data: { projectDirectory, version: snapshot },
    })
  }
  /** A live reorder: the first queued task moves down past the next five. */
  const reorderQueueTop = () => {
    const [moved] = queue.splice(0, 1)
    queue.splice(5, 0, moved!)
    announceChange()
    return moved!
  }
  const refreshWithNewRowAbove = () => {
    const inserted = make(`Alpha inserted ${nextID}`)
    alpha.unshift(inserted)
    snapshot++
    eventSubscriber?.({
      type: "rpc.lazers.tasks.changed",
      data: { projectDirectory, version: snapshot },
    })
    return inserted
  }
  const itemOf = (taskID: string) =>
    row(taskID)!.closest<HTMLElement>(".lazers-tasks-virtual-item")!
  const rowTop = (taskID: string) =>
    Number(/translateY\((-?[\d.]+)px\)/u.exec(itemOf(taskID).style.transform)![1]) +
    HEAD -
    list().scrollTop
  return {
    dom,
    disposeSetup,
    mounted,
    container,
    alpha,
    beta,
    queue,
    queryCalls,
    gates,
    failures,
    pageOverrides,
    openQueuePages: () => {
      queuePagesOpen = true
    },
    extraPlans,
    topologyCalls: () => topologyCalls,
    detailCalls,
    /** A session update with the same fields: a new location object for the same directory. */
    touchSession: () => setLocation({ directory: projectDirectory }),
    reconnect: () => setServerClient({ ...client }),
    locationReads: () => locationReads,
    /** The worker's input request is answered; it keeps working (Now) or goes idle. */
    resolveRequest: (taskID: string, keepsWorking: boolean) => {
      requests.delete(taskID)
      if (keepsWorking) active.add(taskID)
    },
    nameOf: (taskID: string) => names.get(taskID)!,
    announceChange,
    reorderQueueTop,
    list,
    rows,
    row,
    disclosure,
    rowKeys,
    key,
    scrollTo,
    chooseFilter,
    refreshWithNewRowAbove,
    rowTop,
    taskStore,
    projectDirectory,
    pause,
  }
}

test("only a window of a long list is mounted, and the tree spans the whole list", async () => {
  await withPanel(async (h) => {
    await until(() => h.rows().length > 0)
    // 60 Alpha tasks and 4 Beta tasks are 64 flat rows: no headings, no sections.
    expect(64).toBeGreaterThan(h.rows().length + 20)
    expect(h.rows().length).toBeGreaterThanOrEqual(10)
    expect(h.rows().length).toBeLessThanOrEqual(10 + 8 + 2)
    expect(h.row(h.alpha[0]!)).not.toBeNull()
    expect(h.row(h.alpha[40]!)).toBeNull()
    expect(h.row(h.beta.join)).toBeNull()
    await settle()
    const tree = h.container.querySelector<HTMLElement>(".lazers-tasks-tree")!
    expect(parseInt(tree.style.height)).toBe(ROW * 64)
    const first = h.row(h.alpha[0]!)!
    expect(first.getAttribute("aria-posinset")).toBe("1")
    expect(first.getAttribute("aria-setsize")).toBe("64")
    expect(first.getAttribute("aria-level")).toBe("1")
    expect(h.rowTop(h.alpha[0]!)).toBe(0)
    h.scrollTo(ROW * 30)
    await until(() => Boolean(h.row(h.alpha[35]!)))
    expect(h.row(h.alpha[1]!)).toBeNull()
    // The selected row (the tab stop) stays mounted so Tab can always enter the tree.
    expect(h.row(h.alpha[0]!)?.tabIndex).toBe(0)
    expect(h.rows().length).toBeLessThanOrEqual(10 + 16 + 2 + 1)
  })
})

test("a mounted row keeps its element across a refresh that inserts a row above, and stays put", async () => {
  await withPanel(async (h) => {
    await until(() => h.rows().length > 0)
    h.scrollTo(ROW * 20 + 5)
    await until(() => Boolean(h.row(h.alpha[22]!)))
    const watched = h.alpha[22]!
    const before = h.row(watched)!
    const topBefore = h.rowTop(watched)
    const scrollBefore = h.list().scrollTop
    const reads = h.queryCalls.length
    h.refreshWithNewRowAbove()
    await until(() => h.queryCalls.length > reads && h.alpha.length === 61)
    await settle()
    await until(() => h.list().scrollTop === scrollBefore + ROW)
    expect(h.row(watched)).toBe(before)
    expect(h.rowTop(watched)).toBe(topBefore)
    expect(h.list().scrollTop).toBe(scrollBefore + ROW)
  })
})

test("the list is plain task rows: no Now, Attention or Next sections and no plan headings or decorations", async () => {
  await withPanel(
    async (h) => {
      await until(() => h.rows().length > 0)
      expect(h.container.querySelector(".lazers-tasks-schedule-groups")).toBeNull()
      expect(h.container.querySelector(".lazers-tasks-plan")).toBeNull()
      expect(h.container.querySelector("[data-scheduling-group]")).toBeNull()
      const tree = h.container.querySelector<HTMLElement>(".lazers-tasks-tree")!
      expect(tree.querySelector("h3")).toBeNull()
      for (const text of ["Now", "Attention", "Next", "Alpha plan", "Priority", "Order"])
        expect(tree.textContent).not.toContain(text)
      expect(h.rows().every((item) => item.getAttribute("aria-level") === "1")).toBe(true)
      // Only the list region lacks plan titles; the rows carry the task title and reference.
      expect(h.row(h.alpha[0]!)?.textContent).toContain("Alpha 1")
    },
    {},
    { scheduling: true, active: 2, requests: 1, prioritized: true },
  )
})

test("tasks sort by priority: 1 first, larger numbers lower, then plan order", async () => {
  await withPanel(
    async (h) => {
      await until(() => h.rows().length > 0)
      // Beta (priority 1) outranks Alpha (priority 2) even though Alpha is the earlier plan.
      expect(h.rows()[0]?.dataset.taskId).toBe(h.beta.root)
      expect(h.rowKeys().slice(0, 4)).toEqual(
        [h.beta.root, h.beta.a, h.beta.b, h.beta.join].map((id) => `task:${id}`),
      )
      expect(h.rows()[4]?.dataset.taskId).toBe(h.alpha[0])
    },
    {},
    { prioritized: true },
  )
  await withPanel(async (h) => {
    await until(() => h.rows().length > 0)
    // No priorities recorded: unprioritized plans keep plan order, Alpha first.
    expect(h.rows()[0]?.dataset.taskId).toBe(h.alpha[0])
  })
})

test("a task with dependencies is a collapsed accordion; expanding lists its dependency tree beneath it", async () => {
  await withPanel(
    async (h) => {
      await until(() => Boolean(h.row(h.beta.root)))
      const keys = () => h.rowKeys().slice(0, 8)
      // Default collapsed: four top-level Beta rows, then Alpha.
      expect(h.row(h.beta.root)?.hasAttribute("aria-expanded")).toBe(false)
      expect(h.row(h.beta.join)?.getAttribute("aria-expanded")).toBe("false")
      expect(h.disclosure(h.beta.root)).toBeNull()
      expect(h.rows().filter((item) => item.hasAttribute("aria-expanded")).length).toBe(3)
      // join depends on a and b; both depend on root. Expand join, then its a branch.
      h.disclosure(h.beta.join)!.click()
      await until(() => h.row(h.beta.join)?.getAttribute("aria-expanded") === "true")
      const join = `task:${h.beta.join}`
      expect(keys()).toEqual([
        `task:${h.beta.root}`,
        `task:${h.beta.a}`,
        `task:${h.beta.b}`,
        join,
        `${join}>${h.beta.a}`,
        `${join}>${h.beta.b}`,
        `task:${h.alpha[0]}`,
        `task:${h.alpha[1]}`,
      ])
      const nested = h.container.querySelector<HTMLElement>(
        `[data-item-key="${join}>${h.beta.a}"]`,
      )!
      expect(nested.getAttribute("aria-level")).toBe("2")
      expect(nested.dataset.depth).toBe("1")
      expect(nested.getAttribute("aria-expanded")).toBe("false")
      // The nested row expands in turn: root repeats beneath a, though it is also listed on top.
      nested.querySelector<HTMLElement>(".lazers-tasks-disclosure")!.click()
      await until(() => nested.getAttribute("aria-expanded") === "true")
      expect(h.rowKeys()).toContain(`${join}>${h.beta.a}>${h.beta.root}`)
      expect(
        h.rows().filter((item) => item.dataset.taskId === h.beta.root).length,
      ).toBeGreaterThanOrEqual(2)
      // Collapsing the parent hides the whole subtree; the nested expansion is remembered.
      h.disclosure(h.beta.join)!.click()
      await until(() => h.row(h.beta.join)?.getAttribute("aria-expanded") === "false")
      expect(h.rowKeys().some((key) => key?.includes(">"))).toBe(false)
    },
    {},
    { prioritized: true },
  )
})

test("dependency cycles expand once and stop", async () => {
  await withPanel(
    async (h) => {
      await until(() => Boolean(h.row(h.alpha[0]!)))
      const a = `task:${h.alpha[0]}`
      h.disclosure(h.alpha[0]!)!.click()
      await until(() => h.row(h.alpha[0]!)?.getAttribute("aria-expanded") === "true")
      const child = () =>
        h.container.querySelector<HTMLElement>(`[data-item-key="${a}>${h.alpha[1]}"]`)!
      expect(child()).not.toBeNull()
      child().querySelector<HTMLElement>(".lazers-tasks-disclosure")!.click()
      await until(() => child().getAttribute("aria-expanded") === "true")
      // alpha[0] reappears under alpha[1] as a leaf: listed, never expandable.
      const loop = h.container.querySelector<HTMLElement>(
        `[data-item-key="${a}>${h.alpha[1]}>${h.alpha[0]}"]`,
      )!
      expect(loop).not.toBeNull()
      expect(loop.hasAttribute("aria-expanded")).toBe(false)
      expect(h.rowKeys().filter((key) => key?.startsWith(`${a}>`))).toHaveLength(2)
    },
    {},
    { cycle: true },
  )
})

test("keyboard: Right expands then enters, Left leaves then collapses, Enter opens details, Up and Down move", async () => {
  await withPanel(
    async (h) => {
      await until(() => Boolean(h.row(h.beta.join)))
      const doc = h.container.ownerDocument
      const join = h.row(h.beta.join)!
      join.focus()
      h.key(join, "ArrowRight")
      await until(() => h.row(h.beta.join)?.getAttribute("aria-expanded") === "true")
      const key = `task:${h.beta.join}>${h.beta.a}`
      const item = () => h.container.querySelector<HTMLElement>(`[data-item-key="${key}"]`)
      expect(item()).not.toBeNull()
      // Right again enters the first dependency.
      h.key(h.row(h.beta.join)!, "ArrowRight")
      await until(() => doc.activeElement === item())
      // Down moves to the next dependency, Up back; Left returns to the parent.
      h.key(item()!, "ArrowDown")
      await until(
        () =>
          (doc.activeElement as HTMLElement | null)?.dataset.itemKey?.endsWith(h.beta.b) ?? false,
      )
      h.key(doc.activeElement as HTMLElement, "ArrowUp")
      await until(() => doc.activeElement === item())
      h.key(item()!, "ArrowLeft")
      await until(() => doc.activeElement === h.row(h.beta.join))
      // Left on an expanded row collapses it; Left on a collapsed top-level row is a no-op.
      h.key(h.row(h.beta.join)!, "ArrowLeft")
      await until(() => h.row(h.beta.join)?.getAttribute("aria-expanded") === "false")
      h.key(h.row(h.beta.join)!, "ArrowLeft")
      expect(h.row(h.beta.join)?.getAttribute("aria-expanded")).toBe("false")
      // Enter opens the task's details.
      h.key(h.row(h.beta.join)!, "Enter")
      await until(() => h.row(h.beta.join)?.getAttribute("aria-selected") === "true")
      await until(() => h.detailCalls.includes(h.beta.join))
      expect(h.container.querySelector(".lazers-tasks-detail")?.textContent).toContain("Beta join")
    },
    {},
    { prioritized: true },
  )
})

test("arrow keys, Home and End walk rows that are not mounted", async () => {
  await withPanel(async (h) => {
    await until(() => Boolean(h.row(h.alpha[0]!)))
    const doc = h.container.ownerDocument
    const first = h.row(h.alpha[0]!)!
    first.focus()
    h.key(first, "End")
    // The last row is the Beta join, 64 rows down: never mounted until the key reaches it.
    await until(() => h.row(h.beta.join)?.getAttribute("aria-selected") === "true")
    await until(() => doc.activeElement === h.row(h.beta.join))
    await until(() => h.row(h.alpha[0]!) === null)
    h.key(h.row(h.beta.join)!, "ArrowUp")
    await until(() => h.row(h.beta.b)?.getAttribute("aria-selected") === "true")
    await until(() => doc.activeElement === h.row(h.beta.b))
    h.key(h.row(h.beta.b)!, "Home")
    await until(() => h.row(h.alpha[0]!)?.getAttribute("aria-selected") === "true")
    await until(() => doc.activeElement === h.row(h.alpha[0]!))
    h.key(h.row(h.alpha[0]!)!, "ArrowDown")
    await until(() => h.row(h.alpha[1]!)?.getAttribute("aria-selected") === "true")
    for (let step = 2; step <= 14; step++) {
      h.key(h.row(h.alpha[step - 1]!)!, "ArrowDown")
      await until(() => h.row(h.alpha[step]!)?.getAttribute("aria-selected") === "true")
      await until(() => doc.activeElement === h.row(h.alpha[step]!))
    }
  })
})

test("rows end in icon-only signals: a neutral link icon and the state icon, with no sequencing icon", async () => {
  await withPanel(
    async (h) => {
      await until(() => Boolean(h.row(h.beta.root)))
      const entry = (taskID: string) => h.row(taskID)!
      // No sequencing icon, tooltip or label anywhere in a row.
      for (const taskID of [h.alpha[0]!, h.beta.root, h.beta.join]) {
        expect(entry(taskID).querySelector(".lazers-tasks-sequence")).toBeNull()
        expect(entry(taskID).getAttribute("aria-label")).not.toMatch(/sequenced|parallel/iu)
      }
      expect(
        entry(h.alpha[0]!).querySelector(".lazers-tasks-state")?.getAttribute("aria-label"),
      ).toBe("Queued")
      // Link icons are neutral: no tone attribute that could select a status color.
      for (const link of h.container.querySelectorAll(".lazers-tasks-row-blocker"))
        expect((link as HTMLElement).dataset.tone).toBeUndefined()
      // Signals sit last, after the title; the glyphs are icons, not text.
      const order = [...entry(h.alpha[0]!).querySelectorAll(".lazers-tasks-row > *")].map(
        (el) => el.className,
      )
      expect(order.at(-1)).toContain("signals")
      const signalText = entry(h.alpha[0]!).querySelector(".lazers-tasks-row-signals")!.textContent!
      expect(signalText).not.toMatch(/Queued/u)
    },
    {},
    { prioritized: true },
  )
})

test("the inspector carries one meta line: priority, plan and step; sequencing only with dependencies", async () => {
  await withPanel(
    async (h) => {
      await until(() => Boolean(h.row(h.beta.join)))
      h.row(h.beta.join)!.click()
      await until(() => h.detailCalls.includes(h.beta.join))
      const metas = () =>
        [
          ...h.container.querySelectorAll<HTMLElement>(".lazers-tasks-detail .lazers-tasks-meta"),
        ].map((element) => element.textContent ?? "")
      await until(() => metas().some((text) => text.includes("Beta plan")))
      expect(metas()[0]).toBe("Priority 1 · Beta plan · step 4")
      expect(metas().some((text) => text.includes("Runs after"))).toBe(true)
      expect(h.container.querySelector(".lazers-tasks-scheduling-facts")).toBeNull()
      h.row(h.alpha[0]!)!.click()
      await until(() => h.detailCalls.includes(h.alpha[0]!))
      await until(() => metas().some((text) => text.includes("Alpha plan")))
      expect(metas()[0]).toContain("Priority 2 · Alpha plan")
      // No dependencies: no Sequencing line at all.
      expect(metas().some((text) => /Parallel|sequenc|Runs after/iu.test(text))).toBe(false)
    },
    {},
    { scheduling: true, prioritized: true },
  )
})

test("each listed row carries a right-aligned priority cell, blank for none and for nested rows", async () => {
  await withPanel(
    async (h) => {
      await until(() => Boolean(h.row(h.beta.join)))
      const cell = (taskID: string) =>
        h.row(taskID)!.querySelector<HTMLElement>(".lazers-tasks-row-priority")
      expect(cell(h.beta.join)?.textContent).toBe("1")
      expect(cell(h.alpha[0]!)?.textContent).toBe("2")
      // Every row keeps the cell so the reference column stays aligned.
      for (const item of h.container.querySelectorAll('[role="treeitem"]'))
        expect(item.querySelector(".lazers-tasks-row-priority")).not.toBeNull()
      // Nested dependency rows leave it blank.
      h.key(h.row(h.beta.join)!, "ArrowRight")
      await until(() => h.row(h.beta.join)?.getAttribute("aria-expanded") === "true")
      const nested = h.container.querySelector<HTMLElement>(
        `[data-item-key="task:${h.beta.join}>${h.beta.a}"] .lazers-tasks-row-priority`,
      )
      expect(nested?.textContent).toBe("")
    },
    {},
    { prioritized: true },
  )
})

test("the disclosure chevron is a named button that toggles without selecting", async () => {
  await withPanel(
    async (h) => {
      await until(() => Boolean(h.row(h.beta.join)))
      const button = () =>
        h.row(h.beta.join)!.querySelector<HTMLButtonElement>("button.lazers-tasks-disclosure")!
      expect(button().tagName).toBe("BUTTON")
      expect(button().getAttribute("aria-expanded")).toBe("false")
      expect(button().getAttribute("aria-label")).toMatch(/^Expand /u)
      expect(button().tabIndex).toBe(-1)
      button().click()
      await until(() => h.row(h.beta.join)?.getAttribute("aria-expanded") === "true")
      expect(button().getAttribute("aria-label")).toMatch(/^Collapse /u)
      expect(h.row(h.beta.join)?.getAttribute("aria-selected")).not.toBe("true")
    },
    {},
    { prioritized: true },
  )
})

test("changing the filter keeps the selection and never blanks the inspector", async () => {
  await withPanel(async (h) => {
    await until(() => Boolean(h.row(h.alpha[1]!)))
    h.row(h.alpha[1]!)!.click()
    const detail = () => h.container.querySelector(".lazers-tasks-detail")?.textContent ?? ""
    await until(() => detail().includes("Alpha 2"))
    h.chooseFilter("All")
    for (let step = 0; step < 40; step++) {
      expect(detail()).not.toContain("Loading task")
      expect(detail()).toContain("Alpha 2")
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
    await until(() => h.queryCalls.at(-1)?.state === "all" && Boolean(h.row(h.alpha[1]!)))
    expect(h.row(h.alpha[1]!)?.getAttribute("aria-selected")).toBe("true")
    // A filter that does not list the task keeps the inspector's content.
    h.chooseFilter("Queued")
    await until(() => h.queryCalls.at(-1)?.state === "queued" && Boolean(h.row(h.queue[0]!)))
    expect(detail()).toContain("Alpha 2")
    expect(detail()).not.toContain("Loading task")
  })
})

test("at the list top a live reorder of the first rows keeps scrollTop", async () => {
  await withPanel(async (h) => {
    await until(() => h.rows().length > 0)
    h.chooseFilter("Queued")
    await until(() => h.queryCalls.at(-1)?.state === "queued" && Boolean(h.row(h.queue[0]!)))
    await settle()
    h.scrollTo(0)
    for (let round = 0; round < 2; round++) {
      const reads = h.queryCalls.length
      const moved = h.reorderQueueTop()
      await until(() => h.queryCalls.length > reads)
      await until(() => h.rows()[5]?.dataset.taskId === moved)
      await settle()
      expect(h.list().scrollTop).toBe(0)
      expect(h.rows()[0]?.dataset.taskId).toBe(h.queue[0])
    }
  })
})

test("the next page loads once as the end comes into range, for the current filter only", async () => {
  await withPanel(async (h) => {
    await until(() => h.rows().length > 0)
    h.chooseFilter("Queued")
    await until(() => h.queryCalls.at(-1)?.state === "queued" && h.rows().length > 0)
    await settle()
    // Thirty rows and a loader: the end is far from the top, so nothing is requested yet.
    expect(h.queryCalls.filter((call) => call.state === "queued" && call.cursor)).toHaveLength(0)
    const gate = deferred()
    h.gates.set("queued:queue-1", gate)
    // Near the end (30 rows + loader = 992px; viewport 320): scroll events repeat, the request does not.
    for (const top of [400, 560, 640, 700, 700, 640]) h.scrollTo(top)
    await until(() =>
      h.queryCalls.some((call) => call.state === "queued" && call.cursor === "queue-1"),
    )
    h.scrollTo(720)
    h.scrollTo(700)
    await settle()
    expect(
      h.queryCalls.filter((call) => call.state === "queued" && call.cursor === "queue-1"),
    ).toHaveLength(1)
    // Switch filters before the page resolves: the stale page must never be appended.
    h.chooseFilter("Running")
    await until(() => h.queryCalls.at(-1)?.state === "running")
    gate.resolve()
    await settle()
    await until(() => h.rows().length > 0)
    expect(h.container.textContent).not.toContain("Queue 31")
    expect(h.rows().some((row) => row.getAttribute("aria-label")?.includes("Queue"))).toBe(false)
    expect(
      h.queryCalls.filter((call) => call.state === "queued" && call.cursor === "queue-1"),
    ).toHaveLength(1)
    // Back on Queued, pages load on demand with their own cursors, each once.
    h.chooseFilter("Queued")
    await until(() => h.queryCalls.at(-1)?.state === "queued" && Boolean(h.row(h.queue[0]!)))
    await until(() => {
      h.scrollTo(h.list().scrollHeight)
      return h.queryCalls.some((call) => call.cursor === "queue-2")
    })
    expect(
      h.queryCalls.filter((call) => call.state === "queued" && call.cursor === "queue-2"),
    ).toHaveLength(1)
  })
})

test("a failed next page shows its own retry and is not requested again until Retry", async () => {
  await withPanel(async (h) => {
    await until(() => h.rows().length > 0)
    h.chooseFilter("Queued")
    await until(() => h.queryCalls.at(-1)?.state === "queued" && Boolean(h.row(h.queue[0]!)))
    h.failures.add("queued:queue-1")
    const pageOne = () =>
      h.queryCalls.filter((call) => call.state === "queued" && call.cursor === "queue-1").length
    const loader = () => h.container.querySelector<HTMLElement>(".lazers-tasks-loader")
    await until(() => {
      h.scrollTo(h.list().scrollHeight)
      return pageOne() === 1
    })
    await until(() => Boolean(loader()?.textContent?.includes("Could not load more tasks.")))
    // The page failure belongs to the loader: the list keeps no error banner.
    expect(h.container.querySelector(".lazers-tasks-list > .lazers-tasks-error")).toBeNull()
    // Past the list's retry delay, through a live refresh and further scrolling: one request.
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    const reads = h.queryCalls.length
    h.announceChange()
    await until(() => h.queryCalls.length > reads)
    await settle()
    h.scrollTo(h.list().scrollHeight - 40)
    h.scrollTo(h.list().scrollHeight)
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    expect(pageOne()).toBe(1)
    expect(loader()?.textContent).toContain("Could not load more tasks.")
    // Retry asks once more; the page lands.
    h.failures.clear()
    const retry = [...loader()!.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Retry",
    )!
    retry.click()
    await until(() => pageOne() === 2)
    // Rows 31+ follow the first page.
    h.scrollTo(ROW * 28)
    await until(() => Boolean(h.row(h.queue[30]!)))
    expect(pageOne()).toBe(2)
  })
})

test("a next page that repeats its cursor or lists nothing new is requested once until Retry", async () => {
  await withPanel(async (h) => {
    await until(() => h.rows().length > 0)
    h.chooseFilter("Queued")
    await until(() => h.queryCalls.at(-1)?.state === "queued" && Boolean(h.row(h.queue[0]!)))
    // queue-1 lists the first page again and points back at itself: it never advances.
    h.pageOverrides.set("queued:queue-1", { ids: h.queue.slice(0, 30), nextCursor: "queue-1" })
    const asked = (cursor: string) =>
      h.queryCalls.filter((call) => call.state === "queued" && call.cursor === cursor).length
    const loader = () => h.container.querySelector<HTMLElement>(".lazers-tasks-loader")
    const retry = () =>
      [...(loader()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
        (button) => button.textContent === "Retry",
      )
    await until(() => {
      h.scrollTo(h.list().scrollHeight)
      return asked("queue-1") === 1
    })
    await until(() => Boolean(retry()))
    // The loader stays in view; scroll events keep coming; the cursor is not read again.
    for (let round = 0; round < 5; round++) {
      h.scrollTo(h.list().scrollHeight - 40)
      h.scrollTo(h.list().scrollHeight)
      await settle()
    }
    expect(asked("queue-1")).toBe(1)
    expect(loader()?.textContent).toContain("Could not load more tasks.")
    // Retry reads it exactly once more; the cycle stops again.
    retry()!.click()
    await until(() => asked("queue-1") === 2 && Boolean(retry()))
    await settle()
    expect(asked("queue-1")).toBe(2)
    // A fresh cursor with no new task is no progress either: the fresh cursor is not followed.
    h.pageOverrides.set("queued:queue-1", { ids: [], nextCursor: "queue-2" })
    retry()!.click()
    await until(() => asked("queue-1") === 3 && Boolean(retry()))
    h.scrollTo(h.list().scrollHeight)
    await settle()
    expect(asked("queue-2")).toBe(0)
    // Once the page advances, Retry continues and rows 31+ follow.
    h.pageOverrides.clear()
    retry()!.click()
    await until(() => asked("queue-1") === 4)
    h.scrollTo(ROW * 28)
    await until(() => Boolean(h.row(h.queue[30]!)))
  })
})

test("a pinned selected row near the end does not page; the viewport reaching the end does", async () => {
  await withPanel(
    async (h) => {
      await until(() => h.rows().length > 0)
      h.chooseFilter("Queued")
      await until(() => h.queryCalls.at(-1)?.state === "queued" && Boolean(h.row(h.queue[0]!)))
      const doc = h.container.ownerDocument
      // Select and focus a row near the end of the 30 listed, then return the viewport to the top.
      h.scrollTo(h.list().scrollHeight)
      await until(() => Boolean(h.row(h.queue[27]!)))
      h.row(h.queue[27]!)!.click()
      await until(() => h.row(h.queue[27]!)?.getAttribute("aria-selected") === "true")
      // Selection focuses its row once the detail loads; wait for that before scrolling away.
      await until(() => doc.activeElement === h.row(h.queue[27]!))
      await settle()
      h.scrollTo(0)
      await until(() => Boolean(h.row(h.queue[0]!)))
      // The selected, focused row stays mounted far below the viewport.
      expect(h.row(h.queue[27]!)).not.toBeNull()
      await until(() => h.row(h.queue[20]!) === null)
      expect(doc.activeElement).toBe(h.row(h.queue[27]!))
      // A next page appears with the viewport at the top.
      const loaded = h.queryCalls.length
      h.openQueuePages()
      h.announceChange()
      await until(() => h.queryCalls.length > loaded)
      // The loader joins the list (offscreen, so unmounted): 30 rows and a loader row.
      const tree = () => h.container.querySelector<HTMLElement>(".lazers-tasks-tree")!
      await until(() => parseInt(tree().style.height) >= ROW * 31)
      for (let round = 0; round < 3; round++) {
        h.scrollTo(round)
        await settle()
      }
      const paged = () =>
        h.queryCalls.filter((call) => call.state === "queued" && call.cursor === "queue-1").length
      expect(h.row(h.queue[27]!)).not.toBeNull()
      expect(paged()).toBe(0)
      expect(parseInt(tree().style.height)).toBe(ROW * 31)
      expect(h.container.querySelector(".lazers-tasks-loader")).toBeNull()
      // The viewport itself nearing the end still pages, once.
      await until(() => {
        h.scrollTo(h.list().scrollHeight)
        return paged() === 1
      })
      await settle()
      expect(paged()).toBe(1)
    },
    {},
    { queuePagesClosed: true },
  )
})
