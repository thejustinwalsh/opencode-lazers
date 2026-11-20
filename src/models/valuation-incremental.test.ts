import { Database } from "bun:sqlite"
import { afterEach, beforeEach, expect, test } from "bun:test"
import assert from "node:assert/strict"
import { makeLedgerFixture } from "../../test/models-observation-ledger/fixtures/ledger.ts"
import { acquireSharedConnection } from "../storage.ts"
import { projectTaskEffortBasis, projectTaskEffortUsage } from "../trajectory/accounting.ts"
import { ModelDecisionReadInputSchema } from "./decision-contract.ts"
import { decisionDigestCache, resetDecisionDigestCache } from "./decision-progress-digests.ts"
import {
  ensureDecisionProjectionSchema,
  foldDecisionProgress,
  installDecisionProjectionSchema,
} from "./decision-projection.ts"
import { decisionProjectionStats } from "./decision-projection-tables.ts"
import { createModelDecisionReader } from "./decision-read.ts"
import { openReadOnlyObservationLedger } from "./observation-ledger-read.ts"
import {
  defaultModelPriceSourcePolicy,
  ModelPriceSourceSettingsSchema,
} from "./price-source-settings.ts"
import {
  projectTaskValuation,
  taskValuationApplicabilities,
  taskValuationPerCallUsage,
} from "./valuation.ts"
import { SEED_ROUTES, seedHistory, seedPriceIndex } from "./valuation-seed.ts"
import type { CurrentPriceIndex } from "./valuation-schema.ts"

/** Canonical JSON: object keys sorted, so equality does not depend on construction order. */
const canon = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canon)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([left], [right]) => (left < right ? -1 : 1))
            .map(([key, field]) => [key, canon(field)]),
        )
      : value
const digest = (value: unknown) =>
  new Bun.CryptoHasher("sha256")
    .update(JSON.stringify(canon(value)))
    .digest("hex")
    .slice(0, 16)

// -- the synthetic history ------------------------------------------------------------------

/**
 * Hashes of the valuation of `seedHistory({ sessions: 330, callsPerSession: 24 })` taken on the
 * code before it was made incremental. They pin the results, not the implementation: any change
 * to a price, provenance, measured token count or per-call row changes a hash.
 */
const GOLDEN = {
  effort: "fef90323aa85bebd",
  valuation: "9013e9707186e18d",
  valuationTruncated: "197c17100a8cd30a",
  applicabilities: "23ce639d916bd7f9",
  "perCall:a-model": "d82a8a75acfbf6d9",
  "perCall:b-model": "0fddd2f59b5eab39",
  "perCall:c-model": "48f1e6cd876ec020",
  halfEffort: "72ed24f63f0c3e38",
  halfValuation: "5642206b931994c2",
  "halfPerCall:a-model": "8fe404364b6e9df1",
  "halfPerCall:b-model": "5b0ec2965f6a5c29",
  "halfPerCall:c-model": "cf1d7a73c28b2c0a",
}

test("the valuation of the seeded history is the one computed before it was incremental", () => {
  const { attempts, facts } = seedHistory({ sessions: 330, callsPerSession: 24 })
  expect(facts.length).toBeGreaterThan(3_500)
  const base = {
    attempts,
    progressFacts: facts,
    progressTruncated: false,
    truncatedContextSessionIDs: [] as string[],
  }
  const half = { ...base, attempts: attempts.filter((_, index) => index % 2 === 0) }
  const got: Record<string, string> = {
    effort: digest(projectTaskEffortBasis(base)),
    valuation: digest(projectTaskValuation({ ...base, currentIndex: seedPriceIndex() })),
    valuationTruncated: digest(
      projectTaskValuation({
        ...base,
        progressTruncated: true,
        truncatedContextSessionIDs: ["ses-00000", "ses-00003"],
        currentIndex: seedPriceIndex(),
      }),
    ),
    applicabilities: digest(taskValuationApplicabilities(base)),
    halfEffort: digest(projectTaskEffortBasis(half)),
    halfValuation: digest(projectTaskValuation({ ...half, currentIndex: seedPriceIndex() })),
  }
  for (const route of SEED_ROUTES) {
    got[`perCall:${route.modelID}`] = digest(taskValuationPerCallUsage(base, route))
    got[`halfPerCall:${route.modelID}`] = digest(taskValuationPerCallUsage(half, route))
  }
  expect(got).toEqual(GOLDEN)
})

test("the usage composed from digests is the usage of the full effort basis", () => {
  const { attempts, facts } = seedHistory({ sessions: 120, callsPerSession: 12, seed: 7 })
  for (const selected of [attempts, attempts.filter((_, index) => index % 3 === 0)]) {
    const request = {
      attempts: selected,
      progressFacts: facts,
      progressTruncated: false,
      truncatedContextSessionIDs: ["ses-00001"],
    }
    const full = projectTaskEffortBasis(request)
    const lite = projectTaskEffortUsage(request)
    expect(lite.usage.sessions).toEqual(full.usage.sessions)
    expect(lite.usage.coverage).toEqual(full.usage.coverage)
    expect(lite.routes.coverage).toEqual(full.routes.coverage)
    for (const [category, measure] of Object.entries(lite.usage.categories))
      expect(measure).toEqual(
        expect.objectContaining(
          Object.fromEntries(
            Object.keys(measure).map((key) => [
              key,
              (full.usage.categories as Record<string, Record<string, unknown>>)[category]![key],
            ]),
          ),
        ),
      )
  }
})

// -- a project database ---------------------------------------------------------------------

type Fixture = ReturnType<typeof makeLedgerFixture>
const fixtures: Fixture[] = []
const ROUTES = SEED_ROUTES

function mulberry(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const usage = (random: () => number) => ({
  input: Math.floor(random() * 4000),
  output: Math.floor(random() * 900),
  reasoning: Math.floor(random() * 300),
  cacheRead: Math.floor(random() * 9000),
  cacheWrite: Math.floor(random() * 500),
  costUSD: random() < 0.5 ? null : Math.floor(random() * 1000) / 1e5,
})

type Seeded = { sessions: string[]; calls: Map<string, number> }

/**
 * `sessions` more attempts on the fixture's tasks, each with its own session, and their progress
 * interleaved in one global sequence like the recorder writes it: additive steps naming a route,
 * a cumulative snapshot now and then, one session in seven mixing two routes.
 */
function seedSessions(fixture: Fixture, sessions: number, maxCalls: number, seed = 11): Seeded {
  const random = mulberry(seed)
  const db = new Database(fixture.path, { strict: true })
  const seeded: Seeded = { sessions: [], calls: new Map() }
  try {
    const base = [fixture.attempts.failed, fixture.attempts.accepted]
    const insertAttempt = db.query(
      `INSERT INTO runner_attempts
       (id,plan_id,task_id,number,session_id,message_id,workspace,base_commit,artifact,policy,
        state,started_at,token_count,tool_count,retry_count,cost)
       SELECT ?,plan_id,task_id,?,?,?,workspace,base_commit,artifact,policy,state,started_at,
              token_count,tool_count,retry_count,cost FROM runner_attempts WHERE id=?`,
    )
    const insertProgress = db.query(
      `INSERT INTO runner_progress
       (project_directory,project_id,plan_id,task_id,attempt_id,session_id,at,recorded_at,
        source,sources_json,kind,event_ids_json,call_id,message_id,dedupe_key,payload)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    const queues: Array<() => void> = []
    db.exec("BEGIN IMMEDIATE")
    for (let index = 0; index < sessions; index++) {
      const template = base[index % base.length]!
      const attemptID = `seed-attempt-${seed}-${index}`
      const sessionID = `seed-session-${seed}-${index}`
      insertAttempt.run(
        attemptID,
        1_000 + seed * 1_000 + index,
        sessionID,
        `seed-message-${seed}-${index}`,
        template.id,
      )
      seeded.sessions.push(sessionID)
      const home = ROUTES[index % ROUTES.length]!
      const other = ROUTES[(index + 1) % ROUTES.length]!
      const calls = 1 + Math.floor(random() * maxCalls)
      seeded.calls.set(sessionID, calls)
      let clock = 100_000 + index * 100
      for (let call = 0; call < calls; call++) {
        const route = index % 7 === 6 && call % 2 ? other : home
        queues.push(() => {
          insertProgress.run(
            fixture.projectDirectory,
            fixture.projectID,
            template.plan_id,
            template.task_id,
            attemptID,
            sessionID,
            clock,
            clock + 1,
            "runtime",
            '["runtime"]',
            "step",
            "[]",
            null,
            `${sessionID}-call-${call}`,
            `${sessionID}-step-${call}`,
            JSON.stringify({
              measurementBasis: "additive-step-measurement",
              usage: usage(random),
              routeEvidence: { status: "observed", route },
              route,
              observations: [{ source: "native-event", eventType: "message.updated", at: call }],
            }),
          )
        })
        clock += 2
      }
      if (index % 3 === 0)
        queues.push(() => {
          insertProgress.run(
            fixture.projectDirectory,
            fixture.projectID,
            template.plan_id,
            template.task_id,
            attemptID,
            sessionID,
            clock,
            clock + 1,
            "runtime",
            '["runtime"]',
            "usage-snapshot",
            "[]",
            null,
            null,
            `${sessionID}-snapshot`,
            JSON.stringify({
              measurementBasis: "cumulative-session-snapshot",
              usage: usage(random),
              routeEvidence: { status: "observed", route: home },
              route: home,
              observations: [],
            }),
          )
        })
    }
    // Interleave the sessions' rows: each session keeps its order, the sessions do not.
    while (queues.length) queues.splice(Math.floor(random() * queues.length), 1)[0]!()
    db.exec("COMMIT")
  } finally {
    db.close()
  }
  return seeded
}

/** More steps appended to one session, like a worker still running. */
function growSession(fixture: Fixture, attemptIndex: number, seed: number, count: number) {
  const db = new Database(fixture.path, { strict: true })
  try {
    const attemptID = `seed-attempt-11-${attemptIndex}`
    const owner = db
      .query<{ plan_id: string; task_id: string; session_id: string }, [string]>(
        "SELECT plan_id,task_id,session_id FROM runner_attempts WHERE id=?",
      )
      .get(attemptID)
    assert.ok(owner)
    const random = mulberry(seed)
    const route = ROUTES[attemptIndex % ROUTES.length]!
    db.exec("BEGIN IMMEDIATE")
    for (let call = 0; call < count; call++)
      db.query(
        `INSERT INTO runner_progress
         (project_directory,project_id,plan_id,task_id,attempt_id,session_id,at,recorded_at,
          source,sources_json,kind,event_ids_json,call_id,message_id,dedupe_key,payload)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        fixture.projectDirectory,
        fixture.projectID,
        owner.plan_id,
        owner.task_id,
        attemptID,
        owner.session_id,
        900_000 + call,
        900_001 + call,
        "runtime",
        '["runtime"]',
        "step",
        "[]",
        null,
        `${owner.session_id}-grow-${seed}-${call}`,
        `${owner.session_id}-grow-step-${seed}-${call}`,
        JSON.stringify({
          measurementBasis: "additive-step-measurement",
          usage: usage(random),
          routeEvidence: { status: "observed", route },
          route,
          observations: [],
        }),
      )
    db.exec("COMMIT")
  } finally {
    db.close()
  }
}

const priceSettings = () =>
  ModelPriceSourceSettingsSchema.parse({
    policy: defaultModelPriceSourcePolicy(),
    access: { openrouter: "configured", opencode: "not-configured" },
  })

/** The seeded price index with every rate scaled, standing in for a price source refresh. */
function scaledIndex(scale: number): CurrentPriceIndex {
  const index = seedPriceIndex()
  const factor = (value: string | number | null) =>
    value === null ? null : (Number(value) * scale).toFixed(14)
  return {
    ...index,
    indexID: `valuation-seed-${scale}`,
    pins: index.pins.map((pin) => ({
      ...pin,
      rates: {
        ...pin.rates,
        uncachedInput: factor(pin.rates.uncachedInput),
        completion: factor(pin.rates.completion),
        cacheRead: factor(pin.rates.cacheRead),
        cacheWrite: factor(pin.rates.cacheWrite),
      },
    })),
  }
}

const stable = (value: unknown) =>
  JSON.parse(
    JSON.stringify(value, (key, field) =>
      /cursor|producedAt/i.test(key) ? undefined : field,
    ).replace(/models-decision-v2:[0-9a-f-]{36}/g, "snapshot"),
  ) as unknown

type PanelOptions = {
  /** Read every fact, as before the digests. */
  legacy?: boolean
  scale?: number
  reader?: ReturnType<typeof createModelDecisionReader>
}

function openReader(path: string, projectDirectory: string, options: PanelOptions = {}) {
  const scale = { value: options.scale ?? 1 }
  const reader = createModelDecisionReader({
    projectDirectory,
    openLedger: () => {
      const ledger = openReadOnlyObservationLedger(path, projectDirectory)
      return options.legacy
        ? { ...ledger, readDecision: (signal?: AbortSignal) => ledger.readDecision(signal) }
        : ledger
    },
    async readPriceState() {
      return { settings: priceSettings(), index: scaledIndex(scale.value), freshness: "current" }
    },
  })
  return { reader, scale }
}

async function panelOf(
  reader: ReturnType<typeof createModelDecisionReader>,
  projectDirectory: string,
) {
  const scope = { projectDirectory }
  const base = {
    schemaVersion: 2 as const,
    scope,
    filters: ModelDecisionReadInputSchema.parse({
      schemaVersion: 2,
      scope,
      filters: { persona: null, taskKind: null, period: { from: null, to: null } },
    }).filters,
  }
  const overview = await reader.overview(base)
  const rows = await reader.rows({
    ...base,
    limit: 50,
    snapshotID: overview.context.snapshotID,
  } as never)
  const configurations = await reader.configurations({
    ...base,
    limit: 50,
    snapshotID: overview.context.snapshotID,
  } as never)
  return stable({ overview, rows, configurations })
}

const panel = async (path: string, projectDirectory: string, options: PanelOptions = {}) => {
  const { reader } = openReader(path, projectDirectory, options)
  try {
    return await panelOf(reader, projectDirectory)
  } finally {
    reader.close()
  }
}

beforeEach(() => resetDecisionDigestCache())
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close()
})

async function seededProject(sessions = 300, maxCalls = 28) {
  const fixture = makeLedgerFixture()
  fixtures.push(fixture)
  const seeded = seedSessions(fixture, sessions, maxCalls)
  const connection = acquireSharedConnection(fixture.path)
  assert.ok(ensureDecisionProjectionSchema(connection))
  await foldDecisionProgress(connection.db, fixture.projectDirectory, { batch: 256 })
  return { fixture, seeded, connection }
}

const factRows = (fixture: Fixture) =>
  new Database(fixture.path, { strict: true, readonly: true })
    .query<{ n: number }, [string]>(
      "SELECT COUNT(*) AS n FROM runner_progress WHERE project_directory=? AND kind IN ('step','usage-snapshot')",
    )
    .get(fixture.projectDirectory)!.n

/** What a snapshot is made of, from the ledger either way it can be read. */
function valuations(path: string, projectDirectory: string, digests: boolean, scale = 1) {
  const ledger = openReadOnlyObservationLedger(path, projectDirectory)
  try {
    const result = ledger.readDecision(undefined, digests ? { digests: true } : undefined)
    assert.equal(result.status, "captured")
    const captured = result as Extract<typeof result, { status: "captured" }>
    const request = {
      attempts: captured.tasks.flatMap((task) =>
        task.attempts.map((attempt) => attempt.accounting),
      ),
      progressFacts: captured.progressDigests ?? captured.progressFacts,
      progressTruncated: false,
      truncatedContextSessionIDs: [],
    }
    if (digests) assert.ok(captured.progressDigests)
    else assert.equal(captured.progressDigests, undefined)
    return {
      factCount: captured.progressFactCount,
      notes: captured.notes,
      valuation: projectTaskValuation({ ...request, currentIndex: scaledIndex(scale) }),
      perCall: ROUTES.map((route) => taskValuationPerCallUsage(request, route)),
      applicabilities: taskValuationApplicabilities(request),
      usage: projectTaskEffortUsage(request),
    }
  } finally {
    ledger.close()
  }
}

test("a valuation composed from stored session digests equals the full rebuild exactly", async () => {
  const { fixture, seeded } = await seededProject()
  const facts = factRows(fixture)
  expect(facts).toBeGreaterThan(4_000)
  expect(seeded.sessions.length).toBe(300)

  const full = valuations(fixture.path, fixture.projectDirectory, false)
  const incremental = valuations(fixture.path, fixture.projectDirectory, true)
  expect(incremental.factCount).toBe(full.factCount)
  expect(incremental.notes).toEqual(full.notes)
  // Prices, provenance, measured tokens and per-call usage: exact equality, not tolerance.
  expect(incremental.valuation).toEqual(full.valuation)
  expect(digest(incremental.valuation)).toBe(digest(full.valuation))
  expect(incremental.perCall).toEqual(full.perCall)
  expect(incremental.applicabilities).toEqual(full.applicabilities)
  expect(incremental.usage).toEqual(full.usage)
  // The comparison covers priced, measured work across routes, not an empty shell.
  expect(full.perCall.map((entry) => entry.calls.length).filter(Boolean).length).toBeGreaterThan(1)
  expect(full.valuation.marketEquivalentCost.coverage.pricedSessions).toBeGreaterThan(50)
  expect(full.valuation.usage.categories.uncachedInput.value).toBeGreaterThan(0)

  // And the panel built from them is the panel built from the facts.
  expect(await panel(fixture.path, fixture.projectDirectory)).toEqual(
    await panel(fixture.path, fixture.projectDirectory, { legacy: true }),
  )
})

test("a snapshot behind the fold (queued updates, deletes and a live tail) equals the full rebuild", async () => {
  const { fixture, connection } = await seededProject(120, 20)
  const sql = (statement: string, ...params: (string | number)[]) => {
    const db = new Database(fixture.path, { strict: true })
    try {
      db.query(statement).run(...params)
    } finally {
      db.close()
    }
  }
  growSession(fixture, 3, 5, 6)
  await foldDecisionProgress(connection.db, fixture.projectDirectory)
  // Changes the fold has not seen: an edited row, a deleted row, a row leaving the decision kinds,
  // a session that gains rows, a new session in the live tail.
  sql(
    "UPDATE runner_progress SET payload=replace(payload,'\"input\":','\"input\":1') WHERE message_id='seed-session-11-5-call-0'",
  )
  sql("DELETE FROM runner_progress WHERE message_id='seed-session-11-9-call-0'")
  sql("UPDATE runner_progress SET kind='other' WHERE message_id='seed-session-11-12-call-0'")
  growSession(fixture, 20, 6, 4)
  seedSessions(fixture, 5, 6, 12)

  for (const stage of ["behind the fold", "folded"]) {
    const full = valuations(fixture.path, fixture.projectDirectory, false)
    const incremental = valuations(fixture.path, fixture.projectDirectory, true)
    expect(incremental.factCount, stage).toBe(full.factCount)
    expect(incremental.valuation, stage).toEqual(full.valuation)
    expect(incremental.perCall, stage).toEqual(full.perCall)
    expect(incremental.usage, stage).toEqual(full.usage)
    expect(await panel(fixture.path, fixture.projectDirectory), stage).toEqual(
      await panel(fixture.path, fixture.projectDirectory, { legacy: true }),
    )
    await foldDecisionProgress(connection.db, fixture.projectDirectory)
  }
})

test("after facts are added to one session only that session is read and recomputed", async () => {
  const { fixture, seeded, connection } = await seededProject()
  const total = seeded.sessions.length
  const { reader } = openReader(fixture.path, fixture.projectDirectory)
  try {
    decisionProjectionStats.reset()
    const started = performance.now()
    const cold = await panelOf(reader, fixture.projectDirectory)
    const coldMs = performance.now() - started
    const coldStats = { ...decisionProjectionStats }
    // A cold read reduces every session once.
    expect(coldStats.digestBuilds).toBeGreaterThanOrEqual(total)
    expect(coldStats.digestFactsRead).toBe(factRows(fixture))
    console.log(
      `digest cache after a cold read: ${decisionDigestCache.bytes} B estimated for ` +
        `${coldStats.digestFactsRead} facts (${Math.round(decisionDigestCache.bytes / coldStats.digestFactsRead)} B per fact)`,
    )

    growSession(fixture, 41, 9, 7)
    await foldDecisionProgress(connection.db, fixture.projectDirectory)
    decisionProjectionStats.reset()
    const grownSession = seeded.sessions[41]!
    const started2 = performance.now()
    const after = await panelOf(reader, fixture.projectDirectory)
    const incrementalMs = performance.now() - started2
    const afterStats = { ...decisionProjectionStats }
    // Session 41 is not a multiple of three, so it has no snapshot row besides its steps.
    const existing = seeded.calls.get(grownSession)!

    // Exactly one unit recomputed, and only its own facts read.
    expect(decisionProjectionStats.digestBuilds).toBe(1)
    expect(decisionProjectionStats.digestFactsRead).toBe(existing + 7)
    expect(decisionProjectionStats.digestHits).toBe(decisionProjectionStats.digestSessions - 1)
    expect(decisionProjectionStats.readSourceRows).toBe(0)
    expect(after).not.toEqual(cold)

    // The full rebuild this replaces: every stored fact read, every session valued.
    decisionProjectionStats.reset()
    const started3 = performance.now()
    const full = await panel(fixture.path, fixture.projectDirectory, { legacy: true })
    const fullMs = performance.now() - started3
    expect(after).toEqual(full)
    console.log(
      `decision revision change over ${factRows(fixture)} facts in ${total} sessions: ` +
        `before ${decisionProjectionStats.readProjectionRows} facts read, ${fullMs.toFixed(0)} ms; ` +
        `after ${afterStats.digestFactsRead} facts read, ${incrementalMs.toFixed(0)} ms ` +
        `(${afterStats.digestBuilds} unit recomputed; a cold read is ${coldMs.toFixed(0)} ms)`,
    )
  } finally {
    reader.close()
  }
})

test("a price source refresh reprices every session from stored usage without reading facts", async () => {
  const { fixture } = await seededProject(200, 20)
  const { reader, scale } = openReader(fixture.path, fixture.projectDirectory)
  try {
    const before = await panelOf(reader, fixture.projectDirectory)
    decisionProjectionStats.reset()
    scale.value = 2
    const after = await panelOf(reader, fixture.projectDirectory)
    expect(decisionProjectionStats.digestFactsRead).toBe(0)
    expect(decisionProjectionStats.digestBuilds).toBe(0)
    expect(decisionProjectionStats.readSourceRows).toBe(0)
    expect(decisionProjectionStats.digestSessions).toBeGreaterThan(200)
    expect(after).toBeDefined()
    expect(before).toBeDefined()

    // Every session is repriced, and the result is the full rebuild at the new rates.
    const full = valuations(fixture.path, fixture.projectDirectory, false, 2)
    const incremental = valuations(fixture.path, fixture.projectDirectory, true, 2)
    expect(incremental.valuation).toEqual(full.valuation)
    const repriced = incremental.valuation.marketEquivalentCost
    const original = valuations(fixture.path, fixture.projectDirectory, true, 1).valuation
      .marketEquivalentCost
    expect(repriced.coverage.pricedSessions).toBe(original.coverage.pricedSessions)
    const originalBySession = new Map(original.sessions.map((entry) => [entry.sessionID, entry]))
    const priced = repriced.sessions.filter((entry) => entry.subtotalUSD !== null)
    expect(priced.length).toBeGreaterThan(100)
    for (const entry of priced)
      expect(entry.subtotalUSD!).toBeCloseTo(
        originalBySession.get(entry.sessionID)!.subtotalUSD! * 2,
        9,
      )
    expect(await panelOf(reader, fixture.projectDirectory)).toEqual(
      await panel(fixture.path, fixture.projectDirectory, { legacy: true, scale: 2 }),
    )
  } finally {
    reader.close()
  }
})

test("an unchanged revision reads nothing", async () => {
  const { fixture } = await seededProject(150, 16)
  const { reader } = openReader(fixture.path, fixture.projectDirectory)
  try {
    const first = await panelOf(reader, fixture.projectDirectory)
    decisionProjectionStats.reset()
    const second = await panelOf(reader, fixture.projectDirectory)
    expect(second).toEqual(first)
    expect({ ...decisionProjectionStats, reset: undefined }).toEqual({
      foldSourceRows: 0,
      foldWrites: 0,
      foldRemovals: 0,
      foldPages: 0,
      readProjectionRows: 0,
      readSourceRows: 0,
      foldTasks: 0,
      readStoredTasks: 0,
      readLiveTasks: 0,
      digestSessions: 0,
      digestHits: 0,
      digestBuilds: 0,
      digestFactsRead: 0,
      reset: undefined,
    })
  } finally {
    reader.close()
  }
})

test("after a restart one pass reads each session once, then reads are incremental again", async () => {
  const { fixture, seeded, connection } = await seededProject(160, 18)
  const total = seeded.sessions.length
  const first = openReader(fixture.path, fixture.projectDirectory)
  const before = await panelOf(first.reader, fixture.projectDirectory)
  first.reader.close()

  // A restart: no cache, no stamps, no reader. The stored projection resumes from its watermark.
  resetDecisionDigestCache()
  const folded = await foldDecisionProgress(connection.db, fixture.projectDirectory)
  expect(folded.sourceRows).toBe(0)
  const second = openReader(fixture.path, fixture.projectDirectory)
  try {
    decisionProjectionStats.reset()
    expect(await panelOf(second.reader, fixture.projectDirectory)).toEqual(before)
    expect(decisionProjectionStats.digestBuilds).toBeGreaterThanOrEqual(total)
    expect(decisionProjectionStats.digestFactsRead).toBe(factRows(fixture))

    growSession(fixture, 10, 3, 2)
    await foldDecisionProgress(connection.db, fixture.projectDirectory)
    decisionProjectionStats.reset()
    const after = await panelOf(second.reader, fixture.projectDirectory)
    expect(decisionProjectionStats.digestBuilds).toBe(1)
    expect(after).toEqual(await panel(fixture.path, fixture.projectDirectory, { legacy: true }))
  } finally {
    second.reader.close()
  }
})

test("a generation 2 projection is labelled by a paged backfill and read live until it is", async () => {
  const { fixture, connection } = await seededProject(90, 14)
  // Rebuild what generation 2 left: no session on the facts, no stamps, not ready.
  connection.db.exec(`
    UPDATE model_decision_progress SET session_id=NULL;
    DELETE FROM model_decision_session;
    UPDATE model_decision_progress_state SET sessions_ready=0, epoch='', session_clock=0;`)
  const full = valuations(fixture.path, fixture.projectDirectory, false)

  // Until the backfill finishes the read serves every fact live and equals the full read.
  decisionProjectionStats.reset()
  expect(await panel(fixture.path, fixture.projectDirectory)).toEqual(
    await panel(fixture.path, fixture.projectDirectory, { legacy: true }),
  )
  expect(decisionProjectionStats.digestBuilds).toBe(0)

  // The upgrade runs from the schema installer on a reload as well as a restart, and the
  // backfill pages through the fold, not the installer.
  installDecisionProjectionSchema(connection.db)
  const unlabelled = () =>
    connection.db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM model_decision_progress WHERE session_id IS NULL",
      )
      .get()!.n
  expect(unlabelled()).toBeGreaterThan(500)
  await foldDecisionProgress(connection.db, fixture.projectDirectory, { batch: 128 })
  expect(unlabelled()).toBe(0)
  expect(
    connection.db
      .query<{ sessions_ready: number; epoch: string }, []>(
        "SELECT sessions_ready,epoch FROM model_decision_progress_state",
      )
      .get(),
  ).toEqual({ sessions_ready: 1, epoch: expect.stringMatching(/.+/) })

  resetDecisionDigestCache()
  const incremental = valuations(fixture.path, fixture.projectDirectory, true)
  expect(incremental.valuation).toEqual(full.valuation)
  expect(incremental.perCall).toEqual(full.perCall)
})

test("a cache too small to hold the project still serves the same values, re-reading what it dropped", async () => {
  const { fixture } = await seededProject(80, 12)
  const previous = process.env.LAZERS_DECISION_DIGEST_MB
  process.env.LAZERS_DECISION_DIGEST_MB = "0.01"
  try {
    const { reader } = openReader(fixture.path, fixture.projectDirectory)
    try {
      await panelOf(reader, fixture.projectDirectory)
      growSession(fixture, 2, 4, 3)
      decisionProjectionStats.reset()
      const after = await panelOf(reader, fixture.projectDirectory)
      // Nearly every session was evicted, so nearly every session is read again.
      expect(decisionProjectionStats.digestBuilds).toBeGreaterThan(40)
      expect(after).toEqual(await panel(fixture.path, fixture.projectDirectory, { legacy: true }))
    } finally {
      reader.close()
    }
  } finally {
    if (previous === undefined) delete process.env.LAZERS_DECISION_DIGEST_MB
    else process.env.LAZERS_DECISION_DIGEST_MB = previous
  }
})
