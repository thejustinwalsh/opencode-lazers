import { afterAll, expect, test } from "bun:test"
import { Window } from "happy-dom"
import solid from "vite-plugin-solid"
import { build } from "vite"
import { mkdir, rm } from "node:fs/promises"
import { fileURLToPath, pathToFileURL } from "node:url"
import { Streams } from "../../src/streams/contract.ts"
import { readerPool, type ReaderPool } from "../../src/streams/pool.ts"
import { createStreamsService } from "../../src/streams/rpc.ts"
import { makeFixture } from "../trajectory/fixture.ts"
import { insertTask } from "../../src/tasks/schedule/fixture.ts"

type DOMEntry = {
  createReactiveStore<T>(initial: T): {
    value: T
    ready(): boolean
    update(change: (draft: T) => void): void
  }
  registryTokens: { Panel: unknown; Style: unknown }
  createTestUI(): unknown
  setupRadar(context: unknown, navigation?: unknown): () => void
  radarPanelRegistration(
    registrations: Array<{ token: unknown; value: unknown }>,
  ): { render(props: unknown): unknown } | undefined
  mountRadarPanel(
    panel: { render(props: unknown): unknown },
    context: unknown,
    session: unknown,
    container: HTMLElement,
  ): { dispose(): void }
}

type StreamChange = { stream: string; seq: number }

function changeBus<T = StreamChange>() {
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
            const done = (change: T | undefined) => {
              const index = waiters.indexOf(done)
              if (index >= 0) waiters.splice(index, 1)
              signal.removeEventListener("abort", abort)
              resolve(change)
            }
            const abort = () => done(undefined)
            waiters.push(done)
            signal.addEventListener("abort", abort, { once: true })
            if (signal.aborted) abort()
          }))
        if (!value || signal.aborted) return
        yield { data: value }
      }
    })()
  return { publish, subscribe }
}

function until(predicate: () => boolean) {
  return (async () => {
    for (let attempt = 0; attempt < 1_500 && !predicate(); attempt++)
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(predicate()).toBe(true)
  })()
}

const entry = fileURLToPath(new URL("./fixtures/radar-agent-monitor-dom-entry.ts", import.meta.url))
const outputDirectory = fileURLToPath(
  new URL("../../node_modules/.cache/radar-lifecycle-labels-dom-test", import.meta.url),
)
let viteBuild: Promise<void> | undefined

async function loadDOMEntry() {
  viteBuild ??= (async () => {
    await rm(outputDirectory, { recursive: true, force: true })
    await mkdir(outputDirectory, { recursive: true })
    await build({
      configFile: false,
      resolve: { conditions: ["browser", "development", "module"] },
      define: { __LAZERS_RADAR_WORKER_SOURCE__: JSON.stringify("") },
      plugins: [solid()],
      build: {
        outDir: outputDirectory,
        emptyOutDir: true,
        minify: false,
        lib: { entry, formats: ["es"], fileName: "radar-lifecycle-labels-dom-test" },
        rolldownOptions: { output: { codeSplitting: false } },
      },
    })
  })()
  await viteBuild
  return (await import(
    pathToFileURL(`${outputDirectory}/radar-lifecycle-labels-dom-test.js`).href
  )) as DOMEntry
}

afterAll(async () => {
  await viteBuild
  await rm(outputDirectory, { recursive: true, force: true })
})

test("Radar lifecycle pickers show stored labels, update selections and consume only stream frames", async () => {
  const dom = new Window({ url: "https://radar-lifecycle.localhost" })
  const browserDocument = dom.document as unknown as Document
  Object.defineProperty(dom.window, "innerWidth", { configurable: true, value: 390 })
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

  const fixture = makeFixture()
  let mounted: { dispose(): void } | undefined
  let disposeSetup: (() => void) | undefined
  let pool: ReaderPool | undefined
  let streamsService: ReturnType<typeof createStreamsService> | undefined
  try {
    const taskIDs = ["Lifecycle label alpha", "Lifecycle label beta"].map((name) =>
      insertTask(fixture.repository, name),
    )
    const planID = fixture.store.submit(
      {
        requestID: "radar-lifecycle-labels",
        objective: "Lifecycle picker plan",
        baseCommit: "a".repeat(40),
        workspaceMode: "shared",
        nodes: taskIDs.map((taskID) => ({ taskID, revision: 1 })),
        dependencies: [],
        integrationOrder: taskIDs,
        verification: [{ id: "check", command: "bun test", timeoutMs: 60000 }],
        acceptance: [
          {
            id: "ok",
            assertion: "The lifecycle picker labels stored tasks",
            evidence: [{ kind: "verification", verificationID: "check" }],
          },
        ],
      },
      "ses-owner",
    ).planID
    await fixture.index()
    fixture.store.atomic((db) =>
      db
        .query("UPDATE runner_nodes SET state='running' WHERE plan_id=? AND task_id=?")
        .run(planID, taskIDs[0]!),
    )
    const storedPlan = fixture.repository.read((db) =>
      db
        .query<{ seq: number; title: string | null }, [string]>(
          "SELECT seq,title FROM task_schedule_plans WHERE plan_id=?",
        )
        .get(planID),
    )!
    const planLabel = storedPlan.title?.trim() || `Plan ${storedPlan.seq}`
    const references = taskIDs.map((taskID) => fixture.repository.referenceFor(taskID)!)
    expect(references.every((reference) => Boolean(reference))).toBe(true)

    const projectID = "project"
    const eventBus = changeBus()
    const streamOpens: { source: string }[] = []
    let releaseOpens!: () => void
    const openGate = new Promise<void>((resolve) => {
      releaseOpens = resolve
    })
    let holdingOpens = true
    const rpcIDs: string[] = []
    pool = readerPool(fixture.repository.path, { workers: 1 })
    streamsService = createStreamsService({
      pool,
      changed: (stream, seq) => eventBus.publish({ stream, seq }),
      context: {
        projectID,
        projectDirectory: fixture.directory,
        projectIds: (id) => [id],
        assertRead: async () => {},
        read: (run) => fixture.repository.read(run),
      },
    })
    const streamsRpc = {
      open: async (input: { source: string }) => {
        streamOpens.push({ source: input.source })
        if (holdingOpens) await openGate
        return streamsService!.open(input as never)
      },
      slide: (input: never) => streamsService!.slide(input),
      seek: (input: never) => streamsService!.seek(input),
      read: (input: never) => streamsService!.read(input),
      touch: (input: never) => streamsService!.touch(input),
      close: (input: never) => streamsService!.close(input),
      events: {
        subscribe: (_name: string, options: { signal: AbortSignal }) =>
          eventBus.subscribe(options.signal),
      },
    }
    const client = {
      project: {
        list: async (_input: unknown, options: { signal: AbortSignal }) => {
          options.signal.throwIfAborted()
          return [{ id: projectID, canonical: fixture.directory }]
        },
      },
      debug: { location: { list: async () => [{ directory: fixture.directory }] } },
      rpc: (definition: { id: string }) => {
        rpcIDs.push(definition.id)
        if (definition.id !== Streams.id)
          throw new Error(`Unexpected legacy Radar RPC ${definition.id}`)
        return streamsRpc
      },
    }
    const session = {
      id: "ses-lifecycle-owner",
      location: {},
      directory: fixture.directory,
      server: { id: "radar-server", connected: true, client },
    }
    const projectKey = JSON.stringify(["radar-server", fixture.directory])
    const host = await loadDOMEntry()
    const viewStore = host.createReactiveStore({
      projects: {
        [projectKey]: {
          scope: "project",
          session: { scope: "session", view: "map" },
          project: {
            scope: "project",
            view: "lifecycle",
            planID: "missing-plan",
            taskID: "missing-task",
          },
        },
      },
      diagnostics: true,
    })
    const registrations: Array<{ token: unknown; value: unknown }> = []
    const context = {
      id: "lazers",
      add: (token: unknown, value: unknown) => registrations.push({ token, value }),
      sessions: { current: () => session },
      layout: { open: () => {} },
      tabs: { open: () => {} },
      stores: { radarView: () => viewStore },
      appearance: { font: () => "test-mono" },
      ui: host.createTestUI(),
      main: () => ({}),
    }
    disposeSetup = host.setupRadar(context)
    const panel = host.radarPanelRegistration(registrations)
    expect(panel).toBeDefined()
    const styles = registrations.find((item) => item.token === host.registryTokens.Style)?.value
    expect(String(styles)).toContain(".lazers-radar-picker button")
    expect(String(styles)).toContain("text-overflow: ellipsis")
    expect(String(styles)).toContain("white-space: nowrap")

    const container = browserDocument.createElement("div")
    container.style.width = "390px"
    container.style.height = "420px"
    browserDocument.body.append(container)
    mounted = host.mountRadarPanel(panel!, context, session, container)
    await until(() => streamOpens.some((open) => open.source === "tasks.plans"))
    expect(container.querySelector(".lazers-panel-loading")).not.toBeNull()
    releaseOpens()
    holdingOpens = false
    await until(
      () =>
        container.querySelector(".lazers-radar-pickers") !== null &&
        container.textContent?.includes(
          "The previously selected plan is no longer available in this scope.",
        ) === true,
    )

    const pickerTriggers = () => [
      ...container.querySelectorAll<HTMLButtonElement>(".lazers-radar-picker button"),
    ]
    const planTrigger = () => pickerTriggers()[0]!
    const menuItems = () => [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    expect(planTrigger().textContent).toBe("Select plan")
    expect(planTrigger().getAttribute("aria-label")).toBe("Select plan")
    expect(planTrigger().getAttribute("aria-haspopup")).toBe("menu")
    planTrigger().click()
    expect(menuItems().map((item) => item.textContent)).toContain(planLabel)
    menuItems()
      .find((item) => item.textContent === planLabel)!
      .click()

    await until(() => pickerTriggers().length === 2)
    expect(planTrigger().textContent).toBe(planLabel)
    const taskTrigger = () => pickerTriggers()[1]!
    expect(taskTrigger().getAttribute("aria-haspopup")).toBe("menu")
    viewStore.update((draft) => {
      const project = draft.projects[projectKey]?.project
      if (project) project.taskID = "missing-task"
    })
    await until(() =>
      container.textContent?.includes(
        "The previously selected task is no longer part of this plan.",
      ),
    )
    expect(taskTrigger().textContent).toBe("Select task")
    taskTrigger().click()
    menuItems()
      .find((item) => item.textContent === `running · ${references[0]}`)!
      .click()
    await until(() => pickerTriggers()[1]?.textContent === `running · ${references[0]}`)

    taskTrigger().click()
    expect(taskTrigger().textContent).toBe(`running · ${references[0]}`)
    const expectedTaskLabels = [`running · ${references[0]}`, `queued · ${references[1]}`]
    expect(menuItems().map((item) => item.textContent)).toEqual(expectedTaskLabels)
    menuItems()
      .find((item) => item.textContent === expectedTaskLabels[1])!
      .click()
    await until(() => pickerTriggers()[1]?.textContent === expectedTaskLabels[1])

    const updatedReference = "LZ-UPDATED-17"
    fixture.store.atomic((db) =>
      db
        .query("UPDATE task_schedule SET reference=? WHERE task_id=?")
        .run(updatedReference, taskIDs[1]!),
    )
    await until(() => pickerTriggers()[1]?.textContent === `queued · ${updatedReference}`)
    taskTrigger().click()
    expect(menuItems().map((item) => item.textContent)).toEqual([
      expectedTaskLabels[0]!,
      `queued · ${updatedReference}`,
    ])
    expect(container.textContent).not.toContain(taskIDs[0]!.slice(0, 8))
    expect(container.textContent).not.toContain(taskIDs[1]!.slice(0, 8))
    expect(streamOpens.map((open) => open.source)).toContain("radar.nodes")
    expect(streamOpens.map((open) => open.source)).toContain("radar.planEvents")
    expect(rpcIDs.every((id) => id === Streams.id)).toBe(true)
    expect(
      [...container.querySelectorAll('[role="menuitem"]')].every(
        (item) => item.textContent !== null && item.textContent.length > 0,
      ),
    ).toBe(true)
  } finally {
    mounted?.dispose()
    disposeSetup?.()
    streamsService?.dispose()
    await pool?.close()
    fixture.close()
    for (const [name, descriptor] of previousGlobals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
    dom.happyDOM.abort()
  }
})
