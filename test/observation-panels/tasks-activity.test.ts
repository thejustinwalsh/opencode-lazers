import { expect, test } from "bun:test"
import { Window } from "happy-dom"
import solid from "vite-plugin-solid"
import { build } from "vite"
import { mkdir, rm } from "node:fs/promises"
import { fileURLToPath, pathToFileURL } from "node:url"
import { validProposal } from "../proposal.ts"
import { installTasksLayout } from "./virtual-layout.ts"
import { openedTaskView } from "./fixtures/open-details.ts"

function until(predicate: () => boolean) {
  return (async () => {
    for (let attempt = 0; attempt < 200 && !predicate(); attempt++)
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(predicate()).toBe(true)
  })()
}

test("registered Tasks panel separates lifecycle, foreground activity and holds with working filters", async () => {
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
  const entry = fileURLToPath(new URL("../task-panel/fixtures/tasks-dom-entry.ts", import.meta.url))
  const outputDirectory = fileURLToPath(
    new URL("../../node_modules/.cache/tasks-panel-dom-test", import.meta.url),
  )
  const inferenceRuntimeModule = "\0lazers-test-unused-inference-runtime"
  let replacedInferenceRuntime = false
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
            replacedInferenceRuntime = true
            return inferenceRuntimeModule
          },
          load(id) {
            if (id !== inferenceRuntimeModule) return
            return `export function createInferenceRuntime() {
              throw new Error("The inference runtime is not used by this Tasks panel test")
            }`
          },
        },
      ],
      build: {
        outDir: outputDirectory,
        emptyOutDir: true,
        minify: false,
        lib: { entry, formats: ["es"], fileName: "tasks-panel-dom-test" },
        rolldownOptions: { output: { codeSplitting: false } },
      },
    })

    const host = await import(pathToFileURL(`${outputDirectory}/tasks-panel-dom-test.js`).href)
    expect(replacedInferenceRuntime).toBe(true)

    const projectID = "tasks-activity-project"
    const projectDirectory = "/workspace/tasks-activity"
    const ownerSessionID = "ses-tasks-activity-owner"
    const ids = {
      held: "11111111-1111-4111-8111-111111111111",
      active: "22222222-2222-4222-8222-222222222222",
      unknown: "33333333-3333-4333-8333-333333333333",
      queuedOne: "44444444-4444-4444-8444-444444444444",
      queuedTwo: "55555555-5555-4555-8555-555555555555",
      queuedThree: "99999999-9999-4999-8999-999999999999",
      queuedFour: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      queuedFive: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      completed: "66666666-6666-4666-8666-666666666666",
      forkRoot: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      branchA: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      branchB: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      join: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    }
    const attemptIDs = Object.fromEntries(
      Object.entries(ids).map(([key]) => [key, crypto.randomUUID()]),
    ) as Record<keyof typeof ids, string>
    const workerSessionIDs = Object.fromEntries(
      Object.keys(ids).map((key) => [key, `ses-worker-${key}`]),
    ) as Record<keyof typeof ids, string>
    const referenceByTaskID = new Map(
      Object.values(ids).map((taskID, index) => [taskID, `LZ-${index + 1}`]),
    )
    const taskIDByReference = new Map(
      [...referenceByTaskID].map(([taskID, reference]) => [reference, taskID]),
    )
    const taskNames: Record<keyof typeof ids, string> = {
      held: "Inactive worker under a reconciliation hold",
      active: "Active worker under a reconciliation hold",
      unknown: "Uncertain worker under a reconciliation hold",
      queuedOne: "Queued page one",
      queuedTwo: "Queued page two",
      queuedThree: "Queued page two companion",
      queuedFour: "Queued page three",
      queuedFive: "Queued page three companion",
      completed: "Completed despite a combined gate",
      forkRoot: "Prepare parallel checks",
      branchA: "Check the light theme",
      branchB: "Check the dark theme",
      join: "Merge the theme checks",
    }
    const proposal = validProposal()
    const taskObjects = Object.fromEntries(
      Object.entries(ids).map(([key, id]) => [
        id,
        {
          schemaVersion: 1,
          id,
          revision: 1,
          status: "submitted",
          createdAt: "2026-11-05T00:00:00.000Z",
          proposal: { ...proposal, objective: taskNames[key as keyof typeof ids] },
          provenance: {
            projectID,
            projectDirectory,
            workspaceDirectory: projectDirectory,
            sessionID: ownerSessionID,
            startingRevision: { kind: "unborn" },
          },
        },
      ]),
    ) as Record<string, Record<string, unknown>>
    const states: Record<string, string> = {
      [ids.held]: "running",
      [ids.active]: "running",
      [ids.unknown]: "running",
      [ids.queuedOne]: "queued",
      [ids.queuedTwo]: "queued",
      [ids.queuedThree]: "queued",
      [ids.queuedFour]: "queued",
      [ids.queuedFive]: "queued",
      [ids.completed]: "accepted",
      [ids.forkRoot]: "running",
      [ids.branchA]: "queued",
      [ids.branchB]: "queued",
      [ids.join]: "queued",
    }
    const summary = (taskID: string) => {
      const key = (Object.keys(ids) as Array<keyof typeof ids>).find(
        (name) => ids[name] === taskID,
      )!
      const state = states[taskID]!
      return {
        taskID,
        reference: referenceByTaskID.get(taskID)!,
        ...(taskID === ids.held
          ? { sourcePlan: { path: "design/roadmap.md", section: "Recovery", line: 1 } }
          : {}),
        revision: 1,
        status: state,
        recordedState: state,
        reason: taskID === ids.completed ? null : "Reconciliation hold: awaiting review",
        classification: {
          revision: 1,
          classification: { taxonomy: "task-kind/v1", primaryKind: "feature-implementation" },
          provenance: {
            kind: "embedded",
            sessionID: ownerSessionID,
            createdAt: "2026-11-05T00:00:00.000Z",
          },
        },
        title: taskNames[key],
        objective: taskNames[key],
        createdAt: "2026-11-05T00:00:00.000Z",
        sessionID: ownerSessionID,
        matches: [],
      }
    }
    const allRunning = [ids.held, ids.active, ids.unknown]
    const forkTasks = [ids.forkRoot, ids.branchA, ids.branchB, ids.join]
    const allQueued = [
      ids.queuedOne,
      ids.queuedTwo,
      ids.queuedThree,
      ids.queuedFour,
      ids.queuedFive,
    ]
    const queryCalls: Array<{ state?: string; cursor?: string }> = []
    let snapshot = 1
    let topologyFails = false
    const query = async (input: { state?: string; cursor?: string }) => {
      queryCalls.push({ state: input.state, cursor: input.cursor })
      let taskIDs: string[]
      let nextCursor: string | null = null
      if (input.state === "queued") {
        taskIDs =
          input.cursor === "queued-page-two"
            ? [ids.queuedTwo, ids.queuedThree]
            : input.cursor === "queued-page-three"
              ? [ids.queuedFour, ids.queuedFive]
              : [ids.queuedOne]
        nextCursor =
          input.cursor === "queued-page-two"
            ? "queued-page-three"
            : input.cursor === "queued-page-three"
              ? null
              : "queued-page-two"
      } else if (input.state === "running") {
        taskIDs = allRunning
      } else if (input.state === "blocked") {
        taskIDs = input.cursor === "blocked-page-two" ? allQueued : allRunning
        nextCursor = input.cursor ? null : "blocked-page-two"
      } else if (input.state === "accepted") {
        taskIDs = [ids.completed]
      } else if (input.state === "failed" || input.state === "cancelled") {
        taskIDs = []
      } else if (input.state === "open" && input.cursor === "open-page-two") {
        taskIDs = allQueued
      } else {
        taskIDs = [...allRunning, ...forkTasks]
      }
      return {
        projectDirectory,
        snapshot,
        count:
          input.state === "queued"
            ? 5
            : input.state === "blocked" || input.state === "open"
              ? 8
              : taskIDs.length,
        tasks: taskIDs.map(summary),
        nextCursor: input.state === "open" && !input.cursor ? "open-page-two" : nextCursor,
        serverTime: "2026-11-05T00:00:00.000Z",
      }
    }
    const planID = "77777777-7777-4777-8777-777777777777"
    const completedPlanID = "88888888-8888-4888-8888-888888888888"
    const forkPlanID = "12121212-1212-4121-8121-121212121212"
    const activityHoldReason =
      "Worker-level hold: waiting for a reviewer to reconcile the external result before this task may continue.\nAdditional hold: retain the audit trail and confirm the exact input provenance before resuming."
    const node = (taskID: string, ordinal: number) => ({
      taskID,
      reference: referenceByTaskID.get(taskID),
      revision: 1,
      objective:
        taskNames[
          (Object.keys(ids) as Array<keyof typeof ids>).find((key) => ids[key] === taskID)!
        ],
      ordinal,
      state: states[taskID],
      version: 1,
      reason: null,
      machineVersion: "test-machine",
      machineSupported: true,
      snapshot: null,
      snapshotMatchesState: true,
      waitingOn: [],
    })
    const topology = async () => {
      if (topologyFails) {
        topologyFails = false
        throw new Error("transient topology failure")
      }
      return {
        schemaVersion: 1,
        projectID,
        scope: { kind: "session", sessionID: ownerSessionID },
        observedAt: "2026-11-05T00:00:00.000Z",
        boundary: {
          repositoryVersion: snapshot,
          sourceRevision: 1,
          sourceFingerprint: "a".repeat(64),
          nativeRevision: 1,
          eventSequence: 1,
        },
        plans: [
          {
            id: planID,
            revision: 1,
            version: 1,
            state: "blocked",
            reason: "Reconciliation hold: awaiting review",
            title: "Worker activity",
            afterPlans: [],
            nodes: [
              ids.held,
              ids.active,
              ids.unknown,
              ids.queuedOne,
              ids.queuedTwo,
              ids.queuedThree,
              ids.queuedFour,
              ids.queuedFive,
            ].map(node),
            dependencies: [{ prerequisite: ids.queuedFive, successor: ids.held }],
          },
          {
            id: completedPlanID,
            revision: 1,
            version: 1,
            state: "blocked",
            reason: "Combined checks still need review",
            title: "Completed work",
            afterPlans: [],
            nodes: [node(ids.completed, 0)],
            dependencies: [],
          },
          {
            id: forkPlanID,
            revision: 1,
            version: 1,
            state: "running",
            reason: null,
            title: "Parallel checks",
            afterPlans: [],
            nodes: forkTasks.map(node),
            dependencies: [
              { prerequisite: ids.forkRoot, successor: ids.branchA },
              { prerequisite: ids.forkRoot, successor: ids.branchB },
              { prerequisite: ids.branchA, successor: ids.join },
              { prerequisite: ids.branchB, successor: ids.join },
            ],
          },
        ],
        unplannedTasks: [],
      }
    }
    const currentActivity = async ({ taskIDs }: { taskIDs: string[] }) => ({
      activities: taskIDs.map((taskID) => {
        const key = (Object.keys(ids) as Array<keyof typeof ids>).find(
          (name) => ids[name] === taskID,
        )!
        const foreground =
          taskID === ids.held ? "inactive" : taskID === ids.active ? "active" : "unknown"
        return {
          taskID,
          workerSessionID: workerSessionIDs[key],
          attemptID: attemptIDs[key],
          foreground,
          // S8: archived, exactly bound workers remain known in the rendered panel.
          archived: taskID === ids.held,
          unknownReason: foreground === "unknown" ? "unavailable" : null,
          recordedState: states[taskID],
          waiting: taskID !== ids.completed,
          holdReason: taskID === ids.completed ? null : activityHoldReason,
          pendingInput: taskID === ids.active,
          pendingPermissions: taskID === ids.active ? 1 : 0,
          pendingForms: 0,
          outcome: taskID === ids.held ? "succeeded" : null,
          observedAt: Date.now(),
        }
      }),
    })
    const detail = async ({ taskID }: { taskID: string }) => {
      const resolvedTaskID = taskIDByReference.get(taskID) ?? taskID
      const task = taskObjects[resolvedTaskID]!
      const key = (Object.keys(ids) as Array<keyof typeof ids>).find(
        (name) => ids[name] === resolvedTaskID,
      )!
      const state = states[resolvedTaskID]!
      const currentPlan = resolvedTaskID === ids.completed ? completedPlanID : planID
      return {
        status: "found",
        task,
        classification: summary(resolvedTaskID).classification,
        classificationHistory: [summary(resolvedTaskID).classification],
        advice: null,
        reference: summary(resolvedTaskID).reference,
        recordedState: state,
        execution: {
          planID: currentPlan,
          taskID: resolvedTaskID,
          state: resolvedTaskID === ids.completed ? "blocked" : state,
          version: 1,
          reason:
            resolvedTaskID === ids.completed
              ? "Combined checks remain open"
              : "Reconciliation hold: awaiting review",
          waitingOn: resolvedTaskID === ids.held ? [ids.queuedFive] : [],
        },
        attempts: [],
        activity: [],
        _activityKey: key,
      }
    }
    const rpc = {
      query,
      get: detail,
      currentActivity,
      start: async () => ({ status: "existing", planID, state: "running" }),
    }
    let eventSubscriber: ((event: { type: string; data?: unknown } | undefined) => void) | undefined
    const event = {
      subscribe: ({ signal }: { signal: AbortSignal }) =>
        (async function* () {
          while (!signal.aborted) {
            const next = await new Promise<{ type: string; data?: unknown } | undefined>(
              (resolve) => {
                eventSubscriber = resolve
                signal.addEventListener("abort", () => resolve(undefined), { once: true })
              },
            )
            if (!next) return
            yield next
          }
        })(),
    }
    const client = {
      location: {
        get: async () => ({ project: { canonical: projectDirectory, id: projectID } }),
      },
      rpc: (contract: { id?: string }) =>
        contract.id === "lazers.observability" ? { topology } : rpc,
      event,
    }
    const taskStore = host.createReactiveStore({
      projects: { [projectDirectory]: openedTaskView() } as Record<string, unknown>,
    })
    const trajectoryStore = host.createReactiveStore({ projects: {} as Record<string, unknown> })
    const registrations: Array<{ token: unknown; value: unknown }> = []
    const opened: unknown[][] = []
    const taskLinkHandler: {
      value:
        | {
            match(link: { href: string; session: unknown }): boolean
            exists(link: { href: string; session: unknown }): Promise<boolean>
            open(link: { href: string; session: unknown }): void
          }
        | undefined
    } = { value: undefined }
    const session = {
      id: ownerSessionID,
      location: { directory: projectDirectory },
      directory: projectDirectory,
      server: { id: "tasks-server", connected: true, client },
    }
    const context = {
      id: "lazers",
      app: { platform: "web" },
      signal: new AbortController().signal,
      ui: (() => {
        const ui = host.createTestUI() as Record<string, unknown>
        ui.IconButton = (props: {
          label: string
          onClick?: (event: MouseEvent) => void
          disabled?: boolean
        }) => {
          const button = browserDocument.createElement("button")
          button.type = "button"
          button.textContent = props.label
          button.setAttribute("aria-label", props.label)
          button.addEventListener("click", (click) => props.onClick?.(click as MouseEvent))
          if (props.disabled) button.disabled = true
          return button
        }
        ui.Markdown = (props: { text: string }) => {
          const linkMatch = /^\[([^\]]+)\]\((\.lazers\/tasks\/[^)]+)\)$/u.exec(props.text)
          if (linkMatch) {
            const anchor = browserDocument.createElement("a")
            anchor.href = linkMatch[2]!
            anchor.textContent = linkMatch[1]!
            anchor.addEventListener("click", (click) => {
              click.preventDefault()
              const link = { href: linkMatch[2]!, session }
              if (taskLinkHandler.value?.match(link)) taskLinkHandler.value.open(link)
            })
            return anchor
          }
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
        trajectoryView: () => trajectoryStore,
      },
      links: { open: () => {} },
      system: { copy: async () => {} },
      servers: {
        get: (serverID: string) =>
          serverID === "tasks-server" ? { connected: true, client } : undefined,
      },
    }
    disposeSetup = host.setupGui(host.gui, context)
    const tokens = host.registryTokens
    taskLinkHandler.value = registrations.find((entry) => entry.token === host.LinkHandler)
      ?.value as
      | {
          match(link: { href: string; session: unknown }): boolean
          exists(link: { href: string; session: unknown }): Promise<boolean>
          open(link: { href: string; session: unknown }): void
        }
      | undefined
    expect(taskLinkHandler.value).toBeDefined()
    const panel = host.taskPanelRegistration(registrations)
    expect(panel).toBeDefined()
    expect(panel?.id).toBe("tasks")
    expect(panel?.list({ open: ["tasks"] })).toMatchObject([
      { id: "tasks", title: "Tasks", closable: "hover" },
    ])
    const tasksCSS = registrations.find(
      (entry) =>
        entry.token === tokens.Style &&
        typeof entry.value === "string" &&
        entry.value.includes(".lazers-tasks {"),
    )?.value as string | undefined
    expect(tasksCSS).toContain(
      '.lazers-tasks-state, .lazers-tasks-inspector-icon)[data-tone="waiting"]',
    )
    expect(tasksCSS).not.toContain(".lazers-tasks-badge")
    expect(tasksCSS).toContain("container: lazers-tasks / inline-size")
    expect(tasksCSS).toContain(".lazers-tasks-activity-indicator")
    expect(tasksCSS).toContain("overflow-wrap: anywhere")
    const style = browserDocument.createElement("style")
    style.textContent = tasksCSS ?? ""
    browserDocument.head.append(style)

    const container = browserDocument.createElement("main")
    container.style.width = "360px"
    browserDocument.body.append(container)
    const sourceSelections: unknown[] = []
    mounted = host.mountTaskPanel(panel!, context, session, container, {
      file: {
        sync: async () => {},
        get: () => ({
          content: { type: "text", content: "# Roadmap\n\n## Recovery\nFix the flow" },
        }),
        selection: { set: (...args: unknown[]) => sourceSelections.push(args) },
      },
    })
    const row = (taskID: string) =>
      container.querySelector<HTMLElement>(`[data-task-id="${taskID}"]`)
    const chooseAction = (label: string) => {
      const trigger = container.querySelector<HTMLButtonElement>(
        'button[aria-haspopup=menu][aria-label="More task actions"]',
      )!
      trigger.click()
      const item = [...container.querySelectorAll<HTMLButtonElement>("[role=menuitem]")].find(
        (button) => button.textContent === label,
      )
      expect(item).toBeDefined()
      item!.click()
    }
    const key = (element: HTMLElement, value: string) =>
      element.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", { key: value, bubbles: true }) as unknown as Event,
      )
    const activityDetails = () =>
      container.querySelector<HTMLDetailsElement>(".lazers-tasks-activity-details")!
    const toggleActivityDetailsFromKeyboard = (key: "Enter" | " ") => {
      const summary = activityDetails().querySelector("summary")!
      summary.focus()
      expect(summary.ownerDocument.activeElement).toBe(summary)
      summary.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", { key, bubbles: true }) as unknown as Event,
      )
      // Happy DOM does not synthesize the browser's native summary keyboard click.
      summary.click()
    }
    await until(() =>
      Boolean(
        row(ids.held)
          ?.getAttribute("aria-label")
          ?.includes("observed foreground activity inactive"),
      ),
    )
    await until(() => Boolean(activityDetails()))
    const heldRow = row(ids.held)!
    const activeRow = row(ids.active)!
    const unknownRow = row(ids.unknown)!
    expect(heldRow.getAttribute("aria-label")).toContain("recorded lifecycle running")
    expect(heldRow.getAttribute("aria-label")).toContain("observed foreground activity inactive")
    expect(heldRow.getAttribute("aria-label")).toContain("latest worker session ses-worker-held")
    expect(heldRow.getAttribute("aria-label")).toContain("waiting: Reconciliation hold")
    expect(heldRow.getAttribute("aria-label")).toContain("Additional hold: retain the audit trail")
    expect(heldRow.querySelector(".lazers-tasks-state")?.getAttribute("data-waiting")).toBe("true")
    expect(heldRow.querySelector(".lazers-tasks-state")?.getAttribute("data-tone")).toBe("waiting")
    // One tree item per task, one visual line each: no stacked meta, hold or dependency lines.
    expect(container.querySelector('[role="tree"]')).not.toBeNull()
    expect(heldRow.getAttribute("role")).toBe("treeitem")
    // Every task is a top-level tree item; there are no plan headings.
    expect(heldRow.getAttribute("aria-level")).toBe("1")
    expect(heldRow.querySelectorAll(":scope > *")).toHaveLength(1)
    expect(container.querySelector(".lazers-tasks-row-dependencies")).toBeNull()
    expect(container.querySelector(".lazers-tasks-row-hold")).toBeNull()
    expect(heldRow.querySelector(".lazers-tasks-row-reference")?.textContent).toBe("LZ-1")
    expect(heldRow.querySelector(".lazers-tasks-row-title")?.textContent).toBe(taskNames.held)
    // Row status is icons only: the themed state icon names the state with the source reason on
    // hover, and the link icon opens the blocker. No status word appears at any width.
    const tooltip = (element: Element | null | undefined) =>
      element?.closest<HTMLElement>(".fixture-tooltip")?.dataset.tooltip
    const rowPart = (taskID: string, part: string) =>
      row(taskID)?.querySelector<HTMLElement>(`:scope > .lazers-tasks-row ${part}`)
    const heldState = rowPart(ids.held, ".lazers-tasks-state")!
    expect(heldState.getAttribute("role")).toBe("img")
    expect(heldState.getAttribute("aria-label")).toBe("Waiting")
    expect(tooltip(heldState)).toStartWith("Waiting · ")
    expect(tooltip(heldState)).toContain("Reconciliation hold: awaiting review")
    expect(tooltip(heldState)).toContain("Additional hold: retain the audit trail")
    expect(container.querySelector(".lazers-tasks-badge")).toBeNull()
    expect(
      heldRow.querySelectorAll(":scope > .lazers-tasks-row .lazers-tasks-row-blocker"),
    ).toHaveLength(1)
    const heldBlocker = heldRow.querySelector<HTMLButtonElement>(".lazers-tasks-row-blocker")!
    expect(heldBlocker.textContent).toBe("link")
    // LZ-8 is on a later query page until the list's end comes into range and that page loads on
    // its own; once listed, the link names its state and takes its tone.
    await until(() => heldBlocker.getAttribute("aria-label") === "Open blocker LZ-8, waiting")
    expect(tooltip(heldBlocker)).toBe("Waiting on LZ-8 · Waiting")
    expect(heldBlocker.dataset.tone).toBeUndefined()
    // Not a tab stop: the tree keeps one roving stop and the inspector lists blockers by keyboard.
    expect(heldBlocker.tabIndex).toBe(-1)
    expect(getComputedStyle(heldBlocker).flexShrink).toBe("0")
    // The title is the one element that yields width, and the row stays one line.
    const heldTitle = rowPart(ids.held, ".lazers-tasks-row-title")!
    expect(getComputedStyle(heldTitle).flexGrow).toBe("1")
    expect(getComputedStyle(heldTitle).minWidth).toBe("0")
    expect(getComputedStyle(heldTitle).whiteSpace).toBe("nowrap")
    expect(getComputedStyle(heldTitle).textOverflow).toBe("ellipsis")
    // Icons only at every width: no container query swaps a word in or out of the row.
    expect(tasksCSS).not.toContain("@container lazers-tasks (max-width")
    expect(tasksCSS).not.toContain(".lazers-tasks-row-blocker-name")
    expect(heldRow.getAttribute("aria-label")).toContain("waiting on LZ-8 (queued)")
    // Row icons add no tab stops: the tree keeps exactly one roving stop, on a tree item. Plan
    // headings are tree items reached by arrow keys, not extra stops.
    const tree = container.querySelector<HTMLElement>('[role="tree"]')!
    const tabStops = [
      ...tree.querySelectorAll<HTMLElement>("button, a[href], input, [tabindex]"),
    ].filter((element) => element.tabIndex >= 0)
    expect(tabStops).toHaveLength(1)
    expect(tabStops[0]!.getAttribute("role")).toBe("treeitem")
    expect(tree.querySelectorAll(".lazers-tasks-state[tabindex]")).toHaveLength(0)
    heldBlocker.click()
    await until(() => row(ids.queuedFive)?.getAttribute("aria-selected") === "true")
    expect(heldRow.textContent).not.toContain("Additional hold: retain the audit trail")
    expect(heldRow.textContent).not.toContain("Worker archived")
    heldRow.focus()
    expect(heldRow.ownerDocument.activeElement).toBe(heldRow)
    key(heldRow, "Enter")
    await until(() => row(ids.held)?.getAttribute("aria-selected") === "true")
    // The keyboard path to the same blocker is the inspector's focusable Waiting on reference.
    await until(
      () =>
        container.querySelector(".lazers-tasks-detail .lazers-tasks-dependencies-visible") !== null,
    )
    const inspectorBlocker = container.querySelector<HTMLElement>(
      ".lazers-tasks-detail .lazers-tasks-dependencies-visible :is(a[href], button)",
    )!
    expect(inspectorBlocker.textContent).toBe("LZ-8")
    expect(inspectorBlocker.tabIndex).toBe(0)
    await until(() =>
      Boolean(container.querySelector(".lazers-tasks-current-activity")?.textContent),
    )
    expect(container.querySelector(".lazers-tasks-current-activity")?.textContent).toContain(
      "Worker archived",
    )
    chooseAction("Open source plan")
    await until(() => sourceSelections.length === 1)
    expect(sourceSelections[0]).toEqual(["design/roadmap.md", { start: 3, end: 3 }])
    expect(opened.at(-1)?.[0]).toBe("file:design/roadmap.md")
    opened.length = 0
    expect(activeRow.closest(".lazers-tasks-entry")!.textContent).not.toContain("roadmap.md")
    expect(container.querySelector(".lazers-tasks-current-activity")?.textContent).toContain(
      "Worker outcome succeeded",
    )
    expect(activeRow.getAttribute("aria-label")).toContain("observed foreground activity active")
    expect(activeRow.getAttribute("aria-label")).toContain("waiting: Reconciliation hold")
    expect(activeRow.getAttribute("aria-label")).toContain("Input pending · Approval pending")
    // Native attention outranks the hold in the row's icon; the hold stays in the inspector.
    expect(rowPart(ids.active, ".lazers-tasks-state")?.getAttribute("data-tone")).toBe("attention")
    // Attention is the row's own state icon; there is no separate Now or Attention section.
    expect(container.querySelector("[data-scheduling-group]")).toBeNull()
    expect(rowPart(ids.active, ".lazers-tasks-state")?.getAttribute("aria-label")).toBe("Input")
    expect(tooltip(rowPart(ids.active, ".lazers-tasks-state"))).toBe(
      "Input · Input pending · Approval pending",
    )
    expect(unknownRow.getAttribute("aria-label")).not.toContain("observed foreground activity")
    expect(unknownRow.getAttribute("aria-label")).toContain("waiting: Reconciliation hold")
    expect(unknownRow.getAttribute("aria-label")).toContain("activity observation unavailable")
    expect(rowPart(ids.unknown, ".lazers-tasks-state")?.getAttribute("aria-label")).toBe("Waiting")
    expect(tooltip(rowPart(ids.unknown, ".lazers-tasks-state"))).toContain(
      "Additional hold: retain the audit trail",
    )
    expect(unknownRow.querySelector(".lazers-tasks-row-blocker")).toBeNull()
    expect(container.querySelector(".lazers-tasks-plan-heading")).toBeNull()
    expect(container.querySelector(".lazers-tasks-inspector-state")?.textContent).toBe("Waiting")
    const inspectorPane = container.querySelector<HTMLDivElement>(".lazers-tasks-detail")!
    const inspectorText = inspectorPane.textContent ?? ""
    expect(inspectorPane.querySelector(".lazers-tasks-title")?.textContent).toBe(taskNames.held)
    // A one-sentence objective is the title; the goal is not repeated beneath it.
    expect(inspectorPane.querySelector(".lazers-tasks-objective")).toBeNull()
    // The reference, state and title live in the pane's sticky header line, not the scrolling body.
    const paneHeader = container.querySelector(".lazers-details-header")!
    expect(paneHeader.textContent).toContain("LZ-1")
    expect(paneHeader.textContent).toContain(taskNames.held)
    expect(inspectorPane.contains(paneHeader)).toBe(false)
    expect(inspectorText.indexOf(taskNames.held)).toBeLessThan(inspectorText.indexOf("Waiting on"))
    expect(inspectorText.indexOf(taskNames.held)).toBeLessThan(inspectorText.indexOf("Done when"))
    expect(inspectorPane.querySelectorAll(".lazers-tasks-assertions li").length).toBe(
      Math.min(3, proposal.acceptance.length),
    )
    // The reason is a callout: a user sentence first, the runtime's own text behind Details.
    const callout = inspectorPane.querySelector<HTMLElement>(".lazers-callout")!
    expect(callout.querySelector(".lazers-callout-icon")).not.toBeNull()
    const calloutText = callout.querySelector(".lazers-callout-text")!.textContent ?? ""
    expect(calloutText).not.toContain("Reconciliation hold")
    expect(calloutText).toMatch(/\.\s*Details$/)
    const rawReason = callout.querySelector<HTMLElement>(".lazers-callout-raw")!
    expect(rawReason.textContent).toContain("Reconciliation hold")
    expect(rawReason.hasAttribute("hidden")).toBe(true)
    const detailsLink = callout.querySelector<HTMLButtonElement>(".lazers-callout-toggle")!
    detailsLink.click()
    await until(() => !rawReason.hasAttribute("hidden"))
    expect(detailsLink.getAttribute("aria-expanded")).toBe("true")
    detailsLink.click()
    await until(() => rawReason.hasAttribute("hidden"))
    // Two disclosures only, each a full-width row; the activity count sits at the right.
    const disclosureLabels = [
      ...inspectorPane.querySelectorAll(":scope > details > summary .lazers-tasks-section-label"),
    ].map((label) => label.textContent)
    expect(disclosureLabels).toEqual(["Details", "Activity"])
    expect(inspectorPane.querySelectorAll(":scope > details")).toHaveLength(2)
    expect(inspectorText).not.toContain("Activity and holds")
    // Done when: every item is one grid row of a 16px checkbox and its text, spaced uniformly.
    const doneItems = [...inspectorPane.querySelectorAll(".lazers-tasks-assertions li")]
    expect(doneItems.length).toBeGreaterThan(0)
    for (const item of doneItems) {
      expect(item.children).toHaveLength(2)
      expect(item.children[0]!.classList.contains("lazers-tasks-check")).toBe(true)
      expect(item.children[1]!.classList.contains("lazers-tasks-assertion-text")).toBe(true)
    }
    expect((tasksCSS ?? "").match(/^\.lazers-tasks-assertions \{[^}]*\}/m)![0]).toContain(
      "gap: 10px",
    )
    expect((tasksCSS ?? "").match(/\.lazers-tasks-check \{[^}]*\}/)![0]).toMatch(
      /width: 16px;[^}]*height: 16px/,
    )
    // No per-item padding or markdown margin can stack into an uneven band.
    const itemRule = (tasksCSS ?? "").match(/\.lazers-tasks-assertions li \{[^}]*\}/)![0]
    expect(itemRule).toContain("padding: 0;")
    expect((tasksCSS ?? "").match(/\.lazers-tasks-assertion-text p \{[^}]*\}/)![0]).toContain(
      "margin: 0;",
    )
    // Running work leads with Trajectory; Radar, plan and link stay in the overflow menu.
    const barActions = container.querySelector(".lazers-details-actions")!
    expect(
      [...barActions.querySelectorAll<HTMLButtonElement>("button")].some(
        (button) => button.textContent === "Open in Trajectory",
      ),
    ).toBe(true)
    expect(
      [...barActions.querySelectorAll("button")].some(
        (button) => button.textContent === "Open in Radar",
      ),
    ).toBe(false)
    barActions
      .querySelector<HTMLButtonElement>(
        'button[aria-haspopup=menu][aria-label="More task actions"]',
      )!
      .click()
    const radarAction = [...container.querySelectorAll<HTMLButtonElement>("[role=menuitem]")].find(
      (button) => button.textContent === "Open in Radar",
    )!
    opened.length = 0
    radarAction.click()
    expect(opened.at(-1)?.[0]).toBe("lazers:radar")
    opened.length = 0
    const waitingDependencies = container.querySelector<HTMLDivElement>(
      ".lazers-tasks-dependencies-visible",
    )!
    await until(() => waitingDependencies.textContent?.includes("LZ-8") ?? false)
    expect(waitingDependencies.textContent).toContain("Waiting on")
    expect(waitingDependencies.textContent).toContain("LZ-8")
    const waitingLink = waitingDependencies.querySelector<HTMLAnchorElement>("a")!
    expect(waitingLink.textContent).toBe("LZ-8")
    expect(waitingLink.getAttribute("href")).toContain(".lazers/tasks/")
    expect(getComputedStyle(waitingDependencies).flexWrap).toBe("wrap")
    waitingLink.focus()
    expect(waitingLink.ownerDocument.activeElement).toBe(waitingLink)
    expect(inspectorText.indexOf("Waiting on")).toBeLessThan(inspectorText.indexOf("Done when"))
    expect(activityDetails().open).toBe(false)
    expect(inspectorText.indexOf("Done when")).toBeLessThan(inspectorText.indexOf("Activity"))
    expect(activityDetails().open).toBe(false)
    const waitingLinkTarget = { href: waitingLink.getAttribute("href")!, session }
    expect(await taskLinkHandler.value!.exists(waitingLinkTarget)).toBe(true)

    waitingLink.click()
    await until(() => opened.length > 0)
    const taskView = taskStore.value as {
      projects: Record<string, { scope?: string; selectedID?: string }>
    }
    expect(taskView.projects[projectDirectory]).toMatchObject({
      selectedID: ids.queuedFive,
      scope: "project",
    })
    await until(() => row(ids.queuedFive)?.getAttribute("aria-selected") === "true")
    expect(taskView.projects[projectDirectory]?.scope).toBe("project")
    expect(opened).toHaveLength(1)
    opened.length = 0
    row(ids.held)!.click()
    await until(() => row(ids.held)?.getAttribute("aria-selected") === "true")

    toggleActivityDetailsFromKeyboard("Enter")
    await until(() => activityDetails().open)
    let diagnosticText = activityDetails().textContent ?? ""
    expect(diagnosticText).toContain("Recorded running")
    expect(diagnosticText).toContain("Worker archived")
    expect(diagnosticText).toContain("ses-worker-held")
    expect(diagnosticText).toContain("Worker outcome succeeded")
    expect(diagnosticText).toContain("Reconciliation hold: awaiting review")
    expect(diagnosticText).toContain("Additional hold: retain the audit trail")
    toggleActivityDetailsFromKeyboard("Enter")
    await until(() => !activityDetails().open)

    const heldRowAfterNavigation = row(ids.held)!
    heldRowAfterNavigation.focus()
    heldRowAfterNavigation.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
      }) as unknown as Event,
    )
    await until(() => row(ids.active)?.getAttribute("aria-selected") === "true")
    const activeRowAfterNavigation = row(ids.active)!
    activeRowAfterNavigation.click()
    await until(
      () =>
        container
          .querySelector(".lazers-tasks-current-activity")
          ?.textContent?.includes("Worker active") ?? false,
    )
    expect(container.querySelector(".lazers-tasks-current-activity")?.textContent).toContain(
      "ses-worker-active",
    )
    expect(container.querySelector(".lazers-tasks-current-activity")?.textContent).toContain(
      "Latest worker",
    )
    expect(activityDetails().open).toBe(false)
    expect(
      container.querySelector(".lazers-tasks-inspector-state")?.getAttribute("aria-label"),
    ).toContain("Waiting; recorded lifecycle running")
    toggleActivityDetailsFromKeyboard(" ")
    await until(() => activityDetails().open)
    diagnosticText = activityDetails().textContent ?? ""
    expect(diagnosticText).toContain("Recorded running")
    expect(diagnosticText).toContain("Worker active")
    expect(diagnosticText).toContain("ses-worker-active")
    expect(diagnosticText).toContain("Input pending")
    expect(diagnosticText).toContain("Approval pending")
    expect(diagnosticText).toContain("Additional hold: retain the audit trail")
    toggleActivityDetailsFromKeyboard(" ")
    await until(() => !activityDetails().open)
    ;[...container.querySelectorAll<HTMLButtonElement>(".lazers-details-actions button")]
      .find((button) => button.textContent === "Open in Trajectory")!
      .click()
    expect(opened).toHaveLength(1)
    expect(
      (trajectoryStore.value as { projects: Record<string, { selectedTaskID?: string }> }).projects[
        projectDirectory
      ]?.selectedTaskID,
    ).toBe(ids.active)

    activeRowAfterNavigation.focus()
    activeRowAfterNavigation.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
      }) as unknown as Event,
    )
    await until(() => row(ids.unknown)?.getAttribute("aria-selected") === "true")
    expect(activityDetails().open).toBe(false)
    toggleActivityDetailsFromKeyboard("Enter")
    await until(() => activityDetails().open)
    diagnosticText = activityDetails().textContent ?? ""
    expect(diagnosticText).toContain("Recorded running")
    expect(diagnosticText).not.toContain("Worker unknown")
    expect(diagnosticText).toContain("Observation unavailable")
    expect(diagnosticText).toContain("ses-worker-unknown")
    expect(diagnosticText).toContain("Additional hold: retain the audit trail")
    toggleActivityDetailsFromKeyboard("Enter")
    await until(() => !activityDetails().open)

    // A task with dependencies is a collapsed accordion; its dependency tree opens beneath it.
    const branchRow = row(ids.branchA)!
    expect(row(ids.forkRoot)?.hasAttribute("aria-expanded")).toBe(false)
    expect(row(ids.forkRoot)?.querySelector(".lazers-tasks-sequence")).toBeNull()
    expect(branchRow.getAttribute("aria-expanded")).toBe("false")
    expect(branchRow.getAttribute("aria-level")).toBe("1")
    const dependencyKey = `task:${ids.branchA}>${ids.forkRoot}`
    const dependencyRow = () =>
      container.querySelector<HTMLElement>(`[data-item-key="${dependencyKey}"]`)
    expect(dependencyRow()).toBeNull()
    branchRow.focus()
    key(branchRow, "ArrowRight")
    await until(() => row(ids.branchA)?.getAttribute("aria-expanded") === "true")
    expect(dependencyRow()!.getAttribute("data-depth")).toBe("1")
    expect(dependencyRow()!.getAttribute("aria-level")).toBe("2")
    expect(dependencyRow()!.getAttribute("aria-setsize")).toBe("1")
    key(row(ids.branchA)!, "ArrowRight")
    await until(() => dependencyRow()?.getAttribute("aria-selected") === "true")
    expect(dependencyRow()!.ownerDocument.activeElement).toBe(dependencyRow())
    key(dependencyRow()!, "ArrowLeft")
    await until(() => row(ids.branchA)?.getAttribute("aria-selected") === "true")
    key(row(ids.branchA)!, "ArrowLeft")
    await until(() => row(ids.branchA)?.getAttribute("aria-expanded") === "false")
    expect(dependencyRow()).toBeNull()
    row(ids.unknown)!.click()
    await until(() => row(ids.unknown)?.getAttribute("aria-selected") === "true")
    // Scroll restoration applies once the reselected detail mounts; scroll only after that.
    await until(
      () => container.querySelector(".lazers-tasks-title")?.textContent === taskNames.unknown,
    )
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    const list = container.querySelector<HTMLDivElement>(".lazers-tasks-list")!
    const detailPane = container.querySelector<HTMLDivElement>(".lazers-tasks-detail")!
    list.scrollTop = 37
    list.dispatchEvent(new dom.window.Event("scroll") as unknown as Event)
    detailPane.scrollTop = 23
    detailPane.dispatchEvent(new dom.window.Event("scroll") as unknown as Event)
    const readsBeforeRefresh = queryCalls.length
    snapshot++
    eventSubscriber?.({
      type: "rpc.lazers.tasks.changed",
      data: { projectDirectory, version: snapshot },
    })
    await until(
      () =>
        queryCalls.length > readsBeforeRefresh &&
        row(ids.unknown)?.getAttribute("aria-selected") === "true",
    )
    expect(list.scrollTop).toBe(37)
    expect(detailPane.scrollTop).toBe(23)

    // The pane persists `open` and `size` in the stored view; Up grows the body by 5 %.
    const separator = container.querySelector<HTMLDivElement>(".lazers-details-resize")!
    const view = () =>
      (taskStore.value as { projects: Record<string, { open?: boolean; size?: number }> }).projects[
        projectDirectory
      ]
    expect(view()?.open).toBe(true)
    expect(separator.getAttribute("aria-controls")).toBe(detailPane.id)
    key(separator, "ArrowUp")
    await until(() => view()?.size !== undefined)
    expect(view()?.size).toBeCloseTo(0.5)
    key(separator, "Enter")
    await until(() => view()?.open === false)
    expect(container.querySelector(".lazers-tasks-detail")).toBeNull()
    expect(container.querySelector(".lazers-details-header")?.textContent).toContain("LZ-")
    key(separator, "Enter")
    await until(() => view()?.open === true)

    const chooseFilter = async (label: string) => {
      const trigger = container.querySelector<HTMLButtonElement>(
        ".lazers-tasks-state-filter button[aria-haspopup=menu]",
      )!
      trigger.click()
      const item = [...container.querySelectorAll<HTMLButtonElement>("[role=menuitem]")].find(
        (button) => button.textContent === label,
      )!
      item.click()
    }
    await chooseFilter("Queued")
    await until(() => queryCalls.at(-1)?.state === "queued" && Boolean(row(ids.queuedOne)))
    // There is no Load more control: the end of the list is in range, so pages two and three
    // request themselves, once each, with their own cursors.
    await until(
      () => queryCalls.at(-1)?.cursor === "queued-page-three" && Boolean(row(ids.queuedFour)),
    )
    expect(row(ids.queuedTwo)).not.toBeNull()
    expect(row(ids.queuedThree)).not.toBeNull()
    const queuedCursors = queryCalls
      .filter((call) => call.state === "queued")
      .map((call) => call.cursor)
    expect(queuedCursors).toEqual([undefined, "queued-page-two", "queued-page-three"])
    expect(
      [...container.querySelectorAll<HTMLButtonElement>("button")].some(
        (button) => button.textContent === "Load more",
      ),
    ).toBe(false)
    // The last page leaves no loader behind.
    await until(() => !container.textContent?.includes("Loading more tasks"))

    await chooseFilter("Running")
    await until(() => queryCalls.at(-1)?.state === "running" && Boolean(row(ids.held)))
    expect(row(ids.held)?.getAttribute("aria-label")).toContain(
      "observed foreground activity inactive",
    )
    await chooseFilter("Blocked / waiting")
    await until(() => queryCalls.at(-1)?.state === "blocked" && Boolean(row(ids.active)))
    expect(container.textContent).not.toContain("Node or plan holds may overlap")

    await chooseFilter("Accepted")
    await until(() => queryCalls.at(-1)?.state === "accepted" && Boolean(row(ids.completed)))
    expect(row(ids.completed)?.getAttribute("aria-label")).toContain("recorded lifecycle accepted")
    expect(row(ids.completed)?.getAttribute("aria-label")).not.toContain("waiting")
    // The earlier selection is kept (it is not in this list), so the inspector keeps its task until
    // another is chosen.
    row(ids.completed)!.click()
    await until(
      () => container.querySelector(".lazers-tasks-inspector-state")?.textContent === "accepted",
    )
    expect(
      container.querySelector(".lazers-tasks-inspector-state")?.getAttribute("data-waiting"),
    ).toBe("false")
    const taskDetails = [
      ...container.querySelectorAll<HTMLDetailsElement>(".lazers-tasks-section"),
    ].find((details) => details.querySelector("summary")?.textContent?.includes("Details"))!
    taskDetails.open = true
    expect(taskDetails.textContent).toContain("Recorded lifecycle accepted")
    expect(taskDetails.textContent).toContain("Plan status blocked")
    expect(
      queryCalls.some((call) => call.state === "queued" && call.cursor === "queued-page-three"),
    ).toBe(true)

    row(ids.completed)!.click()
    await until(() => row(ids.completed)?.getAttribute("aria-selected") === "true")
    topologyFails = true
    snapshot++
    eventSubscriber?.({
      type: "rpc.lazers.tasks.changed",
      data: { projectDirectory, version: snapshot },
    })
    await until(() =>
      container.textContent?.includes("Execution links unavailable: transient topology failure"),
    )
    expect(row(ids.completed)).not.toBeNull()
    expect(row(ids.completed)?.getAttribute("aria-selected")).toBe("true")
    expect(container.querySelectorAll("[data-task-id]").length).toBeGreaterThanOrEqual(1)
    expect(queryCalls.at(-1)?.state).toBe("accepted")
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
