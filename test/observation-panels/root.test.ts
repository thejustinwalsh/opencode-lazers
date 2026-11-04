import { expect, test } from "bun:test"
import { Window } from "happy-dom"
import solid from "vite-plugin-solid"
import { build } from "vite"
import { mkdir, rm } from "node:fs/promises"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
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
import {
  CONFIG_ONE,
  CONFIG_SINGLE,
  CONFIG_ZERO,
  decisionInspect as fixtureDecisionInspect,
  decisionOverview as fixtureDecisionOverview,
  decisionRow as fixtureDecisionRow,
  decisionRows as fixtureDecisionRows,
  singleEstimate,
} from "../models-decision/fixtures/decision.ts"
import type {
  ModelDecisionConfiguration,
  ModelDecisionEstimate,
  ModelDecisionFilters,
  ModelDecisionInspect,
  ModelDecisionRow,
} from "../../src/models/decision-contract.ts"
import {
  ModelDecisionConfigurationsOutputSchema,
  ModelDecisionInspectOutputSchema,
  ModelDecisionOverviewOutputSchema,
  ModelDecisionRowsOutputSchema,
} from "../../src/models/decision-contract.ts"

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

function menuItemWithText(container: ParentNode, text: string) {
  return [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((button) =>
    button.textContent?.includes(text),
  )
}

const sourceHighDecisionRow = fixtureDecisionRows().rows[0]!
const highDecisionRow: ModelDecisionRow = {
  ...sourceHighDecisionRow,
  cohort: {
    ...sourceHighDecisionRow.cohort,
    acceptedTaskCount: sourceHighDecisionRow.efficiency.observationCount,
  },
}
const highConfiguration = highDecisionRow.configuration
const lowConfiguration: ModelDecisionConfiguration = {
  ...highConfiguration,
  configurationID: "configuration:openai/gpt-6::low:opaque/2",
  label: "GPT-6 · low",
  route: { ...highConfiguration.route, variant: "low" },
}
const qwenConfiguration: ModelDecisionConfiguration = {
  ...highConfiguration,
  configurationID: CONFIG_SINGLE,
  groupID: "group:qwen/qwen-7",
  label: "Qwen 7",
  route: { providerID: "qwen", modelID: "qwen-7", variant: null },
  currentPrice: { ...highConfiguration.currentPrice, sourceRecordID: "qwen/qwen-7" },
}
const zeroConfiguration = fixtureDecisionRow(
  {
    status: "zero-accepted",
    tokensPerAcceptedTask: null,
    currentMarketUSDPerAcceptedTask: null,
    observationCount: 7,
  },
  CONFIG_ZERO,
).configuration
const lowDecisionRow: ModelDecisionRow = {
  ...highDecisionRow,
  configuration: lowConfiguration,
  efficiency: {
    status: "available",
    tokensPerAcceptedTask: 18_500,
    currentMarketUSDPerAcceptedTask: 0.185,
    observationCount: 4,
  },
}
const qwenDecisionRow: ModelDecisionRow = {
  ...highDecisionRow,
  configuration: qwenConfiguration,
  efficiency: {
    status: "single-observation",
    tokensPerAcceptedTask: 20_000,
    currentMarketUSDPerAcceptedTask: 0.08,
    observationCount: 1,
  },
  cohort: { ...highDecisionRow.cohort, acceptedTaskCount: 1 },
}
const zeroDecisionRow: ModelDecisionRow = {
  ...fixtureDecisionRow(
    {
      status: "zero-accepted",
      tokensPerAcceptedTask: null,
      currentMarketUSDPerAcceptedTask: null,
      observationCount: 7,
    },
    CONFIG_ZERO,
  ),
  configuration: zeroConfiguration,
}

function decisionContextFor(
  filters: ModelDecisionFilters,
  directory: string,
  snapshotID: string,
  revision = 0,
) {
  return {
    ...fixtureDecisionOverview().context,
    snapshotID,
    producedAt: `2026-11-03T12:0${revision % 10}:00.000Z`,
    scope: { projectDirectory: directory },
    filters,
    availability: "ready" as const,
    freshness: "current" as const,
    unavailableReason: null,
  }
}

function decisionPointDelta(snapshotNumber: number, filters: ModelDecisionFilters) {
  return snapshotNumber * 125 + (filters.taskKind ? 1_000 : 0) + (filters.persona ? 250 : 0)
}

function shiftRange(range: { minimum: number; maximum: number } | null, delta: number) {
  return range ? { minimum: range.minimum + delta, maximum: range.maximum + delta } : null
}

function shiftDecisionRow(row: ModelDecisionRow, delta: number): ModelDecisionRow {
  switch (row.efficiency.status) {
    case "available":
    case "single-observation":
      return {
        ...row,
        efficiency: {
          ...row.efficiency,
          tokensPerAcceptedTask: row.efficiency.tokensPerAcceptedTask + delta,
          currentMarketUSDPerAcceptedTask:
            row.efficiency.currentMarketUSDPerAcceptedTask + delta / 100_000,
        },
      }
    case "partial":
      return {
        ...row,
        efficiency: {
          ...row.efficiency,
          tokensPerAcceptedTask:
            row.efficiency.tokensPerAcceptedTask === null
              ? null
              : row.efficiency.tokensPerAcceptedTask + delta,
          currentMarketUSDPerAcceptedTask:
            row.efficiency.currentMarketUSDPerAcceptedTask === null
              ? null
              : row.efficiency.currentMarketUSDPerAcceptedTask + delta / 100_000,
        },
      }
    case "zero-accepted":
    case "unknown":
      return row
  }
}

function shiftEstimate(estimate: ModelDecisionEstimate, delta: number): ModelDecisionEstimate {
  switch (estimate.status) {
    case "available":
    case "single-observation":
      return {
        ...estimate,
        range: {
          tokens: shiftRange(estimate.range.tokens, delta)!,
          currentMarketUSD: shiftRange(estimate.range.currentMarketUSD, delta / 100_000)!,
        },
      }
    case "partial":
      return {
        ...estimate,
        range: {
          tokens: shiftRange(estimate.range.tokens, delta),
          currentMarketUSD: shiftRange(estimate.range.currentMarketUSD, delta / 100_000),
        },
      }
    case "zero-accepted":
    case "unknown":
      return estimate
  }
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
    const decisionSnapshotCounts = new Map<string, number>()
    const decisionSnapshots = new Map<string, string>()
    const decisionDeltas = new Map<string, number>()
    let failNextComparison = false
    let suspendedInspection:
      | {
          configurationID: string
          pending: Deferred<ModelDecisionInspect>
          output?: ModelDecisionInspect
        }
      | undefined
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
          taskKind: null,
          selectedTaskID: TASK_A,
          selectedCandidateID: CANDIDATE_C,
          selectedConfigurationID: CONFIG_ONE,
          split: 56,
          topScroll: 0,
          inspectorScroll: 0,
        },
        [DIRECTORY_B]: {
          tab: "compare",
          persona: "ui",
          taskKind: null,
          selectedTaskID: null,
          selectedCandidateID: null,
          selectedConfigurationID: null,
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
    const decisionKey = (directory: string, filters: ModelDecisionFilters) =>
      `${directory}:${JSON.stringify(filters)}`
    const decisionSnapshot = (directory: string, filters: ModelDecisionFilters) =>
      decisionSnapshots.get(decisionKey(directory, filters)) ?? "decision:missing-overview"
    const decisionContext = (
      directory: string,
      filters: ModelDecisionFilters,
      snapshotID: string,
      revision = 0,
    ) => decisionContextFor(filters, directory, snapshotID, revision)
    const decisionConfigs = new Map<string, ModelDecisionConfiguration>([
      [CONFIG_ONE, highConfiguration],
      [lowConfiguration.configurationID, lowConfiguration],
      [CONFIG_SINGLE, qwenConfiguration],
      [CONFIG_ZERO, zeroConfiguration],
    ])
    const decisionRowsByID = new Map<string, ModelDecisionRow>([
      [CONFIG_ONE, highDecisionRow],
      [lowConfiguration.configurationID, lowDecisionRow],
      [CONFIG_SINGLE, qwenDecisionRow],
      [CONFIG_ZERO, zeroDecisionRow],
    ])
    const deltaForSnapshot = (snapshotID: string) => decisionDeltas.get(snapshotID) ?? 0
    const decisionRowForSnapshot = (configurationID: string, snapshotID: string) =>
      shiftDecisionRow(
        decisionRowsByID.get(configurationID) ?? highDecisionRow,
        deltaForSnapshot(snapshotID),
      )
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
              if (directory === DIRECTORY_A && failNextComparison) {
                failNextComparison = false
                throw new Error("comparison request unavailable")
              }
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
        if (definition.id === "lazers.models.decision.v2")
          return {
            overview: async (
              input: {
                sessionID: string
                scope: { projectDirectory: string }
                filters: ModelDecisionFilters
              },
              options: { location: { directory: string }; signal: AbortSignal },
            ) => {
              const directory = options.location.directory
              const key = decisionKey(directory, input.filters)
              const revision = (decisionSnapshotCounts.get(key) ?? 0) + 1
              decisionSnapshotCounts.set(key, revision)
              const snapshotID = `decision:${directory}:${revision}:${input.filters.persona ?? "all"}:${input.filters.taskKind ?? "all"}`
              decisionSnapshots.set(key, snapshotID)
              const delta = decisionPointDelta(revision, input.filters)
              decisionDeltas.set(snapshotID, delta)
              record(directory, "lazers.models.decision.v2", "overview", input, options.signal)
              const base = fixtureDecisionOverview()
              const points = base.graph.points.map((point) => {
                const row = decisionRowForSnapshot(point.configurationID, snapshotID)
                const tokens = row.efficiency.tokensPerAcceptedTask
                const cost = row.efficiency.currentMarketUSDPerAcceptedTask
                if (tokens === null || cost === null)
                  throw new Error("Fixture graph points need matching measured row coordinates")
                return {
                  ...point,
                  label: row.configuration.label,
                  tokensPerAcceptedTask: tokens,
                  currentMarketUSDPerAcceptedTask: cost,
                  observationCount: row.efficiency.observationCount,
                  acceptedTaskCount: row.cohort.acceptedTaskCount,
                }
              })
              return ModelDecisionOverviewOutputSchema.parse({
                context: decisionContext(directory, input.filters, snapshotID, revision),
                graph: {
                  scope: "global-filtered-snapshot",
                  points,
                  frontierConfigurationIDs: base.graph.frontierConfigurationIDs,
                },
                configurationCount: decisionConfigs.size,
                groupCount: 3,
              })
            },
            rows: async (
              input: {
                sessionID: string
                scope: { projectDirectory: string }
                filters: ModelDecisionFilters
                cursor?: string
                limit: number
              },
              options: { location: { directory: string }; signal: AbortSignal },
            ) => {
              const directory = options.location.directory
              record(directory, "lazers.models.decision.v2", "rows", input, options.signal)
              const snapshotID = decisionSnapshot(directory, input.filters)
              return ModelDecisionRowsOutputSchema.parse({
                context: decisionContext(directory, input.filters, snapshotID),
                rows: (input.cursor
                  ? [qwenDecisionRow, zeroDecisionRow]
                  : [highDecisionRow, lowDecisionRow]
                ).map((row) =>
                  decisionRowForSnapshot(row.configuration.configurationID, snapshotID),
                ),
                totalCount: 4,
                nextCursor: input.cursor ? null : "rows-next",
              })
            },
            configurations: async (
              input: {
                sessionID: string
                scope: { projectDirectory: string }
                filters: ModelDecisionFilters
                cursor?: string
                limit: number
              },
              options: { location: { directory: string }; signal: AbortSignal },
            ) => {
              const directory = options.location.directory
              record(
                directory,
                "lazers.models.decision.v2",
                "configurations",
                input,
                options.signal,
              )
              const snapshotID = decisionSnapshot(directory, input.filters)
              return ModelDecisionConfigurationsOutputSchema.parse({
                context: decisionContext(directory, input.filters, snapshotID),
                configurations: input.cursor
                  ? [qwenConfiguration, zeroConfiguration]
                  : [highConfiguration, lowConfiguration],
                totalCount: decisionConfigs.size,
                nextCursor: input.cursor ? null : "configurations-next",
              })
            },
            inspect: async (
              input: {
                sessionID: string
                scope: { projectDirectory: string }
                filters: ModelDecisionFilters
                snapshotID: string
                configurationID: string
                selectedTaskID: string | null
                contributorCursor?: string
                contributorLimit: number
              },
              options: { location: { directory: string }; signal: AbortSignal },
            ) => {
              const directory = options.location.directory
              record(directory, "lazers.models.decision.v2", "inspect", input, options.signal)
              const configuration = decisionConfigs.get(input.configurationID) ?? {
                ...highConfiguration,
                configurationID: input.configurationID,
                label: "Off-page configuration",
              }
              const row = decisionRowForSnapshot(input.configurationID, input.snapshotID)
              const template = fixtureDecisionInspect()
              if (template.status !== "found") throw new Error("Expected fixture inspection")
              const contributor = template.contributorPage.contributors[0]!
              const estimate =
                input.configurationID === CONFIG_ZERO
                  ? {
                      status: "zero-accepted" as const,
                      basis: "no-successful-task-efficiency" as const,
                      observationCount: 7,
                      range: { tokens: null, currentMarketUSD: null },
                      confidenceInterval: null,
                    }
                  : input.configurationID === CONFIG_SINGLE
                    ? singleEstimate
                    : template.estimate
              const output = ModelDecisionInspectOutputSchema.parse({
                ...template,
                context: decisionContext(
                  directory,
                  input.filters,
                  input.snapshotID,
                  decisionSnapshotCounts.get(decisionKey(directory, input.filters)) ?? 0,
                ),
                configuration,
                cohort: row.cohort,
                efficiency: row.efficiency,
                nativeReportedCost: row.nativeReportedCost,
                selectedTaskID: input.selectedTaskID,
                estimate: shiftEstimate(estimate, deltaForSnapshot(input.snapshotID)),
                contributorPage: input.contributorCursor
                  ? {
                      contributors: [
                        {
                          ...contributor,
                          taskID: TASK_A,
                          taskReference: "LZ-17",
                          attemptID: null,
                          contribution: "accepted" as const,
                        },
                      ],
                      totalCount: 2,
                      nextCursor: null,
                    }
                  : {
                      contributors: [contributor],
                      totalCount: 2,
                      nextCursor: "contributors-next",
                    },
              })
              if (suspendedInspection?.configurationID === input.configurationID) {
                suspendedInspection.output = output
                return suspendedInspection.pending.promise
              }
              return output
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
    const appearanceStore = host.createReactiveStore({
      mode: "dark" as "dark" | "light",
      font: "monospace",
    })
    const context = {
      id: "lazers",
      app: { platform: "web" },
      signal: new AbortController().signal,
      ui: host.createTestUI(),
      appearance: {
        mode: () => appearanceStore.value.mode,
        font: (_kind: "mono") => appearanceStore.value.font,
      },
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
        containerA.querySelector(
          `.lazers-models-decision-row-select[data-configuration-id="${CONFIG_ONE}"]`,
        ) !== null &&
        containerA.querySelector(".lazers-models-comparison-chart") !== null &&
        containerA.textContent?.includes("Refreshing sources") === true,
    )
    await until(
      () =>
        containerA
          .querySelector(".lazers-models-task-select")
          ?.getAttribute("title")
          ?.includes("Objective A initial") === true,
    )
    await until(
      () => containerA.querySelector(".lazers-models-inspector h2")?.textContent === "GPT-6",
    )

    const topPaneA = containerA.querySelector<HTMLElement>(".lazers-models-top")!
    const sourceDetails = topPaneA.querySelector<HTMLDetailsElement>(
      ".lazers-models-sources-details",
    )!
    expect(sourceDetails.open).toBe(false)
    expect(sourceDetails.querySelector(".lazers-models-source")?.closest("details")).toBe(
      sourceDetails,
    )
    const comparePanel = topPaneA.querySelector<HTMLElement>("#lazers-models-compare-panel")!
    const overview = comparePanel.querySelector<HTMLElement>(".lazers-models-overview")!
    expect(sourceDetails.compareDocumentPosition(overview) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    )
    expect(
      comparePanel
        .querySelector(".lazers-models-comparison-chart [role=img]")
        ?.getAttribute("aria-label"),
    ).toContain("GPT-6")
    const chartHost = comparePanel.querySelector<HTMLDivElement>(
      ".lazers-models-comparison-chart > div[role=img]",
    )!
    let chartWidth = 640
    const chartHeight = 280
    Object.defineProperty(chartHost, "clientWidth", { configurable: true, get: () => chartWidth })
    Object.defineProperty(chartHost, "clientHeight", { configurable: true, get: () => chartHeight })
    Object.defineProperty(chartHost, "getBoundingClientRect", {
      configurable: true,
      value: () =>
        ({
          top: 0,
          left: 0,
          right: chartWidth,
          bottom: chartHeight,
          width: chartWidth,
          height: chartHeight,
        }) as DOMRect,
    })
    dom.window.dispatchEvent(new dom.Event("resize"))
    const chartSVG = () => chartHost.querySelector<SVGSVGElement>("svg")
    const chartSVGMarkup = () => chartSVG()?.outerHTML ?? ""
    const settleChart = async () => {
      for (let frame = 0; frame < 4; frame++)
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
      return chartSVGMarkup()
    }
    await until(() => Number.parseFloat(chartSVG()?.getAttribute("width") ?? "0") === chartWidth)
    expect(Number.parseFloat(chartSVG()?.getAttribute("height") ?? "0")).toBe(chartHeight)
    const initialSVGGeometry = await settleChart()
    appearanceStore.update((draft: { mode: "dark" | "light"; font: string }) => {
      draft.font = "Test Mono"
    })
    await until(() => chartSVGMarkup().includes("Test Mono"))
    const themedSVGGeometry = await settleChart()
    expect(themedSVGGeometry).not.toBe(initialSVGGeometry)
    chartHost.style.setProperty("--surface-base", "rgb(1, 2, 3)")
    appearanceStore.update((draft: { mode: "dark" | "light"; font: string }) => {
      draft.mode = "light"
    })
    await until(() => chartSVGMarkup() !== themedSVGGeometry)
    await settleChart()
    chartWidth = 720
    dom.window.dispatchEvent(new dom.Event("resize"))
    await until(() => Number.parseFloat(chartSVG()?.getAttribute("width") ?? "0") === chartWidth)
    expect(Number.parseFloat(chartSVG()?.getAttribute("height") ?? "0")).toBe(chartHeight)
    await settleChart()
    expect(
      comparePanel.querySelectorAll(".lazers-models-decision-row[data-group-id]"),
    ).toHaveLength(1)
    expect(
      [...comparePanel.querySelectorAll(".lazers-models-decision-rows thead th")].map(
        (cell) => cell.textContent,
      ),
    ).toEqual(["Model", "Accepted", "Cost / task"])
    const initialRow = comparePanel.querySelector(".lazers-models-decision-row")!
    expect(initialRow.querySelector("th[scope=row]")?.textContent).toBe("GPT-6")
    expect(initialRow.querySelector("td:nth-child(2)")?.textContent).toBe("9")
    expect(initialRow.querySelector("td:nth-child(3)")?.textContent).toBe("$0.127206")
    expect(initialRow.querySelector("td:nth-child(3)")?.getAttribute("title")).toBe(
      "Current market valuation per accepted task.",
    )
    expect(initialRow.textContent).not.toContain("openai")
    expect(initialRow.textContent).not.toContain("gpt-6")
    expect(initialRow.textContent).not.toContain("Effort")
    expect(initialRow.textContent).not.toContain("efficiency")
    expect(initialRow.textContent).not.toContain("failure")
    expect(initialRow.textContent).not.toContain("failed")
    expect(initialRow.textContent).not.toContain("retry")
    expect(initialRow.textContent).not.toContain("Native reported charges")
    expect(initialRow.querySelectorAll("button")).toHaveLength(1)
    expect(initialRow.querySelector("[role=menu]")).toBeNull()
    expect(comparePanel.querySelector("[data-decision-status]")?.textContent).toContain(
      "Current producer snapshot",
    )
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

    expect(containerA.querySelector(".lazers-models-inspector")?.textContent).toContain(
      "execution accepted",
    )
    expect(containerA.querySelector(".lazers-models-inspector")?.textContent).not.toContain(
      "LZ-17 · submitted",
    )
    expect(modelStore.snapshot().projects[DIRECTORY_A]?.selectedConfigurationID).toBe(CONFIG_ONE)
    expect(
      calls.some(
        (call) =>
          call.service === "lazers.models" &&
          call.method === "comparison" &&
          call.directory === DIRECTORY_A,
      ),
    ).toBe(true)

    const decisionInputs = calls
      .filter((call) => call.service === "lazers.models.decision.v2")
      .map((call) => call.input as { filters?: ModelDecisionFilters })
    expect(decisionInputs.every((input) => input.filters?.persona === "ui")).toBe(true)

    const chartDescription = () =>
      containerA.querySelector(".lazers-models-comparison-chart > p")?.textContent ?? ""
    const globalGraphDescription = chartDescription()
    const globalGraphSVG = chartSVGMarkup()
    const initialChartButtons = [
      ...containerA.querySelectorAll<HTMLButtonElement>(
        ".lazers-models-comparison-chart-data [data-configuration-id]",
      ),
    ]
    expect(initialChartButtons.map((button) => button.dataset.configurationId)).toEqual([
      CONFIG_ONE,
      CONFIG_SINGLE,
    ])
    expect(
      initialChartButtons.some((button) => button.dataset.configurationId === CONFIG_ZERO),
    ).toBe(false)
    expect(containerA.querySelector(`[data-group-id="group:qwen/qwen-7"]`)).toBeNull()

    const qwenPoint = containerA.querySelector<HTMLButtonElement>(
      `.lazers-models-comparison-chart-data [data-configuration-id="${CONFIG_SINGLE}"]`,
    )!
    const beforePointSelectionSVG = globalGraphSVG
    qwenPoint.click()
    await until(
      () => containerA.querySelector(".lazers-models-inspector h2")?.textContent === "Qwen 7",
    )
    await until(() => qwenPoint.getAttribute("aria-pressed") === "true")
    await until(() => chartSVGMarkup() !== beforePointSelectionSVG)
    const selectedQwenGraphSVG = await settleChart()
    const currentFilters = (
      calls.filter((call) => call.method === "overview").at(-1)?.input as {
        filters: ModelDecisionFilters
      }
    ).filters
    const currentSnapshotID = decisionSnapshots.get(decisionKey(DIRECTORY_A, currentFilters))
    await until(() =>
      calls.some((call) => {
        if (call.service !== "lazers.models.decision.v2" || call.method !== "inspect") return false
        return (
          (
            call.input as {
              configurationID?: string
              selectedTaskID?: string | null
              snapshotID?: string
            }
          ).configurationID === CONFIG_SINGLE &&
          (call.input as { selectedTaskID?: string | null }).selectedTaskID === TASK_A &&
          (call.input as { snapshotID?: string }).snapshotID === currentSnapshotID
        )
      }),
    )
    for (const method of ["overview", "rows", "configurations", "inspect"])
      expect(
        calls.some(
          (call) =>
            call.directory === DIRECTORY_A &&
            call.service === "lazers.models.decision.v2" &&
            call.method === method,
        ),
      ).toBe(true)
    expect(modelStore.snapshot().projects[DIRECTORY_A]?.selectedConfigurationID).toBe(CONFIG_SINGLE)
    expect(qwenPoint.getAttribute("aria-pressed")).toBe("true")
    const qwenInspectionInput = calls
      .filter((call) => call.method === "inspect")
      .map(
        (call) =>
          call.input as {
            configurationID?: string
            selectedTaskID?: string | null
            snapshotID?: string
          },
      )
      .find(
        (input) =>
          input.configurationID === CONFIG_SINGLE && input.snapshotID === currentSnapshotID,
      )
    expect(qwenInspectionInput).toMatchObject({
      configurationID: CONFIG_SINGLE,
      selectedTaskID: TASK_A,
      snapshotID: currentSnapshotID,
    })
    await until(
      () =>
        containerA
          .querySelector(".lazers-models-inspector .lazers-models-estimate")
          ?.textContent?.includes("n=1") === true,
    )
    expect(
      containerA.querySelector(".lazers-models-inspector .lazers-models-estimate")?.textContent,
    ).toContain("one observed value, no interval")
    expect(containerA.querySelector(".lazers-models-inspector")?.textContent).toContain(
      "Current price",
    )
    expect(containerA.querySelector(".lazers-models-inspector")?.textContent).toContain(
      "native-reported",
    )
    const routeEvidence = containerA.querySelector<HTMLDetailsElement>(
      ".lazers-models-inspector .lazers-models-evidence-details",
    )!
    expect(routeEvidence.open).toBe(false)
    expect(routeEvidence.textContent).toContain("Exact route")
    expect(routeEvidence.textContent).toContain("Native reported charges")
    routeEvidence.open = true
    routeEvidence.dispatchEvent(new Event("toggle"))
    expect(routeEvidence.open).toBe(true)

    expect(containerA.querySelector(`[data-group-id="group:qwen/qwen-7"]`)).toBeNull()
    const moreRows = buttonWithText(containerA, "Load more model groups")
    if (!moreRows)
      throw new Error(
        `Missing row pager: ${containerA.textContent}; row inputs: ${JSON.stringify(calls.filter((call) => call.method === "rows").map((call) => call.input))}`,
      )
    moreRows.click()
    await until(() =>
      calls.some((call) => call.method === "rows" && (call.input as { cursor?: string }).cursor),
    )
    await until(() => containerA.querySelector(`[data-group-id="group:qwen/qwen-7"]`) !== null)
    await settleChart()
    expect(chartDescription()).toBe(globalGraphDescription)
    expect(chartSVGMarkup()).toBe(selectedQwenGraphSVG)
    const moreConfigurations = buttonWithText(containerA, "Load more exact configurations")
    if (!moreConfigurations) throw new Error("Missing exact-configuration pager")
    moreConfigurations.click()
    await until(() =>
      calls.some(
        (call) =>
          call.method === "configurations" && Boolean((call.input as { cursor?: string }).cursor),
      ),
    )
    await until(() => containerA.querySelector(`[data-configuration-id="${CONFIG_ZERO}"]`) !== null)
    expect(chartDescription()).toBe(globalGraphDescription)
    expect(chartSVGMarkup()).toBe(selectedQwenGraphSVG)

    const firstContributorPage = containerA.querySelector(".lazers-models-contributors")!
    const evidenceDisclosure = firstContributorPage.closest<HTMLDetailsElement>(
      ".lazers-models-evidence-details",
    )!
    evidenceDisclosure.open = true
    firstContributorPage.closest<HTMLDetailsElement>(".lazers-models-contributor-details")!.open =
      true
    const contributorTextBefore = firstContributorPage.textContent
    const moreContributors = buttonWithText(firstContributorPage, "Load more contributors")
    if (!moreContributors) throw new Error("Missing contributor pager")
    moreContributors.click()
    await until(() =>
      calls.some(
        (call) =>
          call.method === "inspect" &&
          Boolean((call.input as { contributorCursor?: string }).contributorCursor),
      ),
    )
    await until(() => firstContributorPage.textContent?.includes("LZ-17") === true)
    expect(chartDescription()).toBe(globalGraphDescription)
    const contributorTrajectory = firstContributorPage.querySelector<HTMLButtonElement>(
      '[aria-label="Open trajectory for LZ-17"]',
    )
    contributorTrajectory?.click()
    const contributorTarget = (
      trajectoryStore.snapshot().projects[DIRECTORY_A] as { target: Record<string, unknown> }
    ).target
    expect(contributorTarget).toMatchObject({
      taskID: TASK_A,
      reference: "LZ-17",
      projectID: PROJECT_A,
      projectDirectory: DIRECTORY_A,
    })
    expect(contributorTextBefore).toContain("LZ-42")

    const highRow = containerA.querySelector<HTMLButtonElement>(
      `.lazers-models-decision-row-select[data-configuration-id="${CONFIG_ONE}"]`,
    )!
    const highRowParent = highRow.closest("tr")!
    const pendingHighInspection = deferred<ModelDecisionInspect>()
    const inspectCountBeforeRowSelection = calls.filter(
      (call) => call.service === "lazers.models.decision.v2" && call.method === "inspect",
    ).length
    suspendedInspection = { configurationID: CONFIG_ONE, pending: pendingHighInspection }
    highRow.focus()
    expect(browserDocument.activeElement).toBe(highRow)
    highRow.click()
    await until(() =>
      calls
        .filter((call) => call.service === "lazers.models.decision.v2" && call.method === "inspect")
        .slice(inspectCountBeforeRowSelection)
        .some((call) => {
          const input = call.input as {
            configurationID?: string
            selectedTaskID?: string | null
            snapshotID?: string
          }
          return (
            input.configurationID === CONFIG_ONE &&
            input.selectedTaskID === TASK_A &&
            input.snapshotID === currentSnapshotID
          )
        }),
    )
    await until(
      () =>
        containerA
          .querySelector(".lazers-models-inspector")
          ?.textContent?.includes("Loading exact configuration inspection") === true,
    )
    expect(modelStore.snapshot().projects[DIRECTORY_A]?.selectedConfigurationID).toBe(CONFIG_ONE)
    expect(highRow.isConnected).toBe(true)
    expect(highRow.closest("tr")).toBe(highRowParent)
    expect(browserDocument.activeElement).toBe(highRow)
    expect(highRow.getAttribute("aria-pressed")).toBe("true")
    await until(() => suspendedInspection?.output !== undefined)
    pendingHighInspection.resolve(suspendedInspection!.output!)
    await until(
      () =>
        containerA
          .querySelector(".lazers-models-inspector .lazers-models-estimate")
          ?.textContent?.includes("n=9") === true,
    )
    expect(highRow.isConnected).toBe(true)
    expect(highRow.closest("tr")).toBe(highRowParent)
    expect(browserDocument.activeElement).toBe(highRow)
    expect(highRow.getAttribute("aria-pressed")).toBe("true")
    expect(
      containerA.querySelector<HTMLDetailsElement>(
        ".lazers-models-inspector .lazers-models-evidence-details",
      )?.open,
    ).toBe(true)
    suspendedInspection = undefined
    const effortTrigger = [
      ...containerA.querySelectorAll<HTMLButtonElement>(".lazers-models-decision-tools button"),
    ].find((button) => button.textContent?.includes("Effort"))
    effortTrigger?.click()
    const lowOption = menuItemWithText(containerA, "low")
    if (!lowOption) throw new Error(`No low effort option: ${containerA.textContent}`)
    lowOption.click()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    if (
      modelStore.snapshot().projects[DIRECTORY_A]?.selectedConfigurationID !==
      lowConfiguration.configurationID
    )
      throw new Error(
        `Effort action failed: ${JSON.stringify(modelStore.snapshot().projects[DIRECTORY_A])}`,
      )
    await until(
      () =>
        containerA
          .querySelector(`.lazers-models-decision-row-select[aria-pressed="true"]`)
          ?.getAttribute("data-configuration-id") === lowConfiguration.configurationID,
    )
    expect(modelStore.snapshot().projects[DIRECTORY_A]?.selectedConfigurationID).toBe(
      lowConfiguration.configurationID,
    )
    expect(calls.filter((call) => call.method === "inspect").at(-1)?.input).toMatchObject({
      configurationID: lowConfiguration.configurationID,
      selectedTaskID: TASK_A,
    })

    const providerTrigger = [
      ...containerA.querySelectorAll<HTMLButtonElement>(".lazers-models-decision-tools button"),
    ].find((button) => button.textContent?.includes("Provider"))!
    providerTrigger.click()
    menuItemWithText(containerA, "qwen / qwen-7")?.click()
    await until(
      () => modelStore.snapshot().projects[DIRECTORY_A]?.selectedConfigurationID === CONFIG_SINGLE,
    )
    expect(containerA.querySelector(".lazers-models-inspector h2")?.textContent).toBe("Qwen 7")

    const zeroProviderTrigger = [
      ...containerA.querySelectorAll<HTMLButtonElement>(".lazers-models-decision-tools button"),
    ].find((button) => button.textContent?.includes("Provider"))!
    zeroProviderTrigger.click()
    menuItemWithText(containerA, "anthropic / sonnet")?.click()
    await until(
      () => modelStore.snapshot().projects[DIRECTORY_A]?.selectedConfigurationID === CONFIG_ZERO,
    )
    expect(
      containerA.querySelector(".lazers-models-inspector .lazers-models-estimate")?.textContent,
    ).toContain("No accepted tasks")
    expect(containerA.querySelector(".lazers-models-inspector")?.textContent).not.toContain(
      "Empirical observed spread · n=7",
    )
    expect(chartDescription()).toBe(globalGraphDescription)

    const personaFilter = [
      ...containerA.querySelectorAll<HTMLButtonElement>(".lazers-models-filters button"),
    ].find((button) => button.textContent?.includes("Persona"))!
    personaFilter.click()
    menuItemWithText(containerA, "Systems")?.click()
    await until(
      () =>
        containerA.querySelector(".lazers-models-filters")?.textContent?.includes("Systems") ===
        true,
    )
    await until(
      () =>
        containerA.querySelector(".lazers-models-inspector h2")?.textContent ===
          "Off-page configuration" ||
        calls.some(
          (call) =>
            call.method === "overview" &&
            (call.input as { filters?: ModelDecisionFilters }).filters?.persona === "systems",
        ),
    )
    const systemsOverview = calls.filter((call) => call.method === "overview").at(-1)?.input as {
      filters?: ModelDecisionFilters
    }
    expect(systemsOverview.filters?.persona).toBe("systems")
    const taskKindFilter = [
      ...containerA.querySelectorAll<HTMLButtonElement>(".lazers-models-filters button"),
    ].find((button) => button.textContent?.includes("Task kind"))!
    taskKindFilter.click()
    menuItemWithText(containerA, "Testing")?.click()
    await until(
      () =>
        containerA.querySelector(".lazers-models-filters")?.textContent?.includes("Testing") ===
        true,
    )
    await until(() =>
      calls.some(
        (call) =>
          call.method === "overview" &&
          (call.input as { filters?: ModelDecisionFilters }).filters?.taskKind === "testing",
      ),
    )
    expect(
      calls
        .filter(
          (call) => call.service === "lazers.models.decision.v2" && call.method === "overview",
        )
        .at(-1)?.input,
    ).toMatchObject({ filters: { persona: "systems", taskKind: "testing" } })
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
    const inspectorA = containerA.querySelector<HTMLElement>(".lazers-models-inspector")!
    expect(inspectorA.querySelector(".lazers-models-task-summary")?.textContent).toContain("LZ-17")
    expect(inspectorA.querySelector(".lazers-models-task-summary")?.textContent).toContain(
      "execution accepted",
    )
    const effortDetails = inspectorA.querySelector<HTMLDetailsElement>(
      ".lazers-models-task-effort-details",
    )!
    expect(effortDetails.open).toBe(false)
    expect(effortDetails.querySelector(".lazers-models-category-row")?.closest("details")).toBe(
      effortDetails,
    )
    effortDetails.open = true
    expect(effortDetails.textContent).toContain("tokens")
    expect(effortDetails.textContent).toContain("market-equivalent cost: Unknown")
    effortDetails.open = false

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
      `.lazers-models-decision-row-select[data-configuration-id="${CONFIG_ONE}"]`,
    )!
    firstRow.click()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    if (firstRow.getAttribute("aria-pressed") !== "true")
      throw new Error(
        `Exact decision row did not select: ${JSON.stringify(modelStore.snapshot().projects[DIRECTORY_A])} · row=${firstRow.parentElement?.parentElement?.outerHTML} · inspector=${containerA.querySelector(".lazers-models-inspector h2")?.textContent} · inspect=${JSON.stringify(
          calls
            .filter((call) => call.method === "inspect")
            .slice(-4)
            .map((call) => call.input),
        )}`,
      )
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
        containerA
          .querySelector(".lazers-models-task-objective")
          ?.textContent?.includes("Objective A refreshed") === true &&
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

    const chartBeforeCompareTab = chartDescription()
    containerA
      .querySelector<HTMLButtonElement>('[role="tab"][aria-controls="lazers-models-compare-panel"]')
      ?.click()
    await until(() => containerA.querySelector(".lazers-models-decision-rows") !== null)
    const effortDetailsBeforeRefresh = containerA.querySelector<HTMLDetailsElement>(
      ".lazers-models-task-effort-details",
    )!
    const sourceDetailsBeforeRefresh = containerA.querySelector<HTMLDetailsElement>(
      ".lazers-models-sources-details",
    )!
    effortDetailsBeforeRefresh.open = true
    sourceDetailsBeforeRefresh.open = true

    buttonWithText(containerA, "Refresh")?.click()
    await until(
      () =>
        (sourceSignals.get(DIRECTORY_A)?.length ?? 0) === 3 &&
        chartDescription() !== chartBeforeCompareTab,
    )
    const hiddenSignal = sourceSignals.get(DIRECTORY_A)?.[2]
    expect(containerA.querySelector(".lazers-models-decision-rows")?.textContent).toContain("GPT-6")
    expect(containerA.querySelector(".lazers-models-decision-rows")?.textContent).not.toContain(
      "openai",
    )
    expect(containerA.textContent).toContain("Refreshing sources")
    expect(
      containerA.querySelector(".lazers-models-task-effort-details")?.closest("details")?.open,
    ).toBe(true)
    expect(
      containerA.querySelector<HTMLDetailsElement>(".lazers-models-sources-details")?.open,
    ).toBe(true)
    expect(modelStore.snapshot().projects[DIRECTORY_A]?.selectedTaskID).toBe(TASK_A)
    expect(modelStore.snapshot().projects[DIRECTORY_A]?.selectedConfigurationID).toBe(CONFIG_ONE)
    mountA.setVisible(false)
    await until(() => hiddenSignal?.aborted === true)
    const beforeLateHiddenResult = comparisonCounts.get(DIRECTORY_A)
    const rpcsBeforeLocationReopen = calls.filter((call) => call.service !== "location").length
    mountA.setVisible(true)
    await until(() => (locationSignals.get(DIRECTORY_A)?.length ?? 0) === 2)
    expect(calls.filter((call) => call.service !== "location")).toHaveLength(
      rpcsBeforeLocationReopen,
    )
    expect(containerA.querySelector(`[data-configuration-id="${CONFIG_ONE}"]`)).toBeNull()
    mountA.setVisible(false)
    await until(() => locationSignals.get(DIRECTORY_A)?.[1]?.aborted === true)
    mountA.setVisible(true)
    await until(() => (locationSignals.get(DIRECTORY_A)?.length ?? 0) === 3)
    expect(locationSignals.get(DIRECTORY_A)?.[1]?.aborted).toBe(true)
    expect(calls.filter((call) => call.service !== "location")).toHaveLength(
      rpcsBeforeLocationReopen,
    )
    expect(containerA.querySelector(`[data-configuration-id="${CONFIG_ONE}"]`)).toBeNull()
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
    expect(containerA.querySelector(".lazers-models-decision-rows")?.textContent).toContain("GPT-6")
    expect(modelStore.snapshot().projects[DIRECTORY_A]?.selectedConfigurationID).toBe(CONFIG_ONE)

    const rpcsBeforeSessionSwitch = calls.filter((call) => call.service !== "location").length
    sessionScope.update((draft: { id: string; directory: string }) => {
      draft.id = "ses-models-switched"
      draft.directory = DIRECTORY_B
    })
    await until(() => (locationSignals.get(DIRECTORY_B)?.length ?? 0) === 1)
    expect(calls.filter((call) => call.service !== "location")).toHaveLength(
      rpcsBeforeSessionSwitch,
    )
    expect(containerA.querySelector(`[data-configuration-id="${CONFIG_ONE}"]`)).toBeNull()
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
    const retainedEffort = containerA.querySelector<HTMLDetailsElement>(
      ".lazers-models-task-effort-details",
    )!
    const retainedSources = containerA.querySelector<HTMLDetailsElement>(
      ".lazers-models-sources-details",
    )!
    retainedEffort.open = true
    retainedSources.open = true
    expect(
      [...containerA.querySelectorAll(".lazers-models-refresh-note")].some((warning) =>
        warning.textContent?.includes("Comparison is stale"),
      ),
    ).toBe(false)
    const sourceCountBeforeComparisonFailure = sourceSignals.get(DIRECTORY_A)?.length ?? 0
    const comparisonCountBeforeComparisonFailure = comparisonCounts.get(DIRECTORY_A) ?? 0
    failNextComparison = true
    buttonWithText(containerA, "Refresh")?.click()
    await until(
      () =>
        [...containerA.querySelectorAll(".lazers-models-refresh-note")].some((warning) =>
          warning.textContent?.includes("Comparison is stale"),
        ) ||
        ((sourceSignals.get(DIRECTORY_A)?.length ?? 0) > sourceCountBeforeComparisonFailure &&
          (comparisonCounts.get(DIRECTORY_A) ?? 0) > comparisonCountBeforeComparisonFailure &&
          !buttonWithText(containerA, "Refresh")?.disabled),
    )
    if (
      ![...containerA.querySelectorAll(".lazers-models-refresh-note")].some((warning) =>
        warning.textContent?.includes("Comparison is stale"),
      )
    )
      throw new Error(
        `Expected comparison failure was not shown (comparison ${comparisonCountBeforeComparisonFailure}→${comparisonCounts.get(DIRECTORY_A)}, source ${sourceCountBeforeComparisonFailure}→${sourceSignals.get(DIRECTORY_A)?.length}): ${containerA.textContent}`,
      )
    const staleWarning = [
      ...containerA.querySelectorAll<HTMLElement>(".lazers-models-refresh-note"),
    ].find((warning) => warning.textContent?.includes("Comparison is stale"))!
    expect(staleWarning.closest("details")).toBeNull()
    expect(retainedEffort.open).toBe(true)
    expect(retainedSources.open).toBe(true)
    expect(retainedSources.textContent).toContain(
      "Comparison read error: comparison request unavailable",
    )
    expect(modelStore.snapshot().projects[DIRECTORY_A]?.selectedTaskID).toBe(TASK_A)
    expect(modelStore.snapshot().projects[DIRECTORY_A]?.selectedConfigurationID).toBe(CONFIG_ONE)

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
    expect(containerA.querySelector(".lazers-models-task-effort-details")).toBe(retainedEffort)
    expect(containerA.querySelector(".lazers-models-sources-details")).toBe(retainedSources)
    expect(retainedEffort.open).toBe(true)
    expect(retainedSources.open).toBe(true)
    expect(retainedSources.textContent).toContain(
      "Source refresh error: source request unavailable",
    )
    expect(modelStore.snapshot().projects[DIRECTORY_A]?.selectedTaskID).toBe(TASK_A)
    expect(modelStore.snapshot().projects[DIRECTORY_A]?.selectedConfigurationID).toBe(CONFIG_ONE)

    const containerB = browserDocument.createElement("main")
    browserDocument.body.append(containerB)
    const mountB = host.mountModelPanel(panel!, context, sessionB, containerB)
    mounts.push(mountB)
    await until(
      () =>
        containerB.querySelector(
          `.lazers-models-decision-row-select[data-configuration-id="${CONFIG_ONE}"]`,
        ) !== null && containerB.textContent?.includes("Objective B project only") === true,
    )
    expect(containerB.querySelector(".lazers-models-project")?.textContent).toContain("project-b")
    expect(containerB.querySelector(".lazers-models-decision-rows")?.textContent).toContain("GPT-6")
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
