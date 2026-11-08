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
  setupRadar(context: unknown): () => void
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

test("registered /lz-radar renders live scopes, concurrent calls and stable compact inspection", async () => {
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
      location: {
        get: async (_input: unknown, options: { signal: AbortSignal }) => {
          options.signal.throwIfAborted()
          return { project: { id: projectID, canonical: fixture.directory } }
        },
      },
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
    const context = {
      id: "lazers",
      add: (token: unknown, value: unknown) => registrations.push({ token, value }),
      sessions: { current: () => session },
      layout: { open: () => {} },
      stores: { radarView: () => viewStore },
      appearance: { font: () => "test-mono" },
      ui: (await loadDOMEntry()).createTestUI(),
      main: () => ({}),
    }
    const host = await loadDOMEntry()
    disposeSetup = host.setupRadar(context)
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
    expect(String(styles)).toContain("@media (max-width: 450px)")
    expect(String(styles)).toContain("prefers-reduced-motion")

    const container = browserDocument.createElement("div")
    container.style.width = "390px"
    container.style.height = "420px"
    browserDocument.body.append(container)
    mounted = host.mountRadarPanel(panel!, context, session, container)

    await until(
      () =>
        liveRequests.some((request) => request.scope === "session") &&
        container.textContent?.includes("Current Architect") === true,
    )
    expect(liveRequests[0]).toMatchObject({
      scope: "session",
      sessionID: "ses-view-architect",
      includeUnmanagedSessions: false,
    })
    expect(container.textContent).toContain("No supported native metadata signal")
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
        container.textContent?.includes("model-request") === true &&
        container.textContent?.includes("gpt-6-luna") === true &&
        container.textContent?.includes("Tool Read") === true,
    )
    expect(container.textContent).toContain("Message msg_ui_architect")
    expect(container.textContent).toContain("Call call-ui-…itect")
    for (const decoy of [
      "PRIVATE ARCHITECT TEXT DECOY",
      "PRIVATE ARCHITECT OUTPUT DECOY",
      "PRIVATE ARCHITECT ARGUMENT DECOY",
      "PRIVATE ARCHITECT TOOL RESULT DECOY",
    ])
      expect(container.textContent).not.toContain(decoy)
    expect(container.textContent).not.toContain("[object Object]")
    expect(legacyCalls).toEqual({ snapshot: 0, radar: 0, trajectory: 0, diagnostics: 0 })

    const scopeButtons = [
      ...container.querySelectorAll<HTMLButtonElement>(".lazers-radar-scope button"),
    ]
    const projectButton = scopeButtons.find((button) => button.textContent === "Project")!
    projectButton.click()
    await until(() =>
      liveRequests.some(
        (request) => request.scope === "project" && !request.includeUnmanagedSessions,
      ),
    )
    expect(projectButton.getAttribute("aria-pressed")).toBe("true")
    await until(() =>
      [...container.querySelectorAll<HTMLButtonElement>(".lazers-radar-monitor-session")].some(
        (button) => button.textContent?.includes("ses-failed"),
      ),
    )
    const workerSessionButton = [
      ...container.querySelectorAll<HTMLButtonElement>(".lazers-radar-monitor-session"),
    ].find((button) => button.textContent?.includes("ses-failed"))!
    workerSessionButton.click()
    await until(
      () =>
        container.textContent?.includes("src/worker.ts") === true &&
        container.textContent?.includes("Tool calls · 2 returned") === true,
    )
    expect(container.textContent).toContain("read requested")
    expect(container.textContent).toContain("patch requested")
    expect(container.textContent).toContain("failed")
    expect(container.textContent).not.toContain("NATIVE FILE BODY DECOY")
    expect(container.textContent).not.toContain("PRIVATE TOKEN DECOY")
    expect(container.textContent).not.toContain("PATCH BODY DECOY")
    const broaderButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Managed sessions",
    )!
    broaderButton.click()
    await until(() =>
      liveRequests.some(
        (request) => request.scope === "project" && request.includeUnmanagedSessions,
      ),
    )
    expect(broaderButton.getAttribute("aria-pressed")).toBe("true")
    expect(container.textContent).toContain("Broader sessions shown")
    await until(
      () =>
        container.textContent?.includes("src/worker.ts") === true &&
        container.textContent?.includes("Tool calls · 2 returned") === true,
    )
    expect(container.querySelector(".lazers-radar-monitor-inspector")?.textContent).toContain(
      "ses-failed",
    )
    expect(historyRequests).toContain("ses-failed")

    const activity = container.querySelector<HTMLDivElement>(".lazers-radar-monitor-activity")!
    await until(() =>
      [...container.querySelectorAll<HTMLButtonElement>(".lazers-radar-monitor-target")].some(
        (button) => button.textContent?.includes("src/worker.ts"),
      ),
    )
    const targetButton = [
      ...container.querySelectorAll<HTMLButtonElement>(".lazers-radar-monitor-target"),
    ].find((button) => button.textContent?.includes("src/worker.ts"))!
    targetButton.focus()
    targetButton.click()
    await until(() => container.textContent?.includes("Selected call") === true)
    expect(container.textContent).toContain("Selected requested target:")
    expect(targetButton.getAttribute("aria-pressed")).toBe("true")
    expect(targetButton.querySelector("code")?.getAttribute("style")).toContain("test-mono")

    const separator = container.querySelector<HTMLDivElement>('[role="separator"]')!
    expect(separator.getAttribute("aria-orientation")).toBe("horizontal")
    const before = Number(separator.getAttribute("aria-valuenow"))
    separator.focus()
    separator.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        key: "ArrowUp",
        bubbles: true,
      }) as unknown as KeyboardEvent,
    )
    expect(Number(separator.getAttribute("aria-valuenow"))).toBeGreaterThan(before)

    activity.scrollTop = 37
    targetButton.focus()
    const previousReadCount = liveRequests.length
    tracker.native({
      id: "evt-ui-refresh",
      type: "session.updated",
      data: { sessionID: "ses-failed" },
    })
    await until(() => liveRequests.length > previousReadCount)
    expect(
      [...container.querySelectorAll<HTMLButtonElement>(".lazers-radar-monitor-target")].find(
        (button) => button.textContent?.includes("src/worker.ts"),
      ),
    ).toBe(targetButton)
    expect(browserDocument.activeElement).toBe(targetButton)
    expect(activity.scrollTop).toBe(37)
    expect(legacyCalls).toEqual({ snapshot: 0, radar: 0, trajectory: 0, diagnostics: 0 })
    expect(separator.getAttribute("aria-valuenow")).not.toBeNull()
    expect(container.textContent).toContain("Scheduler")
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
