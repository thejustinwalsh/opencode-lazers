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

async function withPanel(run: (h: Awaited<ReturnType<typeof mountPanel>>) => Promise<void>) {
  const dom = new Window({ url: "http://localhost" })
  Object.defineProperty(dom.window, "innerWidth", { configurable: true, value: 360 })
  const uninstallLayout = installTasksLayout(dom, {
    viewportHeight: 320,
    headHeight: HEAD,
    itemHeights: { task: ROW, plan: PLAN_HEIGHT, note: 28, loader: ROW },
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
    const harness = await mountPanel(dom, outputDirectory)
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

async function mountPanel(dom: Window, outputDirectory: string) {
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
  const blocked = new Set([beta.a, beta.join])
  const referenceOf = (taskID: string) => `LZ-${[...names.keys()].indexOf(taskID) + 1}`
  const stateOf = (taskID: string) => (blocked.has(taskID) ? "blocked" : "queued")
  const summary = (taskID: string) => ({
    taskID,
    reference: referenceOf(taskID),
    revision: 1,
    status: stateOf(taskID),
    recordedState: stateOf(taskID),
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
    if (input.state === "queued") {
      const pageIndex = input.cursor ? Number(input.cursor.split("-")[1]) : 0
      const ids = queue.slice(pageIndex * 30, pageIndex * 30 + 30)
      return pageOf(ids, pageIndex < 2 ? `queue-${pageIndex + 1}` : null, queue.length)
    }
    const ids = [...alpha, ...betaTasks]
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
  const topology = async () => ({
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
        nodes: alpha.map(node),
        dependencies: [],
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
      foreground: "inactive",
      unknownReason: null,
      recordedState: stateOf(taskID),
      waiting: false,
      holdReason: null,
      pendingInput: false,
      pendingPermissions: 0,
      pendingForms: 0,
      outcome: null,
      observedAt: Date.now(),
    })),
  })
  const detail = async ({ taskID }: { taskID: string }) => ({
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
      contract.id === "lazers.observability" ? { topology } : rpc,
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
    expect(h.row(h.beta.a)?.getAttribute("aria-level")).toBe("2")
    expect(h.list().scrollTop).toBeGreaterThan(ROW * 40)

    // Collapse the Beta plan from its heading, return to the top, then reach for its join.
    const heading = () =>
      [...h.container.querySelectorAll<HTMLButtonElement>(".lazers-tasks-plan-heading")].find(
        (button) => button.textContent?.includes("Beta plan"),
      )
    expect(heading()?.getAttribute("aria-expanded")).toBe("true")
    heading()!.click()
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
    // Home from anywhere returns to the first task; ArrowDown steps through the model order.
    h.key(h.row(h.alpha[0]!)!, "ArrowDown")
    await until(() => h.row(h.alpha[1]!)?.getAttribute("aria-selected") === "true")
    for (let step = 2; step <= 14; step++) {
      h.key(h.row(h.alpha[step - 1]!)!, "ArrowDown")
      await until(() => h.row(h.alpha[step]!)?.getAttribute("aria-selected") === "true")
      await until(() => doc.activeElement === h.row(h.alpha[step]!))
    }
    expect(h.row(h.alpha[14]!)).not.toBeNull()
    h.key(h.row(h.alpha[14]!)!, "Home")
    await until(() => h.row(h.alpha[0]!)?.getAttribute("aria-selected") === "true")
  })
})
