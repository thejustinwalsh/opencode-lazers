import { expect, test } from "bun:test"
import { Window } from "happy-dom"
import solid from "vite-plugin-solid"
import { build } from "vite"
import { mkdir, rm } from "node:fs/promises"
import { fileURLToPath, pathToFileURL } from "node:url"
import { validProposal } from "../proposal.ts"

function until(predicate: () => boolean) {
  return (async () => {
    for (let attempt = 0; attempt < 200 && !predicate(); attempt++)
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(predicate()).toBe(true)
  })()
}

test("registered Tasks renders authoritative Now, Attention and Next with navigable priority/dependency reasons", async () => {
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
        tasks: [ids.active, ids.waiting, ids.next].map(summaries),
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
          title: "Parent implementation",
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
              priority: 9,
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
          priority: 9,
          title: "Higher-priority target plan",
          lifecycle: "running",
          decision: schedulingUnknown ? "unknown" : "eligible",
          reason: schedulingUnknown
            ? "Scheduling facts unavailable."
            : "Prerequisite plans are integrated in the selected source.",
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
          priority: 4,
          title: "Parent implementation",
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
    expect(css).toContain(".lazers-tasks-schedule-group")
    const style = browserDocument.createElement("style")
    style.textContent = css ?? ""
    browserDocument.head.append(style)
    const container = browserDocument.createElement("main")
    container.style.width = "360px"
    browserDocument.body.append(container)
    mounted = host.mountTaskPanel(panel!, context, session, container)

    await until(() => container.querySelector('[data-scheduling-group="next"]') !== null)
    const row = (taskID: string) =>
      container.querySelector<HTMLElement>(`[role="treeitem"][data-task-id="${taskID}"]`)
    expect(container.querySelector('[aria-label="Now"]')?.textContent).toContain(
      "Foreground active work",
    )
    expect(container.querySelector('[aria-label="Attention"]')?.textContent).toContain(
      "Waiting for integrated task source",
    )
    expect(container.querySelector('[aria-label="Next"]')?.textContent).toContain(
      "Backend-selected next task",
    )
    expect(
      container.querySelector<HTMLButtonElement>('[data-scheduling-group="next"]')?.dataset
        .schedulingTaskId,
    ).toBe(ids.next)
    expect(row(ids.active)?.getAttribute("aria-label")).toContain(
      "observed foreground activity active",
    )
    expect(row(ids.active)?.getAttribute("aria-label")).toContain("waiting")
    expect(container.querySelectorAll(".lazers-tasks-schedule-group")).toHaveLength(3)
    // Now and Attention entries carry the same colored state icon and no status word.
    for (const group of ["now", "attention"]) {
      const entry = container.querySelector<HTMLElement>(`[data-scheduling-group="${group}"]`)!
      const state = entry.querySelector<HTMLElement>(".lazers-tasks-state")!
      expect(state.dataset.tone).toBeTruthy()
      expect(state.title).toBeTruthy()
      expect(entry.querySelector(".lazers-tasks-badge")).toBeNull()
    }

    const targetGroup = [...container.querySelectorAll<HTMLElement>(".lazers-tasks-plan")].find(
      (element) => element.textContent?.includes("Higher-priority target plan"),
    )!
    expect(targetGroup.textContent).toContain("Priority 9")
    expect(targetGroup.textContent).toContain("Order 1")
    expect(targetGroup.textContent).toContain("Prerequisite plans are integrated")
    const planPrerequisite = targetGroup.querySelector<HTMLButtonElement>(
      ".lazers-tasks-plan-reason button",
    )!
    expect(planPrerequisite.getAttribute("aria-label")).toContain(parentPlanID)
    planPrerequisite.focus()
    expect(planPrerequisite.ownerDocument.activeElement).toBe(planPrerequisite)
    planPrerequisite.click()
    await until(() => row(ids.active)?.getAttribute("aria-selected") === "true")

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
    expect(waitingBlocker.dataset.tone).toBe("waiting")
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
    await until(
      () =>
        queryCalls > callsBefore &&
        container.querySelector('[data-scheduling-group="next"]') === null,
    )
    expect(container.querySelector('[aria-label="Next"]')?.textContent).toContain("Next is unknown")
    expect(container.querySelector('[aria-label="Next"]')?.textContent).not.toContain(
      "Backend-selected next task",
    )
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
    dom.happyDOM.abort()
  }
})
