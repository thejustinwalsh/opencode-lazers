import { expect, test } from "bun:test"
import { Window } from "happy-dom"
import solid from "vite-plugin-solid"
import { build } from "vite"
import { mkdir, rm } from "node:fs/promises"
import { fileURLToPath, pathToFileURL } from "node:url"
import { validProposal } from "../proposal.ts"
import { installTasksLayout } from "./virtual-layout.ts"

function until(predicate: () => boolean) {
  return (async () => {
    for (let attempt = 0; attempt < 200 && !predicate(); attempt++)
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(predicate()).toBe(true)
  })()
}

function pressTab(dom: Window) {
  const document = dom.document as unknown as Document
  const active = document.activeElement as unknown as HTMLElement | null
  const event = new dom.window.KeyboardEvent("keydown", {
    key: "Tab",
    bubbles: true,
    cancelable: true,
  })
  active?.dispatchEvent(event as unknown as Event)
  if (event.defaultPrevented) return
  const stops = (
    Array.from(
      document.querySelectorAll("button, a[href], input, select, textarea, summary, [tabindex]"),
    ) as unknown as HTMLElement[]
  ).filter((element) => element.tabIndex >= 0 && !element.hasAttribute("disabled"))
  const index = stops.indexOf(active!)
  stops[index < 0 ? 0 : (index + 1) % stops.length]?.focus()
}

function pressEnter(dom: Window, element: HTMLButtonElement) {
  const event = new dom.window.KeyboardEvent("keydown", {
    key: "Enter",
    bubbles: true,
    cancelable: true,
  })
  element.dispatchEvent(event as unknown as Event)
  if (!event.defaultPrevented) element.click()
}

test("registered Tasks lists priority-sorted task rows with scheduling reasons and priority in the inspector", async () => {
  const dom = new Window({ url: "http://localhost" })
  Object.defineProperty(dom.window, "innerWidth", { configurable: true, value: 360 })
  const uninstallLayout = installTasksLayout(dom)
  const browserDocument = dom.document as unknown as Document
  const globalNames = [
    "window",
    "document",
    "Node",
    "Element",
    "HTMLElement",
    "HTMLButtonElement",
    "HTMLDivElement",
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
  const entry = fileURLToPath(new URL("../task-panel/fixtures/tasks-dom-entry.ts", import.meta.url))
  const outputDirectory = fileURLToPath(
    new URL("../../node_modules/.cache/tasks-scheduling-dom-test", import.meta.url),
  )
  const inferenceRuntimeModule = "\0lazers-test-unused-inference-runtime"
  let disposeSetup: (() => void) | undefined
  let mounted: { dispose(): void } | undefined
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
            return inferenceRuntimeModule
          },
          load(id) {
            if (id === inferenceRuntimeModule)
              return `export function createInferenceRuntime() { throw new Error("unused") }`
          },
        },
      ],
      build: {
        outDir: outputDirectory,
        emptyOutDir: true,
        minify: false,
        lib: { entry, formats: ["es"], fileName: "tasks-scheduling-dom-test" },
        rolldownOptions: { output: { codeSplitting: false } },
      },
    })
    const host = await import(pathToFileURL(`${outputDirectory}/tasks-scheduling-dom-test.js`).href)
    const projectID = "tasks-scheduling-project"
    const projectDirectory = "/workspace/tasks-scheduling"
    const sessionID = "ses-tasks-scheduling-owner"
    const ids = {
      active: "11111111-1111-4111-8111-111111111111",
      waiting: "22222222-2222-4222-8222-222222222222",
      next: "33333333-3333-4333-8333-333333333333",
    }
    const blockerIDs = Array.from(
      { length: 100 },
      (_, index) => `44444444-4444-4444-8444-${(index + 1).toString().padStart(12, "0")}`,
    )
    const references = new Map([
      [ids.active, "LZ-1"],
      [ids.waiting, "LZ-2"],
      [ids.next, "LZ-3"],
    ])
    const names = {
      [ids.active]: "Foreground active work",
      [ids.waiting]: "Waiting for integrated task source",
      [ids.next]: "Backend-selected next task",
    }
    const proposal = validProposal()
    const taskSpec = (taskID: string) => ({
      schemaVersion: 1,
      id: taskID,
      revision: 1,
      status: "submitted",
      createdAt: "2026-11-05T00:00:00.000Z",
      // Task specifications always carry an objective, including reservation holders.
      proposal: {
        ...proposal,
        objective: names[taskID as keyof typeof names] ?? `Reservation holder ${taskID.slice(-4)}`,
      },
      provenance: {
        projectID,
        projectDirectory,
        workspaceDirectory: projectDirectory,
        sessionID,
        startingRevision: { kind: "unborn" },
      },
    })
    const summaries = (taskID: string) => {
      const status = taskID === ids.active ? "running" : "queued"
      return {
        taskID,
        reference: references.get(taskID),
        revision: 1,
        status,
        recordedState: status,
        reason: null,
        classification: {
          revision: 1,
          classification: { taxonomy: "task-kind/v1", primaryKind: "feature-implementation" },
          provenance: {
            kind: "embedded",
            sessionID,
            createdAt: "2026-11-05T00:00:00.000Z",
          },
        },
        title: names[taskID as keyof typeof names],
        objective: names[taskID as keyof typeof names],
        createdAt: "2026-11-05T00:00:00.000Z",
        sessionID,
        matches: [],
      }
    }
    const parentPlanID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    const targetPlanID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    let version = 1
    let schedulingUnknown = false
    let queryCalls = 0
    const query = async () => {
      queryCalls++
      return {
        projectDirectory,
        snapshot: version,
        count: 3,
        // The read orders by priority: the higher-priority target plan leads.
        tasks: [ids.next, ids.active, ids.waiting].map(summaries),
        nextCursor: null,
        serverTime: "2026-11-05T00:00:00.000Z",
      }
    }
    const topology = async () => ({
      schemaVersion: 1,
      projectID,
      scope: { kind: "session", sessionID },
      observedAt: "2026-11-05T00:00:00.000Z",
      boundary: {
        repositoryVersion: version,
        sourceRevision: 1,
        sourceFingerprint: "a".repeat(64),
        nativeRevision: 1,
        eventSequence: 1,
      },
      plans: [
        {
          id: parentPlanID,
          revision: 1,
          version: 1,
          state: "running",
          reason: null,
          title: "Parent implementation with an unusually long prerequisite plan title",
          afterPlans: [],
          nodes: [
            {
              taskID: ids.active,
              revision: 1,
              objective: names[ids.active],
              ordinal: 0,
              state: "running",
              version: 1,
              reason: null,
              machineVersion: "test",
              machineSupported: true,
              snapshot: null,
              snapshotMatchesState: true,
              waitingOn: [],
            },
            {
              taskID: ids.waiting,
              revision: 1,
              objective: names[ids.waiting],
              ordinal: 1,
              state: "queued",
              version: 1,
              reason: null,
              machineVersion: "test",
              machineSupported: true,
              snapshot: null,
              snapshotMatchesState: true,
              waitingOn: [ids.active],
            },
          ],
          dependencies: [{ prerequisite: ids.active, successor: ids.waiting }],
        },
        {
          id: targetPlanID,
          revision: 1,
          version: 1,
          state: "running",
          reason: null,
          title: "Higher-priority target plan",
          afterPlans: [parentPlanID],
          nodes: [
            {
              taskID: ids.next,
              revision: 1,
              objective: names[ids.next],
              ordinal: 0,
              state: "queued",
              version: 1,
              reason: null,
              machineVersion: "test",
              machineSupported: true,
              snapshot: null,
              snapshotMatchesState: true,
              waitingOn: [],
            },
          ],
          dependencies: [],
        },
      ],
      unplannedTasks: [],
    })
    const schedule = async () => ({
      schemaVersion: 1,
      snapshotID: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      repositoryVersion: version,
      scope: { kind: "session", sessionID },
      observedAt: 0,
      coverage: {
        status: "complete",
        planCount: 2,
        coveredPlanCount: 2,
        nodeCount: 3,
        coveredNodeCount: 3,
        activeReservationCount: 0,
        reservationsComplete: true,
        reason: null,
      },
      next: schedulingUnknown
        ? { status: "unknown", reason: "Higher-priority scheduling facts are unavailable." }
        : {
            status: "known",
            candidate: {
              planID: targetPlanID,
              taskID: ids.next,
              reference: references.get(ids.next),
              title: names[ids.next],
              priority: 1,
              planOrder: 0,
              ordinal: 0,
              order: 0,
            },
          },
      selectedTaskIDs: schedulingUnknown ? [] : [ids.next],
      selectionComplete: true,
      plans: [
        {
          planID: targetPlanID,
          planVersion: 1,
          planOrder: 0,
          priority: 1,
          title: "Higher-priority target plan",
          lifecycle: "running",
          decision: schedulingUnknown ? "unknown" : "eligible",
          reason: schedulingUnknown
            ? "Scheduling facts unavailable."
            : "Prerequisite plans are integrated in the selected source after the scheduler verifies the full source history.",
          afterPlans: [parentPlanID],
          nodesComplete: true,
          nodes: [
            {
              taskID: ids.next,
              reference: references.get(ids.next),
              title: names[ids.next],
              objective: names[ids.next],
              ordinal: 0,
              order: 0,
              lifecycle: "queued",
              decision: schedulingUnknown ? "unknown" : "eligible",
              reason: null,
              prerequisites: [],
              waitingOn: [],
              reservationTaskIDs: [],
            },
          ],
        },
        {
          planID: parentPlanID,
          planVersion: 1,
          planOrder: 1,
          priority: 2,
          title: "Parent implementation with an unusually long prerequisite plan title",
          lifecycle: "running",
          decision: "waiting",
          reason: "No task is currently dispatchable.",
          afterPlans: [],
          nodesComplete: true,
          nodes: [
            {
              taskID: ids.active,
              reference: references.get(ids.active),
              title: names[ids.active],
              objective: names[ids.active],
              ordinal: 0,
              order: 1,
              lifecycle: "running",
              decision: "not-applicable",
              reason: null,
              prerequisites: [],
              waitingOn: [],
              reservationTaskIDs: [],
            },
            {
              taskID: ids.waiting,
              reference: references.get(ids.waiting),
              title: names[ids.waiting],
              objective: names[ids.waiting],
              ordinal: 1,
              order: 2,
              lifecycle: "queued",
              decision: "waiting",
              reason: "Waiting for prerequisite source integration.",
              prerequisites: [ids.active],
              waitingOn: [ids.active],
              reservationTaskIDs: blockerIDs,
              reservationTaskCount: 101,
              reservationTaskIDsComplete: false,
            },
          ],
        },
      ],
      nextCursor: null,
    })
    const detailRequests: string[] = []
    const detail = async ({ taskID }: { taskID: string }) => {
      detailRequests.push(taskID)
      return {
        status: "found",
        task: taskSpec(taskID),
        classification: summaries(taskID).classification,
        classificationHistory: [summaries(taskID).classification],
        advice: null,
        reference: references.get(taskID),
        recordedState: taskID === ids.active ? "running" : "queued",
        execution: {
          planID: taskID === ids.next ? targetPlanID : parentPlanID,
          taskID,
          state: taskID === ids.active ? "running" : "queued",
          version: 1,
          reason: null,
          waitingOn: taskID === ids.waiting ? [ids.active] : [],
        },
        attempts: [],
        activity: [],
      }
    }
    let subscriber: ((event: { type: string; data?: unknown } | undefined) => void) | undefined
    const event = {
      subscribe: ({ signal }: { signal: AbortSignal }) =>
        (async function* () {
          while (!signal.aborted) {
            const next = await new Promise<{ type: string; data?: unknown } | undefined>(
              (resolve) => {
                subscriber = resolve
                signal.addEventListener("abort", () => resolve(undefined), { once: true })
              },
            )
            if (!next) return
            yield next
          }
        })(),
    }
    const rpc = {
      query,
      get: detail,
      currentActivity: async ({ taskIDs }: { taskIDs: string[] }) => ({
        activities: taskIDs.map((taskID) => ({
          taskID,
          workerSessionID: `ses-worker-${taskID.slice(0, 4)}`,
          attemptID: crypto.randomUUID(),
          foreground: taskID === ids.active ? "active" : "unknown",
          unknownReason: taskID === ids.active ? null : "unavailable",
          recordedState: taskID === ids.active ? "running" : "queued",
          waiting: taskID === ids.active,
          holdReason:
            taskID === ids.active ? "The foreground task is also waiting for review." : null,
          pendingInput: null,
          pendingPermissions: 0,
          pendingForms: 0,
          outcome: null,
          observedAt: 0,
        })),
      }),
      start: async () => ({ status: "existing", planID: targetPlanID, state: "queued" }),
    }
    const client = {
      location: { get: async () => ({ project: { canonical: projectDirectory, id: projectID } }) },
      rpc: (contract: { id?: string }) =>
        contract.id === "lazers.observability"
          ? { topology }
          : contract.id === "lazers.tasks.scheduling"
            ? { read: schedule }
            : rpc,
      event,
    }
    const registrations: Array<{ token: unknown; value: unknown }> = []
    const opened: unknown[][] = []
    const taskStore = host.createReactiveStore({ projects: {} })
    const context = {
      id: "lazers",
      app: { platform: "web" },
      signal: new AbortController().signal,
      ui: (() => {
        const ui = host.createTestUI() as Record<string, unknown>
        ui.IconButton = (props: { label: string; onClick?: () => void; disabled?: boolean }) => {
          const button = browserDocument.createElement("button")
          button.textContent = props.label
          button.setAttribute("aria-label", props.label)
          button.addEventListener("click", () => props.onClick?.())
          if (props.disabled) button.disabled = true
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
      layout: { open: (...args: unknown[]) => opened.push(args) },
      stores: {
        taskView: () => taskStore,
        modelsView: () => host.createReactiveStore({ projects: {} }),
        trajectoryView: () => host.createReactiveStore({ projects: {} }),
      },
      links: { open: () => {} },
      system: { copy: async () => {} },
      servers: { get: () => ({ connected: true, client }) },
    }
    const session = {
      id: sessionID,
      location: { directory: projectDirectory },
      directory: projectDirectory,
      server: { id: "tasks-scheduling-server", connected: true, client },
    }
    disposeSetup = host.setupGui(host.gui, context)
    const panel = host.taskPanelRegistration(registrations)
    expect(panel).toBeDefined()
    const css = registrations.find(
      (entry) => typeof entry.value === "string" && entry.value.includes(".lazers-tasks {"),
    )?.value as string | undefined
    expect(css).toContain(".lazers-tasks-row-signals")
    expect(css).not.toContain(".lazers-tasks-schedule-group")
    const style = browserDocument.createElement("style")
    style.textContent = css ?? ""
    browserDocument.head.append(style)
    const container = browserDocument.createElement("main")
    container.style.width = "360px"
    browserDocument.body.append(container)
    mounted = host.mountTaskPanel(panel!, context, session, container)

    await until(() => container.querySelector('[role="treeitem"]') !== null)
    const row = (taskID: string) =>
      container.querySelector<HTMLElement>(`[role="treeitem"][data-task-id="${taskID}"]`)
    // One flat list of task rows sorted by priority (1 first): the target plan outranks its
    // prerequisite plan, so its task leads. No Now, Attention or Next sections, no plan headings.
    await until(() => container.querySelectorAll('[role="treeitem"]').length === 3)
    expect(
      [...container.querySelectorAll<HTMLElement>('[role="treeitem"]')].map(
        (item) => item.dataset.taskId,
      ),
    ).toEqual([ids.next, ids.active, ids.waiting])
    expect(container.querySelector(".lazers-tasks-schedule-groups")).toBeNull()
    expect(container.querySelector("[data-scheduling-group]")).toBeNull()
    expect(container.querySelector(".lazers-tasks-plan")).toBeNull()
    expect(container.querySelector('[role="tree"]')?.textContent).not.toContain("Priority")
    expect(row(ids.active)?.getAttribute("aria-label")).toContain(
      "observed foreground activity active",
    )
    expect(row(ids.active)?.getAttribute("aria-label")).toContain("waiting")
    // The waiting task depends on the active one: a collapsed accordion.
    expect(row(ids.waiting)?.getAttribute("aria-expanded")).toBe("false")
    expect(row(ids.waiting)?.querySelector(".lazers-tasks-sequence")).toBeNull()
    // The target plan waits for the parent plan, so its task has dependencies too.
    expect(row(ids.next)?.getAttribute("aria-expanded")).toBe("false")

    // Priority, order and plan live in the inspector.
    row(ids.next)!.click()
    await until(() => row(ids.next)?.getAttribute("aria-selected") === "true")
    const facts = () =>
      container.querySelector<HTMLElement>(".lazers-tasks-detail .lazers-tasks-meta")
        ?.textContent ?? ""
    await until(() => facts().includes("Higher-priority target plan"))
    expect(facts()).toContain("Priority 1")
    expect(facts()).toContain("step 1")
    const parentPlanTitle = "Parent implementation with an unusually long prerequisite plan title"
    // The scheduler's plan reason and prerequisite plans are reachable from the inspector.
    const planPrerequisite = [
      ...container.querySelectorAll<HTMLButtonElement>(".lazers-tasks-detail button"),
    ].find((button) => button.getAttribute("aria-label")?.includes("Open prerequisite"))!
    expect(planPrerequisite.textContent).toBe(parentPlanTitle)
    planPrerequisite.click()
    await until(() => row(ids.active)?.getAttribute("aria-selected") === "true")
    await until(() => facts().includes("Priority 2"))

    // The scheduler's recorded wait sets the row's state icon; the link icon opens the blocker,
    // and the machine reason stays out of the row.
    const waitingRow = row(ids.waiting)!
    const waitingState = waitingRow.querySelector<HTMLElement>(
      ":scope > .lazers-tasks-row .lazers-tasks-state",
    )!
    expect(waitingState.getAttribute("data-tone")).toBe("waiting")
    expect(waitingState.getAttribute("aria-label")).toBe("Waiting")
    expect(waitingState.closest<HTMLElement>(".fixture-tooltip")?.dataset.tooltip).toStartWith(
      "Waiting · Waiting for prerequisite source integration.",
    )
    expect(waitingRow.querySelector(":scope > .lazers-tasks-row .lazers-tasks-badge")).toBeNull()
    expect(waitingRow.querySelector(".lazers-tasks-node-reason")).toBeNull()
    expect(waitingRow.textContent).not.toContain("Waiting for prerequisite source integration.")
    const waitingBlocker = waitingRow.querySelector<HTMLButtonElement>(".lazers-tasks-row-blocker")!
    expect(waitingBlocker.textContent).toBe("link")
    // One prerequisite, 100 listed reservation holders and one more the read only counted. The
    // listed prerequisite's own state (held by its worker) names and colors the link.
    expect(waitingBlocker.getAttribute("aria-label")).toBe(
      "Open blocker LZ-1, waiting and 101 more",
    )
    expect(waitingBlocker.closest<HTMLElement>(".fixture-tooltip")?.dataset.tooltip).toBe(
      "Waiting on LZ-1 · Waiting and 101 more",
    )
    expect(waitingBlocker.dataset.tone).toBeUndefined()
    expect(waitingRow.getAttribute("aria-label")).toContain(
      "Waiting for prerequisite source integration.",
    )

    // Selecting the waiting task puts the source reason and every reference in the inspector.
    const selectWaiting = async () => {
      row(ids.waiting)!.click()
      await until(() => row(ids.waiting)?.getAttribute("aria-selected") === "true")
      await until(
        () => container.querySelector(".lazers-tasks-detail .lazers-tasks-node-reason") !== null,
      )
      return container.querySelector<HTMLDivElement>(
        ".lazers-tasks-detail .lazers-tasks-node-reason",
      )!
    }
    let nodeReason = await selectWaiting()
    expect(nodeReason.textContent).toContain("Waiting for prerequisite source integration.")
    expect(nodeReason.textContent).toContain(
      "Showing 100 of 101 blocker task references visible in this session.",
    )
    expect(nodeReason.querySelectorAll("button")).toHaveLength(100)
    expect(nodeReason.querySelector("details")?.open).toBe(false)
    expect(
      container.querySelector(".lazers-tasks-detail .lazers-tasks-dependencies-visible")
        ?.textContent,
    ).toContain("LZ-1")
    waitingBlocker.click()
    await until(() => row(ids.active)?.getAttribute("aria-selected") === "true")
    nodeReason = await selectWaiting()
    const blockerReference = [...nodeReason.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.getAttribute("aria-label")?.includes(blockerIDs[0]!.slice(0, 8)),
    )!
    blockerReference.click()
    await until(() => detailRequests.includes(blockerIDs[0]!))

    const callsBefore = queryCalls
    schedulingUnknown = true
    version++
    subscriber?.({
      type: "rpc.lazers.tasks.changed",
      data: { projectDirectory, version },
    })
    await until(() => queryCalls > callsBefore)
    // Unknown scheduling never invents a Next entry; the list keeps its rows.
    expect(container.querySelector('[aria-label="Next"]')).toBeNull()
    expect(row(ids.waiting)).not.toBeNull()
    expect(opened).toHaveLength(0)
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
})

test("keyboard navigation reaches a held task and its related dependency when topology is unavailable", async () => {
  const dom = new Window({ url: "http://localhost" })
  Object.defineProperty(dom.window, "innerWidth", { configurable: true, value: 360 })
  const browserDocument = dom.document as unknown as Document
  const uninstallLayout = installTasksLayout(dom)
  const globalNames = [
    "window",
    "document",
    "Node",
    "Element",
    "HTMLElement",
    "HTMLButtonElement",
    "HTMLDivElement",
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
  const entry = fileURLToPath(new URL("../task-panel/fixtures/tasks-dom-entry.ts", import.meta.url))
  const outputDirectory = fileURLToPath(
    new URL("../../node_modules/.cache/tasks-scheduling-navigation-test", import.meta.url),
  )
  const inferenceRuntimeModule = "\0lazers-test-unused-inference-runtime"
  let disposeSetup: (() => void) | undefined
  let mounted: { dispose(): void } | undefined
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
            return inferenceRuntimeModule
          },
          load(id) {
            if (id === inferenceRuntimeModule)
              return `export function createInferenceRuntime() { throw new Error("unused") }`
          },
        },
      ],
      build: {
        outDir: outputDirectory,
        emptyOutDir: true,
        minify: false,
        lib: { entry, formats: ["es"], fileName: "tasks-scheduling-navigation-test" },
        rolldownOptions: { output: { codeSplitting: false } },
      },
    })
    const host = await import(
      pathToFileURL(`${outputDirectory}/tasks-scheduling-navigation-test.js`).href
    )
    const projectID = "tasks-scheduling-navigation-project"
    const projectDirectory = "/workspace/tasks-scheduling-navigation"
    const sessionID = "ses-tasks-scheduling-navigation"
    const ids = {
      heldAttention: "11111111-1111-4111-8111-111111111111",
      forkRoot: "22222222-2222-4222-8222-222222222222",
      heldChild: "33333333-3333-4333-8333-333333333333",
      otherChild: "44444444-4444-4444-8444-444444444444",
      join: "55555555-5555-4555-8555-555555555555",
    }
    const attentionPlanID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    const forkPlanID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    const names = {
      [ids.heldAttention]: "Review the held fork task",
      [ids.forkRoot]: "Prepare parallel work",
      [ids.heldChild]: "Held parallel branch",
      [ids.otherChild]: "Other parallel branch",
      [ids.join]: "Join parallel work",
    }
    const proposal = validProposal()
    const taskSpec = (taskID: string) => ({
      schemaVersion: 1,
      id: taskID,
      revision: 1,
      status: "submitted",
      createdAt: "2026-11-05T00:00:00.000Z",
      proposal: { ...proposal, objective: names[taskID as keyof typeof names] },
      provenance: {
        projectID,
        projectDirectory,
        workspaceDirectory: projectDirectory,
        sessionID,
        startingRevision: { kind: "unborn" },
      },
    })
    const classification = {
      revision: 1,
      classification: { taxonomy: "task-kind/v1", primaryKind: "feature-implementation" },
      provenance: {
        kind: "embedded",
        sessionID,
        createdAt: "2026-11-05T00:00:00.000Z",
      },
    }
    const reference = (taskID: string) =>
      taskID === ids.heldChild ? undefined : `LZ-${Object.values(ids).indexOf(taskID) + 1}`
    // The Attention entry is a recorded hold (blocked), not a routine dependency wait.
    const recorded = (taskID: string) => (taskID === ids.heldAttention ? "blocked" : "queued")
    const summary = (taskID: string) => ({
      taskID,
      ...(reference(taskID) ? { reference: reference(taskID) } : {}),
      revision: 1,
      status: recorded(taskID),
      recordedState: recorded(taskID),
      reason: null,
      classification,
      title: names[taskID as keyof typeof names],
      objective: names[taskID as keyof typeof names],
      createdAt: "2026-11-05T00:00:00.000Z",
      sessionID,
      matches: [],
    })
    const node = (input: {
      taskID: string
      ordinal: number
      decision: "eligible" | "waiting"
      prerequisites: string[]
      waitingOn: string[]
      reason: string | null
    }) => ({
      taskID: input.taskID,
      ...(reference(input.taskID) ? { reference: reference(input.taskID) } : {}),
      title: names[input.taskID as keyof typeof names],
      objective: names[input.taskID as keyof typeof names],
      ordinal: input.ordinal,
      order: input.ordinal,
      lifecycle: recorded(input.taskID),
      decision: input.decision,
      reason: input.reason,
      prerequisites: input.prerequisites,
      waitingOn: input.waitingOn,
      reservationTaskIDs: [],
    })
    const plans = [
      {
        planID: attentionPlanID,
        planVersion: 1,
        planOrder: 0,
        priority: 10,
        title: "Review plan",
        lifecycle: "running",
        decision: "waiting",
        reason: "Waiting for the held parallel task.",
        afterPlans: [],
        nodesComplete: true,
        nodes: [
          node({
            taskID: ids.heldAttention,
            ordinal: 0,
            decision: "waiting",
            prerequisites: [],
            waitingOn: [ids.heldChild],
            reason: "Waiting for the held parallel task.",
          }),
        ],
      },
      {
        planID: forkPlanID,
        planVersion: 1,
        planOrder: 1,
        priority: 1,
        title: "Parallel plan",
        lifecycle: "running",
        decision: "waiting",
        reason: "A parallel branch is held.",
        afterPlans: [attentionPlanID],
        afterPlansCount: 2,
        afterPlansComplete: false,
        nodesComplete: true,
        nodes: [
          node({
            taskID: ids.forkRoot,
            ordinal: 0,
            decision: "eligible",
            prerequisites: [],
            waitingOn: [],
            reason: null,
          }),
          node({
            taskID: ids.heldChild,
            ordinal: 1,
            decision: "waiting",
            prerequisites: [ids.forkRoot],
            waitingOn: [ids.forkRoot],
            reason: "Waiting for review.",
          }),
          node({
            taskID: ids.otherChild,
            ordinal: 2,
            decision: "eligible",
            prerequisites: [ids.forkRoot],
            waitingOn: [],
            reason: null,
          }),
          node({
            taskID: ids.join,
            ordinal: 3,
            decision: "waiting",
            prerequisites: [ids.heldChild, ids.otherChild],
            waitingOn: [ids.heldChild, ids.otherChild],
            reason: "Waiting for both parallel branches.",
          }),
        ],
      },
    ]
    const schedule = async () => ({
      schemaVersion: 1,
      snapshotID: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      repositoryVersion: 1,
      scope: { kind: "session", sessionID },
      observedAt: 1,
      coverage: {
        status: "complete",
        planCount: plans.length,
        coveredPlanCount: plans.length,
        nodeCount: Object.keys(ids).length,
        coveredNodeCount: Object.keys(ids).length,
        activeReservationCount: 0,
        reservationsComplete: true,
        reason: null,
      },
      next: { status: "none" },
      selectedTaskIDs: [],
      selectionComplete: true,
      plans,
      nextCursor: null,
    })
    let topologyCalls = 0
    const detailRequests: string[] = []
    const detail = async ({ taskID }: { taskID: string }) => {
      detailRequests.push(taskID)
      const planID = taskID === ids.heldAttention ? attentionPlanID : forkPlanID
      const waitingOn = taskID === ids.heldAttention ? [ids.heldChild] : []
      const value = summary(taskID)
      return {
        status: "found",
        task: taskSpec(taskID),
        classification: value.classification,
        classificationHistory: [value.classification],
        advice: null,
        ...(reference(taskID) ? { reference: reference(taskID) } : {}),
        recordedState: "queued",
        execution: {
          planID,
          taskID,
          state: "queued",
          version: 1,
          reason: null,
          waitingOn,
        },
        attempts: [],
        activity: [],
      }
    }
    const rpc = {
      query: async () => ({
        projectDirectory,
        snapshot: 1,
        count: Object.keys(ids).length,
        tasks: Object.values(ids).map(summary),
        nextCursor: null,
        serverTime: "2026-11-05T00:00:00.000Z",
      }),
      get: detail,
      currentActivity: async () => ({ activities: [] }),
      start: async () => ({ status: "existing", planID: attentionPlanID, state: "running" }),
    }
    const client = {
      location: {
        get: async () => ({ project: { canonical: projectDirectory, id: projectID } }),
      },
      rpc: (contract: { id?: string }) =>
        contract.id === "lazers.observability"
          ? {
              topology: async () => {
                topologyCalls++
                throw new Error("fixture topology unavailable")
              },
            }
          : contract.id === "lazers.tasks.scheduling"
            ? { read: schedule }
            : rpc,
      event: { subscribe: () => (async function* () {})() },
    }
    const registrations: Array<{ token: unknown; value: unknown }> = []
    const taskStore = host.createReactiveStore({ projects: {} })
    const context = {
      id: "lazers",
      app: { platform: "web" },
      signal: new AbortController().signal,
      ui: (() => {
        const ui = host.createTestUI() as Record<string, unknown>
        ui.IconButton = (props: { label: string; onClick?: () => void; disabled?: boolean }) => {
          const button = browserDocument.createElement("button")
          button.textContent = props.label
          button.setAttribute("aria-label", props.label)
          button.addEventListener("click", () => props.onClick?.())
          if (props.disabled) button.disabled = true
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
    const session = {
      id: sessionID,
      location: { directory: projectDirectory },
      directory: projectDirectory,
      server: { id: "tasks-scheduling-navigation-server", connected: true, client },
    }
    disposeSetup = host.setupGui(host.gui, context)
    const panel = host.taskPanelRegistration(registrations)
    expect(panel).toBeDefined()
    const css = registrations.find(
      (entry) => typeof entry.value === "string" && entry.value.includes(".lazers-tasks {"),
    )?.value as string | undefined
    const style = browserDocument.createElement("style")
    style.textContent = css ?? ""
    browserDocument.head.append(style)
    const container = browserDocument.createElement("main")
    container.style.width = "360px"
    browserDocument.body.append(container)
    mounted = host.mountTaskPanel(panel!, context, session, container)

    const row = (taskID: string) =>
      container.querySelector<HTMLElement>(`[role="treeitem"][data-task-id="${taskID}"]`)
    await until(() => topologyCalls > 0 && row(ids.heldAttention) !== null)
    const stop = () =>
      [...container.querySelectorAll<HTMLElement>('[role="treeitem"]')].find(
        (item) => item.tabIndex === 0,
      )
    expect(stop()).toBeDefined()
    expect(container.querySelector("[data-scheduling-group]")).toBeNull()
    for (
      let attempt = 0;
      attempt < 100 && browserDocument.activeElement !== (stop() ?? null);
      attempt++
    )
      pressTab(dom)
    expect(browserDocument.activeElement).toBe(stop() ?? null)
    // Arrow keys walk the flat rows in order until the held task takes selection and focus.
    for (
      let attempt = 0;
      attempt < 20 && browserDocument.activeElement !== row(ids.heldAttention);
      attempt++
    ) {
      const active = browserDocument.activeElement as unknown as HTMLElement
      active.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "ArrowDown",
          bubbles: true,
          cancelable: true,
        }) as unknown as Event,
      )
      await new Promise<void>((resolve) => setTimeout(resolve, 20))
    }
    expect(browserDocument.activeElement).toBe(row(ids.heldAttention))
    await until(() => row(ids.heldAttention)?.getAttribute("aria-selected") === "true")
    await until(() => detailRequests.includes(ids.heldAttention))

    const relatedTask = () =>
      container.querySelector<HTMLButtonElement>(
        '.lazers-tasks-detail .lazers-tasks-dependencies-visible button[aria-label^="Open related task"]',
      )
    await until(() => relatedTask() !== null)
    for (
      let attempt = 0;
      attempt < 100 && browserDocument.activeElement !== relatedTask();
      attempt++
    )
      pressTab(dom)
    expect(browserDocument.activeElement).toBe(relatedTask())
    expect(relatedTask()?.textContent).toBe(ids.heldChild.slice(0, 8))

    pressEnter(dom, relatedTask()!)
    await until(() => row(ids.heldChild)?.getAttribute("aria-selected") === "true")
    await until(() => browserDocument.activeElement === row(ids.heldChild))
    // Every task is a top-level row: following a relation never expands anything.
    expect(row(ids.heldChild)?.getAttribute("aria-level")).toBe("1")
    const planWait = [...container.querySelectorAll(".lazers-tasks-dependencies")].find((element) =>
      element.textContent?.includes("Plan waits for"),
    )
    expect(planWait?.textContent).toContain("showing 1 of 2 prerequisite plans")
    expect(topologyCalls).toBeGreaterThan(0)
  } finally {
    mounted?.dispose()
    disposeSetup?.()
    await rm(outputDirectory, { recursive: true, force: true })
    uninstallLayout()
    for (const name of globalNames) {
      const descriptor = previousGlobals.get(name)
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
    dom.happyDOM.abort()
  }
})
