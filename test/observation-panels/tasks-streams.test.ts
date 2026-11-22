import { afterAll, beforeAll, expect, test } from "bun:test"
import { Window } from "happy-dom"
import solid from "vite-plugin-solid"
import { build } from "vite"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { Database } from "bun:sqlite"
import { validProposal } from "../proposal.ts"
import { meterRepository } from "../../src/runner/read-meter.fixture.ts"
import { Streams } from "../../src/streams/contract.ts"
import { readerPool, type ReaderPool } from "../../src/streams/pool.ts"
import { createStreamsService } from "../../src/streams/rpc.ts"
import "../../src/streams/sources/index.ts"
import { TaskRepository } from "../../src/storage.ts"
import { RunnerStore } from "../../src/runner/store.ts"
import { ensureHostSessionStateSchema } from "../../src/host-sessions/state.ts"
import { TaskScheduleOwner } from "../../src/tasks/schedule/owner.ts"
import { installTasksLayout } from "./virtual-layout.ts"
import { openedTaskView } from "./fixtures/open-details.ts"

/**
 * The Tasks panel against a real project database: the projection, a real reader pool and the
 * streams service stand where the plugin's server stands. Only the layout (Happy DOM has none) and
 * the three RPC reads that are not streams (detail, current activity, start) are shims.
 */

const ROW = 32
const PROJECT = "/workspace/tasks-streams"
const SESSION = "ses-tasks-streams"
const QUEUED = 150

const until = async (predicate: () => boolean, attempts = 600) => {
  for (let attempt = 0; attempt < attempts && !predicate(); attempt++)
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  if (!predicate()) throw new Error(`Timed out waiting for: ${predicate.toString()}`)
}
const settle = (ms = 60) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function changeBus<T>() {
  const queued: T[] = []
  const waiters: ((value: T | undefined) => void)[] = []
  const publish = (change: T) => {
    const waiter = waiters.shift()
    if (waiter) waiter(change)
    else queued.push(change)
  }
  const subscribe = (signal: AbortSignal) =>
    (async function* () {
      while (!signal.aborted) {
        const value =
          queued.shift() ??
          (await new Promise<T | undefined>((resolve) => {
            waiters.push(resolve)
            signal.addEventListener("abort", () => resolve(undefined), { once: true })
          }))
        if (value === undefined || signal.aborted) return
        yield { data: value }
      }
    })()
  return { publish, subscribe }
}

// ---- the database -------------------------------------------------------------------------------

let directory: string
let repository: TaskRepository
let reads: { runner: RunnerStore }
let owner: TaskScheduleOwner
let pool: ReaderPool
const ids: Record<string, string> = {}

const insertTask = (name: string) => {
  const proposal = validProposal()
  proposal.objective = name
  proposal.writeScope = [`src/${name.replaceAll(" ", "-")}/**`]
  return repository.insert({
    schemaVersion: 1,
    id: crypto.randomUUID(),
    revision: 1,
    status: "submitted",
    createdAt: "2026-10-31T00:00:00.000Z",
    provenance: {
      projectID: "global",
      projectDirectory: PROJECT,
      workspaceDirectory: "/worktree",
      sessionID: SESSION,
      startingRevision: { kind: "unborn" },
    },
    proposal,
  }).id
}

function plan(name: string, nodes: string[], state: string, dependencies: [string, string][] = []) {
  const taskIDs = nodes.map((node) => insertTask(`${name} ${node}`))
  const submitted = reads.runner.submit(
    {
      requestID: `streams-${name}`,
      objective: name,
      baseCommit: "a".repeat(40),
      nodes: taskIDs.map((taskID) => ({ taskID, revision: 1 })),
      dependencies: dependencies.map(([prerequisite, successor]) => ({
        prerequisite: taskIDs[nodes.indexOf(prerequisite)]!,
        successor: taskIDs[nodes.indexOf(successor)]!,
      })),
      integrationOrder: taskIDs,
      verification: validProposal().verification,
      acceptance: validProposal().acceptance,
    },
    "architect",
  )
  repository.atomic((db) => {
    db.query("UPDATE runner_nodes SET state=? WHERE plan_id=?").run(state, submitted.planID)
    for (const taskID of taskIDs)
      db.query(
        "INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at) VALUES(?,?,?,?,?,?)",
      ).run(submitted.planID, taskID, 1, "MOVE", JSON.stringify({ to: state }), Date.now())
  })
  nodes.forEach((node, index) => (ids[`${name} ${node}`] = taskIDs[index]!))
  ids[`plan:${name}`] = submitted.planID
  return taskIDs
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "lazers-tasks-streams-"))
  repository = new TaskRepository(join(directory, "tasks.sqlite"), PROJECT)
  reads = { runner: new RunnerStore(repository) }
  // The project core's host fold installs the session table the current activity joins.
  ensureHostSessionStateSchema(repository)
  // One plan whose second step waits on the first, and the third on both.
  plan("Chain", ["one", "two", "three"], "queued", [
    ["one", "two"],
    ["one", "three"],
    ["two", "three"],
  ])
  for (let index = 0; index < QUEUED; index++)
    plan(`Q${String(index + 1).padStart(3, "0")}`, ["only"], "queued")
  for (const name of ["R1", "R2", "R3"]) plan(name, ["only"], "running")
  for (const name of ["F1", "F2"]) plan(name, ["only"], "failed")
  for (const name of ["A1", "A2", "A3"]) plan(name, ["only"], "accepted")
  // The owner backfills the project and marks it indexed, as the project core does.
  owner = new TaskScheduleOwner(repository)
  owner.start()
  await until(
    () =>
      repository.read(
        (db) =>
          db.query<{ ready: number }, []>("SELECT ready FROM task_schedule_state").get()?.ready ===
          1,
      ),
    2_000,
  )
  pool = readerPool(repository.path, { workers: 1 })
}, 120_000)

afterAll(async () => {
  owner?.close()
  await pool?.close()
  repository?.close()
  await rm(directory, { recursive: true, force: true })
})

/** Task ids of the stored list in its order, read on a plain read-only connection. */
const storedOrder = (where = "retired=0") => {
  const db = new Database(repository.path, { readonly: true })
  try {
    return db
      .query<{ task_id: string }, []>(
        `SELECT task_id FROM task_schedule WHERE project_directory='${PROJECT}' AND ${where}
         ORDER BY sort_key, task_id`,
      )
      .all()
      .map((row) => row.task_id)
  } finally {
    db.close()
  }
}
/** Tasks in the given buckets of the session view, counted from the rows. */
const storedCount = (...buckets: string[]) => {
  const db = new Database(repository.path, { readonly: true })
  try {
    return db
      .query<{ n: number }, []>(
        `SELECT COUNT(*) n FROM task_schedule WHERE retired=0 AND bucket IN (${buckets.map((b) => `'${b}'`).join(",")})`,
      )
      .get()!.n
  } finally {
    db.close()
  }
}
const storedReference = (taskID: string) => {
  const db = new Database(repository.path, { readonly: true })
  try {
    return db
      .query<{ reference: string }, [string]>("SELECT reference FROM task_schedule WHERE task_id=?")
      .get(taskID)!.reference
  } finally {
    db.close()
  }
}
// ---- the panel ----------------------------------------------------------------------------------

const guiRoot = fileURLToPath(new URL("../../src/gui.tsx", import.meta.url))
const entry = fileURLToPath(new URL("../task-panel/fixtures/tasks-dom-entry.ts", import.meta.url))
const outputDirectory = fileURLToPath(
  new URL(
    `../../node_modules/.cache/tasks-streams-dom-test-${crypto.randomUUID()}`,
    import.meta.url,
  ),
)
let built: Promise<Record<string, never>> | undefined
function loadHost() {
  built ??= (async () => {
    await mkdir(outputDirectory, { recursive: true })
    const unused = "\0lazers-test-unused-inference-runtime"
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
            return unused
          },
          load(id) {
            if (id !== unused) return
            return `export function createInferenceRuntime() { throw new Error("unused") }`
          },
        },
      ],
      build: {
        outDir: outputDirectory,
        emptyOutDir: true,
        minify: false,
        lib: { entry, formats: ["es"], fileName: "tasks-streams-dom-test" },
        rolldownOptions: { output: { codeSplitting: false } },
      },
    })
    return (await import(
      pathToFileURL(`${outputDirectory}/tasks-streams-dom-test.js`).href
    )) as Record<string, never>
  })()
  return built
}
afterAll(async () => {
  await built
  await rm(outputDirectory, { recursive: true, force: true })
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

type Options = {
  view?: Record<string, unknown>
  defaults?: Record<string, string[]>
  sessionID?: string
}

/**
 * One Happy DOM window serves every test: the bundle registers its delegated event listeners on the
 * document that exists when it loads, so another window would never see a click.
 */
let shared: { dom: Window; uninstall(): void; restore(): void } | undefined
function sharedDom() {
  if (shared) return shared.dom
  const dom = new Window({ url: "http://localhost" })
  Object.defineProperty(dom.window, "innerWidth", { configurable: true, value: 360 })
  const uninstallLayout = installTasksLayout(dom, {
    viewportHeight: 320,
    headHeight: 0,
    itemHeights: { task: ROW, loader: ROW },
  })
  const previous = new Map<string, PropertyDescriptor | undefined>()
  for (const name of globalNames) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: (dom as unknown as Record<string, unknown>)[name],
    })
  }
  shared = {
    dom,
    uninstall: uninstallLayout,
    restore() {
      for (const name of globalNames) {
        const descriptor = previous.get(name)
        if (descriptor) Object.defineProperty(globalThis, name, descriptor)
        else Reflect.deleteProperty(globalThis, name)
      }
    },
  }
  return dom
}
afterAll(() => {
  shared?.uninstall()
  shared?.restore()
  shared?.dom.happyDOM.abort()
})

async function withPanel(
  run: (h: Awaited<ReturnType<typeof mountPanel>>) => Promise<void>,
  options: Options = {},
) {
  const dom = sharedDom()
  await loadHost()
  let harness: Awaited<ReturnType<typeof mountPanel>> | undefined
  try {
    harness = await mountPanel(dom, options)
    await run(harness)
  } finally {
    harness?.mounted.dispose()
    harness?.disposeSetup()
    harness?.service.dispose()
    dom.document.body.replaceChildren()
    dom.document.head.replaceChildren()
  }
}

/** Sources the panel reads in one-shot windows (`detail-read.ts`), closed as soon as read. */
const ONE_SHOT = new Set([
  "tasks.detail",
  "tasks.attempts",
  "tasks.activity",
  "tasks.activityPayloads",
  "tasks.attemptCalls",
  "tasks.currentActivity",
])

async function mountPanel(dom: Window, options: Options) {
  const host = (await loadHost()) as unknown as Record<string, any>
  const browserDocument = dom.document as unknown as Document
  const streamBus = changeBus<{ stream: string; seq: number }>()
  const service = createStreamsService({
    pool,
    changed: (stream, seq) => streamBus.publish({ stream, seq }),
    context: {
      projectID: "global",
      projectDirectory: PROJECT,
      projectIds: (id) => [id],
      assertRead: async () => {},
      read: (run) => repository.read(run),
    },
  })
  const opens: { source: string; filter: Record<string, unknown>; window: number }[] = []
  /** Live streams by id; the detail and activity reads open and close one-shot windows. */
  const live = new Map<string, string>()
  const streamsRpc = {
    open: (input: {
      stream: string
      source: string
      filter: Record<string, unknown>
      window: number
    }) => {
      opens.push(input)
      live.set(input.stream, input.source)
      return service.open(input as never)
    },
    slide: (input: never) => service.slide(input),
    seek: (input: never) => service.seek(input),
    read: (input: never) => service.read(input),
    touch: (input: never) => service.touch(input),
    close: (input: { stream: string }) => {
      live.delete(input.stream)
      return service.close(input as never)
    },
    events: {
      subscribe: (_name: string, subscription: { signal: AbortSignal }) =>
        streamBus.subscribe(subscription.signal),
    },
  }
  // The selected task's detail is the `tasks.detail` window, opened like every other stream.
  const detailReads = {
    get count() {
      return opens.filter((open) => open.source === "tasks.detail").length
    },
  }
  const tasksRpc = {
    start: async () => ({ status: "existing", planID: crypto.randomUUID(), state: "running" }),
  }
  const events = changeBus<{ type: string; data?: unknown }>()
  const client = {
    location: { get: async () => ({ project: { canonical: PROJECT, id: "global" } }) },
    rpc: (contract: { id?: string }) => (contract.id === Streams.id ? streamsRpc : tasksRpc),
    event: {
      subscribe: ({ signal }: { signal: AbortSignal }) =>
        (async function* () {
          for await (const next of events.subscribe(signal)) yield next.data
        })(),
    },
  }
  const taskStore = host.createReactiveStore({
    projects: { [PROJECT]: { ...openedTaskView(), ...options.view } },
  })
  const defaultsStore = host.createReactiveStore({ projects: options.defaults ?? {} })
  const registrations: Array<{ token: unknown; value: unknown }> = []
  const session = {
    id: options.sessionID ?? SESSION,
    location: { directory: PROJECT },
    directory: PROJECT,
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
      taskStateDefaults: defaultsStore,
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
    (item) =>
      item.token === host.registryTokens.Style &&
      typeof item.value === "string" &&
      item.value.includes(".lazers-tasks {"),
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
  const topLevel = () => rows().filter((item) => item.dataset.depth === "0")
  const rowIDs = () => rows().map((item) => item.dataset.taskId!)
  const scrollTo = (top: number) => {
    list().scrollTop = top
    list().dispatchEvent(new dom.window.Event("scroll") as unknown as Event)
  }
  const chooseFilter = (label: string) => {
    container
      .querySelector<HTMLButtonElement>(".lazers-tasks-state-filter button[aria-haspopup=menu]")!
      .click()
    ;[...container.querySelectorAll<HTMLButtonElement>("[role=menuitem]")]
      .find((button) => button.textContent!.startsWith(label))!
      .click()
  }
  const itemOf = (taskID: string) =>
    row(taskID)!.closest<HTMLElement>(".lazers-tasks-virtual-item")!
  /** Where the row sits in the viewport, in px from its top. */
  const rowTop = (taskID: string) =>
    Number(/translateY\((-?[\d.]+)px\)/u.exec(itemOf(taskID).style.transform)![1]) -
    list().scrollTop
  const treeHeight = () =>
    Number.parseFloat(container.querySelector<HTMLElement>(".lazers-tasks-tree")!.style.height)
  // The list, counts and relations streams a view holds; one-shot detail windows are not held.
  const streamsOpen = () => [...live.values()].filter((source) => !ONE_SHOT.has(source)).length
  return {
    dom,
    host,
    mounted,
    disposeSetup,
    service,
    container,
    list,
    rows,
    row,
    topLevel,
    rowIDs,
    scrollTo,
    chooseFilter,
    rowTop,
    treeHeight,
    streamsOpen,
    opens,
    detailReads,
    taskStore,
    defaultsStore,
    search: (text: string) => {
      const input = container.querySelector<HTMLInputElement>('input[aria-label="Find tasks"]')
      if (!input) {
        container.querySelector<HTMLButtonElement>('button[aria-label="Search tasks"]')!.click()
      }
      const field = container.querySelector<HTMLInputElement>('input[aria-label="Find tasks"]')!
      field.value = text
      field.dispatchEvent(new dom.window.Event("input", { bubbles: true }) as unknown as Event)
    },
    text: () => container.textContent ?? "",
    key: (element: HTMLElement, value: string) =>
      element.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", { key: value, bubbles: true }) as unknown as Event,
      ),
    announce: () =>
      events.publish({
        type: "rpc.lazers.tasks.changed",
        data: { projectDirectory: PROJECT, version: Date.now() },
      }),
  }
}

// ---- tests --------------------------------------------------------------------------------------

test("the first window renders in the stored order, with one start-of-list state and an end loader", async () => {
  await withPanel(async (h) => {
    const order = storedOrder(
      "retired=0 AND bucket IN ('running','queued','paused','blocked','open')",
    )
    await until(() => h.topLevel().length > 0)
    // Open tasks are listed first: running before queued, in the stored sort order.
    const shown = h.topLevel().map((item) => item.dataset.taskId)
    expect(shown).toEqual(order.slice(0, shown.length))
    expect(h.row(ids["R1 only"]!)).not.toBeNull()
    // Rows that fit plus slop: the window is bounded, not the project.
    const items = h.container.querySelectorAll(".lazers-tasks-virtual-item")
    expect(items.length).toBeLessThan(40)
    // More tasks follow the window: an end loader, and nothing before it.
    expect(h.treeHeight()).toBeGreaterThan(ROW * 60)
    expect(h.treeHeight()).toBeLessThan(ROW * order.length)
    expect(h.text()).not.toContain("unknown")
    // A single stream per source at rest: the list, the counts, the index, and the selected facts.
    expect(
      h.opens.filter((open) => open.source === "tasks.schedule" && open.window > 1),
    ).toHaveLength(1)
  })
})

test("scrolling down and back up slides the window without moving what is read", async () => {
  await withPanel(async (h) => {
    await until(() => h.topLevel().length > 0)
    const order = storedOrder(
      "retired=0 AND bucket IN ('running','queued','paused','blocked','open')",
    )
    const first = order[0]!
    expect(h.row(first)).not.toBeNull()
    // Walk down a screen at a time until a row far past the first window is shown.
    const far = order[120]!
    // The anchor moves scrollTop when the window slides, so each step goes from where it is.
    for (let step = 0; step < 300 && !h.row(far); step++) {
      h.scrollTo(h.list().scrollTop + ROW * 6)
      await settle(30)
    }
    await until(() => Boolean(h.row(far)))
    // The row in view holds still across the slide: its place is the same before and after.
    const before = h.rowTop(far)
    await settle(150)
    expect(Math.abs(h.rowTop(far) - before)).toBeLessThan(ROW)
    expect(h.row(first)).toBeNull()
    // Back up: the first rows return, and the row being read does not jump while they load.
    for (let step = 0; step < 300 && !h.row(first); step++) {
      h.scrollTo(Math.max(0, h.list().scrollTop - ROW * 6))
      await settle(30)
    }
    await until(() => Boolean(h.row(first)))
    // Rows of the window are keyed by task id: each id appears once.
    expect(new Set(h.rowIDs()).size).toBe(h.rowIDs().length)
  })
})

test("expanding a row opens one dependency stream and collapsing closes it", async () => {
  await withPanel(async (h) => {
    await until(() => h.topLevel().length > 0)
    await until(() => Boolean(h.row(ids["Chain three"]!)))
    const dependencyStreams = () => h.opens.filter((open) => open.source === "tasks.dependencies")
    const before = h.streamsOpen()
    const toggle = (taskID: string) =>
      h.row(taskID)!.querySelector<HTMLButtonElement>(".lazers-tasks-disclosure")!.click()
    const chainRow = h.row(ids["Chain three"]!)!
    expect(chainRow.getAttribute("aria-expanded")).toBe("false")
    const openedBefore = dependencyStreams().length
    toggle(ids["Chain three"]!)
    await until(() =>
      h.rows().some((item) => item.dataset.itemKey!.startsWith(`task:${ids["Chain three"]}>`)),
    )
    // The stream of the expanded row holds its two dependencies, in order.
    const children = h
      .rows()
      .filter((item) => item.dataset.itemKey!.startsWith(`task:${ids["Chain three"]}>`))
    expect(children.map((item) => item.dataset.taskId)).toEqual([
      ids["Chain one"],
      ids["Chain two"],
    ])
    // Those are dependency rows of the same list, one level deeper.
    expect(children.every((item) => item.dataset.depth === "1")).toBe(true)
    expect(dependencyStreams().length - openedBefore).toBe(1)
    expect(h.streamsOpen()).toBe(before + 1)
    // Expanding the nested row that has its own dependency opens another stream.
    toggle(ids["Chain three"]!)
    await until(() => h.streamsOpen() === before)
    expect(h.rows().some((item) => item.dataset.itemKey!.includes(">"))).toBe(false)
  })
})

test("switching the chip reads the other state from the head, with counts from the stored counters", async () => {
  await withPanel(async (h) => {
    await until(() => h.topLevel().length > 0)
    const header = () => h.container.querySelector(".lazers-tasks-count")?.textContent ?? ""
    await until(() => header().includes("open"))
    expect(header()).toContain(`${QUEUED + 3 + 3} open`)
    expect(header()).toContain("3 running")
    h.chooseFilter("Open")
    h.chooseFilter("Failed")
    await until(() => h.topLevel().length === 2)
    expect(h.topLevel().map((item) => item.dataset.taskId)).toEqual(
      storedOrder("retired=0 AND bucket='failed'"),
    )
    expect(header()).toContain("2 failed")
    h.chooseFilter("All")
    await until(() => h.topLevel().length > 10)
    expect(header()).toBe(String(QUEUED + 3 + 3 + 2 + 3))
    expect(h.list().scrollTop).toBe(0)
  })
})

test("toggles persist immediately and union overlapping buckets in the real stream window", async () => {
  let saved: Record<string, string[]> = {}
  await withPanel(async (h) => {
    await until(() => h.topLevel().length > 0)
    expect(h.defaultsStore.value.projects).toEqual({})
    const detailReads = h.detailReads.count
    h.chooseFilter("Running")
    await until(() => h.text().includes("flow"))
    expect(h.defaultsStore.value.projects[PROJECT]).toEqual(["open", "running"])
    const header = () => h.container.querySelector(".lazers-tasks-count")?.textContent ?? ""
    await until(() =>
      header().startsWith(String(storedCount("running", "queued", "paused", "blocked", "open"))),
    )
    const filters = h.opens.filter(
      (entry) => entry.source === "tasks.schedule" && !entry.filter.taskID,
    )
    expect(filters.at(-1)?.filter.states).toEqual(["open", "running"])
    expect(filters.at(-1)!.window).toBeLessThan(100)
    expect(h.detailReads.count).toBe(detailReads)
    h.chooseFilter("Open")
    h.chooseFilter("Queued")
    await until(() =>
      (h.container.querySelector(".lazers-tasks-state-filter button")?.textContent ?? "").includes(
        "Motive",
      ),
    )
    expect(h.defaultsStore.value.projects[PROJECT]).toEqual(["queued", "running"])
    saved = structuredClone(h.defaultsStore.value.projects)
    h.chooseFilter("All")
    expect(h.defaultsStore.value.projects[PROJECT]).toEqual([])
    await until(
      () =>
        header() ===
        String(
          storedCount(
            "running",
            "queued",
            "paused",
            "blocked",
            "open",
            "accepted",
            "integrated",
            "failed",
            "cancelled",
          ),
        ),
    )
    await settle()
    const scheduleOpens = () =>
      h.opens.filter((entry) => entry.source === "tasks.schedule" && !entry.filter.taskID).length
    const openCount = scheduleOpens()
    h.chooseFilter("All")
    await settle()
    expect(scheduleOpens()).toBe(openCount)
  })
  await withPanel(
    async (h) => {
      await until(() => h.topLevel().length > 0)
      const filter = h.opens.find(
        (entry) => entry.source === "tasks.schedule" && !entry.filter.taskID,
      )?.filter
      expect(filter?.states).toEqual(["queued", "running"])
      expect(h.container.querySelector(".lazers-tasks-state-filter button")?.textContent).toContain(
        "Motive",
      )
      expect(h.defaultsStore.value.projects).toEqual(saved)
    },
    { defaults: saved, sessionID: "another-session", view: { scope: "project" } },
  )
  await withPanel(
    async (h) => {
      await until(() => h.topLevel().length > 0)
      expect(
        h.opens.find((entry) => entry.source === "tasks.schedule" && !entry.filter.taskID)?.filter
          .states,
      ).toEqual([])
      expect(h.container.querySelector(".lazers-tasks-state-filter button")?.textContent).toBe(
        "All",
      )
    },
    { defaults: { [PROJECT]: [] } },
  )
})

test("a search narrows the list from the stored text and shows no count", async () => {
  await withPanel(async (h) => {
    await until(() => h.topLevel().length > 0)
    h.search("q007")
    await until(() => h.topLevel().length === 1)
    expect(h.topLevel()[0]!.dataset.taskId).toBe(ids["Q007 only"])
    // No badge beside a search: a count of the whole list would be wrong, and a probe has none.
    expect(h.container.querySelector(".lazers-tasks-count")).toBeNull()
    h.search("no-such-task-anywhere")
    await until(() => h.text().includes("No matching tasks."))
    expect(h.topLevel()).toHaveLength(0)
    h.search("")
    await until(() => h.topLevel().length > 10)
  })
})

test("a row that changes after a write updates in place, keeping its element", async () => {
  await withPanel(async (h) => {
    await until(() => h.topLevel().length > 0)
    const taskID = ids["Q003 only"]!
    await until(() => Boolean(h.row(taskID)))
    const element = h.row(taskID)!
    const glyph = () => element.querySelector(".lazers-tasks-state")?.getAttribute("aria-label")
    const before = glyph()
    // The task starts running: the runner moves its node and the projection follows.
    repository.atomic((db) =>
      db.query("UPDATE runner_nodes SET state='running' WHERE task_id=?").run(taskID),
    )
    await until(() => glyph() !== before)
    expect(h.row(taskID)).toBe(element)
    // The chip counters moved with it, in the same transaction.
    await until(() =>
      (h.container.querySelector(".lazers-tasks-count")?.textContent ?? "").includes("4 running"),
    )
    // It sorts with the running tasks now.
    await until(() => h.topLevel().findIndex((item) => item.dataset.taskId === taskID) < 6)
    expect(h.row(taskID)).not.toBeNull()
  })
})

test("tasks are being indexed shows while the project is not indexed, and a stale row is marked", async () => {
  await withPanel(async (h) => {
    await until(() => h.topLevel().length > 0)
    expect(h.text()).not.toContain("Tasks are being indexed.")
    const taskID = ids["Q010 only"]!
    await until(() => Boolean(h.row(taskID)))
    expect(h.row(taskID)!.querySelector(".lazers-tasks-row-stale")).toBeNull()
    repository.atomic((db) =>
      db.query("UPDATE task_schedule SET stale=1 WHERE task_id=?").run(taskID),
    )
    await until(() => Boolean(h.row(taskID)?.querySelector(".lazers-tasks-row-stale")))
    expect(h.row(taskID)!.querySelector(".lazers-tasks-row-stale")!.textContent).toBe("Stale")
    repository.atomic((db) =>
      db.query("UPDATE task_schedule SET stale=0 WHERE task_id=?").run(taskID),
    )
    await until(() => !h.row(taskID)?.querySelector(".lazers-tasks-row-stale"))
    const ready = () =>
      repository.read(
        (db) =>
          db.query<{ ready: number }, []>("SELECT ready FROM task_schedule_state").get()?.ready,
      )
    expect(ready()).toBe(1)
    // A new generation of the projection starts the backfill over; with the owner stopped nothing
    // indexes the project again until a new one starts.
    owner.close()
    repository.atomic((db) =>
      db.query("UPDATE task_schedule_state SET ready=0, backfill_after=0").run(),
    )
    await until(() => h.text().includes("Tasks are being indexed."))
    owner = new TaskScheduleOwner(repository)
    owner.start()
    await until(() => !h.text().includes("Tasks are being indexed."))
    expect(ready()).toBe(1)
  })
})

test("the inspector reads the selected task's plan, prerequisites and dependents from their streams", async () => {
  await withPanel(async (h) => {
    await until(() => Boolean(h.row(ids["Chain two"]!)))
    h.row(ids["Chain two"]!)!.click()
    await until(() => h.text().includes("Runs after"))
    const detail = h.container.querySelector<HTMLElement>(".lazers-tasks-detail")!
    // Chain two runs after Chain one; the reference comes from the stored row, not from a lookup.
    const reference = (name: string) => storedReference(ids[name]!)
    const text = detail.textContent ?? ""
    expect(text).toContain(reference("Chain one"))
    // The plan's title and the step come from the stored plan and row.
    expect(text).toContain("Chain")
    expect(detail.textContent).toContain("Chain")
    // The details bar cuts the title at narrow widths; its tooltip carries the whole title.
    const barTitle = h.container.querySelector<HTMLElement>(".lazers-tasks-inspector-title")!
    expect(barTitle.title).toBe("Chain two")
  })
})

test("open, scroll, expand and a chip switch read nothing from the main repository", async () => {
  const meter = meterRepository(repository)
  try {
    await withPanel(async (h) => {
      await until(() => h.topLevel().length > 0)
      h.scrollTo(ROW * 40)
      await settle(150)
      h.scrollTo(0)
      await settle(150)
      await until(() => Boolean(h.row(ids["Chain three"]!)))
      h.row(ids["Chain three"]!)!
        .querySelector<HTMLButtonElement>(".lazers-tasks-disclosure")!
        .click()
      await until(() => h.rows().some((item) => item.dataset.itemKey!.includes(">")))
      h.chooseFilter("Open")
      h.chooseFilter("Failed")
      await until(() => h.topLevel().length === 2)
      h.chooseFilter("Open")
      await until(() => h.topLevel().length > 10)
      // The detail of the selected task, and every list, count, dependency and relation read,
      // ran on a reader worker.
      expect(h.detailReads.count).toBeGreaterThan(0)
    })
  } finally {
    meter.stop()
  }
  expect(meter.statements).toEqual([])
})

test("keyboard: Right expands then enters, Left leaves then collapses, Down moves", async () => {
  await withPanel(async (h) => {
    await until(() => Boolean(h.row(ids["Chain three"]!)))
    const three = ids["Chain three"]!
    const focus = () =>
      h.rows().find((item) => item === (h.dom.document.activeElement as unknown as HTMLElement))
    h.row(three)!.focus()
    h.key(h.row(three)!, "ArrowRight")
    await until(() => h.row(three)!.getAttribute("aria-expanded") === "true")
    // The dependencies arrive from their own stream.
    await until(() => h.rows().some((item) => item.dataset.itemKey!.startsWith(`task:${three}>`)))
    h.key(h.row(three)!, "ArrowRight")
    await until(() => focus()?.dataset.itemKey?.startsWith(`task:${three}>`) === true)
    h.key(focus()!, "ArrowLeft")
    await until(() => focus()?.dataset.itemKey === `task:${three}`)
    h.key(focus()!, "ArrowLeft")
    await until(() => h.row(three)!.getAttribute("aria-expanded") === "false")
    h.key(h.row(three)!, "ArrowDown")
    await until(() => focus()?.dataset.taskId !== three)
  })
})

test("the state menu marks the current chip and shows the stored counts", async () => {
  await withPanel(async (h) => {
    await until(() => h.topLevel().length > 0)
    await until(() => (h.container.querySelector(".lazers-tasks-count")?.textContent ?? "") !== "")
    h.container
      .querySelector<HTMLButtonElement>(".lazers-tasks-state-filter button[aria-haspopup=menu]")!
      .click()
    const items = () => [...h.container.querySelectorAll<HTMLElement>("[role=menuitem]")]
    expect(items().map((item) => item.textContent)).toEqual([
      "Open",
      "Queued",
      "Running",
      "Blocked / waiting",
      "Paused",
      "Completed",
      "Accepted",
      "Integrated",
      "Failed / exhausted",
      "Cancelled",
      "All",
    ])
    // The current value carries the check; counts ride in the trailing keys column.
    expect(items().map((item) => item.dataset.icon)).toEqual([
      "check",
      ...Array(10).fill(undefined),
    ])
    const count = (name: string) => items().find((item) => item.textContent === name)!.dataset.keys
    expect(count("Open")).toBe(
      String(storedCount("running", "queued", "paused", "blocked", "open")),
    )
    expect(count("Running")).toBe(String(storedCount("running")))
    expect(count("Accepted")).toBe("3")
    expect(count("Failed / exhausted")).toBe("2")
    expect(count("All")).toBe(
      String(
        storedCount(
          "running",
          "queued",
          "paused",
          "blocked",
          "open",
          "accepted",
          "integrated",
          "failed",
          "cancelled",
        ),
      ),
    )
  })
})

test("the list remembers the first row in view and reopens around it", async () => {
  const open = "retired=0 AND bucket IN ('running','queued','paused','blocked','open')"
  let remembered: string | undefined
  await withPanel(async (h) => {
    await until(() => h.topLevel().length > 0)
    for (let step = 0; step < 100 && !remembered; step++) {
      h.scrollTo(h.list().scrollTop + ROW * 6)
      await settle(30)
      const stored = (h.taskStore.value as { projects: Record<string, { anchorTaskID?: string }> })
        .projects[PROJECT]!.anchorTaskID
      if (stored && storedOrder(open).indexOf(stored) > 40) remembered = stored
    }
    expect(remembered).toBeDefined()
  })
  await withPanel(
    async (h) => {
      await until(() => Boolean(h.row(remembered!)))
      expect(h.row(storedOrder(open)[0]!)).toBeNull()
      expect(h.list().scrollTop).toBeGreaterThanOrEqual(0)
    },
    { view: { anchorTaskID: remembered } },
  )
  // A task the chip does not list cannot anchor: the list opens at its head.
  await withPanel(
    async (h) => {
      await until(() => h.topLevel().length > 0)
      expect(h.row(storedOrder(open)[0]!)).not.toBeNull()
    },
    { view: { anchorTaskID: ids["A1 only"] } },
  )
  await withPanel(
    async (h) => {
      await until(() => h.topLevel().length > 0)
      await settle()
      expect(h.taskStore.value.projects[PROJECT]?.anchorTaskID).toBe(storedOrder(open)[5])
      h.chooseFilter("All")
      await until(() => h.list().scrollTop === 0)
      await settle()
      expect(h.list().scrollTop).toBe(0)
      expect(h.topLevel()[0]?.dataset.taskId).toBe(storedOrder()[0])
    },
    { view: { anchorTaskID: storedOrder(open)[5] } },
  )
})
