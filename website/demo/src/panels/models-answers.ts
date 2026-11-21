import { Models } from "../../../../src/models/contract.ts"
import type { ModelSettingsOutput } from "../../../../src/models/contract.ts"
import type {
  ModelDecisionConfiguration,
  ModelDecisionContext,
  ModelDecisionFilters,
  ModelDecisionGraphPoint,
  ModelDecisionInspect,
  ModelDecisionOverview,
  ModelDecisionRow,
} from "../../../../src/models/decision-contract.ts"
import type { ModelComparisonOutput } from "../../../../src/models/comparison-schema.ts"
import type { ModelEvidenceOutput } from "../../../../src/models/source-schema.ts"
import {
  MODEL_EVIDENCE_QUERIES,
  MODEL_EVIDENCE_SOURCE_URLS,
} from "../../../../src/models/source-schema.ts"
import type { ModelMappingRecord } from "../../../../src/models/mapping-schema.ts"
import type { ModelMappingSubject } from "../../../../src/models/agent-ids.ts"
import { Observability } from "../../../../src/observability/contract.ts"
import { Streams } from "../../../../src/streams/contract.ts"
import { combinedStreams, modelStreams } from "./models-streams.ts"
import { TaskEffortBasisSchema } from "../../../../src/models/comparison-presentation.ts"
import { TrajectoryOutput } from "../../../../src/observability/contract.ts"
import type { Read } from "../adapter.ts"
import { PROJECT, rpc as tasksRpc, reads as tasksReads } from "./tasks-answers.ts"
import type { DemoTask } from "./tasks-answers.ts"

/**
 * Pure answers for the Models panel: a compact description of the project's models at one moment,
 * expanded into the exact contract shapes (`lazers.models`, `lazers.models.decision.v2`, plus the
 * tasks and trajectory reads the panel makes for its task filter). No browser or Solid code, so
 * the build script can validate it. Model names, context sizes and per-token prices are the
 * OpenRouter model catalog's published figures as this product recorded them (provenance in
 * stories/models.ts); every run, count and token figure is an invented fixture about a fictional
 * project. Dollars per accepted task are computed from those tokens and those prices.
 */
export interface DemoModel {
  providerID: string
  id: string
  name: string
  /** The model's id in the OpenRouter catalog, where the prices come from. */
  openrouterID: string
  /** USD per million tokens, as the catalog published them. */
  priceIn: number
  priceOut: number
  priceCache: number
  context: number
  /** Effort levels the model offers. */
  variants: string[]
  /** What the project's own accepted-task runs on this model measured; absent when never run. */
  observed?: {
    /** The effort the runs used. */
    variant?: string
    /** Accepted plus rejected logical tasks. */
    terminal: number
    /** Mean tokens per accepted task. */
    tokens: number
    /** Every attempt: its task reference number and the tokens it used. */
    runs: { n: number; kind: "accepted" | "failed" | "retry"; tokens: number }[]
  }
}

export interface DemoAssignment {
  subject: ModelMappingSubject
  scope: "shared" | "project"
  route: { providerID: string; id: string; variant?: string }
}

export interface ModelsData {
  /** When the price source was last retrieved (ISO) and which recorded snapshot that was. */
  pricesRetrievedAt: string
  pricesGeneration: number
  models: DemoModel[]
  /** The project's tasks; the first is the one the panel selects. */
  tasks: { n: number; title: string }[]
  /** Routes already saved before the story starts. */
  assignments: DemoAssignment[]
}

const MIN = 60_000
const uid = (kind: number, n: number) =>
  `${kind.toString(16).padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`
const iso = (ms: number) => new Date(ms).toISOString()
const SNAPSHOT_ID = "snapshot:demo/1"
const POLICY = {
  schemaVersion: 1,
  revision: 0,
  sources: ["openrouter", "opencode"],
  fallback: "whole-model",
} as const

const routeKey = (model: { providerID: string; id: string }) => `${model.providerID}/${model.id}`
const configurationID = (model: DemoModel) =>
  `configuration:${routeKey(model)}::${model.observed?.variant ?? "none"}`
const groupID = (model: DemoModel) => `group:${routeKey(model)}`
const label = (model: DemoModel) =>
  model.observed?.variant ? `${model.name} · ${model.observed.variant}` : model.name
/** USD per accepted task: the mix of fresh input, output and cache reads a coding task makes. */
const usdPerTask = (model: DemoModel) =>
  ((model.observed?.tokens ?? 0) / 1e6) *
  (0.15 * model.priceIn + 0.05 * model.priceOut + 0.8 * model.priceCache)

const acceptedRuns = (model: DemoModel) =>
  model.observed?.runs.filter((run) => run.kind === "accepted").length ?? 0
const observedModels = (data: ModelsData) => data.models.filter((model) => acceptedRuns(model) > 0)

/* -------------------------------------------------------------------- decision */

function context(data: ModelsData, filters: ModelDecisionFilters): ModelDecisionContext {
  const retrieved = data.pricesRetrievedAt
  return {
    schemaVersion: 2,
    snapshotID: SNAPSHOT_ID,
    producedAt: iso(Date.now()),
    scope: { projectDirectory: PROJECT.canonical },
    filters,
    priceSourcePolicy: { ...POLICY, sources: [...POLICY.sources] },
    availability: "ready",
    freshness: "current",
    unavailableReason: null,
    accounting: {
      id: "attributable-cohort-effort-per-accepted-logical-task-v1",
      numerator: "all-attributable-cohort-failed-retry-and-accepted-effort",
      denominator: "accepted-logical-tasks",
      acceptanceThreshold: null,
      sampleSizeThreshold: null,
      valuation: "current-ordered-whole-model-price-source-pins",
      nativeReportedCosts: "retained-separately-not-market-equivalent",
    },
    taskKindCatalog: {
      id: "task-kind/v1",
      kinds: [
        "bug-repair",
        "feature-implementation",
        "refactoring",
        "testing",
        "documentation",
        "maintenance",
      ],
    },
    classification: {
      status: "complete",
      classifiedTaskCount: data.tasks.length,
      unclassifiedTaskCount: 0,
      excludedTaskCount: 0,
      totalTaskCount: data.tasks.length,
    },
    priceIndex: {
      source: "openrouter",
      sourcePolicyRevision: 0,
      pins: [
        {
          source: "openrouter",
          snapshotID: `openrouter-models:${data.pricesGeneration}`,
          retrievedAt: retrieved,
          freshness: "current",
          semantics: "exact-published-route-quotes",
        },
      ],
      freshness: "current",
      semantics: "exact-published-route-quotes",
      note: "Current prices revalue the unchanged recorded token history.",
    },
  }
}

function configuration(data: ModelsData, model: DemoModel): ModelDecisionConfiguration {
  return {
    configurationID: configurationID(model),
    groupID: groupID(model),
    label: label(model),
    route: {
      providerID: model.providerID,
      modelID: model.id,
      variant: model.observed?.variant ?? null,
    },
    currentPrice: {
      source: "openrouter",
      sourcePolicyRevision: 0,
      sourceRecordID: routeKey(model),
      snapshotID: `openrouter-models:${data.pricesGeneration}`,
      retrievedAt: data.pricesRetrievedAt,
      semantics: "exact-route-quote",
      freshness: "current",
    },
  }
}

function row(data: ModelsData, model: DemoModel): ModelDecisionRow {
  const o = model.observed!
  const accepted = acceptedRuns(model)
  const failed = o.runs.filter((run) => run.kind === "failed").length
  const retried = o.runs.filter((run) => run.kind === "retry").length
  return {
    configuration: configuration(data, model),
    cohort: {
      logicalTaskCount: o.terminal,
      classifiedTaskCount: o.terminal,
      unclassifiedTaskCount: 0,
      acceptedTaskCount: accepted,
      terminalTaskCount: o.terminal,
      attemptCount: o.runs.length,
      failedAttemptCount: failed,
      retryAttemptCount: retried,
    },
    efficiency:
      accepted === 1
        ? {
            status: "single-observation",
            tokensPerAcceptedTask: o.tokens,
            currentMarketUSDPerAcceptedTask: usdPerTask(model),
            observationCount: 1,
          }
        : {
            status: "available",
            tokensPerAcceptedTask: o.tokens,
            currentMarketUSDPerAcceptedTask: usdPerTask(model),
            observationCount: accepted,
          },
    nativeReportedCost: {
      status: "unmetered",
      totalUSD: null,
      source: "native-reported",
      note: "Subscription usage is not billed per token.",
    },
  }
}

/** Lower is better on both axes: a point is on the frontier when no other point beats it on both. */
function frontier(points: ModelDecisionGraphPoint[]) {
  return points
    .filter(
      (point) =>
        !points.some(
          (other) =>
            other !== point &&
            other.currentMarketUSDPerAcceptedTask <= point.currentMarketUSDPerAcceptedTask &&
            other.tokensPerAcceptedTask <= point.tokensPerAcceptedTask &&
            (other.currentMarketUSDPerAcceptedTask < point.currentMarketUSDPerAcceptedTask ||
              other.tokensPerAcceptedTask < point.tokensPerAcceptedTask),
        ),
    )
    .map((point) => point.configurationID)
}

function overview(data: ModelsData, filters: ModelDecisionFilters): ModelDecisionOverview {
  const points: ModelDecisionGraphPoint[] = observedModels(data).map((model) => ({
    configurationID: configurationID(model),
    groupID: groupID(model),
    label: label(model),
    tokensPerAcceptedTask: model.observed!.tokens,
    currentMarketUSDPerAcceptedTask: usdPerTask(model),
    observationCount: acceptedRuns(model),
    acceptedTaskCount: acceptedRuns(model),
    terminalTaskCount: model.observed!.terminal,
    partial: false,
  }))
  return {
    context: context(data, filters),
    graph: {
      scope: "global-filtered-snapshot",
      points,
      frontierConfigurationIDs: frontier(points),
    },
    configurationCount: points.length,
    groupCount: points.length,
  }
}

function page<T>(items: T[], input: { cursor?: string; limit?: number }) {
  const start = input.cursor ? Number(input.cursor) : 0
  const end = start + (input.limit ?? 50)
  return {
    items: items.slice(start, end),
    totalCount: items.length,
    nextCursor: end < items.length ? String(end) : null,
  }
}

type DecisionInput = { filters: ModelDecisionFilters; cursor?: string; limit?: number }

function inspect(
  data: ModelsData,
  input: DecisionInput & { configurationID: string; selectedTaskID?: string | null },
): ModelDecisionInspect {
  const ctx = context(data, input.filters)
  const model = observedModels(data).find(
    (entry) => configurationID(entry) === input.configurationID,
  )
  if (!model) return { status: "not-found", context: ctx, configurationID: input.configurationID }
  const base = row(data, model)
  const o = model.observed!
  const usd = usdPerTask(model)
  const accepted = acceptedRuns(model)
  const estimate: Extract<ModelDecisionInspect, { status: "found" }>["estimate"] =
    accepted === 1
      ? {
          status: "single-observation",
          basis: "empirical-observed-spread",
          observationCount: 1,
          range: {
            tokens: { minimum: o.tokens, maximum: o.tokens },
            currentMarketUSD: { minimum: usd, maximum: usd },
          },
          confidenceInterval: null,
        }
      : {
          status: "available",
          basis: "empirical-observed-spread",
          observationCount: accepted,
          range: {
            tokens: { minimum: o.tokens * 0.62, maximum: o.tokens * 1.48 },
            currentMarketUSD: { minimum: usd * 0.62, maximum: usd * 1.48 },
          },
          confidenceInterval: null,
        }
  const contributors = page(
    o.runs.map((run, index) => ({
      taskID: uid(1, run.n),
      taskReference: `LZ-${run.n}`,
      attemptID: uid(2, run.n * 10 + index),
      sessionID: `ses-worker-${run.n}`,
      contribution: run.kind,
      tokens: run.tokens,
      currentMarketUSD: (run.tokens / o.tokens) * usd,
      nativeReportedUSD: null,
      observedAt: iso(Date.now() - (index + 1) * 47 * MIN),
    })),
    { limit: 50 },
  )
  return {
    status: "found",
    context: ctx,
    configuration: base.configuration,
    cohort: base.cohort,
    efficiency: base.efficiency,
    nativeReportedCost: base.nativeReportedCost,
    selectedTaskID: input.selectedTaskID ?? null,
    estimate,
    contributorPage: {
      contributors: contributors.items,
      totalCount: contributors.totalCount,
      nextCursor: contributors.nextCursor,
    },
    medianAcceptedDurationMs: (14 + (o.tokens % 9)) * MIN,
  }
}

/* ------------------------------------------------------------------ comparison */

const evidence = { records: [], recordCount: 0, truncated: false }
const SOURCES = [
  "native-catalog",
  "openrouter-models",
  "openrouter-benchmarks",
  "models-dev",
  "epoch-benchmarks",
] as const

const perToken = (perMillion: number) =>
  (perMillion / 1e6).toFixed(12).replace(/0+$/, "").replace(/\.$/, "")

function candidate(
  data: ModelsData,
  model: DemoModel,
): ModelComparisonOutput["candidates"][number] {
  return {
    candidateID: `${model.providerID.length}:${model.providerID}|${model.id.length}:${model.id}|-`,
    identity: { providerID: model.providerID, modelID: model.id, variant: null },
    native: {
      name: model.name,
      enabled: true,
      type: "chat",
      contextTokens: model.context,
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      availableVariants: model.variants,
      variantCoverage: {
        status: "complete",
        totalVariants: model.variants.length,
        omittedVariants: 0,
      },
      prices: {
        unit: "USD per million tokens",
        tiers: [
          {
            contextTierTokens: null,
            input: model.priceIn,
            output: model.priceOut,
            cacheRead: model.priceCache,
            cacheWrite: null,
          },
        ],
      },
      ambiguousIdentity: false,
      evidence,
    },
    correspondence: { status: "exact", basis: "exact-published-catalog-id", evidence },
    externalModel: {
      kind: "openrouter-model",
      id: model.openrouterID,
      canonicalSlug: model.openrouterID,
      name: model.name,
      contextLength: model.context,
      architecture: {
        modality: null,
        inputModalities: null,
        outputModalities: null,
        tokenizer: null,
        instructType: null,
      },
      supportedParameters: null,
      prices: {
        unit: "USD per token",
        tiers: [
          {
            minPromptTokens: null,
            utcStart: null,
            utcEnd: null,
            prompt: perToken(model.priceIn),
            completion: perToken(model.priceOut),
            inputCacheRead: perToken(model.priceCache),
            inputCacheWrite: null,
          },
        ],
      },
    },
    externalModelEvidence: evidence,
    benchmarkCorrespondence: { status: "unresolved", basis: null, evidence },
    externalBenchmark: null,
    externalBenchmarkEvidence: evidence,
    effortApplicability: { status: "unknown", evidence },
  }
}

function comparison(data: ModelsData): ModelComparisonOutput {
  const retrieved = data.pricesRetrievedAt
  return {
    filters: {},
    sources: SOURCES.map((source, index) => {
      const priced = source === "native-catalog" || source === "openrouter-models"
      return {
        source,
        storage: "ready" as const,
        snapshotState: priced ? ("available" as const) : ("none" as const),
        selectedSnapshotID: priced ? uid(5, index + 1) : null,
        refresh: null,
        snapshot: priced
          ? ({
              source,
              snapshotID: uid(5, index + 1),
              projectDirectory: PROJECT.canonical,
              generation: data.pricesGeneration,
              retrievedAt: retrieved,
              asOf: null,
              version: null,
              citation: null,
              upstreamSourceURL: null,
              sourceURL: MODEL_EVIDENCE_SOURCE_URLS[source],
              query: MODEL_EVIDENCE_QUERIES[source],
              recordCount: data.models.length,
            } as never)
          : null,
      }
    }),
    candidates: data.models.map((model) => candidate(data, model)),
    totalCandidates: data.models.length,
    nextCursor: null,
  }
}

function sourceStatus(data: ModelsData): ModelEvidenceOutput {
  return {
    sources: SOURCES.map((source) => {
      const priced = source === "native-catalog" || source === "openrouter-models"
      const at = data.pricesRetrievedAt
      return {
        source,
        state: priced ? ("succeeded" as const) : ("never" as const),
        generation: priced ? data.pricesGeneration : 0,
        startedAt: priced ? at : null,
        completedAt: priced ? at : null,
        latestSnapshotID: null,
        latestRetrievedAt: priced ? at : null,
        latestRecordCount: priced ? data.models.length : null,
        errorCode: null,
        httpStatus: null,
      }
    }),
    snapshot: null,
  }
}

/* ------------------------------------------------------------------- settings */

const SUBJECTS: { subject: ModelMappingSubject; label: string }[] = [
  { subject: "ui", label: "UI" },
  { subject: "systems", label: "Systems" },
  { subject: "small-refactoring", label: "Small task / refactoring" },
  { subject: "architect", label: "Architect" },
  { subject: "lazers-implementor", label: "Implementor" },
  { subject: "auditor", label: "Auditor" },
]
const AGENTS = [
  { agentID: "architect", label: "Architect", subject: "architect" },
  { agentID: "lazers-implementor", label: "Implementor", subject: "lazers-implementor" },
  { agentID: "auditor", label: "Auditor", subject: "auditor" },
] as const

/**
 * The saved mappings: the story's starting routes plus every write the panel's own Save made.
 * Writes live here, in the host, as they do in the real service's store.
 */
class Mappings {
  private records = new Map<string, ModelMappingRecord>()
  constructor(private data: () => ModelsData) {}

  private key(subject: string, scope: string) {
    return `${subject}|${scope}`
  }
  private target(scope: "shared" | "project" | "task", taskID?: string) {
    return scope === "shared"
      ? ({ scope } as const)
      : scope === "project"
        ? ({ scope, projectDirectory: PROJECT.canonical } as const)
        : ({ scope, projectDirectory: PROJECT.canonical, taskID: taskID! } as const)
  }
  get(subject: string, scope: "shared" | "project" | "task", taskID?: string) {
    const written = this.records.get(this.key(subject, scope))
    if (written) return written
    if (scope === "task") return null
    const seed = this.data().assignments.find(
      (entry) => entry.subject === subject && entry.scope === scope,
    )
    return seed
      ? ({
          schemaVersion: 1,
          target: this.target(scope, taskID),
          persona: subject as ModelMappingSubject,
          revision: 1,
          route: seed.route,
          updatedAt: Date.now() - 3 * 24 * 60 * MIN,
        } as ModelMappingRecord)
      : null
  }
  write(input: {
    target: { scope: "shared" | "project" | "task"; taskID?: string }
    persona: ModelMappingSubject
    expectedRevision: number
    route: { providerID: string; id: string; variant?: string } | null
  }) {
    const { scope } = input.target
    const current = this.get(input.persona, scope, input.target.taskID)
    if ((current?.revision ?? 0) !== input.expectedRevision)
      return {
        status: "conflict" as const,
        expectedRevision: input.expectedRevision,
        currentRevision: current?.revision ?? 0,
        current,
      }
    const mapping: ModelMappingRecord = {
      schemaVersion: 1,
      target: this.target(scope, input.target.taskID),
      persona: input.persona,
      revision: input.expectedRevision + 1,
      route: input.route,
      updatedAt: Date.now(),
    }
    this.records.set(this.key(input.persona, scope), mapping)
    return { status: "updated" as const, mapping }
  }
}

function settings(
  mappings: Mappings,
  data: ModelsData,
  taskID: string | undefined,
): ModelSettingsOutput {
  const personas = SUBJECTS.map(({ subject, label: personaLabel }) => {
    const layers = {
      task: taskID ? mappings.get(subject, "task", taskID) : null,
      project: mappings.get(subject, "project"),
      shared: mappings.get(subject, "shared"),
    }
    const winner = [layers.task, layers.project, layers.shared].find((layer) => layer?.route)
    return {
      persona: subject,
      personaLabel,
      layers,
      resolution: winner?.route
        ? {
            schemaVersion: 1 as const,
            status: "assigned" as const,
            persona: subject,
            personaLabel,
            route: winner.route,
            provenance: { target: winner.target, revision: winner.revision },
          }
        : {
            schemaVersion: 1 as const,
            status: "unassigned" as const,
            persona: subject,
            personaLabel,
            route: null,
            provenance: null,
          },
    }
  })
  void data
  return {
    projectDirectory: PROJECT.canonical,
    taskID: taskID ?? null,
    personas,
    agents: AGENTS.map((agent) => {
      const project = mappings.get(agent.subject, "project")
      const shared = mappings.get(agent.subject, "shared")
      const layer = project?.route ? project : shared?.route ? shared : null
      return {
        agentID: agent.agentID,
        label: agent.label,
        model: layer?.route ?? null,
        source: layer
          ? layer === project
            ? ("project" as const)
            : ("shared" as const)
          : ("none" as const),
      }
    }),
  }
}

/* ------------------------------------------------------------------ trajectory */

function trajectory(taskID: string) {
  const at = Date.now() - 2 * 60 * MIN
  const category = {
    value: 480_000,
    unit: "tokens",
    status: "observed",
    valueScope: "task",
    sources: ["native-session-usage"],
    sourceTypes: ["cumulative-snapshot"],
    observationTimeBases: ["worker-session"],
    observedAtRange: { earliest: at, latest: at },
    observationCount: 1,
    missingObservations: 0,
  }
  const effort = TaskEffortBasisSchema.parse({
    schemaVersion: 1,
    basis: "recorded worker sessions",
    attempts: { count: 1, states: [] },
    usage: {
      unit: "tokens",
      categories: {
        uncachedInput: category,
        output: category,
        reasoning: category,
        cacheRead: category,
        cacheWrite: category,
      },
      coverage: {
        totalUniqueSessions: 1,
        nativeCumulativeSnapshots: 1,
        retainedCumulativeSnapshots: 0,
        additiveStepSubtotals: 0,
        missingSessions: [],
        unavailableSessions: [],
        progressTruncated: false,
      },
    },
    routes: {
      assignments: [],
      assessments: [],
      usageAttribution: "Session-deduplicated usage.",
      mixedRoutes: false,
      coverage: {
        totalUniqueSessions: 1,
        observedSessionRouteCount: 1,
        sessionsWithoutCurrentRoute: [],
        observedStepRouteCount: 0,
        stepContextsByStatus: { available: 1, notRead: 0, unavailable: 0 },
        progressTruncated: false,
        truncatedContextSessionIDs: [],
        missingSessionIDs: [],
        unavailableSessionIDs: [],
      },
    },
    cost: {
      fullTaskCostUSD: { valueUSD: null, status: "unknown", meaning: "Not recorded" },
      marketEquivalentCostUSD: { valueUSD: null, status: "unknown", meaning: "Not recorded" },
    },
    quality: { status: "not-recorded", value: null, meaning: "Not recorded" },
  })
  return TrajectoryOutput.parse({
    schemaVersion: 1,
    projectID: PROJECT.id,
    scope: { kind: "project" },
    boundary: {
      repositoryVersion: 1,
      sourceRevision: 1,
      sourceFingerprint: "a".repeat(64),
      nativeRevision: 1,
      eventSequence: 1,
      transitionSequence: 1,
    },
    report: { task: { id: taskID }, effort: { taskEffortBasis: effort } },
  })
}

/* ------------------------------------------------------------------- the host */

const tasksOf = (data: ModelsData) => ({
  tasks: data.tasks.map((task): DemoTask => ({
    n: task.n,
    title: task.title,
    state: "accepted",
    plan: "Demo plan",
  })),
})

type Handlers = Record<string, Record<string, (input: never) => unknown>>

export function rpc(data: () => ModelsData): Handlers {
  const mappings = new Mappings(data)
  const tasks = tasksRpc(() => tasksOf(data()))
  return {
    ...tasks,
    // One streams answer: the Models sources here, the Tasks sources (the task picker) there.
    [Streams.id]: combinedStreams(
      modelStreams(
        () => ({
          overview: (filters) => overview(data(), filters),
          inspect: (filters, id) =>
            inspect(data(), { filters, configurationID: id, selectedTaskID: null } as never),
          comparison: () => comparison(data()),
          settings: (taskID) => settings(mappings, data(), taskID),
          priceSources: POLICY.sources,
          pricesRetrievedAt: data().pricesRetrievedAt,
        }),
        data,
      ),
      tasks[Streams.id] as never,
    ),
    [Models.id]: {
      refreshSources: () => sourceStatus(data()),
      sourceEvidence: () => sourceStatus(data()),
      configure: (input: never) => mappings.write(input),
      priceSources: () => ({
        policy: { ...POLICY, sources: [...POLICY.sources] },
        access: { openrouter: "configured", opencode: "configured" },
      }),
    },
    [Observability.id]: {
      ...tasks[Observability.id],
      trajectoryStatus: (input: { taskID: string }) => trajectory(input.taskID),
    },
  }
}

/** Every distinct read this data answers, with the contract schema that must accept it. */
export function reads(data: ModelsData): Read[] {
  const out: Read[] = [
    {
      label: "lazers.models.refreshSources",
      schema: Models.methods.refreshSources.output,
      value: sourceStatus(data),
    },
    {
      label: "lazers.models.priceSources",
      schema: Models.methods.priceSources.output,
      value: { policy: POLICY, access: { openrouter: "configured", opencode: "configured" } },
    },
  ]
  const taskOut = tasksReads(tasksOf(data)).filter(
    (read) =>
      read.label.startsWith("lazers.tasks.query") || read.label.startsWith("lazers.tasks.get"),
  )
  out.push(...taskOut)
  out.push({
    label: "lazers.observability.trajectoryStatus",
    schema: Observability.methods.trajectoryStatus.output,
    value: trajectory(uid(1, data.tasks[0]?.n ?? 1)),
  })
  return out
}

/**
 * The Models panel subscribes to no service events: it re-reads on its Refresh button (and when
 * its filters or selection change). So a change in the data needs no event.
 */
export const modelsChanged = (_emit: (type: string, data: unknown) => void) => {}

export { PROJECT }
