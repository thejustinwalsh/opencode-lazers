import { Streams } from "../streams/contract.ts"
import {
  createStream,
  readWindow,
  rpcStreamsTransport,
  type GuiStream,
  type StreamsRpc,
  type StreamsTransport,
} from "../streams/gui.ts"
import { taskScheduleRef } from "../streams/sources/tasks-ref.ts"
import {
  MODEL_ASSIGNMENTS_WINDOW,
  modelAssignmentsRef,
  modelBenchmarkRef,
  modelCandidatesRef,
  modelCatalogRef,
  modelContributorsRef,
  modelPointsRef,
  modelViewRef,
} from "../streams/sources/models-ref.ts"
import { summaryOf } from "../tasks/summary-row.ts"
import { createKeyed, createLatest, usePanel } from "@opencode/plugin/gui"
import { createPanelStatus } from "../panel-status.tsx"
import type { PanelProps } from "@opencode/plugin/gui"
import { createEffect, createMemo, createSignal, on, onCleanup, untrack } from "solid-js"
import type { Accessor, JSX } from "solid-js"
import { Models } from "./contract.ts"
import type { ModelSettingsOutput } from "./contract.ts"
import type { ModelPolicy } from "../runner/schema.ts"
import { isAgentSubject } from "./agent-ids.ts"
import type { ModelMappingSubject as WorkerPersona } from "./agent-ids.ts"
import { assignmentSettingsOf, type AssignmentLayerRow } from "./assignment-settings.ts"
import type { ModelMappingTargetInput } from "./mapping-schema.ts"
import type {
  ModelDecisionConfiguration,
  ModelDecisionContext,
  ModelDecisionContributor,
  ModelDecisionFilters,
  ModelDecisionInspect,
  ModelDecisionOverview,
} from "./decision-contract.ts"
import {
  benchmarkChartPoints,
  benchmarkSourceName,
  comparisonChartKeyboardOrder,
  observedChartPoints,
  projectedChartPoints,
} from "./chart-data.ts"
import type { CatalogEntry, CatalogSummary } from "./catalog-projection.ts"
import { referenceTokenProfile } from "./catalog-inputs.ts"
import { routeKey } from "./benchmark-baseline.ts"
import type {
  BenchmarkBaseline,
  BenchmarkBaselineGap,
  BenchmarkBaselinePoint,
  BenchmarkRoute,
} from "./benchmark-baseline.ts"
import { MODEL_PRICE_SOURCES } from "./price-source-settings.ts"
import type { ModelEvidenceSource } from "./source-schema.ts"
import { AA_BASIS } from "./public-score.ts"
import type { ModelPriceSource } from "./price-source-settings.ts"
import type { ComparisonChartPoint, ComparisonChartReference } from "./chart-data.ts"
import {
  ModelComparisonPanelState,
  decisionStatus as statusOfContext,
  emptyModelDecisionFilters,
} from "./comparison-state.ts"
import type {
  ModelComparisonPanelData,
  ModelComparisonTransport,
  ModelDecisionStatus,
} from "./comparison-state.ts"
import type { DecisionInspectionFacts } from "./decision-read.ts"
import type { DecisionViewBenchmark, DecisionViewSource } from "./decision-view.ts"
import { Tasks } from "../tasks/contract.ts"
import { Observability } from "../observability/contract.ts"
import type { TaskTrajectoryOpener, TaskTrajectoryRequest } from "../tasks/panel.tsx"
import {
  boundedModelLabel,
  currentMarketEstimateSummary,
  formatDate,
  joinSegments,
  routeLabel,
  selectedModelFacts,
} from "./comparison-presentation.ts"
import { READ_DEADLINE_MS, withReadDeadline } from "./read-deadline.ts"
import { panelClock } from "../panel-status.ts"
import {
  marketSummarySource,
  modelPersonaLabels,
  modelTaskKindLabels,
  modelsInitialPreference as initial,
} from "./panel-shared.ts"
import type { ModelsContext, Tab } from "./panel-shared.ts"

type ModelsProps = PanelProps & { ctx: ModelsContext; openTrajectory: TaskTrajectoryOpener }

/** A found inspection, as the pane draws it: the stored facts plus the contributor streams. */
export type ModelInspection = Extract<ModelDecisionInspect, { status: "found" }>

/** A picker option: one native model with its efforts (`models.candidates`, enabled rows). */
export type ModelCatalogOption = {
  providerID: string
  id: string
  name: string
  variants: string[]
}

/**
 * Stream windows of the Models panel, in items. Every window is the rows its view shows plus
 * slop; where the view draws every row (charts, the ranked table), the window is the stored count
 * of the view (`entry_count`, `point_count`, `benchmark_count`), which the view row carries.
 * Measured on the live-sized copy (2026-11-21): a view is 56 entries, 2–3 points and 84–127
 * contributors per configuration.
 */
const CONTRIBUTOR_ROWS = 20
/** The pane's contributor list: 20 rows in view, 10 of slop each side; "more" grows it by 20. */
const CONTRIBUTOR_WINDOW = CONTRIBUTOR_ROWS + 10 + 10
/** The selected task's own contributors, lifted to the top: one task has a few sessions. */
const SELECTED_TASK_CONTRIBUTORS = 10
/** The variants of the one model a route names: the window doubles while rows remain. */
const MODEL_VARIANT_WINDOW = 16
/** The picker's first read of enabled candidates; it doubles until every row is read. */
const PICKER_FIRST_WINDOW = 256

/** Picker options from candidate rows (provider, model, then the model's own row before its efforts). */
function catalogOptionsOf(rows: readonly Record<string, unknown>[]): ModelCatalogOption[] {
  const options = new Map<string, ModelCatalogOption>()
  for (const row of rows) {
    const providerID = String(row.provider_id)
    const id = String(row.model_id)
    const key = JSON.stringify([providerID, id])
    const option = options.get(key) ?? { providerID, id, name: "", variants: [] }
    if (!option.name && typeof row.name === "string") option.name = row.name
    if (typeof row.variant === "string") option.variants.push(row.variant)
    options.set(key, option)
  }
  return [...options.values()]
}

/** All shared state of the Models panel; the shell and both views read from it. */
export function createModelsController(props: ModelsProps) {
  const ctx = props.ctx
  const Ui = ctx.ui
  const frame = usePanel()
  const [data, setData] = createSignal<ModelComparisonPanelData>(
    new ModelComparisonPanelState(() => {}).data,
  )
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
  const keyOf = (value: ReturnType<typeof current>) =>
    value
      ? JSON.stringify([
          value.server,
          value.projectID,
          value.project,
          value.session,
          value.directory,
        ])
      : ""
  const expectedKey = () => keyOf(current())

  onCleanup(() => {
    assignmentPickerRequest++
    state.close()
  })

  // The user's pick between the available score bases; it drives the ranking's score column,
  // the cost-vs-score scatter and the Benchmark view alike. Not persisted.
  const [pickedBasis, setScoreBasisKey] = createSignal<string | null>(null)
  /** Benchmark leads only when observations are sparse and the baseline has data. */
  const compareMode = (): "observed" | "projected" | "benchmark" => {
    const chosen = prefs().compareMode
    if (chosen) return chosen
    if (!overview()) return "observed"
    // Projected is a choice, never the default: it is not backed by the user's runs alone.
    return observedPlottedModels() < 2 && benchmarkPointCount() > 0 ? "benchmark" : "observed"
  }

  /**
   * The streams of one connection. A decision view is named by the filters, the score basis and the
   * selected task (its routes are tagged routed); every view-backed stream reads the same view, so
   * a new selection reopens them together and the service builds the view once.
   */
  type Live = {
    view: GuiStream<typeof modelViewRef.columns & NonNullable<typeof modelViewRef.detail>>
    points: GuiStream<typeof modelPointsRef.columns>
    catalog: GuiStream<typeof modelCatalogRef.columns>
    benchmark: Accessor<GuiStream<typeof modelBenchmarkRef.columns> | undefined>
    contributors: Accessor<
      | {
          top: GuiStream<typeof modelContributorsRef.columns> | undefined
          rest: GuiStream<typeof modelContributorsRef.columns>
        }
      | undefined
    >
    pickerProbe: Accessor<GuiStream<typeof modelCandidatesRef.columns>>
    variants: Accessor<GuiStream<typeof modelCandidatesRef.columns> | undefined>
    /** Every enabled candidate, read once when the picker opens. */
    readOptions(): Promise<ModelCatalogOption[]>
  }
  const [live, setLive] = createSignal<Live>()
  const [contributorWindow, setContributorWindow] = createSignal(CONTRIBUTOR_WINDOW)
  const [catalogAttempt, setCatalogAttempt] = createSignal(0)
  /** Read the picker's catalog again after a failure. */
  const retryCatalog = () => setCatalogAttempt((attempt) => attempt + 1)
  // Value-equal selections: a state update that leaves them alone reopens no stream.
  const selectedTaskID = createMemo(() => data().selectedTaskID)
  const selectedConfigurationID = createMemo(() => data().selectedConfigurationID)
  const routeProvider = createMemo(() => assignmentRoute().providerID)
  const routeModel = createMemo(() => assignmentRoute().id)

  createKeyed(
    () => {
      const value = current()
      if (!value || !ctx.stores.modelsView(props.session).ready()) return undefined
      return { value, key: expectedKey() }
    },
    ({ value, key }) => {
      const view = untrack(prefs)
      const filters: ModelDecisionFilters = {
        persona: view.persona,
        taskKind: view.taskKind ?? null,
        period: { from: null, to: null },
      }
      const models = value.client.rpc(Models)
      const tasks = value.client.rpc(Tasks)
      const observations = value.client.rpc(Observability)
      const location = { location: { directory: value.directory } }
      const abort = new AbortController()
      onCleanup(() => abort.abort())
      const streams = rpcStreamsTransport(
        () => value.client.rpc(Streams) as unknown as StreamsRpc,
        abort.signal,
        { location: { directory: value.directory } },
      )
      const scope = { projectDirectory: value.project, sessionID: value.session }
      const transport: ModelComparisonTransport = {
        refreshSources: (parent, force) =>
          withReadDeadline(
            parent,
            (signal) =>
              models.refreshSources(
                { sessionID: value.session, ...(force ? { force: true } : {}) },
                { ...location, signal },
              ),
            2 * READ_DEADLINE_MS,
          ),
        // The authoritative readback after a mapping write: one window of the assignments.
        settings: (taskID, parent) =>
          withReadDeadline(parent, async () => {
            const rows = await readWindow(streams, modelAssignmentsRef, {
              filter: { ...scope, taskID: taskID ?? null },
              order: "subject",
              window: MODEL_ASSIGNMENTS_WINDOW,
            })
            return assignmentSettingsOf(
              rows as unknown as AssignmentLayerRow[],
              value.project,
              taskID ?? null,
            )
          }),
        configure: (update, signal) =>
          models.configure({ sessionID: value.session, ...update }, { ...location, signal }),
        queryTasks: (parent) =>
          withReadDeadline(parent, async (signal) => {
            // The newest tasks of the project, read as one stream window.
            const rows = await readWindow(
              rpcStreamsTransport(
                () => value.client.rpc(Streams) as unknown as StreamsRpc,
                signal,
                { location: { directory: value.directory } },
              ),
              taskScheduleRef,
              {
                filter: {
                  project: value.project,
                  scope: { kind: "project", sessionID: value.session },
                  state: "all",
                  includeRetired: true,
                },
                order: "recent",
                window: 100,
              },
            )
            return { projectDirectory: value.project, tasks: rows.map((row) => summaryOf(row)) }
          }),
        getTask: (taskID, signal) => tasks.get({ taskID }, { ...location, signal }),
        trajectoryStatus: (taskID, signal) =>
          observations.trajectoryStatus(
            { scope: { kind: "project", sessionID: value.session }, taskID },
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
        filters,
      )
      onCleanup(() => state.close())

      const selection = createMemo(
        () => ({ filters: data().decisionFilters, basis: pickedBasis(), taskID: selectedTaskID() }),
        undefined,
        { equals: (left, right) => JSON.stringify(left) === JSON.stringify(right) },
      )
      const viewFilter = () => ({ ...scope, view: selection() })
      const viewStream = createStream(streams, modelViewRef, () => ({
        filter: viewFilter(),
        order: "key",
        window: 1,
      }))
      const stored = (column: "point_count" | "entry_count" | "benchmark_count") =>
        createMemo(() => Math.max(1, Number(viewStream.items()[0]?.[column] ?? 0)))
      const pointCount = stored("point_count")
      const entryCount = stored("entry_count")
      const benchmarkCount = stored("benchmark_count")
      const points = createStream(streams, modelPointsRef, () => ({
        filter: viewFilter(),
        order: "chart",
        window: pointCount(),
      }))
      const catalog = createStream(streams, modelCatalogRef, () => ({
        filter: viewFilter(),
        order: "rank",
        window: entryCount(),
      }))
      // The Benchmark rows are read only while that view is shown.
      const benchmark = createMemo(
        on(benchmarkShown, (shown) =>
          shown
            ? createStream(streams, modelBenchmarkRef, () => ({
                filter: viewFilter(),
                order: "chart",
                window: benchmarkCount(),
              }))
            : undefined,
        ),
      )
      // The selected configuration's contributors: the selected task's first, then the rest.
      const contributors = createMemo(
        on([selectedConfigurationID, selectedTaskID], ([configurationID, taskID]) => {
          if (!configurationID) return undefined
          setContributorWindow(CONTRIBUTOR_WINDOW)
          const top = taskID
            ? createStream(streams, modelContributorsRef, () => ({
                filter: { ...viewFilter(), configurationID, taskID },
                order: "inspection",
                window: SELECTED_TASK_CONTRIBUTORS,
              }))
            : undefined
          const rest = createStream(streams, modelContributorsRef, () => ({
            filter: {
              ...viewFilter(),
              configurationID,
              ...(taskID ? { exceptTaskID: taskID } : {}),
            },
            order: "inspection",
            window: contributorWindow(),
          }))
          return { top, rest }
        }),
      )
      const assignments = createStream(streams, modelAssignmentsRef, () => ({
        filter: { ...scope, taskID: selectedTaskID() },
        order: "subject",
        window: MODEL_ASSIGNMENTS_WINDOW,
      }))
      createEffect(() => {
        const error = assignments.error()
        if (error) return state.settingsFailed(error.message)
        if (!assignments.loaded()) return
        state.applySettings(
          assignmentSettingsOf(
            assignments.items() as unknown as AssignmentLayerRow[],
            value.project,
            untrack(selectedTaskID),
          ),
        )
      })
      // Whether the picker has anything to offer: one enabled candidate, or none. Retry opens it anew.
      const pickerProbe = createMemo(
        on(catalogAttempt, () =>
          createStream(streams, modelCandidatesRef, () => ({
            filter: { ...scope, enabled: true },
            order: "catalog",
            window: 1,
          })),
        ),
      )
      // The efforts of the model the editor's route names.
      const [variantWindow, setVariantWindow] = createSignal(MODEL_VARIANT_WINDOW)
      const variants = createMemo(
        on([routeProvider, routeModel], ([providerID, modelID]) => {
          if (!providerID || !modelID) return undefined
          setVariantWindow(MODEL_VARIANT_WINDOW)
          const stream = createStream(streams, modelCandidatesRef, () => ({
            filter: { ...scope, providerID, modelID },
            order: "catalog",
            window: variantWindow(),
          }))
          createEffect(() => {
            if (stream.loaded() && stream.after() !== 0) setVariantWindow((size) => size * 2)
          })
          return stream
        }),
      )
      const readOptions = async () => {
        for (let window = PICKER_FIRST_WINDOW; ; window *= 2) {
          const rows = await readWindow(streams, modelCandidatesRef, {
            filter: { ...scope, enabled: true },
            order: "catalog",
            window,
          })
          if (rows.length < window) return catalogOptionsOf(rows)
        }
      }
      setLive({
        view: viewStream as Live["view"],
        points,
        catalog,
        benchmark,
        contributors,
        pickerProbe,
        variants,
        readOptions,
      })
      onCleanup(() => setLive(undefined))
    },
    {
      equals: (left, right) => left.key === right.key && left.value.client === right.value.client,
      otherwise: () => state.close(),
    },
  )

  // -- What the streams hold, in the shapes the views draw ---------------------------------------
  const viewRow = () => live()?.view.items()[0]
  /**
   * What the panel draws while a new view builds (another task, basis or filter): the last ready
   * view of this connection stays on screen until the new one is written. Only a first build, with
   * nothing to keep, shows as building.
   */
  const held = <T>(read: () => T, empty: T) =>
    createMemo<T>((previous) =>
      viewRow()?.state === "ready" ? read() : live() ? (previous ?? empty) : empty,
    )
  const viewDetail = held(() => viewRow(), undefined)
  type PointRow = {
    configuration_id: string
    group_id: string
    display_label: string
    frontier: boolean
    point: ModelDecisionOverview["graph"]["points"][number] | null
    reference: NonNullable<ModelDecisionOverview["graph"]["referenceEstimates"]>[number] | null
    reference_ord: number | null
    chart: ComparisonChartPoint | null
    chart_reference: ComparisonChartReference | null
    inspection: DecisionInspectionFacts
  }
  const pointRows = held(
    () => (live()?.points.items() ?? []) as unknown as PointRow[],
    [] as PointRow[],
  )
  const decisionContext = () => viewDetail()?.context as ModelDecisionContext | undefined
  /** The overview the chart and the pane read, rebuilt from the view's configuration rows. */
  const overview = createMemo((): ModelDecisionOverview | undefined => {
    const row = viewDetail()
    if (!row) return undefined
    const rows = pointRows()
    const counts = row.counts as { configurationCount: number; groupCount: number }
    return {
      context: row.context as ModelDecisionContext,
      configurationCount: counts.configurationCount,
      groupCount: counts.groupCount,
      graph: {
        scope: "global-filtered-snapshot",
        points: rows.flatMap((item) => (item.point ? [item.point] : [])),
        frontierConfigurationIDs: rows
          .filter((item) => item.frontier)
          .map((item) => item.configuration_id)
          .sort((left, right) => left.localeCompare(right)),
        referenceEstimates: rows
          .filter((item) => item.reference !== null)
          .toSorted((left, right) => (left.reference_ord ?? 0) - (right.reference_ord ?? 0))
          .map((item) => item.reference!),
      },
    } as ModelDecisionOverview
  })
  const decisionChartPoints = createMemo(() =>
    pointRows().flatMap((item) => (item.chart ? [item.chart] : [])),
  )
  const decisionChartReferences = createMemo(() =>
    pointRows()
      .filter((item) => item.chart_reference !== null)
      .toSorted((left, right) => (left.reference_ord ?? 0) - (right.reference_ord ?? 0))
      .map((item) => item.chart_reference!),
  )
  const availableConfigurations = (): ModelDecisionConfiguration[] =>
    pointRows().map((item) => item.inspection.configuration)
  const sources = () => (viewDetail()?.sources ?? []) as DecisionViewSource[]
  const benchmarkMeta = () => viewDetail()?.benchmark as DecisionViewBenchmark | undefined
  const benchmarkPointCount = () => Number(viewDetail()?.benchmark_count ?? 0)
  /** A first build with nothing held to show (first open, or a dropped view opened again). */
  const building = () => viewRow()?.state === "backfilling" && !viewDetail()
  const viewError = () => live()?.view.error()?.message ?? live()?.points.error()?.message ?? ""
  const viewStatus = (): ModelDecisionStatus => {
    const context = decisionContext()
    if (context) return statusOfContext(context, props.session.server.connected)
    return viewError() ? "error" : "loading"
  }
  /** The selected configuration's row, when the view holds it. */
  const selectedRow = () => {
    const id = selectedConfigurationID()
    return id ? pointRows().find((item) => item.configuration_id === id) : undefined
  }
  // No selection yet: the first configuration is selected, as the decision read did.
  createEffect(() => {
    const rows = pointRows()
    if (rows.length && !selectedConfigurationID())
      state.selectConfiguration(rows[0]!.configuration_id)
  })
  const contributorRows = createMemo(() => {
    const streams = live()?.contributors()
    if (!streams) return { rows: [], total: 0, more: false, loading: false }
    const top = (streams.top?.items() ?? []).map((row) => row.detail)
    const rest = streams.rest.items().map((row) => row.detail)
    const after = streams.rest.after()
    const count = (value: number | "more") => (value === "more" ? 0 : value)
    return {
      rows: [...top, ...rest] as ModelDecisionContributor[],
      total: top.length + count(streams.rest.before()) + rest.length + count(after),
      more: after !== 0,
      loading: !streams.rest.loaded() || (streams.top ? !streams.top.loaded() : false),
    }
  })
  /** The selected configuration's inspection: its stored facts and the contributor streams. */
  const inspection = createMemo((): ModelInspection | undefined => {
    const row = selectedRow()
    const context = decisionContext()
    if (!row || !context) return undefined
    const contributors = contributorRows()
    return {
      status: "found",
      context,
      selectedTaskID: selectedTaskID(),
      ...row.inspection,
      contributorPage: {
        contributors: contributors.rows,
        totalCount: contributors.total,
        nextCursor: contributors.more ? "more" : null,
      },
    } as ModelInspection
  })
  const catalogEntries = held(
    () => (live()?.catalog.items() ?? []).map((row) => row.detail as unknown as CatalogEntry),
    [] as CatalogEntry[],
  )
  const catalogSummary = () => viewDetail()?.summary as CatalogSummary | undefined
  const baseline = createMemo((): BenchmarkBaseline | undefined => {
    const meta = benchmarkMeta()
    if (!meta) return undefined
    const rows = live()?.benchmark()?.items() ?? []
    return {
      points: rows
        .filter((row) => row.kind === "point")
        .map((row) => row.detail as unknown as BenchmarkBaselinePoint),
      gaps: rows
        .filter((row) => row.kind === "gap")
        .map((row) => row.detail as unknown as BenchmarkBaselineGap),
      unmatchedRoutes: meta.unmatchedRoutes,
      ambiguousRoutes: meta.ambiguousRoutes,
      priceSources: meta.priceSources,
      scoreBasis: meta.scoreBasis,
    }
  })
  const catalogStatus = (): "loading" | "ready" | "unavailable" => {
    const probe = live()?.pickerProbe()
    if (probe?.error()) return "unavailable"
    return probe?.loaded() ? "ready" : "loading"
  }
  /** What the panel shows: the state's selections and reads, with the streams' data beside them. */
  const visible = createMemo(() => {
    const panel = data()
    if (!panel.key || panel.key !== expectedKey()) return undefined
    const contributors = contributorRows()
    return {
      ...panel,
      comparison: { sources: sources(), publicCoverage: benchmarkMeta()?.publicCoverage },
      decisionStatus: viewStatus(),
      decisionError: viewError() || String(viewRow()?.last_error ?? ""),
      decisionContext: decisionContext(),
      decisionOverview: overview(),
      decisionInspection: inspection(),
      decisionInspectLoading: false,
      decisionInspectError:
        live()?.contributors()?.rest.error()?.message ??
        live()?.contributors()?.top?.error()?.message ??
        "",
      decisionNotFound: Boolean(
        panel.selectedConfigurationID && viewDetail() && live()?.points.loaded() && !selectedRow(),
      ),
      decisionContributorsLoading: contributors.loading,
      catalogStatus: catalogStatus(),
      catalogError: live()?.pickerProbe().error()?.message ?? "",
      comparisonError: viewError(),
    }
  })
  /** More contributors of the selected configuration: the pane's window grows by a screen. */
  const moreContributors = () => setContributorWindow((size) => size + CONTRIBUTOR_ROWS)

  /** A configuration's full label among the view's configurations and references. */
  const decisionModelFullName = (configuration: ModelDecisionConfiguration) =>
    pointRows().find((item) => item.configuration_id === configuration.configurationID)
      ?.display_label ?? routeLabel(configuration.route)
  const decisionModelLabel = (configuration: ModelDecisionConfiguration) =>
    boundedModelLabel(decisionModelFullName(configuration))
  const decisionModelChoiceLabel = (configuration: ModelDecisionConfiguration) => {
    const friendly = decisionModelFullName(configuration)
    const exactRoute = routeLabel(configuration.route)
    return friendly.includes(exactRoute) ? friendly : `${friendly} · ${exactRoute}`
  }
  const selectedTask = () => visible()?.task
  const selectedDecisionConfiguration = () => selectedRow()?.inspection.configuration
  /**
   * The last inspection that arrived for this project. A selection or refresh keeps showing it,
   * dimmed, until the next one replaces it, so the pane never blanks and its disclosures stay open.
   */
  const heldInspection = createMemo<ModelInspection | undefined>((previous) => {
    const panel = visible()
    return panel ? (panel.decisionInspection ?? previous) : undefined
  })
  const heldMatchesSelection = () =>
    heldInspection()?.configuration.configurationID === visible()?.selectedConfigurationID
  const selectedMarketEstimate = () => {
    const inspection = heldInspection()
    if (!inspection || inspection.status !== "found") return undefined
    const context = inspection.context
    const freshness =
      visible()?.stale || visible()?.decisionStatus === "stale" || context.freshness === "stale"
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
  const selectedFacts = () => {
    const inspection = heldInspection()
    if (!inspection || inspection.status !== "found") return undefined
    return selectedModelFacts({
      estimate: inspection.estimate,
      referenceEstimate: inspection.referenceEstimate,
      efficiency: inspection.efficiency,
      cohort: inspection.cohort,
      ...(inspection.medianAcceptedDurationMs === undefined
        ? {}
        : { medianDurationMs: inspection.medianAcceptedDurationMs }),
    })
  }
  const [dataMount, setDataMount] = createSignal<HTMLElement>()
  const filterPersona = () =>
    personas().find((persona) => persona.persona === visible()?.decisionFilters.persona)
  /** Right-hand hint of the basis disclosure, e.g. "OpenRouter · 17 Nov". */
  const basisHint = () => {
    const summary = selectedMarketEstimate()
    const time = pricesAsOfTime()
    const date =
      time === undefined
        ? undefined
        : new Date(time).toLocaleDateString([], { day: "numeric", month: "short" })
    const parts = [summary ? marketSummarySource(summary.context) : undefined, date].filter(
      (part): part is string => part !== undefined,
    )
    return parts.length ? parts.join(" · ") : undefined
  }
  /** "$0.35 – 0.67 per accepted task, 9 of 11 accepted"; each part is dropped when absent. */
  const selectedFactsSummary = () => {
    const facts = heldMatchesSelection() ? selectedFacts() : undefined
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
    const inspection = heldInspection()
    return inspection?.status === "found" ? inspection.contributorPage.contributors : []
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
  const comparisonSource = (source: ModelEvidenceSource) =>
    visible()?.comparison?.sources.find((entry) => entry.source === source)
  const observedRouteKeys = createMemo(
    () =>
      new Set([
        ...availableConfigurations().map((configuration) => routeKey(configuration.route)),
        ...decisionChartReferences().map((reference) => routeKey(reference.estimate.route)),
      ]),
  )
  const observedPlottedModels = () =>
    comparisonChartKeyboardOrder(decisionChartPoints(), decisionChartReferences()).length
  /** Median tokens per accepted task by category across our observed configurations. */
  const profile = createMemo(() => referenceTokenProfile(overview()?.graph))
  /** The LAZERS agents with the model native OpenCode resolves for each (read-only). */
  const agentRoutes = createMemo(() => visible()?.settings?.agents ?? [])
  const observedPriceSourceName = () =>
    ({ openrouter: "OpenRouter", opencode: "OpenCode", mixed: "Configured" })[
      (visible()?.decisionOverview?.context.priceIndex.source ?? "") as
        "openrouter" | "opencode" | "mixed"
    ]
  const observedPoints = createMemo(() => {
    return observedChartPoints(
      {
        points: decisionChartPoints(),
        references: decisionChartReferences(),
        frontierConfigurationIDs: [],
      },
      observedPriceSourceName(),
    )
  })
  const projectedPoints = createMemo(() => projectedChartPoints(catalogEntries()))
  const benchmarkPoints = createMemo(() => benchmarkChartPoints(baseline()?.points ?? []))
  const benchmarkShown = createMemo(() => compareMode() === "benchmark")
  /** The one catalog line, while the view is first built: nothing stored to show yet. */
  const catalogLoadingLine = () => {
    if (compareMode() === "observed" || catalogEntries().length > 0) return undefined
    if (!building() && visible()?.sourceRefresh !== "refreshing") return undefined
    const names = priceSourceOrder().sources.map((source) => benchmarkSourceName[source])
    return `Building catalog · ${names.join(", ")}`
  }
  /** One sentence per source that has nothing stored, for "Estimate basis and prices". */
  const catalogNotes = () => {
    const names = {
      "native-catalog": "OpenCode catalog",
      "openrouter-models": "OpenRouter catalog",
      "openrouter-benchmarks": "OpenRouter benchmarks",
      "models-dev": "models.dev",
      "epoch-benchmarks": "Epoch AI benchmarks",
    } as const
    return sources()
      .filter((source) => !source.snapshot && source.refresh?.state !== "refreshing")
      .map((source) => `${names[source.source]} unavailable`)
  }
  /** Epoch ms of the newest price snapshot; absent until one exists. */
  /** The oldest price snapshot among the sources prices are taken from. */
  const pricesAsOfTime = () => {
    const used = new Set(
      priceSourceOrder().sources.map((source) =>
        source === "openrouter" ? "openrouter-models" : "native-catalog",
      ),
    )
    const times = sources()
      .filter((entry) => used.has(entry.source as never))
      .flatMap((entry) => (entry.snapshot ? [Date.parse(entry.snapshot.retrievedAt)] : []))
      .filter((time) => Number.isFinite(time))
    return times.length ? Math.min(...times) : undefined
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
    // A view is content once it is built; Benchmark needs its rows too.
    const hasContent = benchmark
      ? Boolean(viewDetail() && live()?.benchmark()?.loaded())
      : Boolean(panel?.decisionOverview)
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
        (panel.decisionStatus === "loading" || panel.decisionStatus === "backend-not-ready"))
    const tasks = panel?.tasks.length ?? 0
    const asOf = pricesAsOfTime()
    // A view still being built says so; it never shows as empty or unknown.
    const progress = building()
      ? "building it from your runs"
      : tasks
        ? `${tasks} task${tasks === 1 ? "" : "s"} so far`
        : undefined
    return {
      subject: "comparison",
      hasContent,
      loading,
      disconnected: disconnected(),
      error,
      ...(asOf === undefined ? {} : { asOf }),
      ...(progress ? { progress } : {}),
    }
  })
  /** The row to mark as selected in "All models": by configuration when observed. */
  const allModelsSelectedID = () => {
    const configurationID = visible()?.selectedConfigurationID
    if (compareMode() === "observed" && configurationID)
      return (
        catalogEntries().find((item) => item.observed?.configurationID === configurationID)?.id ??
        null
      )
    return selectedEntryID()
  }
  /** A table row selects its point: the observed configuration, or the entry in Projected. */
  const selectedEntryID = () => visible()?.selectedCandidateID ?? null
  const pickEntryID = (id: string) => state.selectCandidate(id)
  const selectEntry = (entry: CatalogEntry) => {
    if (compareMode() === "observed" && entry.observed) {
      state.selectConfiguration(entry.observed.configurationID)
      return
    }
    if (compareMode() === "benchmark") pickEntryID(entry.id)
    else {
      selectCompareMode("projected")
      pickEntryID(entry.id)
    }
  }
  const selectCompareMode = (mode: "observed" | "projected" | "benchmark") =>
    save({ compareMode: mode })
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
  /** The public score that ranks the set: the Coding Index, or one Epoch benchmark. */
  const scoreBasis = () => baseline()?.scoreBasis ?? AA_BASIS
  const scoreOptionsList = () => benchmarkMeta()?.scoreOptions ?? []
  const scoreBasisKey = () => {
    const basis = scoreBasis()
    return basis.source === "epoch" ? basis.benchmarkID : "aa"
  }
  const benchmarkAsOf = () => {
    const snapshot = comparisonSource(
      scoreBasis().source === "epoch" ? "epoch-benchmarks" : "openrouter-benchmarks",
    )?.snapshot
    const date = snapshot?.asOf ?? snapshot?.retrievedAt
    return date ? formatDate(date) : undefined
  }
  /** The comparison loaded but no benchmark source has delivered anything: none is reachable. */
  const benchmarkNeedsOpenRouter = () =>
    Boolean(viewDetail()) &&
    !comparisonSource("openrouter-benchmarks")?.snapshot &&
    !comparisonSource("epoch-benchmarks")?.snapshot &&
    !(baseline()?.points.length || baseline()?.gaps.length)
  /** How many Epoch rows reach a model of this catalog, with the names that did not. */
  const epochCoverage = () => visible()?.comparison?.publicCoverage?.epoch ?? null
  /** "34 of 35 SWE-bench Verified rows matched", for the ranking benchmark. */
  const epochCoverageLine = () => {
    const coverage = epochCoverage()
    if (!coverage) return undefined
    const wanted = scoreBasis().benchmarkID ?? "swe-bench-verified"
    const row =
      coverage.benchmarks.find((entry) => entry.benchmarkID === wanted) ?? coverage.benchmarks[0]
    return row ? `${row.matched} of ${row.rows} ${row.benchmark} rows matched` : undefined
  }
  /** Scored models no configured source prices: left off the cost plots, counted and named. */
  const scoredWithoutPrice = () =>
    (baseline()?.gaps ?? []).filter((gap) => gap.reason === "no-price").map((gap) => gap.label)
  const benchmarkEmptyText = () => {
    const current = baseline()
    if (!current || current.points.length + current.gaps.length === 0)
      return `None of the ${benchmarkMeta()?.catalogRoutes ?? 0} loaded catalog models match a public benchmark yet.`
    return "Benchmarked models have no applicable list price from the configured price sources."
  }
  /** "14 accepted tasks · OpenRouter prices" under the observed chart. */
  const observedCaption = () => {
    const overview = visible()?.decisionOverview
    if (!overview) return undefined
    const accepted = overview.graph.points.reduce((sum, point) => sum + point.acceptedTaskCount, 0)
    const source = { openrouter: "OpenRouter", opencode: "OpenCode", mixed: "Configured" }[
      overview.context.priceIndex.source as "openrouter" | "opencode" | "mixed"
    ]
    return (
      joinSegments([
        accepted > 0 && `${accepted} accepted task${accepted === 1 ? "" : "s"}`,
        source && `${source} prices`,
      ]) || undefined
    )
  }
  const openProviderSettings = () => props.ctx.layout.settings("providers")
  const selectedBenchmark = () => {
    const current = baseline()
    const selectedID = selectedEntryID()
    if (!current || !selectedID) return undefined
    const entry = catalogEntries().find((item) => item.id === selectedID)
    const key = entry ? routeKey(entry.route) : undefined
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
  const taskDescription = () => {
    const task = selectedTask()
    return task
      ? `${task.reference} · ${task.task.id} · ${task.task.proposal.objective}`
      : (visible()?.selectedTaskID ?? "Choose a task for comparison")
  }
  const projectLabel = () => current()?.project.split(/[\\/]/).filter(Boolean).at(-1) ?? "Project"
  const subjects = () => visible()?.settings?.personas ?? []
  /** The worker personas: what a compared model is assigned to. */
  const personas = () => subjects().filter((entry) => !isAgentSubject(entry.persona))
  /** Architect, Implementor and Auditor, with the effective model each starts on. */
  const agentSubjects = () => subjects().filter((entry) => isAgentSubject(entry.persona))
  const assignmentSettings = () =>
    subjects().find((persona) => persona.persona === assignmentPersona())
  const assignmentLayer = () => assignmentSettings()?.layers[assignmentScope()] ?? null
  /** The picker has no enabled model to offer (its probe read none). */
  const catalogEmpty = () =>
    catalogStatus() === "ready" && (live()?.pickerProbe().items().length ?? 0) === 0
  /** The model the editor's route names, with its efforts, when the catalog lists it. */
  const selectedCatalogModel = (): ModelCatalogOption | undefined => {
    const rows = live()?.variants()?.items() ?? []
    return catalogOptionsOf(rows)[0]
  }
  const catalogOptionKey = (option: Pick<ModelCatalogOption, "providerID" | "id">) =>
    JSON.stringify([option.providerID, option.id])
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
  // No effort stored means none is sent, so the provider applies its own default effort.
  const assignmentVariantLabel = () => assignmentRoute().variant || "Default"
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
      catalogEmpty()
    )
      return

    const scope = assignmentScope()
    const taskID = panel.selectedTaskID
    const panelKey = panel.key
    const request = ++assignmentPickerRequest
    let options: ModelCatalogOption[]
    try {
      options = (await live()?.readOptions()) ?? []
    } catch {
      return
    }
    if (request !== assignmentPickerRequest || !options.length) return
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
          description: `${option.providerID} ${option.id}`,
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
    save({ taskFilter: true })
    state.selectTask(taskID)
  }
  /** Drop the task chip; the open task stays selected for the task detail below. */
  const clearTaskFilter = () => save({ taskFilter: false })
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
    contributor: ModelInspection["contributorPage"]["contributors"][number],
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
    benchmarkNeedsOpenRouter,
    scoredWithoutPrice,
    epochCoverage,
    epochCoverageLine,
    scoreBasis,
    scoreBasisKey,
    setScoreBasisKey,
    scoreOptions: scoreOptionsList,
    observedCaption,
    openProviderSettings,
    benchmarkPriceSourceLabel,
    catalogEmpty,
    retryCatalog,
    moreContributors,
    categoryRows,
    changeDecisionFilters,
    clearTaskFilter,
    clearConfirmedAssignmentWrite,
    compareMode,
    allModelsSelectedID,
    pickEntryID,
    selectedEntryID,
    selectEntry,
    catalogEntries,
    catalogNotes,
    catalogSummary,
    catalogLoadingLine,
    observedPoints,
    profile,
    projectedPoints,
    benchmarkPoints,
    pricesAsOf,
    heldInspection,
    dataMount,
    setDataMount,
    filterPersona,
    basisHint,
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
    agentSubjects,
    agentRoutes,
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
    selectedCatalogModel,
    selectedContributors,
    selectedDecisionConfiguration,
    selectedMarketEstimate,
    selectedTask,
    setAssignmentPersona,
    setAssignmentPrefill,
    setAssignmentRoute,
    setAssignmentScope,
    setPriceSourceRevision,
    showObservedFor,
    sourceWarning,
    state,
    tabKey,
    taskDescription,
    updateAssignmentRoute,
    visible,
  }
}

export type ModelsController = ReturnType<typeof createModelsController>
