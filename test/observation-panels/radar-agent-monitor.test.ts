import { afterAll, expect, test } from "bun:test"
import { Window } from "happy-dom"
import solid from "vite-plugin-solid"
import { build } from "vite"
import { mkdir, rm } from "node:fs/promises"
import { fileURLToPath, pathToFileURL } from "node:url"
import { ensureHostSessionStateSchema, writeHostSession } from "../../src/host-sessions/state.ts"
import { ensureNativeCallDisplaySchema } from "../../src/progress/native-call-display.ts"
import { ensureTranscriptMetaSchema } from "../../src/transcript-meta/schema.ts"
import { ProgressRecorder } from "../../src/progress/recorder.ts"
import { refreshProgressDisplay } from "../../src/progress/display-store.ts"
import { Streams } from "../../src/streams/contract.ts"
import { readerPool, type ReaderPool } from "../../src/streams/pool.ts"
import { createStreamsService } from "../../src/streams/rpc.ts"
import { makeFixture, firstAttemptID } from "../trajectory/fixture.ts"
import { insertTask } from "../../src/tasks/schedule/fixture.ts"

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

function changeBus<T = Change>() {
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
  let pool: ReaderPool | undefined
  let streamsService: ReturnType<typeof createStreamsService> | undefined
  try {
    fixture.store.atomic((db) =>
      db.query("UPDATE runner_attempts SET state='running' WHERE id=?").run(firstAttemptID),
    )
    const recorder = new ProgressRecorder(fixture.store, "project")
    // A hundred and fifty calls from long before the live ones (and recorded before them): the older calls.
    fixture.store.atomic((db) => {
      const attempt = db
        .query<{ plan_id: string; task_id: string }, [string]>(
          "SELECT plan_id,task_id FROM runner_attempts WHERE id=?",
        )
        .get(firstAttemptID)!
      const insert = db.query(
        `INSERT INTO runner_progress(project_directory,project_id,plan_id,task_id,attempt_id,session_id,
          at,recorded_at,source,sources_json,kind,event_ids_json,call_id,message_id,dedupe_key,payload)
         VALUES(?,?,?,?,?,?,?,?,?,'[]','tool','[]',?,?,?,?)`,
      )
      for (let index = 0; index < 150; index++) {
        const result = insert.run(
          fixture.directory,
          "project",
          attempt.plan_id,
          attempt.task_id,
          firstAttemptID,
          "ses-failed",
          1 + index,
          1 + index,
          "runtime",
          `call-older-${index}`,
          `msg-older-${index}`,
          `older-${index}`,
          JSON.stringify({
            tool: "read",
            status: "succeeded",
            fileTargets: {
              coverage: "observed",
              operation: "read",
              paths: [`src/older-${index}.ts`],
            },
          }),
        )
        refreshProgressDisplay(db, Number(result.lastInsertRowid))
      }
    })
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

    // Two queued tasks in a plan: the Map's Queue group reads them through `radar.group`.
    const queuedTasks = ["map-alpha", "map-beta"].map((name) =>
      insertTask(fixture.repository, name),
    )
    fixture.store.submit(
      {
        requestID: "radar-dom-queued",
        objective: "Queued work",
        baseCommit: "a".repeat(40),
        workspaceMode: "shared",
        nodes: queuedTasks.map((id) => ({ taskID: id, revision: 1 })),
        dependencies: [],
        integrationOrder: queuedTasks,
        verification: [{ id: "check", command: "bun test", timeoutMs: 60000 }],
        acceptance: [
          {
            id: "ok",
            assertion: "Checks pass",
            evidence: [{ kind: "verification", verificationID: "check" }],
          },
        ],
      },
      "ses-owner",
    )
    await fixture.index()
    const projectID = "project"
    ensureHostSessionStateSchema(fixture.repository)
    ensureTranscriptMetaSchema(fixture.repository)
    ensureNativeCallDisplaySchema(fixture.repository)
    /** The host's session facts as the fold stores them (`host_session_state`). */
    const hostSession = (
      id: string,
      change: { agent: string; parentID?: string | null; busy: boolean; updatedAt: number } & {
        model?: { providerID: string; id: string; variant: string | null } | null
      },
    ) =>
      fixture.repository.atomic((db) =>
        writeHostSession(db, fixture.directory, projectID, id, {
          id,
          projectID,
          parentID: change.parentID ?? null,
          agent: change.agent,
          title: null,
          directory: fixture.directory,
          archived: false,
          busy: change.busy,
          outcome: null,
          model: change.model ?? null,
          tokensIn: null,
          tokensOut: null,
          tokensReasoning: null,
          tokensCacheRead: null,
          tokensCacheWrite: null,
          createdAt: change.updatedAt - 1_000,
          updatedAt: change.updatedAt,
        }),
      )
    for (const native of fixture.sessions.values())
      hostSession(native.id, {
        agent: "worker",
        parentID: native.parentID,
        busy: native.busy,
        updatedAt: native.time.updated,
        model: native.model
          ? {
              providerID: native.model.providerID,
              id: native.model.id,
              variant: native.model.variant ?? null,
            }
          : null,
      })
    hostSession("ses-view-architect", {
      agent: "architect",
      busy: true,
      updatedAt: Date.now(),
      model: { providerID: "openai", id: "gpt-6-luna", variant: "high" },
    })
    // Every Monitor read is a stream, backed here by a real reader pool over the fixture's database.
    const streamBus = changeBus<{ stream: string; seq: number }>()
    const streamOpens: { source: string; filter: Record<string, unknown>; window: number }[] = []
    let frames = 0
    pool = readerPool(fixture.repository.path, { workers: 1 })
    streamsService = createStreamsService({
      pool,
      changed: (stream, seq) => {
        frames++
        streamBus.publish({ stream, seq })
      },
      context: {
        projectID: projectID,
        projectDirectory: fixture.directory,
        projectIds: (id) => [id],
        assertRead: async () => {},
        read: (run) => fixture.repository.read(run),
      },
    })
    const streamsRpc = {
      open: (input: { source: string; filter: Record<string, unknown>; window: number }) => {
        streamOpens.push(input)
        return streamsService!.open(input as never)
      },
      slide: (input: never) => streamsService!.slide(input),
      seek: (input: never) => streamsService!.seek(input),
      read: (input: never) => streamsService!.read(input),
      touch: (input: never) => streamsService!.touch(input),
      close: (input: never) => streamsService!.close(input),
      events: {
        subscribe: (_name: string, options: { signal: AbortSignal }) =>
          streamBus.subscribe(options.signal),
      },
    }
    const bus = changeBus()
    const legacyCalls = { snapshot: 0, radar: 0, trajectory: 0, diagnostics: 0 }
    const rpc = {
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
      // The bundled panel carries its own copy of the contract: match it by id.
      rpc: (definition: { id: string }) => (definition.id === Streams.id ? streamsRpc : rpc),
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
    expect(String(styles)).toContain("@container lazers-radar (max-width: 420px)")
    expect(String(styles)).not.toContain("lazers-radar-timeline")
    expect(String(styles)).toContain(".lazers-radar-session-children")
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
    /** The Monitor opened `radar.sessions` in this scope. */
    const sessionsOpened = (kind: string) =>
      streamOpens.some(
        (open) =>
          open.source === "radar.sessions" &&
          (open.filter.scope as { kind: string; sessionID: string }).kind === kind &&
          (open.filter.scope as { sessionID: string }).sessionID === "ses-view-architect",
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
        sessionsOpened("session") &&
        sessionButton("ses-view-architect")?.textContent?.includes("Architect") === true,
    )
    expect(text()).not.toContain("No model or tool events in this read")
    expect(text()).not.toContain("Busy · no call in progress")
    expect(["Live", "Reconnecting", "Offline"]).toContain(
      container.querySelector(".lazers-radar-connection")?.textContent ?? "",
    )
    // One header; the details pane is always there, collapsed to its bar, saying nothing is selected.
    expect(container.querySelectorAll(".lazers-radar-header").length).toBe(1)
    expect(
      [...container.querySelectorAll<HTMLButtonElement>('.lazers-radar-views [role="tab"]')].map(
        (tab) => tab.textContent,
      ),
    ).toEqual(["Monitor", "Map", "Flow"])
    expect(container.querySelector(".lazers-radar-monitor-inspector")).toBeNull()
    expect(container.querySelector(".lazers-details")?.getAttribute("data-open")).toBe("false")
    expect(container.querySelector(".lazers-details-header")?.textContent).toBe(
      "No session selected",
    )
    const openPane = () => {
      const chevron = container.querySelector<HTMLButtonElement>(".lazers-details-chevron")!
      if (chevron.getAttribute("aria-expanded") !== "true") chevron.click()
    }
    expect(text()).not.toContain("Select a session to see its details")
    const headerShape = () =>
      [...container.querySelector(".lazers-radar-header")!.children].map(
        (child) => child.className || child.tagName,
      )
    const monitorHeaderShape = headerShape()
    expect(text()).not.toMatch(/nknown|not observed|Not reported|None reported|Unavailable/)
    expect(text()).not.toMatch(/ses[-_]/)
    expect(container.querySelector(".lazers-radar-scope button")?.textContent).toBe("This session")
    // The Architect's call as the canonical per-call record stores it (`native_tool_calls`, shown
    // through `native_tool_call_display`). Its arguments and result are never stored.
    fixture.repository.atomic((db) =>
      db
        .query(
          `INSERT INTO native_tool_calls(project_directory,project_id,session_id,identity_kind,
             invocation_id,native_call_id,context_call_id,message_id,agent,tool,first_observed_at,
             last_observed_at,sources_json,event_ids_json,payload)
           VALUES(?,?,?,'native-call',?,?,?,?,?,?,?,?,'[]','[]',?)`,
        )
        .run(
          fixture.directory,
          projectID,
          "ses-view-architect",
          "call-ui-architect",
          "call-ui-architect",
          "call-ui-architect",
          "msg_ui_architect",
          "architect",
          "Read",
          Date.now() - 300,
          Date.now() - 200,
          JSON.stringify({ status: "succeeded" }),
        ),
    )
    await until(
      () =>
        text().includes("gpt-6-luna") &&
        container.querySelector(".lazers-radar-session-lines .lazers-radar-call-tool")
          ?.textContent === "Read",
    )
    expect(text()).not.toContain("completed")
    expect(sessionButton("ses-view-architect")?.textContent).toContain("gpt-6-luna · high")
    sessionButton("ses-view-architect")!.click()
    // Picking a session updates the pane header and opens the pane; mounting did not.
    await until(
      () =>
        container.querySelector(".lazers-details-header")?.textContent?.includes("Architect") ===
        true,
    )
    await until(
      () => container.querySelector(".lazers-details")?.getAttribute("data-open") === "true",
    )
    openPane()
    await until(() => container.querySelector(".lazers-radar-monitor-inspector") !== null)
    const inspectorText = () =>
      container.querySelector(".lazers-radar-monitor-inspector")?.textContent ?? ""
    const disclosure = (label: string) =>
      [
        ...container.querySelectorAll<HTMLButtonElement>(
          ".lazers-radar-disclosures .lazers-kit-disclosure-toggle",
        ),
      ].find((toggle) => toggle.textContent?.startsWith(label))
    const openDisclosure = async (label: string) => {
      await until(() => disclosure(label) !== undefined)
      if (disclosure(label)!.getAttribute("aria-expanded") !== "true") disclosure(label)!.click()
    }
    // An Architect's model steps have no stored form (`transcript_steps` folds worker attempts):
    // it shows no Messages rather than anything not stored.
    await until(() => inspectorText().includes("gpt-6-luna · high"))
    expect(container.querySelectorAll(".lazers-radar-message").length).toBe(0)
    expect(inspectorText()).not.toContain("msg_ui_architect")
    expect(inspectorText()).toContain("gpt-6-luna · high")
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
    await until(() => sessionsOpened("project"))
    await until(() => sessionButton("ses-failed") !== undefined)
    expect(container.querySelector(".lazers-radar-scope button")?.textContent).toBe("Project")
    sessionButton("ses-failed")!.click()
    const lines = () => [...container.querySelectorAll<HTMLButtonElement>(".lazers-radar-call")]
    await until(
      () =>
        lines().some((line) => line.textContent?.includes("src/worker.ts")) &&
        lines().some((line) => line.textContent?.includes("Patch failed")),
    )
    expect(sessionButton("ses-failed")?.textContent).toContain("Inspect a worker attempt")
    expect(container.querySelector(".lazers-radar-monitor-activity")?.textContent).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-/,
    )
    // The row names the task's own state word, the one Tasks shows.
    expect(sessionButton("ses-failed")?.textContent).toContain("accepted")
    expect(
      lines().find((line) => line.textContent?.includes("Patch failed"))?.textContent,
    ).toContain("Patch failed after the request; change is unknown.")
    expect(text()).not.toContain("NATIVE FILE BODY DECOY")
    expect(text()).not.toContain("PRIVATE TOKEN DECOY")
    expect(text()).not.toContain("PATCH BODY DECOY")

    await chooseScope("Project · all sessions")
    await until(
      () =>
        container.querySelector(".lazers-radar-scope button")?.textContent ===
        "Project · all sessions",
    )
    expect(container.querySelector(".lazers-radar-scope button")?.textContent).toBe(
      "Project · all sessions",
    )
    await until(() => lines().some((line) => line.textContent?.includes("src/worker.ts")))
    // The pane state is stored per scope: this scope starts collapsed.
    openPane()
    await until(() => disclosure("Identifiers") !== undefined)
    // Identifiers is the one place for raw ids; the tab strip is gone and empty parts are omitted.
    expect(container.querySelector(".lazers-radar-inspector-tabs")).toBeNull()
    expect(inspectorText()).not.toContain("ses-failed")
    await openDisclosure("Identifiers")
    expect(inspectorText()).toContain("ses-failed")
    expect(container.querySelector(".lazers-radar-inspector-title")).toBeNull()
    expect(
      [
        ...container.querySelectorAll(".lazers-radar-disclosures .lazers-kit-disclosure-toggle"),
      ].map((toggle) => toggle.textContent ?? ""),
    ).not.toContainEqual(expect.stringMatching(/· 0$/))
    expect(
      [...container.querySelectorAll(".lazers-radar-monitor-inspector .lazers-kit-stat dt")].map(
        (label) => label.textContent,
      ),
    ).toContain("Started")
    expect(container.querySelector(".lazers-radar-last-call")?.textContent).toContain("Last call")
    // The stat row is a direct, unwrapped child of the inspector, so it spans the pane's width.
    const statRow = container.querySelector<HTMLElement>(
      ".lazers-radar-monitor-inspector > .lazers-kit-stats",
    )
    expect(statRow).not.toBeNull()
    expect(statRow!.style.getPropertyValue("--lazers-kit-columns")).toMatch(/^[1-4]$/)
    // The attempt read supplies the call count; the state word is the task's own word.
    await until(() =>
      [...container.querySelectorAll(".lazers-radar-monitor-inspector .lazers-kit-stat dt")].some(
        (label) => label.textContent === "Calls",
      ),
    )
    expect(container.querySelector(".lazers-radar-inspector-word")?.textContent).toMatch(
      /^[A-Z][a-z]+$/,
    )
    expect(
      [...container.querySelectorAll(".lazers-radar-monitor-inspector [role=columnheader]")]
        .slice(0, 4)
        .map((header) => header.textContent),
    ).toEqual(["Tool", "Target", "Duration", "Time"])
    expect(inspectorText()).not.toMatch(/Grep|read\b/)
    // The worker's older calls open as a stream of the attempt, tools only, from before its live calls.
    // The pane also opens the attempt's own streams (its row, its whole call lane, its newest
    // row); the older-calls list is the one bounded before the live read's earliest call.
    const olderOpen = () => streamOpens.filter((open) => open.filter.beforeAt !== undefined).at(-1)
    await until(() => olderOpen() !== undefined)
    expect(streamOpens.map((open) => open.source)).toContain("radar.attempt")
    expect(olderOpen()).toMatchObject({
      source: "observability.liveHistory",
      filter: {
        projectDirectory: fixture.directory,
        attemptID: firstAttemptID,
        sessionID: "ses-failed",
        toolsOnly: true,
      },
    })
    // The live read lists the newest calls, some of the 150 among them; the stream lists the
    // rest: every call at a time before the live read's earliest (they are at times 1 to 150).
    const olderCount = () => (olderOpen()!.filter.beforeAt as number) - 1
    expect(olderCount()).toBeGreaterThan(60)
    await openDisclosure("Calls")
    await until(() => container.querySelector(".lazers-radar-history [role=row] code") !== null)
    const historyRows = () =>
      [...container.querySelectorAll<HTMLElement>(".lazers-radar-history-window code")].map((row) =>
        Number(row.dataset.sequence),
      )
    const scrollArea = container.querySelector<HTMLElement>(".lazers-radar-history-scroll")!
    const content = container.querySelector<HTMLElement>(".lazers-radar-history-content")!
    // One scroll area as tall as every older call; only a window of rows is drawn.
    const total = olderCount()
    expect(content.style.height).toBe(`${total * 28}px`)
    expect(scrollArea.style.height).toBe("224px")
    const firstWindow = historyRows()
    expect(firstWindow.length).toBeGreaterThan(8)
    expect(firstWindow.length).toBeLessThan(total)
    expect(container.querySelector(".lazers-radar-history-window code")?.textContent).toBe(
      `src/older-${total - 1}.ts`,
    )
    // Scrolling to the oldest rows slides the window there; its rows stay at their own offset.
    const lastRow = () =>
      [...container.querySelectorAll(".lazers-radar-history-window code")].at(-1)
    expect(
      container.querySelector(".lazers-radar-history-window")?.getAttribute("style"),
    ).toContain("translateY(0px)")
    scrollArea.scrollTop = total * 28 - 224
    scrollArea.dispatchEvent(new dom.window.Event("scroll") as unknown as Event)
    await until(() => lastRow()?.textContent === "src/older-0.ts")
    expect(
      container.querySelector(".lazers-radar-history-window")?.getAttribute("style"),
    ).toContain(`translateY(${(total - firstWindow.length) * 28}px)`)
    expect(historyRows().length).toBe(firstWindow.length)
    expect(content.style.height).toBe(`${total * 28}px`)
    const inspectorHead = container.querySelector(".lazers-details-bar")!
    expect(inspectorHead.querySelector(".lazers-radar-inspector-glyph")).not.toBeNull()
    expect(inspectorHead.querySelector(".lazers-radar-session-icon")).toBeNull()
    // Idle sessions are hidden by default; the summary says how many and shows them on request.
    const idleToggle = () =>
      container.querySelector<HTMLButtonElement>(".lazers-radar-idle-toggle")!
    expect(idleToggle().textContent).toMatch(/^\d+ idle hidden$/)
    const rowsBefore = container.querySelectorAll(".lazers-radar-session").length
    idleToggle().click()
    await until(() => idleToggle().textContent === "Hide idle")
    expect(container.querySelectorAll(".lazers-radar-session").length).toBeGreaterThan(rowsBefore)
    const rowStates = [
      ...container.querySelectorAll(".lazers-radar-sessions .lazers-radar-session-state"),
    ].map((state) => state.textContent ?? "")
    expect(rowStates.length).toBeGreaterThan(2)
    expect(rowStates.findIndex((state) => state.startsWith("idle"))).toBeGreaterThan(
      rowStates.findLastIndex((state) => state === "running"),
    )
    expect(container.querySelector(".lazers-radar-unavailable")).toBeNull()
    const summary = container.querySelector(".lazers-radar-summary")!
    expect(summary.textContent).toMatch(/\d+ running/)
    expect(summary.textContent?.replace("Hide idle", "")).not.toMatch(/Scheduler|active|idle/)
    expect(container.querySelector(".lazers-radar-monitor-status")).toBeNull()

    const activity = container.querySelector<HTMLDivElement>(".lazers-radar-monitor-activity")!
    const readLine = lines().find((line) => line.textContent?.includes("src/worker.ts"))!
    readLine.focus()
    readLine.click()
    await until(() => readLine.getAttribute("aria-pressed") === "true")
    expect(readLine.getAttribute("aria-pressed")).toBe("true")
    expect(readLine.querySelector("code")?.getAttribute("style")).toContain("test-mono")
    expect(inspectorText()).toContain("src/worker.ts")

    const linkButton = (label: string) =>
      [...container.querySelectorAll<HTMLButtonElement>(".lazers-radar-links button")].find(
        (button) => button.textContent === label,
      )!
    const menu = () =>
      [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.getAttribute("aria-label") === "Radar actions",
      )!
    menu().click()
    const menuLabels = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].map(
      (button) => button.textContent,
    )
    expect(menuLabels).toEqual(["Open worker", "Show idle sessions"])
    ;[...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((button) => button.textContent === "Open worker")!
      .click()
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
    const before = Number(separator.getAttribute("aria-valuenow"))
    separator.focus()
    separator.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        key: "ArrowUp",
        bubbles: true,
      }) as unknown as KeyboardEvent,
    )
    await until(() => Number(separator.getAttribute("aria-valuenow")) > before)
    type Saved = {
      monitorSessionID?: string
      showIdle?: boolean
      details?: Record<string, { open?: boolean; size?: number }>
    }
    const saved = () =>
      Object.values(viewStore.value.projects as Record<string, { project: Saved }>)[0]!.project
    const grown = saved().details!.monitor!.size!
    expect(grown).toBeGreaterThan(0.45)
    // Collapsing keeps the last size; picking a call again reopens at that size.
    container.querySelector<HTMLButtonElement>(".lazers-details-chevron")!.click()
    await until(
      () => container.querySelector(".lazers-details")?.getAttribute("data-open") === "false",
    )
    expect(saved().details!.monitor).toEqual({ open: false, size: grown })
    readLine.click()
    await until(
      () => container.querySelector(".lazers-details")?.getAttribute("data-open") === "true",
    )
    expect(saved().details!.monitor!.size).toBe(grown)
    readLine.click() // select it again for the checks below
    const savedProject = saved()
    expect(savedProject.monitorSessionID).toBe("ses-failed")
    expect((savedProject as { showIdle?: boolean }).showIdle).toBe(true)

    activity.scrollTop = 37
    readLine.focus()
    // A stored row changes: the open session stream pushes a frame and the rows re-render in place.
    const previousFrames = frames
    hostSession("ses-view-architect", {
      agent: "architect",
      busy: true,
      updatedAt: Date.now() + 1,
      model: { providerID: "openai", id: "gpt-6-luna", variant: "high" },
    })
    await until(() => frames > previousFrames)
    expect(lines().find((line) => line.textContent?.includes("src/worker.ts"))).toBe(readLine)
    expect(browserDocument.activeElement).toBe(readLine)
    expect(activity.scrollTop).toBe(37)
    expect(readLine.getAttribute("aria-pressed")).toBe("true")
    expect(legacyCalls).toEqual({ snapshot: 0, radar: 0, trajectory: 0, diagnostics: 0 })
    expect(text()).not.toContain("Tool completed")

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
    // Map is the compact tree in the same panel: Architect on top, concrete nodes below.
    await until(() => container.querySelector(".lazers-radar-orgmap svg") !== null)
    const nodeTitles = () =>
      [...container.querySelectorAll(".lazers-radar-node-title")].map((node) => node.textContent)
    expect(nodeTitles()).toContain("You · session")
    expect(nodeTitles()).toContain("Architect")
    expect(container.querySelectorAll(".lazers-radar-session").length).toBe(0)
    expect(text()).not.toMatch(/nknown|navailable|Operational overview|Task runtime/)
    // Map's pane starts collapsed (its own stored state) with the empty text; picking a node opens it.
    const paneOpen = () => container.querySelector(".lazers-details")?.getAttribute("data-open")
    expect(paneOpen()).toBe("false")
    expect(container.querySelector(".lazers-details-header")?.textContent).toBe(
      "No session selected",
    )
    const architectNode = [...container.querySelectorAll<SVGGElement>(".lazers-radar-node")].find(
      (node) => node.dataset.kind === "architect",
    )!
    architectNode.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true }) as unknown as MouseEvent,
    )
    await until(() => container.querySelector(".lazers-radar-node[data-selected='true']") !== null)
    await until(() => paneOpen() === "true")
    expect(container.querySelector(".lazers-details-header")?.textContent).toContain("Architect")
    // The Queue group lists its tasks from the stored task list (`radar.group`, `radar.workload`).
    const queueNode = () =>
      [...container.querySelectorAll<SVGGElement>(".lazers-radar-node")].find((node) =>
        node.getAttribute("aria-label")?.startsWith("Queue"),
      )
    await until(() => queueNode() !== undefined)
    queueNode()!.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true }) as unknown as MouseEvent,
    )
    await until(() => text().includes("map-alpha") && text().includes("map-beta"))
    expect(streamOpens.some((open) => open.source === "radar.group")).toBe(true)
    expect(text()).not.toContain("still being indexed")
    // Flow shares the panel, header and snapshot: no reload, and the lifecycle chart sits in ⋯.
    tab("Flow").click()
    await until(() => tab("Flow")?.getAttribute("aria-selected") === "true")
    expect(headerShape()).toEqual(monitorHeaderShape)
    expect(container.querySelector(".lazers-panel-loading")).toBeNull()
    await until(
      () =>
        container.querySelector(".lazers-radar-flowcanvas svg") !== null ||
        text().includes("Nothing is flowing"),
    )
    expect(text()).not.toMatch(/Unavailable|not observed/)
    const flowCanvas = container.querySelector(".lazers-radar-flowcanvas svg")
    // Flow's pane is collapsed to its tab bar; a tab click opens it on that tab.
    expect(paneOpen()).toBe("false")
    if (flowCanvas) {
      const flowTabs = () => [
        ...container.querySelectorAll<HTMLButtonElement>('.lazers-radar-flow-tabs [role="tab"]'),
      ]
      expect(
        container.querySelector(".lazers-details-header .lazers-radar-flow-tabs"),
      ).not.toBeNull()
      flowTabs()[1]!.click()
      await until(() => paneOpen() === "true")
      expect(flowTabs()[1]!.getAttribute("aria-selected")).toBe("true")
      expect(container.querySelector(".lazers-radar-models")).not.toBeNull()
      expect(
        [...container.querySelectorAll('.lazers-radar-flow-tabs [role="tab"]')].map((item) =>
          item.textContent?.replace(/\d+$/, "").trim(),
        ),
      ).toEqual(["Feed", "Models"])
    }
    menu().click()
    const lifecycle = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
      (button) => button.textContent === "Task lifecycle diagram",
    )
    expect(lifecycle).toBeDefined()
    lifecycle!.click()
    await until(() =>
      [...container.querySelectorAll("button")].some(
        (button) => button.textContent === "Back to Flow",
      ),
    )
    expect(container.querySelector(".lazers-details-header")?.textContent).toBe("No state selected")
    expect(headerShape()).toEqual(monitorHeaderShape)
    // The lifecycle reads streams (plans, the plan's nodes, the node's recorded edges), never the
    // snapshot: the statechart draws with the recorded ACCEPT edge of the fixture's task.
    await until(() => container.querySelector(".lazers-radar-statechart") !== null)
    for (const source of ["tasks.plans", "radar.nodes", "radar.planEvents"])
      expect(streamOpens.map((open) => open.source)).toContain(source)
    expect(legacyCalls.snapshot).toBe(0)
    await until(
      () => container.querySelector('.lazers-radar-statechart g[data-recorded="true"]') !== null,
    )
    ;[...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Back to Flow")!
      .click()
    await until(() => container.querySelector(".lazers-radar-monitor") !== null)
    tab("Monitor").click()
    await until(() => container.querySelector(".lazers-radar-session") !== null)
    expect((viewStore.value as { diagnostics?: boolean }).diagnostics).toBe(false)
    expect(headerShape()).toEqual(monitorHeaderShape)

    // Losing the service keeps the last sessions on screen, dimmed, under one banner.
    session.server.connected = false
    hostSession("ses-view-architect", {
      agent: "architect",
      busy: true,
      updatedAt: Date.now() + 2,
      model: { providerID: "openai", id: "gpt-6-luna", variant: "high" },
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
