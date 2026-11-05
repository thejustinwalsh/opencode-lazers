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
    } = await import(pathToFileURL(`${outputDirectory}/targeted-trajectory-dom-test.js`).href)
    expect(replacedInferenceRuntime).toBe(true)

    const host: TrajectoryHost = {
      session: (id) => fixture.host.session(id),
      status: async (id) => {
        const session = fixture.sessions.get(id)
        return session
          ? { ...session, messages: null, messageStatus: "not-read", messageError: null }
          : null
      },
    }
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
    const reads = new ObservationReads(fixture.store, host, "project", cursorSecret)
    expect(() => reads.snapshot({ kind: "project", sessionID: "ses-owner" }, tracker)).toThrow(
      "Observation scope is too large; narrow it",
    )
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
        }) => reads.trajectory(input, tracker),
        trajectoryHistory: async (input: {
          scope: Parameters<typeof reads.trajectoryHistory>[0]["scope"]
          taskID: string
          limit: number
          cursor?: string
        }) => {
          historyCalls++
          return reads.trajectoryHistory(input, tracker)
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
    expect(container.querySelector(".lazers-trajectory-axis")).not.toBeNull()
    const measuredSegment = [
      ...container.querySelectorAll<HTMLElement>(".lazers-trajectory-segment"),
    ].find((segment) => Number.parseFloat(segment.style.width) > 0)
    expect(measuredSegment).toBeDefined()
    expect(measuredSegment?.dataset.point).toBe("false")
    expect(measuredSegment?.title).toContain("Report model-activity interval:")
    expect(measuredSegment?.title).not.toContain("WORKER_STARTED")
    expect(
      [...container.querySelectorAll<HTMLButtonElement>(".lazers-trajectory-attempt-label")].map(
        (button) => button.getAttribute("aria-label"),
      ),
    ).toEqual(["Select attempt 1, failed", "Select attempt 2, accepted"])
    expect(
      [...container.querySelectorAll<HTMLButtonElement>(".lazers-trajectory-check-marker")].some(
        (button) => button.getAttribute("aria-label")?.includes("attempt-check"),
      ),
    ).toBe(true)
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
