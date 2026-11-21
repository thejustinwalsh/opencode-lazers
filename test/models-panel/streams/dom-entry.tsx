import { setupModelsPanel } from "../../../src/models/comparison-panel.tsx"
import { modelsInitialPreference, type ModelsPreference } from "../../../src/models/panel-shared.ts"
import { Models } from "../../../src/models/contract.ts"
import { Streams } from "../../../src/streams/contract.ts"
import { frameSize, writeFrame, type Columns } from "../../../src/streams/frame.ts"
import {
  MODELS_SOURCES,
  modelAssignmentColumns,
  modelBenchmarkColumns,
  modelCandidateColumns,
  modelCandidateDetail,
  modelCatalogColumns,
  modelContributorColumns,
  modelPointColumns,
  modelViewColumns,
  modelViewDetail,
} from "../../../src/streams/sources/models-ref.ts"
import type { ModelComparisonOutput } from "../../../src/models/comparison-schema.ts"
import type { ModelSettingsOutput } from "../../../src/models/contract.ts"
import type { ModelDecisionOverview } from "../../../src/models/decision-contract.ts"
import { ModelDecisionReferenceEstimateSchema } from "../../../src/models/reference-estimate.ts"
import { mountPanel } from "../../../website/demo/src/host.tsx"
import type { PanelAdapter } from "../../../website/demo/src/adapter.ts"
import { PROJECT, reads, rpc } from "../../../website/demo/src/panels/models-answers.ts"
import type { ModelsData } from "../../../website/demo/src/panels/models-answers.ts"
import story from "../../../website/demo/stories/models.ts"

export { PROJECT, story }

/** The selection a decision view is named by (`ModelViewFilter.view`). */
export type ViewSelection = {
  filters: { persona: string | null; taskKind: string | null }
  basis?: string | null
  taskID?: string | null
}
export type OpenRecord = {
  stream: string
  source: string
  filter: Record<string, unknown>
  window: number
}
type Handlers = Record<string, (input: never) => unknown>

const sourceColumns: Record<string, Columns> = {
  [MODELS_SOURCES.view]: { ...modelViewColumns, ...modelViewDetail },
  [MODELS_SOURCES.points]: modelPointColumns,
  [MODELS_SOURCES.catalog]: modelCatalogColumns,
  [MODELS_SOURCES.benchmark]: modelBenchmarkColumns,
  [MODELS_SOURCES.contributors]: modelContributorColumns,
  [MODELS_SOURCES.assignments]: modelAssignmentColumns,
  [MODELS_SOURCES.candidates]: { ...modelCandidateColumns, ...modelCandidateDetail },
}
const viewBacked = new Set<string>([
  MODELS_SOURCES.view,
  MODELS_SOURCES.points,
  MODELS_SOURCES.catalog,
  MODELS_SOURCES.benchmark,
  MODELS_SOURCES.contributors,
])

/**
 * What a view the service has created but not yet built is stored as: the view row says
 * `backfilling`, no rows exist, the detail columns are empty. Frames are written with the real codec.
 */
function backfillingFrame(source: string, seq: number) {
  const columns = sourceColumns[source]!
  const rows =
    source === MODELS_SOURCES.view
      ? [
          Object.keys(columns).map((name) =>
            name === "id"
              ? 1
              : name === "state"
                ? "backfilling"
                : ["entry_count", "point_count", "benchmark_count"].includes(name)
                  ? 0
                  : null,
          ),
        ]
      : []
  const bytes = new Uint8Array(frameSize(columns, rows))
  writeFrame(
    bytes.buffer,
    0,
    columns,
    { revision: seq, count: rows.length, before: 0, after: 0 },
    rows,
  )
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return { seq, data: btoa(binary) }
}

/**
 * The overview the service stores holds an OpenRouter reference estimate for each plotted
 * configuration (the demo's mock overview has none): the catalog's observed facts and the
 * projected ranking's token profile come from them.
 */
function withReferences(overview: ModelDecisionOverview): ModelDecisionOverview {
  const category = (tokens: number) => ({
    tokens,
    status: "observed" as const,
    rateCoverage: "complete" as const,
  })
  return {
    ...overview,
    graph: {
      ...overview.graph,
      referenceEstimates: overview.graph.points.map((point) => {
        const [, route = "", variant = "none"] =
          /^configuration:(.*)::(.*)$/.exec(point.configurationID) ?? []
        const [providerID = "", ...rest] = route.split("/")
        const tokens = point.tokensPerAcceptedTask
        return {
          configurationID: point.configurationID,
          label: point.label,
          tokensPerAcceptedTask: tokens,
          estimate: ModelDecisionReferenceEstimateSchema.parse({
            status: "exact",
            basis: "openrouter-published-model-reference-cost-per-accepted-task",
            route: {
              providerID,
              modelID: rest.join("/"),
              variant: variant === "none" ? null : variant,
            },
            acceptedTaskCount: point.acceptedTaskCount,
            numeratorUSD: point.currentMarketUSDPerAcceptedTask * point.acceptedTaskCount,
            numeratorRangeUSD: null,
            valueUSDPerAcceptedTask: point.currentMarketUSDPerAcceptedTask,
            rangeUSDPerAcceptedTask: null,
            knownSubtotalUSD: null,
            knownSubtotalRangeUSD: null,
            knownSubtotalUSDPerAcceptedTask: null,
            knownSubtotalRangeUSDPerAcceptedTask: null,
            identityStatus: "exact",
            provenance: {
              source: "openrouter-models",
              policyRevision: 0,
              availability: "available",
              access: "configured",
              snapshotID: "33333333-3333-4333-8333-333333333333",
              generation: 337,
              retrievedAt: "2026-11-19T17:21:30.333Z",
              sourceURL: "https://openrouter.ai/api/v1/models",
              recordID: route,
              recordIndex: 0,
              freshness: "current",
            },
            coverage: {
              categories: {
                uncachedInput: category(tokens * 0.15),
                output: category(tokens * 0.05),
                reasoning: category(0),
                cacheRead: category(tokens * 0.8),
                cacheWrite: category(0),
              },
              retries: {
                status: "complete",
                attemptCount: point.acceptedTaskCount,
                failedAttemptCount: 0,
                retryAttemptCount: 0,
                attemptsWithCompleteUsage: point.acceptedTaskCount,
                failedAttemptsWithCompleteUsage: 0,
                retryAttemptsWithCompleteUsage: 0,
              },
              attribution: {
                status: "complete",
                relatedTaskCount: point.acceptedTaskCount,
                unknownRouteTaskCount: 0,
                relatedSessionCount: point.acceptedTaskCount,
                matchedRouteSessionCount: point.acceptedTaskCount,
                includedSessionCount: point.acceptedTaskCount,
                otherRouteSessionCount: 0,
                mixedRouteSessionCount: 0,
                unknownRouteSessionCount: 0,
                sharedSessionCount: 0,
                unattributedSessionCount: 0,
              },
            },
            reasons: [],
          }),
        }
      }),
    },
  }
}

/**
 * The Models panel over the demo's streams (real frames from the real view builder), with a
 * service the test steers: `hold` answers matching view selections as backfilling until `release`.
 */
export function harness(
  root: HTMLElement,
  options: {
    /** Changes the candidates the comparison answers. */
    comparison?: (output: ModelComparisonOutput) => ModelComparisonOutput
    /** Changes what the host says about each agent. */
    settings?: (output: ModelSettingsOutput) => ModelSettingsOutput
    /** Starts with views answered as backfilling when this matches the selection. */
    hold?: (view: ViewSelection) => boolean
    data?: ModelsData
    /** What the panel's store held when it opened (a returning user's choices). */
    preferences?: Partial<ModelsPreference>
  } = {},
) {
  let data = options.data ?? story.initial
  let holding = options.hold ?? null
  const opens: OpenRecord[] = []
  const calls: { method: string; input: Record<string, unknown> }[] = []
  const known = new Map<string, OpenRecord>()
  let emit: ((type: string, data: unknown) => void) | undefined
  let heldFrames = 0

  const table = rpc(() => data, {
    overview: withReferences,
    ...(options.comparison ? { comparison: options.comparison } : {}),
    ...(options.settings ? { settings: options.settings } : {}),
  })
  const inner = table[Streams.id] as unknown as Record<
    string,
    (input: never) => { seq: number; data: string }
  >
  const masked = (stream: string, reply: { seq: number; data: string }) => {
    const open = known.get(stream)
    const view = open?.filter.view as ViewSelection | undefined
    if (!open || !view || !holding || !viewBacked.has(open.source) || !holding(view)) return reply
    heldFrames++
    return backfillingFrame(open.source, reply.seq)
  }
  const streams: Handlers = {
    ...inner,
    open: ((input: OpenRecord & { stream: string }) => {
      const record = {
        stream: input.stream,
        source: input.source,
        filter: structuredClone(input.filter),
        window: input.window,
      }
      known.set(input.stream, record)
      opens.push(record)
      return masked(input.stream, inner.open!(input as never))
    }) as never,
    slide: ((input: { stream: string }) =>
      masked(input.stream, inner.slide!(input as never))) as never,
    seek: ((input: { stream: string }) =>
      masked(input.stream, inner.seek!(input as never))) as never,
    read: ((input: { stream: string }) =>
      masked(input.stream, inner.read!(input as never))) as never,
    close: ((input: { stream: string }) => {
      known.delete(input.stream)
      return inner.close!(input as never)
    }) as never,
  }
  const modelsMethods = table[Models.id] as Handlers
  table[Streams.id] = streams as never
  table[Models.id] = {
    ...modelsMethods,
    configure: ((input: Record<string, unknown>) => {
      calls.push({ method: "configure", input: structuredClone(input) })
      const result = modelsMethods.configure!(input as never)
      // The revision feed: every open stream re-reads after a write.
      queueMicrotask(pushChanged)
      return result
    }) as never,
  }
  const pushChanged = () => {
    for (const stream of known.keys())
      emit?.("rpc.lazers.streams.changed", { stream, seq: Number.MAX_SAFE_INTEGER })
  }

  const adapter: PanelAdapter<ModelsData> = {
    panelID: "models",
    tabTitle: "Models",
    project: PROJECT,
    setup: (ctx, host) => setupModelsPanel(ctx as never, () => host.openPanel("trajectory")),
    rpc: () => table,
    changed: (_data, send) => {
      emit = send
      pushChanged()
    },
    reads,
    stores: {
      modelsView: {
        projects: {
          [PROJECT.canonical]: { ...modelsInitialPreference, ...options.preferences },
        },
      },
    },
  }
  const mounted = mountPanel(adapter, root, () => data)
  // The host hands its event emitter over on the first change; prime it before any stream opens.
  mounted.changed(data)
  return {
    opens,
    calls,
    /** How many frames were answered as backfilling. */
    heldFrames: () => heldFrames,
    /** The newest open of a source whose filter matches. */
    lastOpen(source: string, match: (open: OpenRecord) => boolean = () => true) {
      return opens.findLast((open) => open.source === source && match(open))
    },
    /** From now on, answer the views `matches` selects as backfilling. */
    hold(matches: (view: ViewSelection) => boolean) {
      holding = matches
    },
    /** Every held view is built: re-read what was open. */
    release(next?: ModelsData) {
      holding = null
      if (next) data = next
      pushChanged()
    },
    dispose: mounted.dispose,
  }
}
