import { createKeyed, createLatest, usePanel } from "@opencode/plugin/gui"
import { createPanelStatus } from "../panel-status.tsx"
import type { PanelProps } from "@opencode/plugin/gui"
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import type { JSX } from "solid-js"
import { Models } from "./contract.ts"
import type { ModelPolicy, WorkerPersona } from "../runner/schema.ts"
import type { ModelMappingTargetInput } from "./mapping-schema.ts"
import { ModelsDecision } from "./decision-contract.ts"
import type { ModelDecisionConfiguration, ModelDecisionFilters } from "./decision-contract.ts"
import { comparisonChartKeyboardOrder } from "./comparison-chart.tsx"
import { benchmarkBaseline, routeKey } from "./benchmark-baseline.ts"
import type { BenchmarkRoute } from "./benchmark-baseline.ts"
import { MODEL_PRICE_SOURCES } from "./price-source-settings.ts"
import type { ModelPriceSource } from "./price-source-settings.ts"
import type { ComparisonChartPoint, ComparisonChartReference } from "./comparison-chart.tsx"
import { emptyModelDecisionFilters } from "./comparison-state.ts"
import { Tasks } from "../tasks/contract.ts"
import { Observability } from "../observability/contract.ts"
import type { TaskTrajectoryOpener, TaskTrajectoryRequest } from "../tasks/panel.tsx"
import { ModelComparisonPanelState } from "./comparison-state.ts"
import type {
  ModelCatalogOutput,
  ModelComparisonPanelData,
  ModelComparisonTransport,
} from "./comparison-state.ts"
import {
  boundedModelLabel,
  currentMarketEstimateSummary,
  formatDate,
  modelDisplayLabel,
  routeLabel,
  selectedModelFacts,
} from "./comparison-presentation.ts"
import { benchmarkSourceName } from "./benchmark-chart.tsx"
import { READ_DEADLINE_MS, withReadDeadline } from "./read-deadline.ts"
import { panelClock } from "../panel-status.ts"
import {
  clampSplit,
  marketSummarySource,
  modelPersonaLabels,
  modelTaskKindLabels,
  modelsInitialPreference as initial,
} from "./panel-shared.ts"
import type { ModelsContext, Tab } from "./panel-shared.ts"

type ModelsProps = PanelProps & { ctx: ModelsContext; openTrajectory: TaskTrajectoryOpener }

/** All shared state of the Models panel; the shell and both views read from it. */
export function createModelsController(props: ModelsProps) {
  const ctx = props.ctx
  const Ui = ctx.ui
  const frame = usePanel()
  const [data, setData] = createSignal<ModelComparisonPanelData>(
    new ModelComparisonPanelState(() => {}).data,
  )
  const [split, setSplit] = createSignal(initial.split)
  const [chartHeight, setChartHeight] = createSignal<number>()
  const [assignmentPersona, setAssignmentPersona] = createSignal<WorkerPersona | null>(null)
  const [assignmentScope, setAssignmentScope] =
    createSignal<ModelMappingTargetInput["scope"]>("project")
  const [assignmentRoute, setAssignmentRoute] = createSignal({
    providerID: "",
    id: "",
    variant: "",
  })
  // A route carried from Compare into the Assignments editor draft for one persona.
  const [assignmentPrefill, setAssignmentPrefill] = createSignal<{
    persona: WorkerPersona
    route: { providerID: string; id: string; variant: string }
    version: number
    /** What Compare showed for this model, e.g. "$0.35 – 0.67 per accepted task, 9 of 11 accepted". */
    summary?: string
  }>()
  let assignmentPickerRequest = 0
  const refs: {
    root?: HTMLDivElement
    topPane?: HTMLDivElement
    header?: HTMLElement
    comparison?: HTMLElement
    inspector?: HTMLDivElement
  } = {}
  let endDrag: (() => void) | undefined

  const locationRequest = createMemo(
    () => {
      if (!frame.visible() || !props.session.location || !props.session.directory) return undefined
      return {
        lookup: Symbol("models-location"),
        client: props.session.server.client,
        server: props.session.server.id,
        session: props.session.id,
        directory: props.session.directory,
      }
    },
    undefined,
    {
      equals: (previous, next) =>
        previous?.client === next?.client &&
        previous?.server === next?.server &&
        previous?.session === next?.session &&
        previous?.directory === next?.directory,
    },
  )
  const source = createLatest(locationRequest, async (value, signal) => {
    const location = await value.client.location.get(
      { location: { directory: value.directory } },
      { signal },
    )
    return {
      ...value,
      project: location.project.canonical,
      projectID: location.project.id,
    }
  })
  const current = () => {
    const request = locationRequest()
    if (!request) return undefined
    const value = source.latest
    return value &&
      value.lookup === request.lookup &&
      value.server === props.session.server.id &&
      value.session === props.session.id &&
      value.directory === props.session.directory
      ? value
      : undefined
  }
  const prefs = () => {
    const value = current()
    return value
      ? (ctx.stores.modelsView(props.session).value?.projects[value.project] ?? initial)
      : initial
  }
  const save = (change: Partial<typeof initial>) => {
    const value = current()
    if (!value) return
    ctx.stores.modelsView(props.session).update((draft) => {
      draft.projects[value.project] = {
        ...(draft.projects[value.project] ?? initial),
        ...change,
      }
    })
  }
  const state = new ModelComparisonPanelState(setData, (selection) =>
    save({
      selectedTaskID: selection.selectedTaskID,
      selectedCandidateID: selection.selectedCandidateID,
      selectedConfigurationID: selection.selectedConfigurationID,
    }),
  )
  const expectedKey = () => {
    const value = current()
    return value
      ? JSON.stringify([
          value.server,
          value.projectID,
          value.project,
          value.session,
          value.directory,
        ])
      : ""
  }
  const visible = () => (data().key === expectedKey() ? data() : undefined)

  onCleanup(() => {
    assignmentPickerRequest++
    state.close()
    endDrag?.()
  })

  createKeyed(
    () => {
      const value = current()
      if (!value || !ctx.stores.modelsView(props.session).ready()) return undefined
      return { value, key: expectedKey() }
    },
    ({ value, key }) => {
      const view = prefs()
      setSplit(clampSplit(view.split))
      const models = value.client.rpc(Models)
      const decisions = value.client.rpc(ModelsDecision)
      const tasks = value.client.rpc(Tasks)
      const observations = value.client.rpc(Observability)
      const location = { location: { directory: value.directory } }
      const transport: ModelComparisonTransport = {
        comparison: (cursor, parent) =>
          withReadDeadline(parent, (signal) =>
            models.comparison(
              {
                sessionID: value.session,
                limit: 100,
                ...(cursor ? { cursor } : {}),
              },
              { ...location, signal },
            ),
          ),
        refreshSources: (parent) =>
          withReadDeadline(
            parent,
            (signal) =>
              models.refreshSources({ sessionID: value.session }, { ...location, signal }),
            2 * READ_DEADLINE_MS,
          ),
        settings: (taskID, parent) =>
          withReadDeadline(parent, (signal) =>
            models.settings(
              { sessionID: value.session, ...(taskID ? { taskID } : {}) },
              { ...location, signal },
            ),
          ),
        catalog: (parent) =>
          withReadDeadline(parent, (signal) =>
            models.catalog({ sessionID: value.session }, { ...location, signal }),
          ),
        configure: (update, signal) =>
          models.configure({ sessionID: value.session, ...update }, { ...location, signal }),
        queryTasks: (parent) =>
          withReadDeadline(parent, (signal) =>
            tasks.query(
              { state: "all", includeCompleted: true, includeRetired: true, limit: 100 },
              { ...location, signal },
            ),
          ),
        getTask: (taskID, signal) => tasks.get({ taskID }, { ...location, signal }),
        trajectoryStatus: (taskID, signal) =>
          observations.trajectoryStatus(
            { scope: { kind: "project", sessionID: value.session }, taskID },
            { ...location, signal },
          ),
        decisionOverview: (filters, parent) =>
          withReadDeadline(parent, (signal) =>
            decisions.overview(
              { sessionID: value.session, scope: { projectDirectory: value.project }, filters },
              { ...location, signal },
            ),
          ),
        decisionRows: (filters, cursor, snapshotID, signal) =>
          decisions.rows(
            {
              sessionID: value.session,
              scope: { projectDirectory: value.project },
              filters,
              limit: 50,
              snapshotID,
              ...(cursor ? { cursor } : {}),
            },
            { ...location, signal },
          ),
        decisionConfigurations: (filters, cursor, snapshotID, signal) =>
          decisions.configurations(
            {
              sessionID: value.session,
              scope: { projectDirectory: value.project },
              filters,
              limit: 50,
              snapshotID,
              ...(cursor ? { cursor } : {}),
            },
            { ...location, signal },
          ),
        decisionInspect: (
          filters,
          snapshotID,
          configurationID,
          selectedTaskID,
          contributorCursor,
          signal,
        ) =>
          decisions.inspect(
            {
              sessionID: value.session,
              scope: { projectDirectory: value.project },
              filters,
              snapshotID,
              configurationID,
              selectedTaskID,
              contributorLimit: 50,
              ...(contributorCursor ? { contributorCursor } : {}),
            },
            { ...location, signal },
          ),
        online: () => props.session.server.connected,
      }
      state.connect(
        key,
        value.projectID,
        value.project,
        transport,
        {
          selectedTaskID: view.selectedTaskID,
          selectedCandidateID: view.selectedCandidateID,
          selectedConfigurationID: view.selectedConfigurationID ?? null,
        },
        {
          persona: view.persona,
          taskKind: view.taskKind ?? null,
          period: { from: null, to: null },
        },
      )
      onCleanup(() => state.close())
    },
    {
      equals: (left, right) => left.key === right.key && left.value.client === right.value.client,
      otherwise: () => state.close(),
    },
  )

  const selectedCandidate = () => {
    const configuration = selectedDecisionConfiguration()
    if (!configuration) return undefined
    return visible()?.candidates.find(
      (candidate) =>
        candidate.identity.providerID === configuration?.route.providerID &&
        candidate.identity.modelID === configuration.route.modelID &&
        candidate.identity.variant === configuration.route.variant,
    )
  }
  const decisionDisplayRoutes = () => [
    ...availableConfigurations().map((configuration) => ({
      ...configuration.route,
      variant: null,
    })),
    ...(visible()?.decisionOverview?.graph.referenceEstimates ?? []).map((reference) => ({
      ...reference.estimate.route,
      variant: null,
    })),
  ]
  const decisionModelFullName = (configuration: ModelDecisionConfiguration) =>
    modelDisplayLabel(
      configuration.route,
      decisionDisplayRoutes(),
      visible()?.candidates ?? [],
      visible()?.catalog?.options ?? [],
    )
  const decisionModelLabel = (configuration: ModelDecisionConfiguration) =>
    boundedModelLabel(decisionModelFullName(configuration))
  const decisionModelChoiceLabel = (configuration: ModelDecisionConfiguration) => {
    const friendly = decisionModelFullName(configuration)
    const exactRoute = routeLabel(configuration.route)
    return friendly.includes(exactRoute) ? friendly : `${friendly} · ${exactRoute}`
  }
  const selectedTask = () => visible()?.task
  const selectedDecisionConfiguration = () => {
    const current = visible()
    if (!current?.selectedConfigurationID) return undefined
    return (
      current.decisionInspection?.configuration ??
      current.decisionConfigurations.find(
        (configuration) => configuration.configurationID === current.selectedConfigurationID,
      ) ??
      current.decisionRows.find(
        (row) => row.configuration.configurationID === current.selectedConfigurationID,
      )?.configuration
    )
  }
  const selectedMarketEstimate = () => {
    const inspection = visible()?.decisionInspection
    if (!inspection || inspection.status !== "found") return undefined
    const context = inspection.context
    const freshness =
      visible()?.stale ||
      visible()?.comparisonStale ||
      visible()?.decisionStatus === "stale" ||
      context.freshness === "stale"
        ? "stale"
        : context.priceIndex.freshness
    return currentMarketEstimateSummary({
      estimate: inspection.estimate,
      referenceEstimate: inspection.referenceEstimate,
      acceptedTaskCount: inspection.cohort.acceptedTaskCount,
      priceSource: context.priceIndex.source,
      priceFreshness: freshness,
    })
  }
  /** Two-line summary: model · effort above, rounded cost · sample size · source below. */
  const selectedSummaryLine = () => {
    const inspection = visible()?.decisionInspection
    if (!inspection || inspection.status !== "found") return undefined
    const count = inspection.cohort.acceptedTaskCount
    const tasks = `from ${count} task${count === 1 ? "" : "s"}`
    const summary = selectedMarketEstimate()
    // No applicable price: omit the cost rather than label it unavailable.
    if (!summary)
      return count > 0
        ? { text: `From ${count} task${count === 1 ? "" : "s"}`, title: `${count} accepted tasks` }
        : undefined
    return {
      text: `${summary.amount} · ${tasks} · ${marketSummarySource(summary.context)}`,
      title: summary.title,
    }
  }
  const selectedFacts = () => {
    const inspection = visible()?.decisionInspection
    if (!inspection || inspection.status !== "found") return undefined
    return selectedModelFacts({
      estimate: inspection.estimate,
      referenceEstimate: inspection.referenceEstimate,
      efficiency: inspection.efficiency,
      cohort: inspection.cohort,
    })
  }
  /** "$0.35 – 0.67 per accepted task, 9 of 11 accepted"; each part is dropped when absent. */
  const selectedFactsSummary = () => {
    const facts = selectedFacts()
    if (!facts) return undefined
    const parts = [
      facts.price ? `${facts.price} per accepted task` : undefined,
      facts.accepted !== undefined && facts.terminal !== undefined
        ? `${facts.accepted} of ${facts.terminal} accepted`
        : undefined,
    ].filter((part): part is string => part !== undefined)
    return parts.length ? parts.join(", ") : undefined
  }
  const selectedContributors = () => {
    const inspection = visible()?.decisionInspection
    return inspection?.status === "found" ? inspection.contributorPage.contributors : []
  }
  type DecisionChartGraph = NonNullable<ModelComparisonPanelData["decisionOverview"]>["graph"]
  let chartReferencePoints: DecisionChartGraph["points"] | undefined
  let chartReferenceEstimates: DecisionChartGraph["referenceEstimates"] | undefined
  let chartReferenceCandidates: ModelComparisonPanelData["candidates"] | undefined
  let chartReferenceCatalog: ModelCatalogOutput["options"] | undefined
  let chartReferences: ComparisonChartReference[] = []
  const decisionChartReferences = createMemo(() => {
    const current = visible()
    const graph = current?.decisionOverview?.graph
    if (!graph) return []

    const candidates = current.candidates
    const catalogOptions = current.catalog?.options
    if (
      chartReferencePoints === graph.points &&
      chartReferenceEstimates === graph.referenceEstimates &&
      chartReferenceCandidates === candidates &&
      chartReferenceCatalog === catalogOptions
    )
      return chartReferences

    const points = new Map(graph.points.map((point) => [point.configurationID, point] as const))
    const catalog = catalogOptions ?? []
    const routes = (graph.referenceEstimates ?? []).map((item) => item.estimate.route)
    chartReferencePoints = graph.points
    chartReferenceEstimates = graph.referenceEstimates
    chartReferenceCandidates = candidates
    chartReferenceCatalog = catalogOptions
    chartReferences = (graph.referenceEstimates ?? []).map((item) => {
      const point = points.get(item.configurationID)
      return {
        configurationID: item.configurationID,
        estimate: item.estimate,
        // An explicit null is authoritative: never replace unknown global data
        // with a number or label discovered on a loaded page or inspection.
        tokensPerAcceptedTask: Object.hasOwn(item, "tokensPerAcceptedTask")
          ? (item.tokensPerAcceptedTask ?? null)
          : (point?.tokensPerAcceptedTask ?? null),
        label: modelDisplayLabel(item.estimate.route, routes, candidates, catalog),
      }
    })
    return chartReferences
  })
  let chartPointSource: DecisionChartGraph["points"] | undefined
  let chartPointReferences: ComparisonChartReference[] | undefined
  let chartPointCandidates: ModelComparisonPanelData["candidates"] | undefined
  let chartPointCatalog: ModelCatalogOutput["options"] | undefined
  let chartPointMarketSource:
    | NonNullable<ModelComparisonPanelData["decisionOverview"]>["context"]["priceIndex"]["source"]
    | undefined
  let chartPoints: ComparisonChartPoint[] = []
  const decisionChartPoints = createMemo(() => {
    const current = visible()
    const overview = current?.decisionOverview
    if (!overview) return []
    const references = decisionChartReferences()
    const candidates = current.candidates
    const catalogOptions = current.catalog?.options
    const marketSource = overview.context.priceIndex.source
    if (
      chartPointSource === overview.graph.points &&
      chartPointReferences === references &&
      chartPointCandidates === candidates &&
      chartPointCatalog === catalogOptions &&
      chartPointMarketSource === marketSource
    )
      return chartPoints

    const routeByConfiguration = new Map(
      references.map((reference) => [reference.configurationID, reference.estimate.route] as const),
    )
    const routes = references.map((reference) => reference.estimate.route)
    const catalog = catalogOptions ?? []
    chartPointSource = overview.graph.points
    chartPointReferences = references
    chartPointCandidates = candidates
    chartPointCatalog = catalogOptions
    chartPointMarketSource = marketSource
    chartPoints = overview.graph.points.map((point) => {
      const route = routeByConfiguration.get(point.configurationID)
      return {
        ...point,
        ...(route
          ? {
              label: modelDisplayLabel(route, routes, candidates, catalog),
              route,
            }
          : {}),
        marketSource,
      }
    })
    return chartPoints
  })
  const availableConfigurations = (): ModelDecisionConfiguration[] => {
    const current = visible()
    if (!current) return []
    const all = [
      ...current.decisionConfigurations,
      ...current.decisionRows.map((row) => row.configuration),
      ...(current.decisionInspection ? [current.decisionInspection.configuration] : []),
    ]
    const seen = new Set<string>()
    return all.filter((configuration) => {
      if (seen.has(configuration.configurationID)) return false
      seen.add(configuration.configurationID)
      return true
    })
  }
  const configurationsForGroup = (groupID: string) =>
    availableConfigurations().filter((configuration) => configuration.groupID === groupID)
  const providerChoices = () => {
    const groupByID = new Map<string, ModelDecisionConfiguration>()
    for (const configuration of availableConfigurations())
      if (!groupByID.has(configuration.groupID)) groupByID.set(configuration.groupID, configuration)
    return [...groupByID.values()]
  }
  // Public benchmark baseline. Units (Coding Index vs list price per 1M tokens) differ
  // from observed cost per task, so it is a separate chart mode, never a shared frontier.
  const [priceSourceRevision, setPriceSourceRevision] = createSignal(0)
  const priceSourceRequest = createMemo(
    () => {
      const value = current()
      return value ? { value, revision: priceSourceRevision() } : undefined
    },
    undefined,
    {
      equals: (previous, next) =>
        previous?.value === next?.value && previous?.revision === next?.revision,
    },
  )
  const priceSourceSettings = createLatest(priceSourceRequest, async ({ value }, signal) => {
    try {
      const settings = await value.client
        .rpc(Models)
        .priceSources(
          { sessionID: value.session },
          { location: { directory: value.directory }, signal },
        )
      return { value, sources: settings.policy.sources, configured: true }
    } catch {
      return { value, sources: [...MODEL_PRICE_SOURCES], configured: false }
    }
  })
  /** Configured price source order; the documented default until it is read. */
  const priceSourceOrder = (): { sources: ModelPriceSource[]; configured: boolean } => {
    const latest = priceSourceSettings.latest
    return latest && latest.value === current()
      ? latest
      : { sources: [...MODEL_PRICE_SOURCES], configured: false }
  }
  const comparisonSource = (
    source: "native-catalog" | "openrouter-models" | "openrouter-benchmarks",
  ) => visible()?.comparison?.sources.find((entry) => entry.source === source)
  const observedRouteKeys = createMemo(
    () =>
      new Set([
        ...availableConfigurations().map((configuration) => routeKey(configuration.route)),
        ...decisionChartReferences().map((reference) => routeKey(reference.estimate.route)),
      ]),
  )
  const baseline = createMemo(() => {
    const panel = visible()
    if (!panel) return undefined
    const candidates = panel.candidates
    const routes = candidates.map((candidate) => ({ ...candidate.identity, variant: null }))
    const catalog = panel.catalog?.options ?? []
    return benchmarkBaseline({
      candidates,
      priceSources: priceSourceOrder().sources,
      sourceDates: {
        openrouter: comparisonSource("openrouter-models")?.snapshot?.retrievedAt ?? null,
        opencode: comparisonSource("native-catalog")?.snapshot?.retrievedAt ?? null,
      },
      observedRoutes: observedRouteKeys(),
      label: (route) => modelDisplayLabel({ ...route, variant: null }, routes, candidates, catalog),
    })
  })
  const observedPlottedModels = () =>
    comparisonChartKeyboardOrder(decisionChartPoints(), decisionChartReferences()).length
  /** Benchmark leads only when observations are sparse and the baseline has data. */
  const compareMode = (): "observed" | "benchmark" => {
    const chosen = prefs().compareMode
    if (chosen) return chosen
    if (!visible()?.decisionOverview) return "observed"
    return observedPlottedModels() < 2 && (baseline()?.points.length ?? 0) > 0
      ? "benchmark"
      : "observed"
  }
  /** Epoch ms of the newest price snapshot; absent until one exists. */
  const pricesAsOfTime = () => {
    const times = (visible()?.comparison?.sources ?? [])
      .filter((entry) => entry.source !== "openrouter-benchmarks")
      .flatMap((entry) => (entry.snapshot ? [Date.parse(entry.snapshot.retrievedAt)] : []))
      .filter((time) => Number.isFinite(time))
    return times.length ? Math.max(...times) : undefined
  }
  const pricesAsOf = () => {
    const time = pricesAsOfTime()
    return time === undefined ? undefined : panelClock(time)
  }
  const disconnected = () => !props.session.server.connected
  const refreshAll = () => {
    setPriceSourceRevision((revision) => revision + 1)
    void state.refresh()
  }
  /**
   * The one loading surface: skeleton on a first load, one banner over kept content on a
   * refresh or reconnect, one sentence with Retry on failure.
   */
  const status = createPanelStatus(() => {
    const panel = visible()
    const benchmark = compareMode() === "benchmark"
    const hasContent = benchmark ? Boolean(panel?.comparison) : Boolean(panel?.decisionOverview)
    const decisionError =
      panel && ["error", "missing-rpc", "stale"].includes(panel.decisionStatus)
        ? panel.decisionError || panel.decisionStatus
        : ""
    const error = benchmark
      ? (panel?.comparisonError ?? "")
      : decisionError || panel?.comparisonError || panel?.sourceRefreshError || ""
    const loading =
      !panel ||
      (!error &&
        !hasContent &&
        (benchmark
          ? panel.comparisonLoading
          : panel.decisionStatus === "loading" || panel.decisionStatus === "backend-not-ready"))
    const tasks = panel?.tasks.length ?? 0
    const asOf = pricesAsOfTime()
    return {
      subject: "comparison",
      hasContent,
      loading,
      disconnected: disconnected(),
      error,
      ...(asOf === undefined ? {} : { asOf }),
      ...(tasks ? { progress: `${tasks} task${tasks === 1 ? "" : "s"} so far` } : {}),
    }
  })
  const selectCompareMode = (mode: "observed" | "benchmark") => save({ compareMode: mode })
  const observedScopeLabel = () => {
    const filters = visible()?.decisionFilters
    const scope = [
      filters?.persona ? modelPersonaLabels[filters.persona] : null,
      filters?.taskKind ? modelTaskKindLabels[filters.taskKind] : null,
    ].filter(Boolean)
    return scope.length ? `Observed for ${scope.join(" · ")}` : "Observed in this project"
  }
  const benchmarkPriceSourceLabel = () => {
    const used = new Set(baseline()?.points.map((point) => point.price.source) ?? [])
    const names = priceSourceOrder()
      .sources.filter((source) => used.has(source))
      .map((source) => benchmarkSourceName[source])
    return names.length ? names.join(" / ") : "Catalog"
  }
  const benchmarkAsOf = () => {
    const snapshot = comparisonSource("openrouter-benchmarks")?.snapshot
    const date = snapshot?.asOf ?? snapshot?.retrievedAt
    return date ? formatDate(date) : undefined
  }
  const benchmarkEmptyText = () => {
    const source = comparisonSource("openrouter-benchmarks")
    const current = baseline()
    if (!source?.snapshot)
      return "Public benchmark data hasn't been retrieved. It needs OpenRouter access configured in OpenCode; Refresh retries."
    if (!current || current.points.length + current.gaps.length === 0)
      return `None of the ${new Set(visible()?.candidates.map((candidate) => routeKey(candidate.identity))).size} loaded catalog models match a public benchmark yet.`
    return "Benchmarked models have no applicable list price from the configured price sources."
  }
  const selectedBenchmark = () => {
    const current = baseline()
    const selectedID = visible()?.selectedCandidateID
    if (!current || !selectedID) return undefined
    const candidate = visible()?.candidates.find((entry) => entry.candidateID === selectedID)
    const key = candidate ? routeKey(candidate.identity) : undefined
    return (
      current.points.find((point) => point.id === selectedID || routeKey(point.route) === key) ??
      current.gaps.find((gap) => gap.id === selectedID || routeKey(gap.route) === key)
    )
  }
  const observedConfigurationFor = (route: BenchmarkRoute) =>
    availableConfigurations().find(
      (configuration) =>
        configuration.route.providerID === route.providerID &&
        configuration.route.modelID === route.modelID,
    )
  const showObservedFor = (route: BenchmarkRoute) => {
    const configuration = observedConfigurationFor(route)
    selectCompareMode("observed")
    if (configuration) state.selectConfiguration(configuration.configurationID)
  }
  const changeDecisionFilters = (change: Partial<ModelDecisionFilters>) => {
    const current = visible()?.decisionFilters ?? emptyModelDecisionFilters
    const next: ModelDecisionFilters = {
      ...current,
      ...change,
      period: current.period,
    }
    save({ persona: next.persona, taskKind: next.taskKind })
    state.setDecisionFilters(next)
  }
  const selectDecisionGroup = (groupID: string) => {
    const configurations = configurationsForGroup(groupID)
    const current = selectedDecisionConfiguration()
    const next =
      configurations.find(
        (configuration) => configuration.configurationID === current?.configurationID,
      ) ?? configurations[0]
    if (next) state.selectConfiguration(next.configurationID)
    else {
      const point = visible()?.decisionOverview?.graph.points.find(
        (entry) => entry.groupID === groupID,
      )
      if (point) state.selectConfiguration(point.configurationID)
    }
  }
  const taskLabel = () => {
    const task = selectedTask()
    return task ? task.reference : visible()?.selectedTaskID ? "Task unavailable" : "Choose task"
  }
  const taskDescription = () => {
    const task = selectedTask()
    return task
      ? `${task.reference} · ${task.task.id} · ${task.task.proposal.objective}`
      : (visible()?.selectedTaskID ?? "Choose a task for comparison")
  }
  const projectLabel = () => current()?.project.split(/[\\/]/).filter(Boolean).at(-1) ?? "Project"
  const personas = () => visible()?.settings?.personas ?? []
  const assignmentSettings = () =>
    personas().find((persona) => persona.persona === assignmentPersona())
  const assignmentLayer = () => assignmentSettings()?.layers[assignmentScope()] ?? null
  const catalogOptions = () =>
    (visible()?.catalog?.options ?? []).filter((option) => option.enabled !== false)
  const selectedCatalogModel = () =>
    catalogOptions().find(
      (option) =>
        option.providerID === assignmentRoute().providerID && option.id === assignmentRoute().id,
    )
  const catalogOptionKey = (
    option: Pick<ModelCatalogOutput["options"][number], "providerID" | "id">,
  ) => JSON.stringify([option.providerID, option.id])
  const modelSelectionCaption = () => {
    const model = selectedCatalogModel()
    if (model) return `${model.providerID}/${model.id}`
    const route = assignmentRoute()
    return route.providerID && route.id ? `${route.providerID}/${route.id}` : "Choose a model"
  }
  const modelPickerButtonLabel = () => {
    const model = selectedCatalogModel()
    return model
      ? `${model.name || model.id} · ${model.providerID}`
      : assignmentRoute().providerID && assignmentRoute().id
        ? "Custom route"
        : "Choose model"
  }
  const assignmentVariantChoices = () => selectedCatalogModel()?.variants ?? []
  const assignmentVariantLabel = () => assignmentRoute().variant || "No variant"
  const assignmentEditorTitleID = () =>
    `lazers-models-assignment-editor-title-${encodeURIComponent(visible()?.key ?? "panel")}`
  const assignmentScopeLabel = (scope: ModelMappingTargetInput["scope"]) =>
    scope === "shared"
      ? "Shared default"
      : scope === "project"
        ? "Project override"
        : "Task override"
  const clearConfirmedAssignmentWrite = () => state.clearConfirmedAssignmentWrite()
  const selectAssignmentPersona = (persona: WorkerPersona) => {
    assignmentPickerRequest++
    clearConfirmedAssignmentWrite()
    setAssignmentPrefill(undefined)
    setAssignmentPersona(persona)
  }
  const selectAssignmentScope = (scope: ModelMappingTargetInput["scope"]) => {
    assignmentPickerRequest++
    clearConfirmedAssignmentWrite()
    setAssignmentScope(scope)
  }
  const updateAssignmentRoute = (change: Partial<ReturnType<typeof assignmentRoute>>) => {
    assignmentPickerRequest++
    clearConfirmedAssignmentWrite()
    setAssignmentRoute((previous) => ({ ...previous, ...change }))
  }
  const assignmentWrite = () => visible()?.assignmentWrite
  const assignmentBusy = () =>
    assignmentWrite()?.status === "saving" || assignmentWrite()?.status === "verifying"
  const assignmentBlocked = () =>
    assignmentBusy() ||
    assignmentWrite()?.status === "uncertain" ||
    assignmentWrite()?.status === "conflict" ||
    assignmentWrite()?.status === "failed"
  const assignmentCanSave = () => {
    const route = assignmentRoute()
    return Boolean(
      assignmentPersona() &&
      visible()?.settings &&
      !visible()?.settingsLoading &&
      !visible()?.settingsError &&
      !(assignmentScope() === "task" && !visible()?.selectedTaskID) &&
      route.providerID.trim() &&
      route.id.trim() &&
      !assignmentBlocked(),
    )
  }
  let lastAssignmentDraftKey = ""
  createEffect(() => {
    const panel = visible()
    const persona = assignmentPersona()
    const scope = assignmentScope()
    const setting = assignmentSettings()
    const prefill = assignmentPrefill()
    if (!panel?.settings || !persona || !setting) {
      lastAssignmentDraftKey = ""
      return
    }
    const layer = setting.layers[scope]
    const carried = prefill?.persona === persona ? prefill : undefined
    const key = `${panel.key}:${panel.settings.taskID ?? "project"}:${persona}:${scope}:${layer?.revision ?? 0}:${carried?.version ?? 0}`
    if (key === lastAssignmentDraftKey) return
    lastAssignmentDraftKey = key
    setAssignmentRoute(
      carried?.route ?? {
        providerID: layer?.route?.providerID ?? "",
        id: layer?.route?.id ?? "",
        variant: layer?.route?.variant ?? "",
      },
    )
  })
  const assignmentDirty = () => {
    const draft = assignmentRoute()
    const route = assignmentLayer()?.route
    return (
      draft.providerID !== (route?.providerID ?? "") ||
      draft.id !== (route?.id ?? "") ||
      draft.variant !== (route?.variant ?? "")
    )
  }
  const revertAssignmentRoute = () => {
    assignmentPickerRequest++
    clearConfirmedAssignmentWrite()
    setAssignmentPrefill(undefined)
    const route = assignmentLayer()?.route
    setAssignmentRoute({
      providerID: route?.providerID ?? "",
      id: route?.id ?? "",
      variant: route?.variant ?? "",
    })
  }
  // The editor always has a persona once assignments are known.
  createEffect(() => {
    if (prefs().tab !== "assignments" || assignmentPersona()) return
    const first = personas()[0]
    if (first) setAssignmentPersona(first.persona)
  })
  const saveAssignmentRoute = () => {
    const persona = assignmentPersona()
    if (!persona || !assignmentCanSave()) return
    const draft = assignmentRoute()
    const route: ModelPolicy = {
      providerID: draft.providerID,
      id: draft.id,
      ...(draft.variant.length ? { variant: draft.variant } : {}),
    }
    void state.configureMapping(persona, assignmentScope(), route)
  }
  const removeAssignmentRoute = () => {
    const persona = assignmentPersona()
    if (!persona || !assignmentLayer()?.route || assignmentBlocked()) return
    setAssignmentPrefill(undefined)
    void state.configureMapping(persona, assignmentScope(), null)
  }
  const assignmentLayerLabel = (
    label: string,
    layer: NonNullable<ReturnType<typeof assignmentSettings>>["layers"]["task"],
  ) => {
    if (!layer) return `${label}: Not set`
    if (!layer.route) return `${label}: Removed · revision ${layer.revision}`
    return `${label}: ${routeLabel({
      providerID: layer.route.providerID,
      modelID: layer.route.id,
      variant: layer.route.variant ?? null,
    })} · revision ${layer.revision}`
  }
  const openAssignmentModelPicker = async () => {
    const panel = visible()
    const persona = assignmentPersona()
    if (
      !panel ||
      !persona ||
      assignmentBlocked() ||
      panel.catalogStatus !== "ready" ||
      !catalogOptions().length
    )
      return

    const scope = assignmentScope()
    const taskID = panel.selectedTaskID
    const panelKey = panel.key
    const options = catalogOptions()
    const request = ++assignmentPickerRequest
    const selectedOption = selectedCatalogModel()
    let chosenKey: string | undefined
    try {
      chosenKey = await ctx.dialogs.select({
        title: "Choose a model",
        placeholder: "Search model name, provider, or ID",
        current: selectedOption ? catalogOptionKey(selectedOption) : undefined,
        options: options.map((option) => ({
          title: option.name || option.id,
          value: catalogOptionKey(option),
          group: option.providerID,
          description: `${option.providerID} ${option.id}${option.type ? ` · ${option.type}` : ""}`,
        })),
      })
    } catch {
      return
    }

    const currentPanel = visible()
    if (
      chosenKey === undefined ||
      request !== assignmentPickerRequest ||
      assignmentBlocked() ||
      currentPanel?.key !== panelKey ||
      currentPanel.selectedTaskID !== taskID ||
      assignmentPersona() !== persona ||
      assignmentScope() !== scope
    )
      return

    const option = options.find((candidate) => catalogOptionKey(candidate) === chosenKey)
    if (!option) return
    const previous = assignmentRoute()
    const sameModel = previous.providerID === option.providerID && previous.id === option.id
    updateAssignmentRoute({
      providerID: option.providerID,
      id: option.id,
      variant: sameModel ? previous.variant : "",
    })
  }
  /** Technical reason behind the status chip; shown only inside a collapsed disclosure. */
  const decisionStatusDetail = () => {
    const panel = visible()
    if (!panel) return undefined
    if (panel.decisionError) return panel.decisionError
    return panel.decisionStatus === "backend-not-ready"
      ? panel.decisionContext?.unavailableReason
      : undefined
  }
  const sourceWarning = () => {
    const sources = visible()?.comparison?.sources ?? []
    if (sources.some((source) => source.refresh?.state === "failed"))
      return {
        message: "A price source couldn't refresh; showing saved data.",
        role: "alert" as const,
      }
    if (sources.some((source) => source.refresh?.state === "cancelled"))
      return {
        message: "Source refresh cancelled; showing saved data.",
        role: "status" as const,
      }
    if (sources.some((source) => source.storage !== "ready"))
      return {
        message: "Some source details are missing; model names may not match.",
        role: "status" as const,
      }
    if (sources.length && sources.some((source) => !source.snapshot))
      return { message: "Some sources have no saved data yet.", role: "status" as const }
    return undefined
  }
  const effortDetailsSummary = () => {
    const basis = visible()?.effortBasis
    if (!basis) return "Recorded task effort"
    const partial =
      basis.usage.coverage.missingSessions.length > 0 ||
      basis.usage.coverage.unavailableSessions.length > 0 ||
      basis.usage.coverage.progressTruncated
    return `${basis.attempts.count} recorded attempts · ${basis.usage.coverage.totalUniqueSessions} sessions · ${partial ? "partial coverage" : "coverage available"}`
  }

  const selectTab = (tab: Tab) => save({ tab })
  /** Open the Assignments editor for a persona with a compared route as an unsaved draft. */
  const assignRoute = (
    persona: WorkerPersona,
    route: { providerID: string; modelID: string; variant: string | null },
    summary?: string,
  ) => {
    if (assignmentBlocked()) return
    assignmentPickerRequest++
    clearConfirmedAssignmentWrite()
    setAssignmentPrefill((previous) => ({
      persona,
      route: { providerID: route.providerID, id: route.modelID, variant: route.variant ?? "" },
      version: (previous?.version ?? 0) + 1,
      ...(summary ? { summary } : {}),
    }))
    setAssignmentPersona(persona)
    selectTab("assignments")
  }
  const assignSelectedRoute = (persona: WorkerPersona) => {
    const configuration = selectedDecisionConfiguration()
    if (configuration) assignRoute(persona, configuration.route, selectedFactsSummary())
  }
  const assignMenuItems = (route: () => BenchmarkRoute & { variant: string | null }) =>
    personas().map((persona) => ({
      label: persona.personaLabel,
      onSelect: () => assignRoute(persona.persona, route()),
    }))
  const assignDisabled = () =>
    !visible()?.settings || Boolean(visible()?.settingsLoading) || assignmentBlocked()
  const selectTask = (taskID: string) => {
    assignmentPickerRequest++
    state.selectTask(taskID)
  }
  const tabKey: JSX.EventHandler<HTMLButtonElement, KeyboardEvent> = (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return
    event.preventDefault()
    const next: Tab =
      event.key === "Home"
        ? "compare"
        : event.key === "End"
          ? "assignments"
          : prefs().tab === "compare"
            ? "assignments"
            : "compare"
    selectTab(next)
    const targetID =
      next === "compare" ? "lazers-models-compare-tab" : "lazers-models-assignments-tab"
    refs.topPane?.querySelector<HTMLButtonElement>(`#${targetID}`)?.focus()
  }

  const openSelectedTrajectory = () => {
    const task = selectedTask()
    const value = current()
    if (!task || !value) return
    const target: TaskTrajectoryRequest = {
      taskID: task.task.id,
      reference: task.reference,
      projectID: task.task.provenance.projectID,
      projectDirectory: value.project,
    }
    props.openTrajectory(props.session, target)
  }
  const openContributorTrajectory = (
    contributor: NonNullable<
      ModelComparisonPanelData["decisionInspection"]
    >["contributorPage"]["contributors"][number],
  ) => {
    const value = current()
    if (!value) return
    props.openTrajectory(props.session, {
      taskID: contributor.taskID,
      reference: contributor.taskReference,
      projectID: value.projectID,
      projectDirectory: value.project,
    })
  }

  const drag: JSX.EventHandler<HTMLDivElement, PointerEvent> = (event) => {
    endDrag?.()
    const key = expectedKey()
    const element = event.currentTarget
    element.setPointerCapture(event.pointerId)
    const move = (moveEvent: PointerEvent) => {
      const bounds = refs.root?.getBoundingClientRect()
      if (!bounds) return
      setSplit(clampSplit(((moveEvent.clientY - bounds.top) / bounds.height) * 100))
    }
    const end = () => {
      element.removeEventListener("pointermove", move)
      element.removeEventListener("pointerup", end)
      element.removeEventListener("pointercancel", end)
      if (expectedKey() === key) save({ split: split() })
      endDrag = undefined
    }
    element.addEventListener("pointermove", move)
    element.addEventListener("pointerup", end, { once: true })
    element.addEventListener("pointercancel", end, { once: true })
    endDrag = end
  }

  const categoryRows = [
    ["Uncached input", "uncachedInput"],
    ["Output", "output"],
    ["Reasoning", "reasoning"],
    ["Cache read", "cacheRead"],
    ["Cache write", "cacheWrite"],
  ] as const
  return {
    Ui,
    assignDisabled,
    assignMenuItems,
    assignRoute,
    assignSelectedRoute,
    assignmentBlocked,
    assignmentBusy,
    assignmentCanSave,
    assignmentEditorTitleID,
    assignmentLayer,
    assignmentLayerLabel,
    assignmentPersona,
    assignmentPrefill,
    assignmentRoute,
    assignmentScope,
    assignmentScopeLabel,
    assignmentSettings,
    assignmentVariantChoices,
    assignmentVariantLabel,
    assignmentWrite,
    availableConfigurations,
    baseline,
    benchmarkAsOf,
    benchmarkEmptyText,
    benchmarkPriceSourceLabel,
    catalogOptions,
    categoryRows,
    changeDecisionFilters,
    chartHeight,
    clearConfirmedAssignmentWrite,
    compareMode,
    pricesAsOf,
    disconnected,
    refreshAll,
    status,
    comparisonSource,
    configurationsForGroup,
    ctx,
    current,
    decisionChartPoints,
    decisionChartReferences,
    decisionModelChoiceLabel,
    decisionModelFullName,
    decisionModelLabel,
    decisionStatusDetail,
    drag,
    effortDetailsSummary,
    expectedKey,
    modelPickerButtonLabel,
    modelSelectionCaption,
    observedConfigurationFor,
    observedPlottedModels,
    observedRouteKeys,
    observedScopeLabel,
    openAssignmentModelPicker,
    openContributorTrajectory,
    openSelectedTrajectory,
    personas,
    prefs,
    priceSourceOrder,
    priceSourceRevision,
    projectLabel,
    providerChoices,
    refs,
    removeAssignmentRoute,
    save,
    saveAssignmentRoute,
    assignmentDirty,
    revertAssignmentRoute,
    selectedFacts,
    selectedFactsSummary,
    selectAssignmentPersona,
    selectAssignmentScope,
    selectCompareMode,
    selectDecisionGroup,
    selectTab,
    selectTask,
    selectedBenchmark,
    selectedCandidate,
    selectedCatalogModel,
    selectedContributors,
    selectedDecisionConfiguration,
    selectedMarketEstimate,
    selectedSummaryLine,
    selectedTask,
    setAssignmentPersona,
    setAssignmentPrefill,
    setAssignmentRoute,
    setAssignmentScope,
    setChartHeight,
    setPriceSourceRevision,
    setSplit,
    showObservedFor,
    sourceWarning,
    split,
    state,
    tabKey,
    taskDescription,
    taskLabel,
    updateAssignmentRoute,
    visible,
  }
}

export type ModelsController = ReturnType<typeof createModelsController>
