import { expect } from "bun:test"
import { Window } from "happy-dom"
import solid from "vite-plugin-solid"
import { build } from "vite"
import { mkdir, rm } from "node:fs/promises"
import { fileURLToPath, pathToFileURL } from "node:url"
import { Streams } from "../../../src/streams/contract.ts"
import { TRAJECTORY_SOURCES } from "../../../src/streams/sources/trajectory-ref.ts"
import { TASK_SOURCES } from "../../../src/streams/sources/tasks-ref.ts"
import {
  rpc as demoRpc,
  taskID as demoTaskID,
} from "../../../website/demo/src/panels/trajectory-answers.ts"
import type { TrajectoryData } from "../../../website/demo/src/panels/trajectory-answers.ts"

const projectID = "stream-project"
const directory = "/workspace/trajectory-streams"
const ownerSessionID = "ses-stream-owner"
const taskID = demoTaskID(7)

function until(predicate: () => boolean) {
  return (async () => {
    for (let attempt = 0; attempt < 400 && !predicate(); attempt++)
      await new Promise<void>((resolve) => setTimeout(resolve, 5))
    expect(predicate()).toBe(true)
  })()
}

/** One task: a failed first attempt with a failed check, then a running second attempt. */
function data(version: number): TrajectoryData {
  return {
    version,
    task: {
      n: 7,
      title: "Record check timing",
      objective: "Show recorded verification timing precisely",
      state: "running",
      plan: "Timing",
    },
    attempts: [
      {
        number: 1,
        state: "failed",
        start: 3,
        end: 60,
        workEnd: 50,
        model: { providerID: "p", id: "m" },
      },
      {
        number: 2,
        state: "running",
        start: 70,
        end: null,
        workEnd: null,
        model: { providerID: "p", id: "m" },
      },
    ],
    calls: [
      { key: "a", attempt: 1, tool: "Read", at: 10, s: 2, status: "completed", path: "src/a.ts" },
      { key: "b", attempt: 1, tool: "Bash", at: 30, s: 5, status: "error", command: "bun test" },
      { key: "c", attempt: 2, tool: "Edit", at: 80, s: 3, status: "completed", path: "src/a.ts" },
    ],
    checks: [
      {
        id: "tests",
        attempt: 1,
        start: 40,
        end: 41.1,
        result: "failed",
        command: "bun test quality",
        exit: 1,
      },
    ],
    others: [],
  }
}

/** `pinned`: the task is chosen in the view; `target`: another panel asked to open it. */
export async function run(mode: "pinned" | "target") {
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

  const guiRoot = fileURLToPath(new URL("../../../src/gui.tsx", import.meta.url))
  const entry = fileURLToPath(new URL("./trajectory-dom-entry.ts", import.meta.url))
  const outputDirectory = fileURLToPath(
    new URL(`../../../node_modules/.cache/trajectory-streams-${mode}-dom-test`, import.meta.url),
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
        lib: { entry, formats: ["es"], fileName: `trajectory-streams-${mode}-dom-test` },
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
    } = await import(
      pathToFileURL(`${outputDirectory}/trajectory-streams-${mode}-dom-test.js`).href
    )
    expect(replacedInferenceRuntime).toBe(true)
    // The service answers `lazers.streams`; a change notifies every open stream, as the server does.
    let current = data(1)
    const calls: Array<{ source: string; window: number; filter: Record<string, unknown> }> = []
    const handlers = demoRpc(() => current)[Streams.id] as unknown as Record<
      string,
      (input: never) => unknown
    >
    const opened = new Set<string>()
    let pushChange: ((event: { data: { stream: string; seq: number } }) => void) | undefined
    const client = {
      location: {
        get: async () => ({ project: { canonical: directory, id: projectID } }),
      },
      rpc: () => ({
        open: async (input: {
          stream: string
          source: string
          window: number
          filter: Record<string, unknown>
        }) => {
          calls.push({ source: input.source, window: input.window, filter: input.filter })
          opened.add(input.stream)
          return handlers.open!(input as never)
        },
        slide: async (input: never) => handlers.slide!(input),
        seek: async (input: never) => handlers.seek!(input),
        read: async (input: never) => handlers.read!(input),
        touch: async () => ({ alive: true }),
        close: async (input: { stream: string }) => {
          opened.delete(input.stream)
          return handlers.close!(input as never)
        },
        events: {
          subscribe: (_name: string, { signal }: { signal: AbortSignal }) =>
            (async function* () {
              while (!signal.aborted) {
                const next = await new Promise<
                  { data: { stream: string; seq: number } } | undefined
                >((resolve) => {
                  pushChange = resolve
                  signal.addEventListener("abort", () => resolve(undefined), { once: true })
                })
                if (!next) return
                yield next
              }
            })(),
        },
      }),
      event: { subscribe: () => (async function* () {})() },
    }
    const registrations: Array<{ token: unknown; value: unknown }> = []
    const openedTabs: unknown[][] = []
    const modelsStore = createReactiveStore({ projects: {} })
    // The view already holds this task: a panel with no task context asks the person to pick.
    const trajectoryStore = createReactiveStore({
      projects: {
        [directory]: {
          scope: mode === "target" ? "project" : "session",
          selectedTaskID: mode === "target" ? null : taskID,
          selectedReference: null,
          target:
            mode === "target"
              ? {
                  requestID: "open-1",
                  taskID,
                  reference: "LZ-7",
                  projectID,
                  projectDirectory: directory,
                }
              : null,
          selectedKind: "",
          selectedRecordID: "",
          open: true,
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
      server: { id: "stream-server", connected: true, client },
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
    await until(
      () =>
        container.querySelector(".lazers-trajectory-heading")?.textContent ===
          "Show recorded verification timing precisely" &&
        container.querySelectorAll(".lazers-trajectory-check-marker").length > 0,
    )
    // Only the Trajectory and Tasks sources are read: no snapshot, no captured history.
    const sources = new Set(calls.map((call) => call.source))
    expect([...sources].sort()).toEqual(
      [
        TASK_SOURCES.schedule,
        TRAJECTORY_SOURCES.attempts,
        TRAJECTORY_SOURCES.effort,
        TRAJECTORY_SOURCES.events,
        TRAJECTORY_SOURCES.transcript,
      ].sort(),
    )
    // The timeline window is the rows in view plus slop; the effort and the header are one row.
    expect(calls.find((call) => call.source === TRAJECTORY_SOURCES.effort)?.window).toBe(1)
    expect(
      Math.max(
        ...calls
          .filter((call) => call.source === TRAJECTORY_SOURCES.events)
          .map((call) => call.window),
      ),
    ).toBe(120)
    expect(container.querySelector(".lazers-trajectory-line1")?.textContent).toContain("LZ-7")

    // Marks come from the timeline rows: both attempts, the failed check, the tool calls.
    expect(container.querySelectorAll(".lazers-trajectory-attempt").length).toBeGreaterThanOrEqual(
      2,
    )
    const failed = container.querySelector<HTMLElement>(
      '.lazers-trajectory-check-marker[data-result="failed"]',
    )!
    expect(failed).not.toBeNull()
    // A file call is drawn on two lanes with the one id.
    const toolMarks = () =>
      new Set(
        [...container.querySelectorAll('[data-mark-id*=":tool:"]')].map((mark) =>
          mark.getAttribute("data-mark-id"),
        ),
      ).size
    expect(toolMarks()).toBe(3)

    // A selected check reads its stored interval from the one-row detail stream.
    // The marks are redrawn as the first frames arrive: click the one on screen now.
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    container
      .querySelector<HTMLElement>('.lazers-trajectory-check-marker[data-result="failed"]')!
      .click()
    await until(
      () =>
        container.querySelector(".lazers-trajectory-command")?.textContent === "bun test quality",
    )
    const stat = (label: string) =>
      [...container.querySelectorAll('[data-pane="call"] .lazers-kit-stat')]
        .find((item) => item.querySelector("dt")?.textContent === label)
        ?.querySelector("dd")?.textContent
    await until(() => stat("Duration") === "1.1s")
    expect(container.querySelector(".lazers-trajectory-inspector")?.textContent).not.toMatch(
      /unknown|\d{13}/i,
    )
    expect(
      calls.some((call) => call.source === TRAJECTORY_SOURCES.events && call.window === 1),
    ).toBe(true)

    // A change in the service reaches the open streams: a call the worker just made appears.
    current = {
      ...data(2),
      calls: [
        ...data(2).calls,
        { key: "d", attempt: 2, tool: "Edit", at: 90, s: 2, status: "completed", path: "src/b.ts" },
      ],
    }
    // One subscription yields one event per turn: give it a turn for each stream.
    for (const stream of [...opened]) {
      pushChange?.({ data: { stream, seq: Number.MAX_SAFE_INTEGER } })
      await new Promise<void>((resolve) => setTimeout(resolve, 5))
    }
    await until(() => toolMarks() === 4)
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
}
