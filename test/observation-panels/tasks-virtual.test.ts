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
const HEAD = 80
const PLAN_HEIGHT = 40

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
  /** The first N Alpha tasks have a foreground-active worker (Now). */
  active?: number
  /** The Architect paused dispatch of the Alpha plan. */
  alphaPaused?: boolean
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
    itemHeights: { task: ROW, plan: PLAN_HEIGHT, note: 28, loader: ROW },
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
  const pause = { reason: "Paused by Architect for review", untilPlans: [] as string[] }
  const paused = (taskID: string) =>
    Boolean(fixture.alphaPaused && alpha.includes(taskID) && stateOf(taskID) === "queued")
  let queuePagesOpen = !fixture.queuePagesClosed
  const blocked = new Set([beta.a, beta.join])
  const referenceOf = (taskID: string) => `LZ-${[...names.keys()].indexOf(taskID) + 1}`
  const stateOf = (taskID: string) => (blocked.has(taskID) ? "blocked" : "queued")
  const summary = (taskID: string) => ({
    taskID,
    reference: referenceOf(taskID),
    revision: 1,
    status: stateOf(taskID),
    recordedState: stateOf(taskID),
    ...(paused(taskID) ? { dispatchPause: pause } : {}),
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
        priority: 0,
        title: "Alpha plan",
        lifecycle: "running",
        decision: fixture.alphaPaused ? "waiting" : "eligible",
        reason: fixture.alphaPaused ? pause.reason : null,
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
        priority: 0,
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
        ...(fixture.alphaPaused ? { dispatchPause: pause } : {}),
        nodes: alpha.map(node),
        dependencies: fixture.alphaChain
          ? alpha.slice(1).map((successor, index) => ({ prerequisite: alpha[index]!, successor }))
          : [],
      },
      {
        id: uuid(9002),
        revision: 1,
        version: 1,
        state: "queued",
        reason: null,
        title: "Beta plan",
        afterPlans: [],
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
    execution: {
      ...(paused(taskID) ? { dispatchPause: pause } : {}),
      planID: uuid(9001),
      taskID,
      state: stateOf(taskID),
      version: 1,
      reason: null,
      waitingOn: [],
    },
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
    location: { get: async () => ({ project: { canonical: projectDirectory, id: projectID } }) },
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
  const session = {
    id: ownerSessionID,
    location: { directory: projectDirectory },
    directory: projectDirectory,
    server: { id: "tasks-server", connected: true, client },
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
  const attention = (taskID: string) =>
    container.querySelector<HTMLButtonElement>(
      `[data-scheduling-group="attention"][data-scheduling-task-id="${taskID}"]`,
    )
  const key = (element: HTMLElement, value: string) =>
    element.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: value, bubbles: true }) as unknown as Event,
    )
  const scrollTo = (top: number) => {
    list().scrollTop = top
    list().dispatchEvent(new dom.window.Event("scroll") as unknown as Event)
  }
  const chooseFilter = (label: string) => {
    const trigger = [
      ...container.querySelectorAll<HTMLButtonElement>("button[aria-haspopup=menu]"),
    ].find((button) => button.getAttribute("aria-label")?.startsWith("State:"))!
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
    nameOf: (taskID: string) => names.get(taskID)!,
    announceChange,
    reorderQueueTop,
    list,
    rows,
    row,
    attention,
    key,
    scrollTo,
    chooseFilter,
    refreshWithNewRowAbove,
    rowTop,
    taskStore,
    projectDirectory,
  }
}

test("only a window of a long list is mounted, and the tree spans the whole list", async () => {
  await withPanel(async (h) => {
    await until(() => h.rows().length > 0 && Boolean(h.attention(h.beta.a)))
    const total = 1 + 60 + 1 + 3 // Alpha heading + rows, Beta heading, root/join... (fork collapsed)
    expect(total).toBeGreaterThan(h.rows().length + 20)
    // Viewport 320px: 10 rows plus overscan below. Far fewer than the 64 rows in the model.
    expect(h.rows().length).toBeGreaterThanOrEqual(10)
    expect(h.rows().length).toBeLessThanOrEqual(10 + 8 + 2)
    expect(h.row(h.alpha[0]!)).not.toBeNull()
    expect(h.row(h.alpha[40]!)).toBeNull()
    expect(h.row(h.beta.join)).toBeNull()
    await settle()
    const tree = h.container.querySelector<HTMLElement>(".lazers-tasks-tree")!
    // Alpha heading (measured 40) + 60 rows + root + join (fork collapsed) + Beta heading, which is
    // not mounted and so still carries its 36px estimate.
    expect(parseInt(tree.style.height)).toBe(PLAN_HEIGHT + 36 + ROW * 62)
    // Every mounted row sits at its flat offset; positions follow list order.
    const first = h.row(h.alpha[0]!)!
    expect(first.getAttribute("aria-posinset")).toBe("1")
    expect(first.getAttribute("aria-setsize")).toBe("60")
    expect(h.rowTop(h.alpha[0]!)).toBe(HEAD + PLAN_HEIGHT)
    // Scrolling swaps the window: the first rows unmount, later rows mount.
    h.scrollTo(HEAD + PLAN_HEIGHT + ROW * 30)
    await until(() => Boolean(h.row(h.alpha[35]!)))
    expect(h.row(h.alpha[1]!)).toBeNull()
    // The selected row (the tab stop) stays mounted so Tab can always enter the tree.
    expect(h.row(h.alpha[0]!)?.tabIndex).toBe(0)
    expect(h.rows().length).toBeLessThanOrEqual(10 + 16 + 2 + 1)
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

test("a mounted row keeps its element across a refresh that inserts a row above, and stays put", async () => {
  await withPanel(async (h) => {
    await until(() => h.rows().length > 0)
    h.scrollTo(HEAD + PLAN_HEIGHT + ROW * 20 + 5)
    await until(() => Boolean(h.row(h.alpha[22]!)))
    const watched = h.alpha[22]!
    const before = h.row(watched)!
    const topBefore = h.rowTop(watched)
    const scrollBefore = h.list().scrollTop
    const reads = h.queryCalls.length
    h.refreshWithNewRowAbove()
    await until(() => h.queryCalls.length > reads && h.alpha.length === 61)
    // The new row sits above the viewport: the scroll offset moves by exactly its height.
    await settle()
    await until(() => h.list().scrollTop === scrollBefore + ROW)
    expect(h.row(watched)).toBe(before)
    expect(h.rowTop(watched)).toBe(topBefore)
    expect(h.list().scrollTop).toBe(scrollBefore + ROW)
  })
})

test("selecting an Attention task inside a collapsed fork or plan expands it, mounts, selects and focuses the row", async () => {
  await withPanel(async (h) => {
    await until(() => Boolean(h.attention(h.beta.a)) && Boolean(h.attention(h.beta.join)))
    const doc = h.container.ownerDocument
    // Beta sits below 60 Alpha rows: it is not mounted, and its fork is collapsed.
    expect(h.row(h.beta.root)).toBeNull()
    expect(h.row(h.beta.a)).toBeNull()
    h.attention(h.beta.a)!.click()
    await until(() => h.row(h.beta.a)?.getAttribute("aria-selected") === "true")
    await until(() => doc.activeElement === h.row(h.beta.a))
    expect(h.row(h.beta.root)?.getAttribute("aria-expanded")).toBe("true")
    // Beta heading (level 1) > fork root (level 2) > branch row (level 3).
    expect(h.row(h.beta.root)?.getAttribute("aria-level")).toBe("2")
    expect(h.row(h.beta.a)?.getAttribute("aria-level")).toBe("3")
    expect(h.list().scrollTop).toBeGreaterThan(ROW * 40)

    // Collapse the Beta plan from its heading, return to the top, then reach for its join.
    const heading = () =>
      [...h.container.querySelectorAll<HTMLElement>(".lazers-tasks-plan[role=treeitem]")].find(
        (item) => item.textContent?.includes("Beta plan"),
      )
    expect(heading()?.getAttribute("aria-expanded")).toBe("true")
    expect(heading()?.getAttribute("aria-level")).toBe("1")
    heading()!.querySelector<HTMLElement>(".lazers-tasks-plan-heading")!.click()
    await until(() => heading()?.getAttribute("aria-expanded") === "false")
    expect(h.row(h.beta.root)).toBeNull()
    expect(h.row(h.beta.join)).toBeNull()
    h.scrollTo(0)
    await until(() => Boolean(h.row(h.alpha[0]!)))
    h.attention(h.beta.join)!.click()
    await until(() => h.row(h.beta.join)?.getAttribute("aria-selected") === "true")
    await until(() => doc.activeElement === h.row(h.beta.join))
    expect(heading()?.getAttribute("aria-expanded")).toBe("true")
    expect(h.row(h.beta.root)).not.toBeNull()
  })
})

test("arrow keys, Home and End walk rows that are not mounted", async () => {
  await withPanel(async (h) => {
    await until(() => Boolean(h.row(h.alpha[0]!)))
    const doc = h.container.ownerDocument
    const first = h.row(h.alpha[0]!)!
    first.focus()
    h.key(first, "End")
    // The last row is a join 64 rows down: never mounted until the key reaches it.
    await until(() => h.row(h.beta.join)?.getAttribute("aria-selected") === "true")
    await until(() => doc.activeElement === h.row(h.beta.join))
    await until(() => h.row(h.alpha[0]!) === null)
    h.key(h.row(h.beta.join)!, "ArrowUp")
    await until(() => h.row(h.beta.root)?.getAttribute("aria-selected") === "true")
    await until(() => doc.activeElement === h.row(h.beta.root))
    // Down from the last Attention entry enters the first task, which has scrolled out of the window.
    const last = [
      ...h.container.querySelectorAll<HTMLButtonElement>("[data-scheduling-task-id]"),
    ].at(-1)!
    last.focus()
    h.key(last, "ArrowDown")
    await until(() => h.row(h.alpha[0]!)?.getAttribute("aria-selected") === "true")
    await until(() => doc.activeElement === h.row(h.alpha[0]!))
    // ArrowDown steps through the model order; Home returns to the first tree item, Alpha's heading.
    h.key(h.row(h.alpha[0]!)!, "ArrowDown")
    await until(() => h.row(h.alpha[1]!)?.getAttribute("aria-selected") === "true")
    for (let step = 2; step <= 14; step++) {
      h.key(h.row(h.alpha[step - 1]!)!, "ArrowDown")
      await until(() => h.row(h.alpha[step]!)?.getAttribute("aria-selected") === "true")
      await until(() => doc.activeElement === h.row(h.alpha[step]!))
    }
    expect(h.row(h.alpha[14]!)).not.toBeNull()
    h.key(h.row(h.alpha[14]!)!, "Home")
    const alphaHeading = () =>
      h.container.querySelector<HTMLElement>(".lazers-tasks-plan[role=treeitem]")
    await until(() => doc.activeElement === alphaHeading())
    expect(alphaHeading()?.textContent).toContain("Alpha plan")
    h.key(alphaHeading()!, "ArrowDown")
    await until(() => h.row(h.alpha[0]!)?.getAttribute("aria-selected") === "true")
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
    h.scrollTo(HEAD + ROW * 28)
    await until(() => Boolean(h.row(h.queue[30]!)))
    expect(pageOne()).toBe(2)
  })
})

test("at the list top, with the head above the tree, a live reorder of the first rows keeps scrollTop", async () => {
  await withPanel(async (h) => {
    await until(() => h.rows().length > 0)
    h.chooseFilter("Queued")
    await until(() => h.queryCalls.at(-1)?.state === "queued" && Boolean(h.row(h.queue[0]!)))
    await settle()
    // At the top, the head (Now/Attention/Next, 80px here) sits above the first tree row.
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
    // Scrolled partway into the head: still the head's view, still no row anchor.
    h.scrollTo(40)
    const reads = h.queryCalls.length
    h.reorderQueueTop()
    await until(() => h.queryCalls.length > reads)
    await settle()
    expect(h.list().scrollTop).toBe(40)
  })
})

test("collapsing a plan keeps the fitted split; plan headings are level-1 tree items", async () => {
  await withPanel(
    async (h) => {
      await until(() => h.rows().length > 0)
      await settle()
      const separator = () =>
        h.container.querySelector<HTMLElement>(".lazers-tasks-separator[role=separator]")!
      const plan = (title: string) =>
        [...h.container.querySelectorAll<HTMLElement>(".lazers-tasks-plan[role=treeitem]")].find(
          (item) => item.textContent?.includes(title),
        )
      const fitted = separator().getAttribute("aria-valuenow")
      // Alpha heading, then Beta heading: one top-level sibling set; Alpha's rows sit below it.
      const alpha = plan("Alpha plan")!
      expect(alpha.getAttribute("aria-level")).toBe("1")
      expect(alpha.getAttribute("aria-posinset")).toBe("1")
      expect(alpha.getAttribute("aria-setsize")).toBe("2")
      expect(alpha.getAttribute("aria-expanded")).toBe("true")
      expect(h.row(h.alpha[0]!)?.getAttribute("aria-level")).toBe("2")
      // Left from a plan row reaches its heading, whose own keys collapse and expand it.
      const doc = h.container.ownerDocument
      h.row(h.alpha[0]!)!.focus()
      h.key(h.row(h.alpha[0]!)!, "ArrowLeft")
      await until(() => doc.activeElement === plan("Alpha plan"))
      h.key(plan("Alpha plan")!, "ArrowLeft")
      await until(() => plan("Alpha plan")?.getAttribute("aria-expanded") === "false")
      expect(h.row(h.alpha[0]!)).toBeNull()
      await settle()
      // Collapsing reveals no new content: the divider stays where the listed content put it.
      expect(separator().getAttribute("aria-valuenow")).toBe(fitted)
      // Down from the collapsed heading moves to the next plan heading.
      h.key(plan("Alpha plan")!, "ArrowDown")
      await until(() => doc.activeElement === plan("Beta plan"))
      h.key(plan("Alpha plan")!, "Enter")
      await until(() => plan("Alpha plan")?.getAttribute("aria-expanded") === "true")
      await settle()
      expect(separator().getAttribute("aria-valuenow")).toBe(fitted)
    },
    { paneHeight: 1000 },
  )
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
    h.scrollTo(HEAD + ROW * 28)
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

test("routine dependency waits stay in the planned tree; Attention lists holds only", async () => {
  await withPanel(
    async (h) => {
      // Every Alpha task after the first waits on the one before it; no worker is active.
      await until(() => h.rows().length > 0 && Boolean(h.attention(h.beta.a)))
      await settle()
      const attention = h.container.querySelector<HTMLElement>('[aria-label="Attention"]')!
      expect(attention.querySelector(".lazers-tasks-schedule-count")?.textContent).toBe("2")
      expect(
        [...h.container.querySelectorAll<HTMLElement>('[data-scheduling-group="attention"]')].map(
          (entry) => entry.dataset.schedulingTaskId,
        ),
      ).toEqual([h.beta.a, h.beta.join])
      expect(h.container.querySelector('[aria-label="Now"]')).toBeNull()
      // The routine waits are in the tree, in plan order, marked waiting on their prerequisite.
      const waitingRow = h.row(h.alpha[3]!)!
      expect(waitingRow.getAttribute("aria-posinset")).toBe("4")
      expect(
        waitingRow
          .querySelector(":scope > .lazers-tasks-row .lazers-tasks-state")
          ?.getAttribute("data-tone"),
      ).toBe("waiting")
      expect(h.attention(h.alpha[3]!)).toBeNull()
    },
    {},
    { alphaChain: true },
  )
})

test("Attention mounts a bounded window of requests and holds; keys walk every entry across groups", async () => {
  await withPanel(
    async (h) => {
      // Twelve workers ask for input; two tasks are blocked; 47 more wait routinely on the chain.
      await until(() => Boolean(h.attention(h.alpha[0]!)))
      await settle()
      const doc = h.container.ownerDocument
      const expected = [...h.alpha.slice(0, 12), h.beta.a, h.beta.join]
      const mounted = () => [
        ...h.container.querySelectorAll<HTMLButtonElement>('[data-scheduling-group="attention"]'),
      ]
      const count = () =>
        h.container.querySelector('[aria-label="Attention"] .lazers-tasks-schedule-count')
          ?.textContent
      expect(count()).toBe("14")
      expect(mounted().length).toBe(5)
      expect(mounted()[0]!.tabIndex).toBe(0)
      expect(h.container.querySelector(".lazers-tasks-schedule-pager")?.textContent).toContain(
        "1–5 of 14",
      )
      // Down walks every entry in order; the window slides and never mounts more than five.
      // (Selecting an entry later moves focus to its tree row, so each key goes to the entry.)
      const pressed = (taskID: string) =>
        h.attention(taskID)?.getAttribute("aria-pressed") === "true"
      let current = mounted()[0]!
      const visited = [current.dataset.schedulingTaskId]
      for (let step = 1; step < expected.length; step++) {
        h.key(current, "ArrowDown")
        await until(() => pressed(expected[step]!))
        expect(mounted().length).toBeLessThanOrEqual(5)
        current = h.attention(expected[step]!)!
        visited.push(current.dataset.schedulingTaskId)
      }
      expect(visited).toEqual(expected)
      await until(() => h.row(h.beta.join)?.getAttribute("aria-selected") === "true")
      // Up from the window's first entry slides it back.
      const firstShown = mounted()[0]!.dataset.schedulingTaskId!
      h.key(mounted()[0]!, "ArrowUp")
      await until(() => pressed(expected[expected.indexOf(firstShown) - 1]!))
      // Home and End reach the ends of the whole list.
      h.key(mounted()[0]!, "Home")
      await until(() => pressed(h.alpha[0]!))
      h.key(h.attention(h.alpha[0]!)!, "End")
      await until(() => pressed(h.beta.join))
      // Down from the last entry enters the tree at its first task.
      h.key(h.attention(h.beta.join)!, "ArrowDown")
      await until(() => doc.activeElement === h.row(h.alpha[0]!))
      // The pager reaches every entry without a keyboard.
      h.scrollTo(0)
      const pagerButton = (label: string) =>
        [
          ...h.container.querySelectorAll<HTMLButtonElement>(".lazers-tasks-schedule-pager button"),
        ].find((button) => button.textContent === label)!
      pagerButton("Previous").click()
      pagerButton("Previous").click()
      await until(() => mounted()[0]?.dataset.schedulingTaskId === h.alpha[0])
      const seen = new Set<string>()
      for (let page = 0; page < 4; page++) {
        for (const entry of mounted()) seen.add(entry.dataset.schedulingTaskId!)
        pagerButton("More").click()
        await settle()
      }
      expect([...seen].toSorted()).toEqual(expected.toSorted())
    },
    {},
    { alphaChain: true, requests: 12 },
  )
})

test("an all-collapsed tree keeps a mounted tab stop and keeps a focused heading mounted", async () => {
  await withPanel(
    async (h) => {
      await until(() => h.rows().length > 0)
      await settle()
      const doc = h.container.ownerDocument
      const headings = () => [
        ...h.container.querySelectorAll<HTMLElement>(".lazers-tasks-plan[role=treeitem]"),
      ]
      const heading = (title: string) =>
        headings().find((item) => item.textContent?.includes(title))
      const titles = ["Alpha plan", "Beta plan", ...h.extraPlans.map((plan) => plan.title)]
      // Collapse every plan from the keyboard, heading by heading.
      h.row(h.alpha[0]!)!.focus()
      h.key(h.row(h.alpha[0]!)!, "ArrowLeft")
      await until(() => doc.activeElement === heading("Alpha plan"))
      for (const [index, title] of titles.entries()) {
        h.key(heading(title)!, "ArrowLeft")
        await until(() => heading(title)?.getAttribute("aria-expanded") === "false")
        if (index === titles.length - 1) break
        h.key(heading(title)!, "ArrowDown")
        await until(() => doc.activeElement === heading(titles[index + 1]!))
      }
      expect(h.rows().filter((item) => item.dataset.taskId)).toHaveLength(0)
      // Scrolled to the end with focus outside the tree, one mounted heading is still tabbable:
      // the one holding the selected task (Alpha, the first), far above the viewport.
      ;(doc.activeElement as HTMLElement).blur()
      h.scrollTo(h.list().scrollHeight)
      await settle()
      expect(heading("Alpha plan")).toBeDefined()
      expect(heading("Gamma 5 plan")).toBeUndefined()
      const stops = headings().filter((item) => item.tabIndex === 0)
      expect(stops.map((item) => item.textContent?.includes("Alpha plan"))).toEqual([true])
      stops[0]!.focus()
      expect(doc.activeElement).toBe(heading("Alpha plan")!)
      // A focused heading that is not the tab stop stays mounted and focused while scrolled away.
      h.key(heading("Alpha plan")!, "ArrowDown")
      await until(() => doc.activeElement === heading("Beta plan"))
      h.scrollTo(h.list().scrollHeight)
      await settle()
      expect(heading("Beta plan")).toBeDefined()
      expect(doc.activeElement).toBe(heading("Beta plan")!)
      // Down still steps from the focused heading through the model.
      h.key(heading("Beta plan")!, "ArrowDown")
      await until(() => doc.activeElement === heading("Gamma 1 plan"))
    },
    {},
    { extraPlans: 30 },
  )
})

/** Attention, Now and tree probes shared by the signal tests below. */
function signals(h: Awaited<ReturnType<typeof mountPanel>>) {
  const entries = (group: string) => [
    ...h.container.querySelectorAll<HTMLButtonElement>(`[data-scheduling-group="${group}"]`),
  ]
  const entry = (group: string, taskID: string) =>
    h.container.querySelector<HTMLButtonElement>(
      `[data-scheduling-group="${group}"][data-scheduling-task-id="${taskID}"]`,
    )
  const count = (label: string) =>
    h.container.querySelector(`[aria-label="${label}"] .lazers-tasks-schedule-count`)?.textContent
  const tone = (taskID: string) =>
    h
      .row(taskID)
      ?.querySelector(":scope > .lazers-tasks-row .lazers-tasks-state")
      ?.getAttribute("data-tone")
  return { entries, entry, count, tone }
}

/** One paused plan is one actionable Attention entry; its rows keep the pause marker. */
async function expectPausedPlan(h: Awaited<ReturnType<typeof mountPanel>>) {
  const s = signals(h)
  await until(() => Boolean(s.entry("attention", h.alpha[0]!)))
  await settle()
  // Two blocked Beta tasks, then the paused plan once: not 60 entries, and no routine waits.
  expect(s.count("Attention")).toBe("3")
  expect(s.entries("attention").map((entry) => entry.dataset.schedulingTaskId)).toEqual([
    h.beta.a,
    h.beta.join,
    h.alpha[0],
  ])
  const pauseEntry = s.entry("attention", h.alpha[0]!)!
  expect(pauseEntry.dataset.pausedCount).toBe("60")
  expect(pauseEntry.textContent).toContain("60 paused")
  expect(pauseEntry.getAttribute("aria-label")).toContain(
    "paused: Paused by Architect for review, 60 paused tasks in this plan",
  )
  expect(pauseEntry.querySelector(".lazers-tasks-state")?.getAttribute("data-tone")).toBe("paused")
  // The tree marks every paused row; a routine wait under the pause is not promoted.
  for (const index of [0, 3, 7]) expect(s.tone(h.alpha[index]!)).toBe("paused")
  expect(s.entry("attention", h.alpha[3]!)).toBeNull()
  // The entry is actionable: it selects the task and the inspector names the pause.
  pauseEntry.click()
  await until(() => h.row(h.alpha[0]!)?.getAttribute("aria-selected") === "true")
  await until(() =>
    Boolean(
      h.container
        .querySelector('.lazers-tasks-detail [data-kind="pause"]')
        ?.textContent?.includes("Paused by Architect for review"),
    ),
  )
}

test("a manual dispatch pause is one actionable Attention entry for its plan", async () => {
  await withPanel(expectPausedPlan, {}, { alphaPaused: true, alphaChain: true })
})

test("without topology, the scheduling fallback keeps the pause marker and its Attention entry", async () => {
  await withPanel(
    async (h) => {
      await until(() => h.topologyCalls() > 0)
      await expectPausedPlan(h)
      // The plan groups come from the scheduling read, not topology.
      expect(h.container.textContent).toContain("Showing scheduling-backed groups")
    },
    {},
    { alphaPaused: true, alphaChain: true, topologyUnavailable: true, scheduling: true },
  )
})

test("without topology or scheduling, ungrouped paused tasks keep their marker and one entry", async () => {
  await withPanel(
    async (h) => {
      const s = signals(h)
      await until(() => h.topologyCalls() > 0 && Boolean(s.entry("attention", h.alpha[0]!)))
      await settle()
      expect(s.count("Attention")).toBe("3")
      expect(s.entry("attention", h.alpha[0]!)?.dataset.pausedCount).toBe("60")
      for (const index of [0, 5]) expect(s.tone(h.alpha[index]!)).toBe("paused")
      expect(s.entry("attention", h.alpha[5]!)).toBeNull()
    },
    {},
    { alphaPaused: true, topologyUnavailable: true },
  )
})

test("Now mounts a bounded window of active work; keys reach every entry across Now and Attention", async () => {
  await withPanel(
    async (h) => {
      // Eight foreground workers, then two asking for input, then two blocked tasks.
      const s = signals(h)
      await until(
        () => Boolean(s.entry("now", h.alpha[0]!)) && Boolean(s.entry("attention", h.beta.join)),
      )
      await settle()
      const now = h.alpha.slice(0, 8)
      const attention = [h.alpha[8]!, h.alpha[9]!, h.beta.a, h.beta.join]
      expect(s.count("Now")).toBe("8")
      expect(s.entries("now").length).toBe(5)
      expect(s.entries("now")[0]!.tabIndex).toBe(0)
      expect(
        h.container.querySelector('[aria-label="Now"] .lazers-tasks-schedule-pager')?.textContent,
      ).toContain("1–5 of 8")
      const sequence = [
        ...now.map((taskID) => ["now", taskID] as const),
        ...attention.map((taskID) => ["attention", taskID] as const),
      ]
      const pressed = ([group, taskID]: readonly [string, string]) =>
        s.entry(group, taskID)?.getAttribute("aria-pressed") === "true"
      // Down walks Now, slides its window, then crosses into Attention in order.
      let current = s.entries("now")[0]!
      for (const target of sequence.slice(1)) {
        h.key(current, "ArrowDown")
        await until(() => pressed(target))
        expect(s.entries("now").length).toBeLessThanOrEqual(5)
        expect(s.entries("attention").length).toBeLessThanOrEqual(5)
        current = s.entry(target[0], target[1])!
      }
      // Up from Attention's first entry reaches Now's last, its window slid to the end.
      h.key(s.entry("attention", h.alpha[8]!)!, "ArrowUp")
      await until(() => pressed(["now", now.at(-1)!]))
      // Home reaches Now's first entry; its window slides back.
      h.key(s.entry("now", now.at(-1)!)!, "Home")
      await until(() => pressed(["now", now[0]!]))
      expect(s.entries("now")[0]?.dataset.schedulingTaskId).toBe(now[0])
      // End reaches the last Attention entry; Down from there enters the tree.
      h.key(s.entry("now", now[0]!)!, "End")
      await until(() => pressed(["attention", h.beta.join]))
      h.key(s.entry("attention", h.beta.join)!, "ArrowDown")
      await until(() => h.container.ownerDocument.activeElement === h.row(h.alpha[0]!))
      // The Now pager reaches every active entry without a keyboard.
      const more = () =>
        [
          ...h.container.querySelectorAll<HTMLButtonElement>(
            '[aria-label="Now"] .lazers-tasks-schedule-pager button',
          ),
        ].find((button) => button.textContent === "More")!
      const seen = new Set(s.entries("now").map((entry) => entry.dataset.schedulingTaskId))
      more().click()
      await settle()
      for (const entry of s.entries("now")) seen.add(entry.dataset.schedulingTaskId)
      expect([...seen].toSorted()).toEqual(now.toSorted())
    },
    {},
    { active: 8, requests: 2 },
  )
})

test("arrowing through Now and Attention keeps focus on the entries while details load", async () => {
  await withPanel(
    async (h) => {
      // Two foreground workers, six requests, two blocked tasks: ten entries in two windows.
      const s = signals(h)
      await until(
        () => Boolean(s.entry("now", h.alpha[0]!)) && Boolean(s.entry("attention", h.alpha[2]!)),
      )
      await settle()
      const doc = h.container.ownerDocument
      const sequence = [
        ...h.alpha.slice(0, 2).map((taskID) => ["now", taskID] as const),
        ...[...h.alpha.slice(2, 8), h.beta.a, h.beta.join].map(
          (taskID) => ["attention", taskID] as const,
        ),
      ]
      const title = () => h.container.querySelector(".lazers-tasks-detail .lazers-tasks-title")
      s.entry("now", h.alpha[0]!)!.focus()
      for (const [group, taskID] of sequence.slice(1)) {
        // The key goes wherever focus is, as it would from a keyboard.
        h.key(doc.activeElement as HTMLElement, "ArrowDown")
        // The selected task's details resolve before the next keypress.
        await until(
          () => h.detailCalls.at(-1) === taskID && title()?.textContent === h.nameOf(taskID),
        )
        await settle()
        expect(doc.activeElement).toBe(s.entry(group, taskID))
        expect(h.row(taskID)?.getAttribute("aria-selected")).toBe("true")
      }
      // Up and Home stay in the list too.
      h.key(doc.activeElement as HTMLElement, "ArrowUp")
      await until(() => title()?.textContent === h.nameOf(h.beta.a))
      await settle()
      expect(doc.activeElement).toBe(s.entry("attention", h.beta.a))
      h.key(doc.activeElement as HTMLElement, "Home")
      await until(() => title()?.textContent === h.nameOf(h.alpha[0]!))
      await settle()
      expect(doc.activeElement).toBe(s.entry("now", h.alpha[0]!))
      // A click on an entry still takes the person to its row, even for the selected task.
      s.entry("now", h.alpha[0]!)!.click()
      await until(() => doc.activeElement === h.row(h.alpha[0]!))
      // (Attention's window still ends at its last entries.)
      s.entry("attention", h.beta.a)!.click()
      await until(() => doc.activeElement === h.row(h.beta.a))
      // Down from the last entry still enters the tree.
      s.entry("attention", h.beta.join)!.focus()
      h.key(s.entry("attention", h.beta.join)!, "ArrowDown")
      await until(() => doc.activeElement === h.row(h.alpha[0]!))
    },
    {},
    { active: 2, requests: 6 },
  )
})

test("an unchanged refresh keeps the focused Now or Attention button and its focus", async () => {
  await withPanel(
    async (h) => {
      const s = signals(h)
      await until(
        () => Boolean(s.entry("now", h.alpha[0]!)) && Boolean(s.entry("attention", h.beta.a)),
      )
      await settle()
      const doc = h.container.ownerDocument
      for (const [group, taskID] of [
        ["attention", h.beta.a],
        ["now", h.alpha[1]!],
      ] as const) {
        const focused = s.entry(group, taskID)!
        focused.focus()
        expect(doc.activeElement).toBe(focused)
        const reads = h.queryCalls.length
        h.announceChange()
        await until(() => h.queryCalls.length > reads)
        await settle()
        await settle()
        expect(focused.isConnected).toBe(true)
        expect(s.entry(group, taskID)).toBe(focused)
        expect(doc.activeElement).toBe(focused)
      }
    },
    {},
    { active: 2, requests: 2 },
  )
})
