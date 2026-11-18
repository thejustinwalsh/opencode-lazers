import { afterAll, expect, test } from "bun:test"
import { Window } from "happy-dom"
import solid from "vite-plugin-solid"
import { build } from "vite"
import { mkdir, rm } from "node:fs/promises"
import { fileURLToPath, pathToFileURL } from "node:url"
import { ObservationChangeTracker } from "../../src/observability/changes.ts"
import { Observability } from "../../src/observability/contract.ts"
import { ProgressRecorder } from "../../src/progress/recorder.ts"
import { makeFixture, firstAttemptID } from "../trajectory/fixture.ts"
import { operationalReads } from "../radar/operational.ts"
import type { RadarNativeSession } from "../../src/observability/native.ts"

type DOMEntry = {
  createReactiveStore<T>(initial: T): {
    value: T
    ready(): boolean
    update(change: (draft: T) => void): void
  }
  registryTokens: { Command: unknown; MenuItem: unknown; Panel: unknown; Style: unknown }
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
  ): { dispose(): void; setVisible(value: boolean): void }
}

type Change = {
  projectID: string
  sequence: number
  repositoryVersion: number
  sourceRevision: number
  nativeRevision: number
  cause: "runner" | "native" | "gap"
  resnapshotRequired: boolean
}

function changeBus() {
  const queued: Change[] = []
  const waiters: ((value: Change | undefined) => void)[] = []
  const publish = (change: Change) => {
    const waiter = waiters.shift()
    if (waiter) waiter(change)
    else queued.push(change)
  }
  const subscribe = (signal: AbortSignal) =>
    (async function* () {
      while (!signal.aborted) {
        const value =
          queued.shift() ??
          (await new Promise<Change | undefined>((resolve) => {
            const done = (change: Change | undefined) => {
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
    for (let attempt = 0; attempt < 300 && !predicate(); attempt++)
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(predicate()).toBe(true)
  })()
}

const guiRoot = fileURLToPath(new URL("../../src/gui.tsx", import.meta.url))
const entry = fileURLToPath(new URL("./fixtures/radar-agent-monitor-dom-entry.ts", import.meta.url))
const outputDirectory = fileURLToPath(
  new URL("../../node_modules/.cache/radar-agent-monitor-dom-test", import.meta.url),
)
const inferenceRuntimeModule = "\0lazers-test-unused-inference-runtime"
let viteBuild: Promise<void> | undefined

async function loadDOMEntry() {
  viteBuild ??= (async () => {
    await rm(outputDirectory, { recursive: true, force: true })
    await mkdir(outputDirectory, { recursive: true })
    await build({
      configFile: false,
      resolve: { conditions: ["browser", "development", "module"] },
      define: { __LAZERS_RADAR_WORKER_SOURCE__: JSON.stringify("") },
      plugins: [
        solid(),
        {
          name: "radar-monitor-unused-inference-runtime",
          enforce: "pre",
          resolveId(source, importer) {
            if (source !== "./webgpu/runtime.ts" || importer !== guiRoot) return
            return inferenceRuntimeModule
          },
          load(id) {
            if (id !== inferenceRuntimeModule) return
            return `export function createInferenceRuntime() {
              throw new Error("The Radar monitor does not use local inference")
            }`
          },
        },
      ],
      build: {
        outDir: outputDirectory,
        emptyOutDir: true,
        minify: false,
        lib: { entry, formats: ["es"], fileName: "radar-agent-monitor-dom-test" },
        rolldownOptions: { output: { codeSplitting: false } },
      },
    })
  })()
  await viteBuild
  return (await import(
    pathToFileURL(`${outputDirectory}/radar-agent-monitor-dom-test.js`).href
  )) as DOMEntry
}

afterAll(async () => {
  await viteBuild
  await rm(outputDirectory, { recursive: true, force: true })
})

test("registered /lz-radar renders live session activity, concurrent calls and stable compact inspection", async () => {
  const dom = new Window({ url: "https://radar-monitor.localhost" })
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
  let disposeSetup: (() => void) | undefined
  let mounted: { dispose(): void; setVisible(value: boolean): void } | undefined
  let tracker: ObservationChangeTracker | undefined
  try {
    fixture.store.atomic((db) =>
      db.query("UPDATE runner_attempts SET state='running' WHERE id=?").run(firstAttemptID),
    )
    const recorder = new ProgressRecorder(fixture.store, "project")
    const createCall = (input: {
      tool: "read" | "patch"
      callID: string
      messageID: string
      target: string
    }) => {
      const observed = recorder.recordToolTargets({
        tool: input.tool,
        sessionID: "ses-failed",
        agent: "lazers-implementor",
        messageID: input.messageID,
        callID: input.callID,
        input:
          input.tool === "read"
            ? {
                path: input.target,
                content: "NATIVE FILE BODY DECOY",
                token: "PRIVATE TOKEN DECOY",
              }
            : {
                patchText: [
                  "*** Begin Patch",
                  `*** Update File: ${input.target}`,
                  "+PATCH BODY DECOY",
                  "*** End Patch",
                ].join("\n"),
              },
      })
      expect(observed).toBeGreaterThan(0)
      recorder.recordNativeEvent({
        id: `evt-input-${input.callID}`,
        type: "session.tool.input.started",
        created: Date.now() - 1_000,
        data: {
          sessionID: "ses-failed",
          assistantMessageID: input.messageID,
          id: input.callID,
          name: input.tool,
        },
      })
    }
    createCall({
      tool: "read",
      callID: "call-ui-read",
      messageID: "msg_ui_read",
      target: "src/worker.ts",
    })
    createCall({
      tool: "patch",
      callID: "call-ui-patch",
      messageID: "msg_ui_patch",
      target: "src/manifest.ts",
    })
    recorder.recordNativeEvent({
      id: "evt-ui-patch-failed",
      type: "session.tool.failed",
      created: Date.now(),
      data: {
        sessionID: "ses-failed",
        assistantMessageID: "msg_ui_patch",
        id: "call-ui-patch",
        error: { type: "ToolError", message: "Patch failed after the request; change is unknown." },
      },
    })

    const projectID = "project"
    const secret = new Uint8Array(32).fill(91)
    const architect: RadarNativeSession = {
      id: "ses-view-architect",
      projectID,
      parentID: null,
      directory: fixture.directory,
      agent: "architect",
      model: { providerID: "openai", id: "gpt-6-luna", variant: "high" },
      archived: false,
      busy: true,
      createdAt: Date.now() - 1_000,
      updatedAt: Date.now(),
    }
    const reads = operationalReads(fixture, projectID, secret, [architect])
    const bus = changeBus()
    tracker = new ObservationChangeTracker(fixture.repository, secret, projectID)
    tracker.initialize((change) => bus.publish(change))
    const liveRequests: Array<{
      scope: string
      sessionID: string
      includeUnmanagedSessions: boolean
    }> = []
    const historyRequests: string[] = []
    const legacyCalls = { snapshot: 0, radar: 0, trajectory: 0, diagnostics: 0 }
    const rpc = {
      liveRadar: (
        input: {
          scope: { kind: "session" | "project"; sessionID: string }
          includeUnmanagedSessions: boolean
        },
        options: { signal: AbortSignal },
      ) => {
        liveRequests.push({
          scope: input.scope.kind,
          sessionID: input.scope.sessionID,
          includeUnmanagedSessions: input.includeUnmanagedSessions,
        })
        return reads.liveRadar(input, tracker!, options.signal, tracker!.streamEpoch)
      },
      liveHistory: (
        input: {
          scope: { kind: "session" | "project"; sessionID: string }
          sessionID: string
          limit: number
          cursor?: string
        },
        options: { signal: AbortSignal },
      ) => {
        historyRequests.push(input.sessionID)
        return reads.liveHistory(input, options.signal)
      },
      snapshot: async () => {
        legacyCalls.snapshot++
        throw new Error("Observation scope is too large; narrow it")
      },
      radar: async () => {
        legacyCalls.radar++
        throw new Error("Observation scope is too large; narrow it")
      },
      trajectory: async () => {
        legacyCalls.trajectory++
        throw new Error("Unexpected context call")
      },
      progressDiagnostics: async () => {
        legacyCalls.diagnostics++
        throw new Error("Unexpected diagnostics call")
      },
      events: {
        subscribe: (_name: string, options: { signal: AbortSignal }) =>
          bus.subscribe(options.signal),
      },
    }
    const client = {
      // Radar identifies the project by path and reads only loaded locations; location.get would boot one.
      project: {
        list: async (_input: unknown, options: { signal: AbortSignal }) => {
          options.signal.throwIfAborted()
          return [{ id: projectID, canonical: fixture.directory }]
        },
      },
      debug: { location: { list: async () => [{ directory: fixture.directory }] } },
      rpc: (_definition: typeof Observability) => rpc,
    }
    const session = {
      id: "ses-view-architect",
      location: {},
      directory: fixture.directory,
      server: { id: "radar-server", connected: true, client },
    }
    const registrations: Array<{ token: unknown; value: unknown }> = []
    const viewStore = (await loadDOMEntry()).createReactiveStore({
      projects: {} as Record<string, unknown>,
    })
    const opened: unknown[] = []
    const context = {
      id: "lazers",
      add: (token: unknown, value: unknown) => registrations.push({ token, value }),
      sessions: { current: () => session },
      layout: { open: () => {} },
      tabs: { open: (...args: unknown[]) => opened.push(["worker", ...args]) },
      stores: { radarView: () => viewStore },
      appearance: { font: () => "test-mono" },
      ui: (await loadDOMEntry()).createTestUI(),
      main: () => ({}),
    }
    const host = await loadDOMEntry()
    disposeSetup = host.setupRadar(context, {
      openTask: (_session: unknown, target: unknown) => opened.push(["task", target]),
      openTrajectory: (_session: unknown, target: unknown) => opened.push(["trajectory", target]),
    })
    const panel = host.radarPanelRegistration(registrations)
    expect(panel).toBeDefined()
    const tokens = host.registryTokens
    expect(registrations.some((item) => item.token === tokens.Style)).toBe(true)
    const command = registrations.find((item) => item.token === tokens.Command)?.value as {
      slash: { name: string }
    }
    expect(command.slash.name).toBe("lz-radar")
    expect(registrations.some((item) => item.token === tokens.MenuItem)).toBe(true)
    const styles = registrations.find((item) => item.token === tokens.Style)?.value
    expect(String(styles)).toContain(".lazers-radar-monitor")
    expect(String(styles)).toContain("@container lazers-radar (max-width: 360px)")
    expect(String(styles)).toContain("@container lazers-radar (min-width: 640px)")
    expect(String(styles)).not.toContain("lazers-radar-timeline")
    expect(String(styles)).toContain(".lazers-radar-session-main > .lazers-radar-session-icon")
    expect(String(styles)).not.toMatch(/\n\.lazers-radar-session-icon \{\n\s+grid-area/)
    expect(String(styles)).not.toContain("--icon-success-base);\n}\n.lazers-radar-status-dot")
    expect(String(styles)).toContain("prefers-reduced-motion")

    const container = browserDocument.createElement("div")
    container.style.width = "390px"
    container.style.height = "420px"
    browserDocument.body.append(container)
    mounted = host.mountRadarPanel(panel!, context, session, container)

    const text = () => container.textContent ?? ""
    const sessionButton = (sessionID: string) =>
      [...container.querySelectorAll<HTMLButtonElement>(".lazers-radar-session-main")].find(
        (button) => button.dataset.sessionId === sessionID,
      )
    const chooseScope = async (label: string) => {
      container.querySelector<HTMLButtonElement>(".lazers-radar-scope button")!.click()
      const item = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
        (button) => button.textContent === label,
      )!
      item.click()
    }

    await until(
      () =>
        liveRequests.some((request) => request.scope === "session") &&
        sessionButton("ses-view-architect")?.textContent?.includes("Architect") === true,
    )
    expect(liveRequests[0]).toMatchObject({
      scope: "session",
      sessionID: "ses-view-architect",
      includeUnmanagedSessions: false,
    })
    expect(text()).not.toContain("No model or tool events in this read")
    expect(text()).toContain("Busy · no call in progress")
    expect(["Live", "Reconnecting", "Offline"]).toContain(
      container.querySelector(".lazers-radar-connection")?.textContent ?? "",
    )
    // One header; nothing is selected, so there is no inspector and no separator.
    expect(container.querySelectorAll(".lazers-radar-header").length).toBe(1)
    expect(
      [...container.querySelectorAll<HTMLButtonElement>('.lazers-radar-views [role="tab"]')].map(
        (tab) => tab.textContent,
      ),
    ).toEqual(["Monitor", "Map", "Flow"])
    expect(container.querySelector(".lazers-radar-monitor-inspector")).toBeNull()
    expect(container.querySelector('[role="separator"]')).toBeNull()
    expect(container.querySelector(".lazers-radar-monitor")?.getAttribute("data-inspector")).toBe(
      "false",
    )
    expect(text()).not.toContain("Select a session to see its details")
    const headerShape = () =>
      [...container.querySelector(".lazers-radar-header")!.children].map(
        (child) => child.className || child.tagName,
      )
    const monitorHeaderShape = headerShape()
    expect(text()).not.toMatch(/nknown|not observed|Not reported|None reported|Unavailable/)
    expect(text()).not.toMatch(/ses[-_]/)
    expect(container.querySelector(".lazers-radar-scope button")?.textContent).toBe("This session")
    tracker.native({
      id: "evt-ui-architect-step",
      type: "session.step.started",
      created: Date.now() - 500,
      durable: { aggregateID: "ses-view-architect", seq: 1, version: 2 },
      data: {
        sessionID: "ses-view-architect",
        assistantMessageID: "msg_ui_architect",
        agent: "architect",
        model: { providerID: "openai", id: "gpt-6-luna", variant: "high" },
        text: "PRIVATE ARCHITECT TEXT DECOY",
      },
    })
    tracker.native({
      id: "evt-ui-architect-text",
      type: "session.text.ended",
      created: Date.now() - 400,
      durable: { aggregateID: "ses-view-architect", seq: 2, version: 2 },
      data: {
        sessionID: "ses-view-architect",
        assistantMessageID: "msg_ui_architect",
        text: "PRIVATE ARCHITECT OUTPUT DECOY",
      },
    })
    tracker.native({
      id: "evt-ui-architect-tool-input",
      type: "session.tool.input.started",
      created: Date.now() - 300,
      durable: { aggregateID: "ses-view-architect", seq: 3, version: 2 },
      data: {
        sessionID: "ses-view-architect",
        assistantMessageID: "msg_ui_architect",
        id: "call-ui-architect",
        name: "Read",
        input: { path: "PRIVATE ARCHITECT ARGUMENT DECOY" },
      },
    })
    tracker.native({
      id: "evt-ui-architect-tool-success",
      type: "session.tool.success",
      created: Date.now() - 200,
      durable: { aggregateID: "ses-view-architect", seq: 4, version: 2 },
      data: {
        sessionID: "ses-view-architect",
        assistantMessageID: "msg_ui_architect",
        id: "call-ui-architect",
        content: [{ type: "text", text: "PRIVATE ARCHITECT TOOL RESULT DECOY" }],
      },
    })
    await until(
      () =>
        text().includes("Model request") &&
        text().includes("gpt-6-luna") &&
        text().includes("Read completed"),
    )
    expect(sessionButton("ses-view-architect")?.textContent).toContain("gpt-6-luna · high")
    const modelFlow = [
      ...container.querySelectorAll<HTMLButtonElement>(".lazers-radar-flow-row"),
    ].find((button) => button.textContent?.includes("Model request"))!
    expect(modelFlow.textContent).toContain("Architect / Model request")
    modelFlow.click()
    await until(() => modelFlow.getAttribute("aria-pressed") === "true")
    const inspectorText = () =>
      container.querySelector(".lazers-radar-monitor-inspector")?.textContent ?? ""
    expect(inspectorText()).not.toContain("msg_ui_architect")
    expect(inspectorText()).toContain("openai / gpt-6-luna · high")
    expect(container.querySelector('[role="separator"]')).not.toBeNull()
    for (const decoy of [
      "PRIVATE ARCHITECT TEXT DECOY",
      "PRIVATE ARCHITECT OUTPUT DECOY",
      "PRIVATE ARCHITECT ARGUMENT DECOY",
      "PRIVATE ARCHITECT TOOL RESULT DECOY",
    ])
      expect(text()).not.toContain(decoy)
    expect(text()).not.toContain("[object Object]")
    expect(legacyCalls).toEqual({ snapshot: 0, radar: 0, trajectory: 0, diagnostics: 0 })

    await chooseScope("Project")
    await until(() =>
      liveRequests.some(
        (request) => request.scope === "project" && !request.includeUnmanagedSessions,
      ),
    )
    await until(() => sessionButton("ses-failed") !== undefined)
    expect(container.querySelector(".lazers-radar-scope button")?.textContent).toBe("Project")
    sessionButton("ses-failed")!.click()
    const lines = () => [...container.querySelectorAll<HTMLButtonElement>(".lazers-radar-line")]
    await until(
      () =>
        lines().some((line) => line.textContent?.includes("src/worker.ts")) &&
        lines().some((line) => line.textContent?.includes("patch failed")),
    )
    expect(sessionButton("ses-failed")?.textContent).toContain("Inspect a worker attempt")
    expect(container.querySelector(".lazers-radar-monitor-activity")?.textContent).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-/,
    )
    expect(sessionButton("ses-failed")?.textContent).toContain("Running")
    expect(
      lines().find((line) => line.textContent?.includes("patch failed"))?.textContent,
    ).toContain("Patch failed after the request; change is unknown.")
    expect(text()).not.toContain("NATIVE FILE BODY DECOY")
    expect(text()).not.toContain("PRIVATE TOKEN DECOY")
    expect(text()).not.toContain("PATCH BODY DECOY")

    await chooseScope("Project · all sessions")
    await until(() =>
      liveRequests.some(
        (request) => request.scope === "project" && request.includeUnmanagedSessions,
      ),
    )
    expect(container.querySelector(".lazers-radar-scope button")?.textContent).toBe(
      "Project · all sessions",
    )
    await until(() => lines().some((line) => line.textContent?.includes("src/worker.ts")))
    expect(inspectorText()).toContain("ses-failed")
    expect(container.querySelector(".lazers-radar-inspector-title")?.textContent).toContain(
      "Inspect a worker attempt without disclosing private data",
    )
    expect(container.querySelector(".lazers-radar-inspector-title")?.textContent).not.toContain(
      "Task ",
    )
    expect(container.querySelector(".lazers-radar-facts-line")?.textContent).toContain("attempt")
    expect(
      [...container.querySelectorAll(".lazers-radar-inspector-tabs button")].map((tab) =>
        tab.textContent?.replace(/\d+$/, "").trim(),
      ),
    ).toEqual(["Calls", "Files", "Messages"])
    expect(historyRequests).toContain("ses-failed")
    const inspectorHead = container.querySelector(".lazers-radar-inspector-head")!
    expect(inspectorHead.querySelector(".lazers-radar-state-dot")).not.toBeNull()
    expect(inspectorHead.querySelector(".lazers-radar-session-icon")).toBeNull()
    const rowStates = [
      ...container.querySelectorAll(".lazers-radar-sessions .lazers-radar-session-state"),
    ].map((state) => state.textContent ?? "")
    expect(rowStates.length).toBeGreaterThan(2)
    expect(rowStates.findIndex((state) => state.startsWith("Idle"))).toBeGreaterThan(
      rowStates.findLastIndex((state) => state === "Busy" || state === "Running"),
    )
    expect(container.querySelector(".lazers-radar-unavailable")).toBeNull()
    const summary = container.querySelector(".lazers-radar-summary")!
    expect(summary.textContent).toMatch(/\d+ running/)
    expect(summary.textContent).not.toMatch(/Scheduler|active|idle/)
    expect(container.querySelector(".lazers-radar-monitor-status")).toBeNull()

    const activity = container.querySelector<HTMLDivElement>(".lazers-radar-monitor-activity")!
    const readLine = lines().find((line) => line.textContent?.includes("src/worker.ts"))!
    readLine.focus()
    readLine.click()
    await until(() => inspectorText().includes("Requested read target"))
    expect(readLine.getAttribute("aria-pressed")).toBe("true")
    expect(readLine.querySelector("code")?.getAttribute("style")).toContain("test-mono")
    expect(inspectorText()).toContain("src/worker.ts")

    const linkButton = (label: string) =>
      [...container.querySelectorAll<HTMLButtonElement>(".lazers-radar-links button")].find(
        (button) => button.textContent === label,
      )!
    linkButton("Open worker").click()
    linkButton("Open task").click()
    linkButton("Trajectory").click()
    expect(opened).toEqual([
      ["worker", { server: "radar-server", id: "ses-failed" }, { focus: true }],
      ["task", { taskID: expect.any(String), projectID, projectDirectory: fixture.directory }],
      [
        "trajectory",
        {
          taskID: expect.any(String),
          reference: expect.stringMatching(/\S/),
          projectID,
          projectDirectory: fixture.directory,
        },
      ],
    ])

    const separator = container.querySelector<HTMLDivElement>('[role="separator"]')!
    expect(separator.getAttribute("aria-orientation")).toBe("horizontal")
    expect(separator.getAttribute("aria-valuetext")).toContain("Activity")
    const before = Number(separator.getAttribute("aria-valuenow"))
    separator.focus()
    separator.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        key: "PageDown",
        bubbles: true,
      }) as unknown as KeyboardEvent,
    )
    await until(() => Number(separator.getAttribute("aria-valuenow")) > before)
    const savedProject = Object.values(
      viewStore.value.projects as Record<
        string,
        { project: { monitorSplit?: number; monitorSessionID?: string } }
      >,
    )[0]!.project
    expect(savedProject.monitorSplit).toBe(Number(separator.getAttribute("aria-valuenow")))
    expect(savedProject.monitorSessionID).toBe("ses-failed")

    activity.scrollTop = 37
    readLine.focus()
    const previousReadCount = liveRequests.length
    tracker.native({
      id: "evt-ui-refresh",
      type: "session.updated",
      data: { sessionID: "ses-failed" },
    })
    await until(() => liveRequests.length > previousReadCount)
    expect(lines().find((line) => line.textContent?.includes("src/worker.ts"))).toBe(readLine)
    expect(browserDocument.activeElement).toBe(readLine)
    expect(activity.scrollTop).toBe(37)
    expect(readLine.getAttribute("aria-pressed")).toBe("true")
    expect(legacyCalls).toEqual({ snapshot: 0, radar: 0, trajectory: 0, diagnostics: 0 })
    expect(text()).not.toContain("Tool completed")

    // The ⋯ menu keeps Refresh and no longer carries Diagnostics.
    const actions = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.getAttribute("aria-label") === "Radar actions",
    )!
    actions.click()
    expect(
      [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].map(
        (button) => button.textContent,
      ),
    ).toEqual(["Refresh"])
    actions.click()
    const tab = (label: string) =>
      [...container.querySelectorAll<HTMLButtonElement>('.lazers-radar-views [role="tab"]')].find(
        (button) => button.textContent === label,
      )!
    tab("Map").click()
    await until(() => tab("Map")?.getAttribute("aria-selected") === "true")
    expect((viewStore.value as { diagnostics?: boolean }).diagnostics).toBe(true)
    expect(container.querySelectorAll(".lazers-radar-header").length).toBe(1)
    expect(headerShape()).toEqual(monitorHeaderShape)
    expect(text()).not.toContain("Live monitor")
    expect(text()).not.toContain("Timeline")
    expect(
      [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].map(
        (item) => item.textContent,
      ),
    ).toEqual(["Monitor", "Map", "Flow"])
    expect(container.querySelector(".lazers-radar-scope button")?.textContent).toBe(
      "Project · all sessions",
    )
    tab("Monitor").click()
    await until(() => container.querySelector(".lazers-radar-monitor") !== null)
    expect((viewStore.value as { diagnostics?: boolean }).diagnostics).toBe(false)
    expect(headerShape()).toEqual(monitorHeaderShape)

    // Losing the service keeps the last sessions on screen, dimmed, under one banner.
    session.server.connected = false
    tracker.native({
      id: "evt-ui-offline",
      type: "session.updated",
      data: { sessionID: "ses-failed" },
    })
    await until(() => container.querySelector(".lazers-panel-banner") !== null)
    expect(container.querySelectorAll(".lazers-panel-banner").length).toBe(1)
    expect(container.querySelector(".lazers-radar-connection")?.textContent).toBe("Offline")
    expect(container.querySelector('[data-panel-dimmed="true"]')).not.toBeNull()
    expect(sessionButton("ses-failed")).toBeDefined()
    expect(text()).not.toMatch(/Syncing|Connecting|Transport|Timed out/)
  } finally {
    mounted?.dispose()
    disposeSetup?.()
    tracker?.close()
    fixture.close()
    for (const [name, descriptor] of previousGlobals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
    dom.happyDOM.abort()
  }
})
