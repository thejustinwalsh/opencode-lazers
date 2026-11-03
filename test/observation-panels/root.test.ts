import { expect, test } from "bun:test"
import { Window } from "happy-dom"
import solid from "vite-plugin-solid"
import { build } from "vite"
import { mkdir, rm } from "node:fs/promises"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
  CANDIDATE_A,
  CANDIDATE_A_SECOND,
  CANDIDATE_B,
  CANDIDATE_C,
  DIRECTORY_A,
  DIRECTORY_B,
  PROJECT_A,
  PROJECT_B,
  TASK_A,
  TASK_B,
  comparison,
  settings,
  sourceEvidence,
  taskDetail,
  taskPage,
  trajectory,
} from "../models-panel/fixtures/data.ts"

type Deferred<T> = {
  promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 200 && !predicate(); attempt++)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  expect(predicate()).toBe(true)
}

function buttonWithText(container: ParentNode, text: string) {
  return [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes(text),
  )
}

test("gui.setup registers and mounts the real Models panel render with isolated, cancellable DOM state", async () => {
  const dom = new Window({ url: "http://localhost" })
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

  const guiRoot = fileURLToPath(new URL("../../src/gui.tsx", import.meta.url))
  const entry = fileURLToPath(new URL("../models-panel/fixtures/dom-entry.ts", import.meta.url))
  const outputDirectory = fileURLToPath(
    new URL("../../node_modules/.cache/models-panel-dom-test", import.meta.url),
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
              throw new Error("The inference runtime is not used by this GUI registration test")
            }`
          },
        },
      ],
      build: {
        outDir: outputDirectory,
        emptyOutDir: true,
        minify: false,
        lib: { entry, formats: ["es"], fileName: "models-panel-dom-test" },
        rolldownOptions: { output: { codeSplitting: false } },
      },
    })

    const { gui, ...host } = await import(
      pathToFileURL(`${outputDirectory}/models-panel-dom-test.js`).href
    )
    expect(replacedInferenceRuntime).toBe(true)

    const calls: Array<{
      directory: string
      service: string
      method: string
      input: unknown
      signal?: AbortSignal
    }> = []
    const counts = new Map<string, number>()
    const sourceSignals = new Map<string, AbortSignal[]>()
    const comparisonCounts = new Map<string, number>()
    const deferredA1 = deferred<ReturnType<typeof sourceEvidence>>()
    const deferredA3 = deferred<ReturnType<typeof sourceEvidence>>()
    const deferredB2 = deferred<ReturnType<typeof sourceEvidence>>()
    const opened: unknown[][] = []
    const registrations: Array<{ token: unknown; value: unknown }> = []
    const modelStore = host.createReactiveStore({
      projects: {
        [DIRECTORY_A]: {
          tab: "compare",
          persona: "ui",
          selectedTaskID: TASK_A,
          selectedCandidateID: CANDIDATE_C,
          split: 56,
          topScroll: 0,
          inspectorScroll: 0,
        },
        [DIRECTORY_B]: {
          tab: "compare",
          persona: "ui",
          selectedTaskID: null,
          selectedCandidateID: null,
          split: 56,
          topScroll: 0,
          inspectorScroll: 0,
        },
      },
    })
    const trajectoryStore = host.createReactiveStore({ projects: {} as Record<string, unknown> })

    const record = (
      directory: string,
      service: string,
      method: string,
      input: unknown,
      signal?: AbortSignal,
    ) => calls.push({ directory, service, method, input, signal })
    const nextCount = (key: string) => {
      const count = (counts.get(key) ?? 0) + 1
      counts.set(key, count)
      return count
    }
    const client = {
      location: {
        get: async (
          input: { location: { directory: string } },
          options: { signal: AbortSignal },
        ) => {
          const directory = input.location.directory
          record(directory, "location", "get", input, options.signal)
          return {
            project: {
              canonical: directory,
              id: directory === DIRECTORY_A ? PROJECT_A : PROJECT_B,
            },
          }
        },
      },
      rpc(definition: { id: string }) {
        if (definition.id === "lazers.models")
          return {
            comparison: async (
              input: { sessionID: string; limit: number; cursor?: string },
              options: { location: { directory: string }; signal: AbortSignal },
            ) => {
              const directory = options.location.directory
              const key = `${directory}:comparison`
              const count = nextCount(key)
              comparisonCounts.set(directory, (comparisonCounts.get(directory) ?? 0) + 1)
              record(directory, "lazers.models", "comparison", input, options.signal)
              const projectID = directory === DIRECTORY_A ? PROJECT_A : PROJECT_B
              return comparison(projectID, count > 1 ? 2 : 1, input.cursor)
            },
            refreshSources: async (
              input: { sessionID: string },
              options: { location: { directory: string }; signal: AbortSignal },
            ) => {
              const directory = options.location.directory
              const key = `${directory}:refreshSources`
              const count = nextCount(key)
              record(directory, "lazers.models", "refreshSources", input, options.signal)
              const observed = sourceSignals.get(directory) ?? []
              observed.push(options.signal)
              sourceSignals.set(directory, observed)
              if (directory === DIRECTORY_A && count === 1) return deferredA1.promise
              if (directory === DIRECTORY_A && count === 3) return deferredA3.promise
              if (directory === DIRECTORY_B && count === 2) return deferredB2.promise
              return sourceEvidence()
            },
            settings: async (
              input: { sessionID: string; taskID?: string },
              options: { location: { directory: string }; signal: AbortSignal },
            ) => {
              const directory = options.location.directory
              const count = nextCount(`${directory}:settings`)
              record(directory, "lazers.models", "settings", input, options.signal)
              return settings(directory, input.taskID, count)
            },
          }
        if (definition.id === "lazers.tasks")
          return {
            query: async (
              input: {
                state: string
                includeCompleted: boolean
                includeRetired: boolean
                limit: number
              },
              options: { location: { directory: string }; signal: AbortSignal },
            ) => {
              const directory = options.location.directory
              const count = nextCount(`${directory}:queryTasks`)
              record(directory, "lazers.tasks", "query", input, options.signal)
              return directory === DIRECTORY_A
                ? taskPage(
                    directory,
                    TASK_A,
                    "LZ-17",
                    count > 1 ? "Objective A refreshed" : "Objective A initial",
                    "ses-models-panel",
                  )
                : taskPage(
                    directory,
                    TASK_B,
                    "LZ-42",
                    "Objective B project only",
                    "ses-models-panel",
                  )
            },
            get: async (
              input: { taskID: string },
              options: { location: { directory: string }; signal: AbortSignal },
            ) => {
              const directory = options.location.directory
              const count = nextCount(`${directory}:getTask`)
              record(directory, "lazers.tasks", "get", input, options.signal)
              return directory === DIRECTORY_A
                ? taskDetail(
                    TASK_A,
                    PROJECT_A,
                    directory,
                    "LZ-17",
                    count > 1 ? "Objective A refreshed" : "Objective A initial",
                  )
                : taskDetail(TASK_B, PROJECT_B, directory, "LZ-42", "Objective B project only")
            },
          }
        if (definition.id === "lazers.observability")
          return {
            trajectoryStatus: async (
              input: { scope: { kind: "project"; sessionID: string }; taskID: string },
              options: { location: { directory: string }; signal: AbortSignal },
            ) => {
              const directory = options.location.directory
              const count = nextCount(`${directory}:trajectoryStatus`)
              record(directory, "lazers.observability", "trajectoryStatus", input, options.signal)
              return trajectory(
                directory === DIRECTORY_A ? PROJECT_A : PROJECT_B,
                input.taskID,
                count > 1 ? 42 : 10,
              )
            },
          }
        throw new Error(`Unexpected RPC contract ${definition.id}`)
      },
    }

    const sessionA = {
      id: "ses-models-panel",
      location: { directory: DIRECTORY_A },
      directory: DIRECTORY_A,
      server: { id: "server-models", connected: true, client },
    }
    const sessionB = {
      id: sessionA.id,
      location: { directory: DIRECTORY_B },
      directory: DIRECTORY_B,
      server: sessionA.server,
    }
    const sessions = [sessionA, sessionB]
    const context = {
      id: "lazers",
      app: { platform: "web" },
      signal: new AbortController().signal,
      ui: host.createTestUI(),
      appearance: { font: () => "monospace" },
      add: (token: unknown, value: unknown) => registrations.push({ token, value }),
      sessions: { current: () => sessionA, list: () => sessions },
      layout: { open: (...args: unknown[]) => opened.push(args) },
      stores: {
        modelsView: () => modelStore,
        trajectoryView: () => trajectoryStore,
      },
    }

    disposeSetup = host.setupGui(gui, context)
    const tokens = host.registryTokens
    const panel = host.modelPanelRegistration(registrations)
    const panels = registrations
      .filter((entry) => entry.token === tokens.Panel)
      .map(
        (entry) =>
          entry.value as {
            id: string
            list: (input: { open: string[] }) => unknown[]
            render: unknown
          },
      )
    expect(Object.keys(gui.stores)).toContain("modelsView")
    expect(Object.keys(gui.stores)).toContain("trajectoryView")
    expect(panel?.id).toBe("models")
    expect(panels.map((registeredPanel) => registeredPanel.id).toSorted()).toEqual([
      "models",
      "radar",
      "tasks",
      "trajectory",
    ])
    for (const [id, title] of [
      ["radar", "Radar"],
      ["models", "Models"],
      ["trajectory", "Trajectory"],
    ] as const) {
      const registeredPanel = panels.find((entry) => entry.id === id)!
      expect(registeredPanel.list({ open: [] })).toEqual([])
      expect(registeredPanel.list({ open: [id] })).toMatchObject([{ id, title, closable: "hover" }])
      expect(typeof registeredPanel.render).toBe("function")
    }

    const modelCss = registrations.find(
      (entry) =>
        entry.token === tokens.Style &&
        typeof entry.value === "string" &&
        entry.value.includes(".lazers-models {"),
    )?.value as string | undefined
    expect(modelCss).toBeDefined()
    expect(modelCss).toContain("container-name: models-panel")
    expect(modelCss).toContain("@container models-panel (min-width: 720px)")
    expect(modelCss).toContain("@container models-panel (max-width: 500px)")
    expect(modelCss).toContain("grid-template-rows: minmax(180px, var(--models-top-size)) 8px")
    expect(modelCss).toContain(".lazers-models-separator {")
    expect(modelCss).toContain("cursor: row-resize")
    expect(modelCss).toContain("touch-action: none")
    expect(modelCss).not.toContain("@media (min-width: 720px)")
    expect(modelCss).not.toContain("@media (max-width: 500px)")
    expect(modelCss).not.toContain("450px")
    const style = browserDocument.createElement("style")
    style.textContent = modelCss ?? ""
    browserDocument.head.append(style)

    const command = registrations.find(
      (entry) =>
        entry.token === tokens.Command && (entry.value as { id?: string }).id === "lz-models",
    )?.value as { slash: { name: string }; run: () => void } | undefined
    const menuItem = registrations.find(
      (entry) =>
        entry.token === tokens.MenuItem && (entry.value as { id?: string }).id === "models.open",
    )?.value as { run: () => void } | undefined
    expect(command?.slash).toEqual({ name: "lz-models" })
    command?.run()
    menuItem?.run()
    expect(opened.slice(0, 2)).toEqual([
      ["lazers:models", sessionA, { tab: "select" }],
      ["lazers:models", sessionA, { tab: "select" }],
    ])
    for (const id of ["radar", "trajectory"]) {
      const entries = registrations.filter(
        (entry) =>
          (entry.token === tokens.Command || entry.token === tokens.MenuItem) &&
          (entry.value as { id?: string }).id === `${id}.open`,
      )
      expect(entries).toHaveLength(2)
      entries.forEach((entry) => (entry.value as { run: () => void }).run())
    }
    expect(opened.slice(2, 6)).toEqual([
      ["lazers:radar", sessionA, { tab: "select" }],
      ["lazers:radar", sessionA, { tab: "select" }],
      ["lazers:trajectory", sessionA, { tab: "select" }],
      ["lazers:trajectory", sessionA, { tab: "select" }],
    ])

    const containerA = browserDocument.createElement("main")
    browserDocument.body.append(containerA)
    const mountA = host.mountModelPanel(panel!, context, sessionA, containerA)
    mounts.push(mountA)
    await until(
      () =>
        containerA.querySelector('[data-candidate-id="' + CANDIDATE_A + '"]') !== null &&
        containerA.textContent?.includes("Source refresh is running in the background") === true,
    )
    await until(() => containerA.textContent?.includes("Objective A initial") === true)

    const rowsBeforeMore = [
      ...containerA.querySelectorAll<HTMLButtonElement>("[data-candidate-id]"),
    ]
    expect(rowsBeforeMore).toHaveLength(2)
    expect(rowsBeforeMore[0]?.tabIndex).toBe(0)
    expect(rowsBeforeMore[1]?.tabIndex).toBe(-1)
    expect(containerA.querySelector(".lazers-models-inspector")?.textContent).toContain(
      "The selected candidate is not in the available evidence page.",
    )
    expect(modelStore.snapshot().projects[DIRECTORY_A]?.selectedCandidateID).toBe(CANDIDATE_C)
    expect(
      calls.some(
        (call) =>
          call.service === "lazers.models" &&
          call.method === "comparison" &&
          call.directory === DIRECTORY_A,
      ),
    ).toBe(true)
    expect(
      calls.some(
        (call) =>
          call.service === "lazers.models" &&
          call.method === "refreshSources" &&
          call.directory === DIRECTORY_A,
      ),
    ).toBe(true)

    deferredA1.resolve(sourceEvidence())
    await until(
      () =>
        !buttonWithText(containerA, "Refresh")?.disabled && comparisonCounts.get(DIRECTORY_A) === 2,
    )
    buttonWithText(containerA, "Load more candidates")?.click()
    await until(() => containerA.querySelector(`[data-candidate-id="${CANDIDATE_C}"]`) !== null)
    expect(
      containerA
        .querySelector(`[data-candidate-id="${CANDIDATE_C}"]`)
        ?.getAttribute("aria-pressed"),
    ).toBe("true")
    await until(() => containerA.textContent?.includes("10 tokens") === true)

    const rowsAfterMore = [...containerA.querySelectorAll<HTMLButtonElement>("[data-candidate-id]")]
    rowsAfterMore[2]?.focus()
    rowsAfterMore[2]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }))
    expect(browserDocument.activeElement).toBe(rowsAfterMore[1]!)
    expect(rowsAfterMore[1]?.getAttribute("aria-pressed")).toBe("true")
    expect(modelStore.snapshot().projects[DIRECTORY_A]?.selectedCandidateID).toBe(
      CANDIDATE_A_SECOND,
    )

    const separator = containerA.querySelector<HTMLDivElement>('[role="separator"]')!
    expect(separator.getAttribute("aria-valuemin")).toBe("24")
    expect(separator.getAttribute("aria-valuemax")).toBe("76")
    separator.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }))
    expect(separator.getAttribute("aria-valuenow")).toBe("76")
    separator.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }))
    expect(separator.getAttribute("aria-valuenow")).toBe("71")
    separator.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }))
    expect(separator.getAttribute("aria-valuenow")).toBe("24")
    const root = containerA.querySelector<HTMLDivElement>(".lazers-models")!
    Object.defineProperty(root, "getBoundingClientRect", {
      configurable: true,
      value: () =>
        ({ top: 0, left: 0, right: 800, bottom: 1_000, width: 800, height: 1_000 }) as DOMRect,
    })
    const captureTarget = separator as HTMLDivElement & {
      setPointerCapture?: (pointerId: number) => void
    }
    captureTarget.setPointerCapture ??= () => {}
    separator.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, clientY: 0 }),
    )
    separator.dispatchEvent(
      new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientY: 850 }),
    )
    separator.dispatchEvent(
      new PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientY: 850 }),
    )
    expect(separator.getAttribute("aria-valuenow")).toBe("76")
    expect(modelStore.snapshot().projects[DIRECTORY_A]?.split).toBe(76)

    const firstRow = containerA.querySelector<HTMLButtonElement>(
      `[data-candidate-id="${CANDIDATE_A}"]`,
    )!
    firstRow.click()
    expect(firstRow.getAttribute("aria-pressed")).toBe("true")
    const trajectoryButton = buttonWithText(
      containerA.querySelector(".lazers-models-inspector-heading")!,
      "Open trajectory",
    )
    trajectoryButton?.click()
    const target = (
      trajectoryStore.snapshot().projects[DIRECTORY_A] as { target: Record<string, unknown> }
    ).target
    expect(target).toMatchObject({
      taskID: TASK_A,
      reference: "LZ-17",
      projectID: PROJECT_A,
      projectDirectory: DIRECTORY_A,
    })
    expect(target.requestID).toMatch(/^[0-9a-f-]{36}$/)
    expect(opened.at(-1)).toEqual(["lazers:trajectory", sessionA, { tab: "select" }])

    const assignmentTab = containerA.querySelector<HTMLButtonElement>(
      '[role="tab"][aria-controls="lazers-models-assignments-panel"]',
    )!
    assignmentTab.click()
    await until(() => containerA.textContent?.includes("openai / route-1") === true)
    expect(
      calls.some(
        (call) =>
          call.directory === DIRECTORY_A &&
          call.service === "lazers.models" &&
          call.method === "settings" &&
          JSON.stringify(call.input) === JSON.stringify({ sessionID: sessionA.id, taskID: TASK_A }),
      ),
    ).toBe(true)
    const comparisonInputs = calls
      .filter(
        (call) =>
          call.directory === DIRECTORY_A &&
          call.service === "lazers.models" &&
          call.method === "comparison",
      )
      .map((call) => call.input)
    expect(comparisonInputs).toContainEqual({ sessionID: sessionA.id, limit: 100 })
    expect(comparisonInputs).toContainEqual({
      sessionID: sessionA.id,
      limit: 100,
      cursor: "more-candidates",
    })

    buttonWithText(containerA, "Refresh")?.click()
    await until(
      () =>
        containerA
          .querySelector(".lazers-models-inspector")
          ?.textContent?.includes("Objective A refreshed") === true &&
        containerA.querySelector(".lazers-models-inspector")?.textContent?.includes("42 tokens") ===
          true &&
        containerA.textContent?.includes("openai / route-2") === true,
    )
    expect(
      calls.some(
        (call) =>
          call.directory === DIRECTORY_A &&
          call.service === "lazers.tasks" &&
          call.method === "get",
      ),
    ).toBe(true)
    expect(
      calls.some(
        (call) =>
          call.directory === DIRECTORY_A &&
          call.service === "lazers.observability" &&
          call.method === "trajectoryStatus",
      ),
    ).toBe(true)
    expect(
      calls.some(
        (call) =>
          call.directory === DIRECTORY_A &&
          call.service === "lazers.tasks" &&
          call.method === "query" &&
          JSON.stringify(call.input) ===
            JSON.stringify({
              state: "all",
              includeCompleted: true,
              includeRetired: true,
              limit: 100,
            }),
      ),
    ).toBe(true)
    expect(
      calls.some(
        (call) =>
          call.directory === DIRECTORY_A &&
          call.service === "lazers.tasks" &&
          call.method === "get" &&
          JSON.stringify(call.input) === JSON.stringify({ taskID: TASK_A }),
      ),
    ).toBe(true)
    expect(
      calls.some(
        (call) =>
          call.directory === DIRECTORY_A &&
          call.service === "lazers.observability" &&
          call.method === "trajectoryStatus" &&
          JSON.stringify(call.input) ===
            JSON.stringify({ scope: { kind: "project", sessionID: sessionA.id }, taskID: TASK_A }),
      ),
    ).toBe(true)

    containerA
      .querySelector<HTMLButtonElement>('[role="tab"][aria-controls="lazers-models-compare-panel"]')
      ?.click()
    await until(
      () =>
        containerA
          .querySelector(".lazers-models-candidate-list")
          ?.textContent?.includes("GPT-6 refreshed") === true,
    )
    const details = containerA.querySelector<HTMLDetailsElement>(".lazers-models-evidence-details")!
    details.open = true
    expect(details.textContent).toContain("100 shown of 105 total; 5 omitted")
    expect(details.textContent).toContain("effort-100")
    expect(details.textContent).not.toContain("effort-101")

    buttonWithText(containerA, "Refresh")?.click()
    await until(() => (sourceSignals.get(DIRECTORY_A)?.length ?? 0) === 3)
    const hiddenSignal = sourceSignals.get(DIRECTORY_A)?.[2]
    expect(containerA.querySelector(`[data-candidate-id="${CANDIDATE_A}"]`)).not.toBeNull()
    expect(containerA.querySelector(".lazers-models-candidate-list")?.textContent).toContain(
      "GPT-6 refreshed",
    )
    expect(containerA.textContent).toContain("Source refresh is running in the background")
    mountA.setVisible(false)
    await until(() => hiddenSignal?.aborted === true)
    const beforeLateHiddenResult = comparisonCounts.get(DIRECTORY_A)
    mountA.setVisible(true)
    await until(
      () =>
        containerA.querySelector('[data-candidate-id="' + CANDIDATE_A + '"]') !== null &&
        (sourceSignals.get(DIRECTORY_A)?.length ?? 0) === 4,
    )
    await until(() => comparisonCounts.get(DIRECTORY_A) === (beforeLateHiddenResult ?? 0) + 2)
    const afterReconnectComparisons = comparisonCounts.get(DIRECTORY_A)
    deferredA3.resolve(sourceEvidence())
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(comparisonCounts.get(DIRECTORY_A)).toBe(afterReconnectComparisons)
    expect(containerA.querySelector(".lazers-models-candidate-list")?.textContent).toContain(
      "GPT-6 refreshed",
    )
    expect(modelStore.snapshot().projects[DIRECTORY_A]?.selectedCandidateID).toBe(CANDIDATE_A)

    const containerB = browserDocument.createElement("main")
    browserDocument.body.append(containerB)
    const mountB = host.mountModelPanel(panel!, context, sessionB, containerB)
    mounts.push(mountB)
    await until(
      () =>
        containerB.querySelector(`[data-candidate-id="${CANDIDATE_B}"]`) !== null &&
        containerB.textContent?.includes("Objective B project only") === true,
    )
    expect(containerB.querySelector(".lazers-models-project")?.textContent).toContain("project-b")
    expect(containerB.querySelector(".lazers-models-candidate-list")?.textContent).toContain(
      "Claude 4 project B",
    )
    expect(containerB.querySelector(".lazers-models-candidate-list")?.textContent).not.toContain(
      "GPT-6",
    )
    expect(modelStore.snapshot().projects[DIRECTORY_A]?.selectedTaskID).toBe(TASK_A)
    expect(modelStore.snapshot().projects[DIRECTORY_B]?.selectedTaskID).toBe(TASK_B)
    expect(
      calls.some(
        (call) =>
          call.directory === DIRECTORY_B &&
          call.service === "lazers.models" &&
          call.method === "settings" &&
          JSON.stringify(call.input) === JSON.stringify({ sessionID: sessionB.id }),
      ),
    ).toBe(true)

    buttonWithText(containerB, "Refresh")?.click()
    await until(() => (sourceSignals.get(DIRECTORY_B)?.length ?? 0) === 2)
    const disposedSignal = sourceSignals.get(DIRECTORY_B)?.[1]
    const comparisonsBeforeDispose = comparisonCounts.get(DIRECTORY_B)
    mountB.dispose()
    await until(() => disposedSignal?.aborted === true)
    deferredB2.resolve(sourceEvidence())
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(comparisonCounts.get(DIRECTORY_B)).toBe(comparisonsBeforeDispose)
    expect(containerB.textContent).toBe("")
    mounts.splice(mounts.indexOf(mountB), 1)

    for (const call of calls.filter((entry) => entry.service !== "location"))
      expect(call.signal).toBeDefined()
  } finally {
    for (const mount of mounts.reverse()) mount.dispose()
    disposeSetup?.()
    await rm(outputDirectory, { recursive: true, force: true })
    await dom.happyDOM.abort()
    for (const name of globalNames) {
      const prior = previousGlobals.get(name)
      if (prior) Object.defineProperty(globalThis, name, prior)
      else Reflect.deleteProperty(globalThis, name)
    }
  }
})
