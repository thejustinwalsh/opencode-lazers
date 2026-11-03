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
  reject(reason: unknown): void
}

type PanelLocation = {
  project: { canonical: string; id: string }
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
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
    const locationSignals = new Map<string, AbortSignal[]>()
    const comparisonCounts = new Map<string, number>()
    const deferredA1 = deferred<ReturnType<typeof sourceEvidence>>()
    const deferredA3 = deferred<ReturnType<typeof sourceEvidence>>()
    const deferredB2 = deferred<ReturnType<typeof sourceEvidence>>()
    const deferredLocationA2 = deferred<PanelLocation>()
    const deferredLocationA3 = deferred<PanelLocation>()
    const deferredLocationA4 = deferred<PanelLocation>()
    const deferredLocationB1 = deferred<PanelLocation>()
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
    const connectionRPCs = [
      { service: "lazers.models", method: "comparison", count: 2 },
      { service: "lazers.models", method: "refreshSources", count: 1 },
      { service: "lazers.models", method: "settings", count: 1 },
      { service: "lazers.tasks", method: "query", count: 1 },
      { service: "lazers.tasks", method: "get", count: 1 },
      { service: "lazers.observability", method: "trajectoryStatus", count: 1 },
    ] as const
    const connectionCounts = (directory: string) =>
      connectionRPCs.map(
        ({ service, method }) =>
          calls.filter(
            (call) =>
              call.directory === directory && call.service === service && call.method === method,
          ).length,
      )
    const connectedOnceSince = (directory: string, before: number[]) =>
      connectionRPCs.every(
        (request, index) => connectionCounts(directory)[index] === before[index]! + request.count,
      )
    const locationResult = (directory: string): PanelLocation => ({
      project: {
        canonical: directory,
        id: directory === DIRECTORY_A ? PROJECT_A : PROJECT_B,
      },
    })
    const client = {
      location: {
        get: async (
          input: { location: { directory: string } },
          options: { signal: AbortSignal },
        ) => {
          const directory = input.location.directory
          record(directory, "location", "get", input, options.signal)
          const count = nextCount(`${directory}:location`)
          const observed = locationSignals.get(directory) ?? []
          observed.push(options.signal)
          locationSignals.set(directory, observed)
          if (directory === DIRECTORY_A && count === 2) return deferredLocationA2.promise
          if (directory === DIRECTORY_A && count === 3) return deferredLocationA3.promise
          if (directory === DIRECTORY_A && count === 4) return deferredLocationA4.promise
          if (directory === DIRECTORY_B && count === 1) return deferredLocationB1.promise
          return locationResult(directory)
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
              if (directory === DIRECTORY_A && count === 9)
                throw new Error("comparison request unavailable")
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
              if (directory === DIRECTORY_A && count === 7)
                throw new Error("source request unavailable")
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

    const sessionScope = host.createReactiveStore({
      id: "ses-models-panel",
      directory: DIRECTORY_A,
    })
    const sessionA = {
      get id() {
        return sessionScope.value.id
      },
      get location() {
        return { directory: sessionScope.value.directory }
      },
      get directory() {
        return sessionScope.value.directory
      },
      server: { id: "server-models", connected: true, client },
    }
    const sessionB = {
      id: "ses-models-panel",
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
    expect(modelCss).toContain(
      "grid-template-rows: minmax(0, var(--models-top-size)) 8px minmax(0, 1fr)",
    )
    expect(modelCss).not.toContain("minmax(180px")
    expect(modelCss).not.toContain("minmax(150px")
    expect(modelCss).toContain("min-height: 0")
    expect(modelCss).toContain("overflow: auto")
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
        containerA.textContent?.includes("Refreshing sources") === true,
    )
    await until(
      () =>
        containerA
          .querySelector(".lazers-models-task-select")
          ?.getAttribute("title")
          ?.includes("Objective A initial") === true,
    )

    const topPaneA = containerA.querySelector<HTMLElement>(".lazers-models-top")!
    const filterDetails = topPaneA.querySelector<HTMLDetailsElement>(
      ".lazers-models-filter-details",
    )!
    const sourceDetails = topPaneA.querySelector<HTMLDetailsElement>(
      ".lazers-models-sources-details",
    )!
    expect(filterDetails.open).toBe(false)
    expect(sourceDetails.open).toBe(false)
    expect(filterDetails.querySelector("div")?.closest("details")).toBe(filterDetails)
    expect(sourceDetails.querySelector(".lazers-models-source")?.closest("details")).toBe(
      sourceDetails,
    )
    const comparePanel = topPaneA.querySelector<HTMLElement>("#lazers-models-compare-panel")!
    const overview = comparePanel.querySelector<HTMLElement>(".lazers-models-overview")!
    expect(sourceDetails.compareDocumentPosition(overview) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    )
    expect(comparePanel.querySelector(".lazers-models-chart-empty")?.textContent).toContain(
      "No sample points or frontier are shown",
    )
    expect(comparePanel.querySelectorAll(".lazers-models-chart-empty p")).toHaveLength(1)
    const refreshWarning = topPaneA.querySelector<HTMLElement>(".lazers-models-refresh-note")!
    expect(refreshWarning.textContent).toContain("Refreshing sources")
    expect(refreshWarning.closest("details")).toBeNull()
    expect(containerA.querySelector(".lazers-models-project")?.getAttribute("aria-label")).toBe(
      `Project · ${DIRECTORY_A}`,
    )
    const taskMenu = topPaneA.querySelector<HTMLButtonElement>(".lazers-models-task-select button")!
    expect(taskMenu.textContent).toBe("Task · LZ-17")
    expect(taskMenu.textContent).not.toContain(TASK_A)
    expect(taskMenu.closest(".lazers-models-task-select")?.getAttribute("aria-label")).toContain(
      TASK_A,
    )
    expect(taskMenu.closest(".lazers-models-task-select")?.getAttribute("title")).toContain(
      "Objective A initial",
    )

    const rowsBeforeMore = [
      ...containerA.querySelectorAll<HTMLButtonElement>("[data-candidate-id]"),
    ]
    expect(rowsBeforeMore).toHaveLength(2)
    expect(rowsBeforeMore[0]?.tabIndex).toBe(0)
    expect(rowsBeforeMore[1]?.tabIndex).toBe(-1)
    expect(rowsBeforeMore[0]?.textContent).toContain("Effort Not specified")
    expect(rowsBeforeMore[0]?.textContent).toContain("Available")
    expect(rowsBeforeMore[0]?.textContent).not.toContain("No exact match")
    expect(rowsBeforeMore[0]?.textContent).not.toContain("No matched benchmark")
    expect(rowsBeforeMore[0]?.getAttribute("aria-label")).toContain("openai / gpt-6")
    expect(rowsBeforeMore[0]?.getAttribute("aria-label")).not.toContain(TASK_A)
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

    const inspectorA = containerA.querySelector<HTMLElement>(".lazers-models-inspector")!
    expect(inspectorA.querySelector(".lazers-models-estimate")?.textContent).toContain(
      "Task estimate unavailable",
    )
    expect(inspectorA.querySelector(".lazers-models-task-summary")?.textContent).toContain("LZ-17")
    const effortDetails = inspectorA.querySelector<HTMLDetailsElement>(
      ".lazers-models-task-effort-details",
    )!
    expect(effortDetails.open).toBe(false)
    expect(effortDetails.querySelector(".lazers-models-category-list")?.closest("details")).toBe(
      effortDetails,
    )
    effortDetails.open = true
    expect(effortDetails.textContent).toContain("10 tokens · observed subtotal")
    expect(effortDetails.textContent).toContain("native-session-usage")
    expect(effortDetails.textContent).toContain("observed ")
    expect(effortDetails.textContent).toContain("partial coverage")
    expect(effortDetails.textContent).toContain("not read")
    expect(effortDetails.textContent).toContain("attempt-route-1")
    expect(effortDetails.textContent).toContain("Plan route · explicit")
    expect(effortDetails.textContent).toContain("market-equivalent cost: Unknown")

    const candidateEvidence = inspectorA.querySelector<HTMLDetailsElement>(
      ".lazers-models-evidence-details",
    )!
    expect(candidateEvidence.open).toBe(false)
    expect(
      candidateEvidence.querySelector(".lazers-models-evidence-summary")?.closest("details"),
    ).toBe(candidateEvidence)
    candidateEvidence.open = true
    expect(candidateEvidence.textContent).toContain("Variants (coverage unknown): Not reported")
    expect(candidateEvidence.textContent).toContain("Selected route variant: Not specified")
    expect(candidateEvidence.textContent).toContain("External model correspondence: unresolved")
    expect(candidateEvidence.textContent).toContain("Benchmark correspondence: unresolved")
    candidateEvidence.open = false
    effortDetails.open = false

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
    let rootHeight = 500
    Object.defineProperty(root, "getBoundingClientRect", {
      configurable: true,
      value: () =>
        ({
          top: 0,
          left: 0,
          right: 800,
          bottom: rootHeight,
          width: 800,
          height: rootHeight,
        }) as DOMRect,
    })
    // happy-dom does not lay out CSS grid; compare the declared percentage tracks against each root height.
    const assertSplitGeometry = (height: number) => {
      rootHeight = height
      const topPercent = Number.parseFloat(root.style.getPropertyValue("--models-top-size"))
      const ariaValue = Number.parseFloat(separator.getAttribute("aria-valuenow") ?? "NaN")
      const topHeight = (height * topPercent) / 100
      const inspectorHeight = height - topHeight - 8
      expect(ariaValue).toBe(topPercent)
      expect(topPercent).toBeGreaterThanOrEqual(Number(separator.getAttribute("aria-valuemin")))
      expect(topPercent).toBeLessThanOrEqual(Number(separator.getAttribute("aria-valuemax")))
      expect(topHeight + 8 + inspectorHeight).toBeCloseTo(height, 6)
      expect(topHeight).toBeGreaterThan(0)
      expect(inspectorHeight).toBeGreaterThan(0)
      return { topHeight, inspectorHeight, topPercent }
    }
    expect(assertSplitGeometry(500)).toMatchObject({
      topHeight: 120,
      inspectorHeight: 372,
      topPercent: 24,
    })
    expect(assertSplitGeometry(900)).toMatchObject({
      topHeight: 216,
      inspectorHeight: 676,
      topPercent: 24,
    })
    const beforeAdjacentKeyboardMove = assertSplitGeometry(500).topHeight
    separator.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))
    expect(separator.getAttribute("aria-valuenow")).toBe("29")
    expect(assertSplitGeometry(500).topHeight - beforeAdjacentKeyboardMove).toBe(25)
    expect(assertSplitGeometry(900).topHeight).toBe(261)
    expect(assertSplitGeometry(500).topHeight).toBe(145)
    const captureTarget = separator as HTMLDivElement & {
      setPointerCapture?: (pointerId: number) => void
    }
    captureTarget.setPointerCapture ??= () => {}
    separator.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, clientY: 145 }),
    )
    separator.dispatchEvent(
      new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientY: 160 }),
    )
    expect(separator.getAttribute("aria-valuenow")).toBe("32")
    separator.dispatchEvent(
      new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientY: 350 }),
    )
    expect(separator.getAttribute("aria-valuenow")).toBe("70")
    separator.dispatchEvent(
      new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientY: 450 }),
    )
    expect(separator.getAttribute("aria-valuenow")).toBe("76")
    expect(assertSplitGeometry(500)).toMatchObject({
      topHeight: 380,
      inspectorHeight: 112,
      topPercent: 76,
    })
    separator.dispatchEvent(
      new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientY: 325 }),
    )
    expect(separator.getAttribute("aria-valuenow")).toBe("65")
    separator.dispatchEvent(
      new PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientY: 325 }),
    )
    expect(assertSplitGeometry(500)).toMatchObject({ topHeight: 325, topPercent: 65 })
    expect(assertSplitGeometry(900)).toMatchObject({
      topHeight: 585,
      inspectorHeight: 307,
      topPercent: 65,
    })
    expect(assertSplitGeometry(500).topHeight).toBe(325)
    expect(modelStore.snapshot().projects[DIRECTORY_A]?.split).toBe(65)

    const firstRow = containerA.querySelector<HTMLButtonElement>(
      `[data-candidate-id="${CANDIDATE_A}"]`,
    )!
    firstRow.click()
    expect(firstRow.getAttribute("aria-pressed")).toBe("true")
    const trajectoryButton = buttonWithText(
      containerA.querySelector(".lazers-models-task-summary")!,
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

    const topPaneBeforeRefresh = containerA.querySelector<HTMLElement>(".lazers-models-top")!
    const inspectorBeforeRefresh = containerA.querySelector<HTMLElement>(
      ".lazers-models-inspector",
    )!
    topPaneBeforeRefresh.scrollTop = 42
    topPaneBeforeRefresh.dispatchEvent(new Event("scroll"))
    inspectorBeforeRefresh.scrollTop = 55
    inspectorBeforeRefresh.dispatchEvent(new Event("scroll"))
    expect(modelStore.snapshot().projects[DIRECTORY_A]?.topScroll).toBe(42)
    expect(modelStore.snapshot().projects[DIRECTORY_A]?.inspectorScroll).toBe(55)
    buttonWithText(containerA, "Refresh")?.click()
    topPaneBeforeRefresh.scrollTop = 0
    inspectorBeforeRefresh.scrollTop = 0
    await until(
      () =>
        containerA
          .querySelector(".lazers-models-inspector")
          ?.textContent?.includes("Objective A refreshed") === true &&
        containerA.querySelector(".lazers-models-inspector")?.textContent?.includes("42 tokens") ===
          true &&
        containerA.textContent?.includes("openai / route-2") === true,
    )
    expect(topPaneBeforeRefresh.scrollTop).toBe(42)
    expect(inspectorBeforeRefresh.scrollTop).toBe(55)
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
    const effortDetailsBeforeRefresh = containerA.querySelector<HTMLDetailsElement>(
      ".lazers-models-task-effort-details",
    )!
    const sourceDetailsBeforeRefresh = containerA.querySelector<HTMLDetailsElement>(
      ".lazers-models-sources-details",
    )!
    const filterDetailsBeforeRefresh = containerA.querySelector<HTMLDetailsElement>(
      ".lazers-models-filter-details",
    )!
    effortDetailsBeforeRefresh.open = true
    sourceDetailsBeforeRefresh.open = true
    filterDetailsBeforeRefresh.open = true

    buttonWithText(containerA, "Refresh")?.click()
    await until(() => (sourceSignals.get(DIRECTORY_A)?.length ?? 0) === 3)
    const hiddenSignal = sourceSignals.get(DIRECTORY_A)?.[2]
    expect(containerA.querySelector(`[data-candidate-id="${CANDIDATE_A}"]`)).not.toBeNull()
    expect(containerA.querySelector(".lazers-models-candidate-list")?.textContent).toContain(
      "GPT-6 refreshed",
    )
    expect(containerA.textContent).toContain("Refreshing sources")
    expect(
      containerA
        .querySelector(".lazers-models-inspector")
        ?.querySelector<HTMLDetailsElement>(".lazers-models-evidence-details")?.open,
    ).toBe(true)
    expect(
      containerA.querySelector(".lazers-models-task-effort-details")?.closest("details")?.open,
    ).toBe(true)
    expect(
      containerA.querySelector<HTMLDetailsElement>(".lazers-models-sources-details")?.open,
    ).toBe(true)
    expect(
      containerA.querySelector<HTMLDetailsElement>(".lazers-models-filter-details")?.open,
    ).toBe(true)
    expect(modelStore.snapshot().projects[DIRECTORY_A]?.selectedTaskID).toBe(TASK_A)
    expect(modelStore.snapshot().projects[DIRECTORY_A]?.selectedCandidateID).toBe(CANDIDATE_A)
    mountA.setVisible(false)
    await until(() => hiddenSignal?.aborted === true)
    const beforeLateHiddenResult = comparisonCounts.get(DIRECTORY_A)
    const rpcsBeforeLocationReopen = calls.filter((call) => call.service !== "location").length
    mountA.setVisible(true)
    await until(() => (locationSignals.get(DIRECTORY_A)?.length ?? 0) === 2)
    expect(calls.filter((call) => call.service !== "location")).toHaveLength(
      rpcsBeforeLocationReopen,
    )
    expect(containerA.querySelector(`[data-candidate-id="${CANDIDATE_A}"]`)).toBeNull()
    mountA.setVisible(false)
    await until(() => locationSignals.get(DIRECTORY_A)?.[1]?.aborted === true)
    mountA.setVisible(true)
    await until(() => (locationSignals.get(DIRECTORY_A)?.length ?? 0) === 3)
    expect(locationSignals.get(DIRECTORY_A)?.[1]?.aborted).toBe(true)
    expect(calls.filter((call) => call.service !== "location")).toHaveLength(
      rpcsBeforeLocationReopen,
    )
    expect(containerA.querySelector(`[data-candidate-id="${CANDIDATE_A}"]`)).toBeNull()
    deferredLocationA2.resolve(locationResult(DIRECTORY_A))
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(calls.filter((call) => call.service !== "location")).toHaveLength(
      rpcsBeforeLocationReopen,
    )
    const connectionCountsBeforeReopen = connectionCounts(DIRECTORY_A)
    deferredLocationA3.resolve(locationResult(DIRECTORY_A))
    await until(() => connectedOnceSince(DIRECTORY_A, connectionCountsBeforeReopen))
    await until(() => (sourceSignals.get(DIRECTORY_A)?.length ?? 0) === 4)
    await until(() => comparisonCounts.get(DIRECTORY_A) === (beforeLateHiddenResult ?? 0) + 2)
    const afterReconnectComparisons = comparisonCounts.get(DIRECTORY_A)
    deferredA3.resolve(sourceEvidence())
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(comparisonCounts.get(DIRECTORY_A)).toBe(afterReconnectComparisons)
    expect(containerA.querySelector(".lazers-models-candidate-list")?.textContent).toContain(
      "GPT-6 refreshed",
    )
    expect(modelStore.snapshot().projects[DIRECTORY_A]?.selectedCandidateID).toBe(CANDIDATE_A)

    const rpcsBeforeSessionSwitch = calls.filter((call) => call.service !== "location").length
    sessionScope.update((draft: { id: string; directory: string }) => {
      draft.id = "ses-models-switched"
      draft.directory = DIRECTORY_B
    })
    await until(() => (locationSignals.get(DIRECTORY_B)?.length ?? 0) === 1)
    expect(calls.filter((call) => call.service !== "location")).toHaveLength(
      rpcsBeforeSessionSwitch,
    )
    expect(containerA.querySelector(`[data-candidate-id="${CANDIDATE_A}"]`)).toBeNull()
    sessionScope.update((draft: { id: string; directory: string }) => {
      draft.id = "ses-models-panel"
      draft.directory = DIRECTORY_A
    })
    await until(() => (locationSignals.get(DIRECTORY_A)?.length ?? 0) === 4)
    expect(locationSignals.get(DIRECTORY_B)?.[0]?.aborted).toBe(true)
    const rpcsBeforeLateProjectResult = calls.filter((call) => call.service !== "location").length
    deferredLocationB1.resolve(locationResult(DIRECTORY_B))
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(calls.filter((call) => call.service !== "location")).toHaveLength(
      rpcsBeforeLateProjectResult,
    )
    deferredLocationA4.reject(new Error("location lookup failed"))
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(calls.filter((call) => call.service !== "location")).toHaveLength(
      rpcsBeforeLateProjectResult,
    )
    const comparisonsBeforeRetry = comparisonCounts.get(DIRECTORY_A) ?? 0
    const connectionCountsBeforeRetry = connectionCounts(DIRECTORY_A)
    mountA.setVisible(false)
    mountA.setVisible(true)
    await until(() => (locationSignals.get(DIRECTORY_A)?.length ?? 0) === 5)
    await until(() => connectedOnceSince(DIRECTORY_A, connectionCountsBeforeRetry))
    await until(() => (sourceSignals.get(DIRECTORY_A)?.length ?? 0) === 5)
    await until(() => comparisonCounts.get(DIRECTORY_A) === comparisonsBeforeRetry + 2)
    expect(counts.get(`${DIRECTORY_A}:refreshSources`)).toBe(5)

    await until(() => !buttonWithText(containerA, "Refresh")?.disabled)
    const retainedEvidence = containerA.querySelector<HTMLDetailsElement>(
      ".lazers-models-evidence-details",
    )!
    const retainedEffort = containerA.querySelector<HTMLDetailsElement>(
      ".lazers-models-task-effort-details",
    )!
    const retainedSources = containerA.querySelector<HTMLDetailsElement>(
      ".lazers-models-sources-details",
    )!
    const retainedFilters = containerA.querySelector<HTMLDetailsElement>(
      ".lazers-models-filter-details",
    )!
    retainedEvidence.open = true
    retainedEffort.open = true
    retainedSources.open = true
    retainedFilters.open = true
    expect(
      [...containerA.querySelectorAll(".lazers-models-refresh-note")].some((warning) =>
        warning.textContent?.includes("Comparison is stale"),
      ),
    ).toBe(false)
    buttonWithText(containerA, "Refresh")?.click()
    await until(() =>
      [...containerA.querySelectorAll(".lazers-models-refresh-note")].some((warning) =>
        warning.textContent?.includes("Comparison is stale"),
      ),
    )
    const staleWarning = [
      ...containerA.querySelectorAll<HTMLElement>(".lazers-models-refresh-note"),
    ].find((warning) => warning.textContent?.includes("Comparison is stale"))!
    expect(staleWarning.closest("details")).toBeNull()
    expect(retainedEvidence.open).toBe(true)
    expect(retainedEffort.open).toBe(true)
    expect(retainedSources.open).toBe(true)
    expect(retainedFilters.open).toBe(true)
    expect(retainedSources.textContent).toContain(
      "Comparison read error: comparison request unavailable",
    )
    expect(modelStore.snapshot().projects[DIRECTORY_A]?.selectedTaskID).toBe(TASK_A)
    expect(modelStore.snapshot().projects[DIRECTORY_A]?.selectedCandidateID).toBe(CANDIDATE_A)

    await until(() => !buttonWithText(containerA, "Refresh")?.disabled)
    buttonWithText(containerA, "Refresh")?.click()
    await until(() => (sourceSignals.get(DIRECTORY_A)?.length ?? 0) === 7)
    await until(
      () =>
        containerA
          .querySelector(".lazers-models-error")
          ?.textContent?.includes("Source refresh failed") === true,
    )
    const failedRefreshWarning = containerA.querySelector<HTMLElement>(".lazers-models-error")!
    expect(failedRefreshWarning.closest("details")).toBeNull()
    expect(containerA.querySelector(".lazers-models-evidence-details")).toBe(retainedEvidence)
    expect(containerA.querySelector(".lazers-models-task-effort-details")).toBe(retainedEffort)
    expect(containerA.querySelector(".lazers-models-sources-details")).toBe(retainedSources)
    expect(containerA.querySelector(".lazers-models-filter-details")).toBe(retainedFilters)
    expect(retainedEvidence.open).toBe(true)
    expect(retainedEffort.open).toBe(true)
    expect(retainedSources.open).toBe(true)
    expect(retainedFilters.open).toBe(true)
    expect(retainedSources.textContent).toContain(
      "Source refresh error: source request unavailable",
    )
    expect(modelStore.snapshot().projects[DIRECTORY_A]?.selectedTaskID).toBe(TASK_A)
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
