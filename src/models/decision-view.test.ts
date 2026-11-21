import { Database } from "bun:sqlite"
import { afterAll, beforeAll, expect, test } from "bun:test"
import { rewriteAttemptFacts } from "../../test/models-observation-ledger/fixtures/attempt-facts.ts"
import { makeLedgerFixture } from "../../test/models-observation-ledger/fixtures/ledger.ts"
import { openStream } from "../streams/client.ts"
import { readerPool, type ReaderPool } from "../streams/pool.ts"
import {
  modelBenchmarkSource,
  modelCatalogSource,
  modelContributorsSource,
  modelPointsSource,
  modelViewSource,
} from "../streams/sources/models.ts"
import { acquireSharedConnection, TaskRepository } from "../storage.ts"
import type { BenchmarkRoute } from "./benchmark-baseline.ts"
import { seedEvidenceCorpus } from "./candidate.fixture.ts"
import { ensureModelCandidatesSchema, refreshModelCandidates } from "./candidate-store.ts"
import { benchmarkBaseline, routeKey } from "./benchmark-baseline.ts"
import { catalogFor, chartPoints, chartReferences, modelDisplayLabeler } from "./catalog-inputs.ts"
import { modelDisplayLabel } from "./comparison-presentation.ts"
import { scoreOptions } from "./public-score.ts"
import { readModelComparison } from "./comparison-read.ts"
import { ModelDecisionReadInputSchema } from "./decision-contract.ts"
import type { ModelDecisionFilters } from "./decision-contract.ts"
import { createModelDecisionReader } from "./decision-read.ts"
import {
  dropIdleDecisionViews,
  ensureDecisionViewSchema,
  openDecisionView,
  writeDecisionView,
} from "./decision-store.ts"
import {
  buildDecisionView,
  DecisionViewRequestSchema,
  type DecisionViewCall,
  type DecisionViewResult,
} from "./decision-view-build.ts"
import {
  decisionViewIdentity,
  readCandidateSet,
  readSourceStamps,
  readSourceSummaries,
  sourceDatesOf,
} from "./decision-view.ts"
import { DecisionViews } from "./decision-views.ts"
import { registerDecisionViewOpener } from "./decision-view-registry.ts"
import { createStreamsService } from "../streams/rpc.ts"
import { createThreadedDecisionWorker } from "./decision-worker-client.ts"
import { openReadOnlyObservationLedger } from "./observation-ledger-read.ts"
import { readDecisionPriceState, readPriceIdentity } from "./price-state.ts"
import type { PriceInputs } from "./price-state.ts"
import { defaultModelPriceSourcePolicy } from "./price-source-settings.ts"
import { ModelEvidenceReadStore, ModelEvidenceStore } from "./source-store.ts"

const priceInputs = (): PriceInputs => ({
  policy: defaultModelPriceSourcePolicy(),
  openrouter: "configured",
})

let fixture: ReturnType<typeof makeLedgerFixture>
let repository: TaskRepository
let pool: ReaderPool
let reader: ReturnType<typeof createModelDecisionReader>
let evidence: ModelEvidenceReadStore
let nativeNames: { providerID: string; id: string; name: string }[]
const routed: BenchmarkRoute[] = [
  { providerID: "openai", modelID: "gpt-5" },
  { providerID: "anthropic", modelID: "claude-haiku-4-5" },
]

/** Give an attempt's recorded steps an observed route and usage, as `decision-read.test.ts` does. */
function observeRoute(
  path: string,
  attemptID: string,
  route: { providerID: string; modelID: string; variant: string | null },
  input: number,
) {
  const db = new Database(path, { strict: true })
  try {
    const rows = db
      .query<{ seq: number; kind: string; payload: string }, [string]>(
        "SELECT seq,kind,payload FROM runner_progress WHERE attempt_id=? ORDER BY seq",
      )
      .all(attemptID)
    for (const row of rows) {
      if (row.kind !== "step" && row.kind !== "usage-snapshot") continue
      const payload = JSON.parse(row.payload) as Record<string, unknown>
      payload.usage = { input, output: input / 2, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
      payload.routeEvidence = { status: "observed", route }
      payload.route = route
      db.query("UPDATE runner_progress SET payload=?,message_id=? WHERE seq=?").run(
        JSON.stringify(payload),
        `view-test-call-${row.seq}`,
        row.seq,
      )
    }
  } finally {
    db.close()
  }
}

beforeAll(() => {
  fixture = makeLedgerFixture()
  const gpt = { providerID: "openrouter", modelID: "vendor/model", variant: "high" }
  // Complete usage on a route OpenRouter prices: the accepted task is a priced graph point.
  rewriteAttemptFacts(fixture.path, fixture.projectID, fixture.attempts.failed.id, gpt)
  rewriteAttemptFacts(
    fixture.path,
    fixture.projectID,
    fixture.attempts.accepted.id,
    gpt,
    [1_000, 400],
  )
  observeRoute(
    fixture.path,
    fixture.attempts.adoption.id,
    { providerID: "anthropic", modelID: "claude-haiku-4-5", variant: null },
    2_000,
  )
  const writer = new ModelEvidenceStore(fixture.path, fixture.projectDirectory)
  // Retrieved now: current prices, so observed configurations are priced and plotted.
  const saved = seedEvidenceCorpus(writer, fixture.projectDirectory, new Date().toISOString())
  writer.close()
  nativeNames = saved["native-catalog"]!.records.map((record) => {
    const native = record as { providerID: string; id: string; name: string }
    return { providerID: native.providerID, id: native.id, name: native.name }
  })
  repository = new TaskRepository(fixture.path, fixture.projectDirectory)
  ensureModelCandidatesSchema(repository)
  repository.atomic((db) => refreshModelCandidates(db, fixture.projectDirectory))
  const { path, projectDirectory } = fixture
  reader = createModelDecisionReader({
    projectDirectory,
    openLedger: () => openReadOnlyObservationLedger(path, projectDirectory),
    readPriceState: async (routes) =>
      readDecisionPriceState({ path, projectDirectory, inputs: priceInputs(), routes }),
    readPriceIdentity: async () =>
      readPriceIdentity({ path, projectDirectory, inputs: priceInputs() }),
  })
  evidence = new ModelEvidenceReadStore(path, projectDirectory)
  pool = readerPool(path, { workers: 1 })
})
afterAll(async () => {
  await pool.close()
  evidence.close()
  reader.close()
  repository.close()
  fixture.close()
})

const filtersOf = (persona: string | null, taskKind: string | null): ModelDecisionFilters =>
  ({ persona, taskKind, period: { from: null, to: null } }) as ModelDecisionFilters
const FILTERS = [
  filtersOf(null, null),
  filtersOf("systems", null),
  filtersOf(null, "testing"),
  filtersOf("systems", "feature-implementation"),
]
const inputOf = (filters: ModelDecisionFilters) =>
  ModelDecisionReadInputSchema.parse({
    schemaVersion: 2,
    scope: { projectDirectory: fixture.projectDirectory },
    filters,
  })

/** Every candidate as the panel paged them in, with the first page (sources, public catalog). */
function panelCandidates() {
  const candidates = []
  let first: ReturnType<typeof readModelComparison> | undefined
  let cursor: string | undefined
  do {
    const page = readModelComparison(evidence, { limit: 100, ...(cursor ? { cursor } : {}) })
    first ??= page
    candidates.push(...page.candidates)
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  return { candidates, first: first! }
}

/** The catalog exactly as the panel builds it today: comparison pages, live catalog, overview. */
async function panelCatalog(filters: ModelDecisionFilters, basis: string | null) {
  const { candidates, first } = panelCandidates()
  const source = (name: string) =>
    first.sources.find((entry) => entry.source === name)?.snapshot?.retrievedAt ?? null
  return catalogFor({
    candidates,
    catalog: nativeNames,
    overview: await reader.overview(inputOf(filters)),
    priceSources: priceInputs().policy.sources,
    sourceDates: {
      openrouter: source("openrouter-models"),
      opencode: source("native-catalog"),
      modelsDev: source("models-dev"),
    },
    routed,
    preferredBasis: basis,
    external: first.publicCatalog ?? [],
  })
}

/** The worker's computation, in process: what `decision-worker.ts` runs for a `view` call. */
async function computedView(call: DecisionViewCall): Promise<DecisionViewResult> {
  const db = acquireSharedConnection(fixture.path, "readonly")
  try {
    const parts = await reader.viewParts(inputOf(call.filters))
    const set = readCandidateSet(db.db, fixture.projectDirectory)
    const stamps = readSourceStamps(db.db, fixture.projectDirectory)
    const sourceDates = sourceDatesOf(stamps)
    const sources = readSourceSummaries(db.db, fixture.projectDirectory, stamps)
    const priceSources = priceInputs().policy.sources
    const identity = decisionViewIdentity({ parts, set, call, priceSources, stamps })
    if (identity === call.known) return { unchanged: true, identity }
    return buildDecisionView({ parts, set, call, priceSources, sourceDates, sources, identity })
  } finally {
    db.release()
  }
}

function storeView(filters: ModelDecisionFilters, basis: string | null, rows: DecisionViewResult) {
  if ("unchanged" in rows) throw new Error("expected rows")
  const shared = acquireSharedConnection(fixture.path)
  try {
    ensureDecisionViewSchema(shared)
    const view = shared.db
      .transaction(() =>
        openDecisionView(shared.db, fixture.projectDirectory, { filters, basis, taskID: null }),
      )
      .immediate()
    return { viewID: view.id, write: writeDecisionView(shared.db, view.id, rows) }
  } finally {
    shared.release()
  }
}

async function walk(
  source: { columns: Record<string, unknown>; detail?: Record<string, unknown> },
  filter: unknown,
  order: string,
  window: number,
) {
  const stream = openStream(pool, source as never, { filter, order, window, transport: "copy" })
  await stream.ready()
  const seen = new Map<number, Record<string, unknown>>()
  const take = () => {
    for (const row of stream.items as Record<string, unknown>[])
      seen.set(
        row.id as number,
        Object.fromEntries(
          Object.keys({ ...source.columns, ...(window === 1 ? source.detail : {}) }).map(
            (column) => [column, row[column]],
          ),
        ),
      )
  }
  take()
  while (stream.after !== 0) {
    await stream.slide(window)
    take()
  }
  stream.close()
  return [...seen.values()]
}

const scope = (viewID: number) => ({
  projectDirectory: fixture.projectDirectory,
  sessionID: "ses",
  view: { filters: filtersOf(null, null) },
  viewID,
})

test("catalog parity: models.catalog for each persona × task kind equals buildCatalog + rankCatalog of the old GUI inputs", async () => {
  let compared = 0
  for (const filters of FILTERS)
    for (const basis of [null, "swe-bench-verified"]) {
      const expected = await panelCatalog(filters, basis)
      const rows = await computedView({ filters, basis, taskID: null, routed, known: null })
      const { viewID } = storeView(filters, basis, rows)
      const streamed = await walk(modelCatalogSource, scope(viewID), "rank", 7)
      expect(streamed.map((row) => row.detail)).toEqual(
        JSON.parse(JSON.stringify(expected.entries)) as unknown[],
      )
      if ("unchanged" in rows) throw new Error("expected rows")
      expect(rows.summary).toEqual(expected.summary)
      compared += expected.entries.length
    }
  // The fixture lists observed, routed and catalog models.
  expect(compared).toBeGreaterThan(20)
  const all = await panelCatalog(filtersOf(null, null), null)
  for (const tag of ["observed", "routed", "catalog"] as const)
    expect(all.entries.some((entry) => entry.tags.includes(tag))).toBe(true)
})

test("points/contributors parity: equal overview.graph.points and inspect contributor pages", async () => {
  let plotted = 0
  let priced = 0
  let contributed = 0
  for (const filters of FILTERS) {
    const input = inputOf(filters)
    const overview = await reader.overview(input)
    const rows = await computedView({ filters, basis: null, taskID: null, routed, known: null })
    const { viewID } = storeView(filters, null, rows)
    const points = await walk(modelPointsSource, scope(viewID), "chart", 3)
    expect(points.filter((row) => row.point !== null).map((row) => row.point)).toEqual(
      overview.graph.points,
    )
    expect(
      points
        .filter((row) => row.reference !== null)
        .toSorted((a, b) => (a.reference_ord as number) - (b.reference_ord as number))
        .map((row) => row.reference),
    ).toEqual(overview.graph.referenceEstimates ?? [])
    const frontier = new Set(overview.graph.frontierConfigurationIDs)
    for (const row of points)
      expect(row.frontier).toBe(frontier.has(row.configuration_id as string))
    // What the panel drew from the overview, the paged candidates and the live catalog names.
    const { candidates } = panelCandidates()
    const references = chartReferences(overview.graph, candidates, nativeNames)
    const chart = chartPoints(overview, references, candidates, nativeNames)
    expect(points.filter((row) => row.chart !== null).map((row) => row.chart)).toEqual(
      JSON.parse(JSON.stringify(chart)) as unknown[],
    )
    expect(
      points.filter((row) => row.chart_reference !== null).map((row) => row.chart_reference),
    ).toEqual(JSON.parse(JSON.stringify(references)) as unknown[])
    priced += chart.filter((point) => point.currentMarketUSDPerAcceptedTask > 0).length

    const parts = await reader.viewParts(input)
    const configurations = parts.inspections.map((item) => item.configuration)
    const displayRoutes = [
      ...configurations.map((item) => ({ ...item.route, variant: null })),
      ...(overview.graph.referenceEstimates ?? []).map((item) => ({
        ...item.estimate.route,
        variant: null,
      })),
    ]
    for (const [index, configuration] of configurations.entries()) {
      const row = points.find((item) => item.configuration_id === configuration.configurationID)
      expect(row?.display_label).toBe(
        modelDisplayLabel(configuration.route, displayRoutes, candidates, nativeNames),
      )
      expect(row?.group_id).toBe(configuration.groupID)
      expect(row?.inspection).toEqual(
        JSON.parse(JSON.stringify(parts.inspections[index])) as unknown,
      )
      const part = parts.contributors.find(
        (item) => item.configurationID === configuration.configurationID,
      )
      const inspected: unknown[] = JSON.parse(JSON.stringify(part?.contributors ?? [])) as unknown[]
      const stored = await walk(
        modelContributorsSource,
        { ...scope(viewID), configurationID: configuration.configurationID },
        "inspection",
        2,
      )
      expect(stored.map((row) => row.detail)).toEqual(inspected)
      contributed += inspected.length
    }
    plotted += overview.graph.points.length
    plotted += overview.graph.referenceEstimates?.length ?? 0
  }
  expect(plotted).toBeGreaterThan(0)
  // Priced graph points: their values, not only order and frontier, are compared above.
  expect(priced).toBeGreaterThan(0)
  expect(contributed).toBeGreaterThan(2)
})

test("benchmark and sources parity: equal benchmarkBaseline, scoreOptions and the comparison's sources", async () => {
  const { candidates, first } = panelCandidates()
  const date = (name: string) =>
    first.sources.find((entry) => entry.source === name)?.snapshot?.retrievedAt ?? null
  let compared = 0
  for (const filters of FILTERS)
    for (const basis of [null, "swe-bench-verified"]) {
      const input = inputOf(filters)
      const overview = await reader.overview(input)
      const configurations = (await reader.viewParts(input)).inspections.map(
        (item) => item.configuration,
      )
      const references = chartReferences(overview.graph, candidates, nativeNames)
      const label = modelDisplayLabeler(
        candidates.map((candidate) => ({ ...candidate.identity, variant: null })),
        candidates,
        nativeNames,
      )
      const expected = benchmarkBaseline({
        candidates,
        priceSources: priceInputs().policy.sources,
        sourceDates: {
          openrouter: date("openrouter-models"),
          opencode: date("native-catalog"),
          modelsDev: date("models-dev"),
        },
        observedRoutes: new Set([
          ...configurations.map((item) => routeKey(item.route)),
          ...references.map((item) => routeKey(item.estimate.route)),
        ]),
        preferredBasis: basis,
        external: first.publicCatalog ?? [],
        label: (route) => label({ ...route, variant: null }),
      })
      const rows = await computedView({ filters, basis, taskID: null, routed, known: null })
      if ("unchanged" in rows) throw new Error("expected rows")
      const { viewID } = storeView(filters, basis, rows)
      const streamed = await walk(modelBenchmarkSource, scope(viewID), "chart", 5)
      expect(streamed.map((row) => row.detail)).toEqual(
        JSON.parse(JSON.stringify([...expected.points, ...expected.gaps])) as unknown[],
      )
      const [view] = await walk(modelViewSource, scope(viewID), "key", 1)
      expect(view?.benchmark).toEqual(
        JSON.parse(
          JSON.stringify({
            scoreBasis: expected.scoreBasis,
            scoreOptions: scoreOptions(candidates, first.publicCatalog ?? []),
            unmatchedRoutes: expected.unmatchedRoutes,
            ambiguousRoutes: expected.ambiguousRoutes,
            priceSources: expected.priceSources,
            publicCoverage: first.publicCoverage ?? null,
            catalogRoutes: new Set(candidates.map((item) => routeKey(item.identity))).size,
          }),
        ) as unknown,
      )
      expect(view?.sources).toEqual(JSON.parse(JSON.stringify(first.sources)) as unknown)
      compared += expected.points.length + expected.gaps.length
    }
  expect(compared).toBeGreaterThan(0)
})

test("missing price: a catalog entry no configured source prices has no price and no price source", async () => {
  const rows = await computedView({
    filters: filtersOf(null, null),
    basis: null,
    taskID: null,
    routed,
    known: null,
  })
  if ("unchanged" in rows) throw new Error("expected rows")
  const unpriced = rows.entries.filter((entry) => entry.detail.price === null)
  for (const entry of unpriced) {
    expect(entry.priceSource).toBeNull()
    expect(entry.detail.projection).toBeNull()
  }
  // Priced entries keep the chosen source and its retrieval date as provenance.
  const priced = rows.entries.filter((entry) => entry.detail.price !== null)
  expect(priced.length).toBeGreaterThan(0)
  for (const entry of priced) expect(entry.priceSource).toBe(entry.detail.price!.source)
})

test("an unchanged identity computes nothing, and a rewrite of the same rows writes zero rows", async () => {
  const filters = filtersOf("systems", "bug-repair")
  const rows = await computedView({ filters, basis: null, taskID: null, routed, known: null })
  if ("unchanged" in rows) throw new Error("expected rows")
  const first = storeView(filters, null, rows)
  expect(first.write.written).toBeGreaterThan(0)
  expect(
    await computedView({ filters, basis: null, taskID: null, routed, known: rows.identity }),
  ).toEqual({
    unchanged: true,
    identity: rows.identity,
  })
  const again = storeView(filters, null, rows)
  expect(again.viewID).toBe(first.viewID)
  expect(again.write).toMatchObject({ written: 0, deleted: 0 })
})

test("view lifecycle: building → ready; idle sweep drops; a stream on a dropped view rebuilds it", async () => {
  const calls: DecisionViewCall[] = []
  const views = new DecisionViews(
    fixture.path,
    {
      async view(_project, call) {
        calls.push(call)
        return computedView(call)
      },
    },
    async () => routed,
  )
  const shared = acquireSharedConnection(fixture.path)
  try {
    const request = { filters: filtersOf("systems", "testing"), basis: null, taskID: null }
    const viewID = views.open(fixture.projectDirectory, request)
    const state = () =>
      shared.db
        .query<{ state: string; entry_count: number }, [number]>(
          "SELECT state,entry_count FROM model_decision_views WHERE id=?",
        )
        .get(viewID)
    expect(state()?.state).toBe("backfilling")
    await views.settle()
    expect(state()).toMatchObject({ state: "ready" })
    // The view row is what a panel reads for "building" and the counts.
    const [row] = await walk(modelViewSource, scope(viewID), "key", 1)
    expect(row).toMatchObject({ id: viewID, state: "ready" })
    expect(row!.entry_count).toBeGreaterThan(0)
    expect(views.writes.get(viewID)!.transactions).toBeGreaterThan(0)
    // A second open with nothing changed: the worker answers unchanged, nothing is written.
    views.open(fixture.projectDirectory, request)
    await views.settle()
    expect(calls.at(-1)!.known).not.toBeNull()

    // Nobody opened it for longer than the idle period: dropped with its rows.
    expect(
      dropIdleDecisionViews(shared.db, {
        now: Date.now() + 8 * 86_400_000,
        idleMs: 7 * 86_400_000,
      }),
    ).toBeGreaterThan(0)
    expect(state()).toBeNull()
    const rows = shared.db
      .query<{ n: number }, [number]>(
        "SELECT COUNT(*) AS n FROM model_catalog_entries WHERE view_id=?",
      )
      .get(viewID)!.n
    expect(rows).toBe(0)
    // The next open creates and builds it again.
    const again = views.open(fixture.projectDirectory, request)
    await views.settle()
    expect(
      shared.db
        .query<{ state: string }, [number]>("SELECT state FROM model_decision_views WHERE id=?")
        .get(again)?.state,
    ).toBe("ready")
  } finally {
    shared.release()
    views.close()
  }
})

test("the decision worker computes the same view rows as the in-process reader", async () => {
  const worker = createThreadedDecisionWorker({
    path: fixture.path,
    readPriceInputs: async () => priceInputs(),
  })
  try {
    const call = {
      filters: filtersOf("systems", null),
      basis: null,
      taskID: null,
      routed,
      known: null,
    }
    const threaded = await worker.view(fixture.projectDirectory, call)
    const local = await computedView(call)
    if ("unchanged" in threaded || "unchanged" in local) throw new Error("expected rows")
    // Snapshot ids and production times are per build; everything else is the same.
    const normal = (rows: typeof local) =>
      JSON.parse(
        JSON.stringify({
          ...rows,
          snapshotID: "",
          context: { ...rows.context, snapshotID: "", producedAt: "" },
        }),
      ) as unknown
    expect(normal(threaded)).toEqual(normal(local))
    expect(
      await worker.view(fixture.projectDirectory, { ...call, known: threaded.identity }),
    ).toEqual({
      unchanged: true,
      identity: threaded.identity,
    })
  } finally {
    worker.close()
  }
})

test("idle: an open view with no revision or evidence change asks the worker nothing; a revision write rebuilds", async () => {
  const calls: DecisionViewCall[] = []
  const views = new DecisionViews(
    fixture.path,
    {
      async view(_project, call) {
        calls.push(call)
        return computedView(call)
      },
    },
    async () => routed,
    { debounceMs: 5, refreshMs: 0 },
  )
  const shared = acquireSharedConnection(fixture.path)
  try {
    views.open(fixture.projectDirectory, {
      filters: filtersOf(null, "bug-repair"),
      basis: null,
      taskID: null,
    })
    await views.settle()
    const opened = calls.length
    // A write to a table no view reads: nothing is scheduled.
    shared.db.exec("CREATE TABLE IF NOT EXISTS view_test_noise(x)")
    shared.db.query("INSERT INTO view_test_noise VALUES(1)").run()
    await Bun.sleep(50)
    await views.settle()
    expect(calls.length).toBe(opened)
    // The project's observation revision moves: one rebuild, which finds the identity changed.
    shared.db
      .query("UPDATE observation_revisions SET revision=revision+1 WHERE project_directory=?")
      .run(fixture.projectDirectory)
    await Bun.sleep(50)
    await views.settle()
    expect(calls.length).toBe(opened + 1)
  } finally {
    shared.release()
    views.close()
  }
})

test("a view stays current while a stream holds it, however long; once let go it stops after the active period", async () => {
  const calls: DecisionViewCall[] = []
  let clock = Date.now()
  const views = new DecisionViews(
    fixture.path,
    {
      async view(_project, call) {
        calls.push(call)
        return computedView(call)
      },
    },
    async () => routed,
    { debounceMs: 5, refreshMs: 0, now: () => clock },
  )
  const off = registerDecisionViewOpener(fixture.projectDirectory, {
    open: (request) =>
      views.open(fixture.projectDirectory, DecisionViewRequestSchema.parse(request)),
    release: (viewID) => views.release(viewID),
  })
  const service = createStreamsService({
    pool,
    changed: () => {},
    context: {
      projectID: "p",
      projectDirectory: fixture.projectDirectory,
      projectIds: (id) => [id],
      assertRead: async () => {},
      assertAction: async () => {},
    },
  })
  const shared = acquireSharedConnection(fixture.path)
  const bump = async () => {
    shared.db
      .query("UPDATE observation_revisions SET revision=revision+1 WHERE project_directory=?")
      .run(fixture.projectDirectory)
    await Bun.sleep(50)
    await views.settle()
  }
  try {
    const view = { filters: filtersOf("systems", "testing"), basis: "aider-polyglot" }
    await service.open({
      stream: "catalog",
      source: "models.catalog",
      filter: { projectDirectory: "/x", sessionID: "ses", view },
      order: "rank",
      window: 10,
    })
    await views.settle()
    const viewID = shared.db
      .query<{ id: number }, [string]>(
        "SELECT id FROM model_decision_views WHERE request LIKE ? ORDER BY id DESC LIMIT 1",
      )
      .get("%aider-polyglot%")!.id
    expect(views.holders(viewID)).toBe(1)
    // An hour later, still open: a revision change still rebuilds it.
    clock += 60 * 60_000
    const before = calls.length
    await bump()
    expect(calls.length).toBe(before + 1)
    // Closed: it stays current for the active period after, then stops.
    service.close({ stream: "catalog" })
    expect(views.holders(viewID)).toBe(0)
    clock += 60_000
    await bump()
    expect(calls.length).toBe(before + 2)
    clock += 11 * 60_000
    await bump()
    expect(calls.length).toBe(before + 2)
  } finally {
    service.dispose()
    shared.release()
    off()
    views.close()
  }
})
