import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import assert from "node:assert/strict"
import { copyFileSync } from "node:fs"
import { join } from "node:path"
import { makeLedgerFixture } from "../../test/models-observation-ledger/fixtures/ledger.ts"
import { acquireSharedConnection } from "../storage.ts"
import { ModelDecisionReadInputSchema } from "./decision-contract.ts"
import {
  DecisionProjectionOwner,
  decisionProjectionStats,
  ensureDecisionProjectionSchema,
  foldDecisionProgress,
  installDecisionProjectionSchema,
} from "./decision-projection.ts"
import { createModelDecisionReader } from "./decision-read.ts"
import { modelConfigurationID } from "./model-identity.ts"
import { openReadOnlyObservationLedger } from "./observation-ledger-read.ts"
import {
  defaultModelPriceSourcePolicy,
  ModelPriceSourceSettingsSchema,
} from "./price-source-settings.ts"
import type { CurrentPriceIndex } from "./valuation-schema.ts"

type Fixture = ReturnType<typeof makeLedgerFixture>

const usage = (input: number, output = 0) => ({
  input,
  output,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
})
const ROUTES = [
  { providerID: "openrouter", modelID: "a-model", variant: "medium" },
  { providerID: "openrouter", modelID: "b-model", variant: "medium" },
]

/** Direct SQL, like the recorder: one immediate transaction, rows appended past the watermark. */
function addFacts(fixture: Fixture, attemptID: string, count: number, from = 0, tag = "p") {
  const db = new Database(fixture.path, { strict: true })
  try {
    const owner = db
      .query<
        { task_id: string; plan_id: string; session_id: string; project_directory: string },
        [string]
      >(
        `SELECT a.task_id,a.plan_id,a.session_id,p.project_directory
         FROM runner_attempts a JOIN runner_plans p ON p.id=a.plan_id WHERE a.id=?`,
      )
      .get(attemptID)
    assert.ok(owner)
    const insert = db.query(
      `INSERT INTO runner_progress
       (project_directory,project_id,plan_id,task_id,attempt_id,session_id,at,recorded_at,
        source,sources_json,kind,event_ids_json,call_id,message_id,dedupe_key,payload)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    db.exec("BEGIN IMMEDIATE")
    for (let index = from; index < from + count; index++) {
      const route = ROUTES[index % ROUTES.length]!
      const kind = index % 7 === 6 ? "usage-snapshot" : "step"
      insert.run(
        owner.project_directory,
        fixture.projectID,
        owner.plan_id,
        owner.task_id,
        attemptID,
        owner.session_id,
        70_000 + index,
        70_001 + index,
        "runtime",
        '["runtime"]',
        kind,
        "[]",
        null,
        `${tag}-call-${index}`,
        `${tag}-${attemptID}-${index}`,
        JSON.stringify({
          measurementBasis:
            kind === "step" ? "additive-step-measurement" : "cumulative-session-snapshot",
          usage: usage(100 + index, 10 + (index % 5)),
          routeEvidence: { status: "observed", route },
          route,
          observations: [{ source: "native-event", eventType: "message.updated", at: index }],
          privatePrompt: "x".repeat(400),
        }),
      )
    }
    db.exec("COMMIT")
  } finally {
    db.close()
  }
}

const sql = (fixture: Fixture, statement: string, ...params: (string | number)[]) => {
  const db = new Database(fixture.path, { strict: true })
  try {
    return db.query(statement).run(...params)
  } finally {
    db.close()
  }
}

/** Route and usage evidence on the fixture's own attempts, so the panel has priced rows. */
function routeAttempt(
  fixture: Fixture,
  attemptID: string,
  route: (typeof ROUTES)[number],
  inputs: number[],
) {
  const db = new Database(fixture.path, { strict: true })
  try {
    const rows = db
      .query<{ seq: number; kind: string; payload: string }, [string]>(
        "SELECT seq,kind,payload FROM runner_progress WHERE attempt_id=? ORDER BY seq",
      )
      .all(attemptID)
    let step = 0
    for (const row of rows) {
      const payload = JSON.parse(row.payload) as Record<string, unknown>
      if (row.kind === "step") payload.usage = usage(inputs[step++] ?? 10)
      else if (row.kind === "usage-snapshot") payload.usage = usage(inputs[0] ?? 100)
      payload.routeEvidence = { status: "observed", route }
      payload.route = route
      db.query("UPDATE runner_progress SET payload=?,message_id=? WHERE seq=?").run(
        JSON.stringify(payload),
        `decision-test-call-${row.seq}`,
        row.seq,
      )
    }
  } finally {
    db.close()
  }
}

const writeConnection = (fixture: Fixture) => acquireSharedConnection(fixture.path)

const capture = (path: string, projectDirectory: string) => {
  const ledger = openReadOnlyObservationLedger(path, projectDirectory)
  try {
    const result = ledger.readDecision()
    assert.equal(result.status, "captured")
    return result as Extract<typeof result, { status: "captured" }>
  } finally {
    ledger.close()
  }
}

/** The facts a read sees, without the capture time and fingerprint that differ by construction. */
const comparable = (value: ReturnType<typeof capture>) => ({
  facts: value.progressFacts,
  notes: value.notes,
  tasks: value.tasks,
  coverage: value.classificationCoverage,
  sourceRevision: value.sourceRevision,
})

/** The same database with the projection removed: the pre-projection read path, byte for byte. */
function withoutProjection(fixture: Fixture) {
  const copy = join(fixture.directory, "legacy.sqlite")
  const db = new Database(fixture.path, { strict: true })
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
  } finally {
    db.close()
  }
  copyFileSync(fixture.path, copy)
  const legacy = new Database(copy, { strict: true })
  try {
    legacy.exec(`
      DROP TRIGGER IF EXISTS model_decision_progress_updated;
      DROP TRIGGER IF EXISTS model_decision_progress_deleted;
      DROP TABLE IF EXISTS model_decision_progress;
      DROP TABLE IF EXISTS model_decision_progress_state;
      DROP TABLE IF EXISTS model_decision_progress_dirty;`)
  } finally {
    legacy.close()
  }
  return copy
}

const fixtures: Fixture[] = []
const fixtureWithHistory = (rows: number) => {
  const fixture = makeLedgerFixture()
  fixtures.push(fixture)
  addFacts(fixture, fixture.attempts.failed.id, rows)
  addFacts(fixture, fixture.attempts.accepted.id, Math.floor(rows / 2), 0, "q")
  return fixture
}
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close()
})

const matchingRows = (fixture: Fixture) =>
  new Database(fixture.path, { strict: true, readonly: true })
    .query<{ n: number }, [string]>(
      "SELECT COUNT(*) AS n FROM runner_progress WHERE project_directory=? AND kind IN ('step','usage-snapshot')",
    )
    .get(fixture.projectDirectory)!.n

test("a folded read returns the facts, notes and tasks the full read returned", async () => {
  const fixture = fixtureWithHistory(1_200)
  // Rows the old path counts in notes: malformed payload, unreadable lineage, an updated row,
  // a deleted row, a row that leaves the decision kinds.
  sql(fixture, "UPDATE runner_progress SET payload='not-json' WHERE message_id='p-call-3'")
  sql(fixture, "UPDATE runner_progress SET sources_json='nope' WHERE message_id='p-call-4'")
  sql(fixture, "UPDATE runner_progress SET event_ids_json='nope' WHERE message_id='p-call-5'")
  const connection = writeConnection(fixture)
  assert.ok(ensureDecisionProjectionSchema(connection))
  await foldDecisionProgress(connection.db, fixture.projectDirectory, { batch: 200 })

  sql(fixture, "UPDATE runner_progress SET payload=? WHERE message_id='p-call-20'", "[1,2]")
  sql(fixture, "UPDATE runner_progress SET kind='other' WHERE message_id='p-call-21'")
  sql(fixture, "DELETE FROM runner_progress WHERE message_id='p-call-22'")
  sql(fixture, "UPDATE runner_progress SET kind='step' WHERE message_id='q-call-8'")
  addFacts(fixture, fixture.attempts.failed.id, 25, 5_000, "late")

  const legacy = comparable(capture(withoutProjection(fixture), fixture.projectDirectory))
  // Behind the writer (queued rows and a live tail): the overlay returns the same facts.
  expect(comparable(capture(fixture.path, fixture.projectDirectory))).toEqual(legacy)
  // After the fold: the stored rows alone return them.
  await foldDecisionProgress(connection.db, fixture.projectDirectory, { batch: 200 })
  expect(comparable(capture(fixture.path, fixture.projectDirectory))).toEqual(legacy)
  expect(legacy.notes.join("\n")).toContain(
    "1 retained decision progress facts have malformed JSON",
  )
  expect(legacy.notes.join("\n")).toContain("unreadable source lineage")
  expect(legacy.notes.join("\n")).toContain("unreadable event lineage")
})

const priceSettings = () =>
  ModelPriceSourceSettingsSchema.parse({
    policy: defaultModelPriceSourcePolicy(),
    access: { openrouter: "configured", opencode: "not-configured" },
  })

function pricedIndex(routes: readonly { route: (typeof ROUTES)[number] }[]): CurrentPriceIndex {
  return {
    indexID: "decision-projection-parity",
    retrievedAt: "2026-11-05T12:00:00.000Z",
    pins: [
      ...new Map(
        routes.map(({ route }) => [
          modelConfigurationID(route.providerID, route.modelID, route.variant),
          route,
        ]),
      ).values(),
    ].map((route, index) => ({
      route,
      productID: `${route.providerID}/${route.modelID}`,
      configurationID: modelConfigurationID(route.providerID, route.modelID, route.variant),
      semantics: "quote" as const,
      resolution: {
        route: "resolved" as const,
        sku: "resolved" as const,
        configuration: "resolved" as const,
        tier: "resolved" as const,
        schedule: "not-applicable" as const,
      },
      tier: {
        id: "base",
        contextTierTokens: null,
        minPromptTokens: null,
        utcStart: null,
        utcEnd: null,
      },
      rates: {
        unit: "USD per token" as const,
        uncachedInput: index ? "0.00000001" : "0.000001",
        completion: index ? "0.00000002" : "0.000002",
        cacheRead: "0.0000001",
        cacheWrite: "0.0000012",
      },
      provenance: {
        source: "openrouter-models" as const,
        snapshotID: `aaaaaaaa-aaaa-4aaa-8aaa-${(index + 1).toString(16).padStart(12, "0")}`,
        generation: 1,
        retrievedAt: "2026-11-05T12:00:00.000Z",
        asOf: null,
        sourceURL: "https://openrouter.ai/api/v1/models",
        recordIndex: index,
        recordID: route.modelID,
      },
    })),
  }
}

/** Snapshot ids and cursors are random per read; everything else must match. */
const stable = (value: unknown) =>
  JSON.parse(
    JSON.stringify(value, (key, field) =>
      /cursor|producedAt/i.test(key) ? undefined : field,
    ).replace(/models-decision-v2:[0-9a-f-]{36}/g, "snapshot"),
  ) as unknown

async function panel(path: string, projectDirectory: string) {
  const reader = createModelDecisionReader({
    projectDirectory,
    openLedger: () => openReadOnlyObservationLedger(path, projectDirectory),
    async readPriceState(routes) {
      return {
        settings: priceSettings(),
        index: pricedIndex(routes as { route: (typeof ROUTES)[number] }[]),
        freshness: "current",
      }
    },
  })
  try {
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
  } finally {
    reader.close()
  }
}

test("the panel's decision overview, rows and configurations are identical with and without the projection", async () => {
  const fixture = fixtureWithHistory(900)
  routeAttempt(fixture, fixture.attempts.failed.id, ROUTES[0]!, [40, 60])
  routeAttempt(fixture, fixture.attempts.accepted.id, ROUTES[1]!, [20, 30])
  const connection = writeConnection(fixture)
  ensureDecisionProjectionSchema(connection)
  await foldDecisionProgress(connection.db, fixture.projectDirectory, { batch: 128 })
  sql(
    fixture,
    "UPDATE runner_progress SET payload=replace(payload,'\"input\":10','\"input\":9910') WHERE seq=(SELECT MIN(seq) FROM runner_progress WHERE kind='step')",
  )
  addFacts(fixture, fixture.attempts.failed.id, 12, 8_000, "late")

  const legacy = await panel(withoutProjection(fixture), fixture.projectDirectory)
  const behind = await panel(fixture.path, fixture.projectDirectory)
  await foldDecisionProgress(connection.db, fixture.projectDirectory)
  const folded = await panel(fixture.path, fixture.projectDirectory)

  expect(behind).toEqual(legacy)
  expect(folded).toEqual(legacy)
  // The comparison carries priced, provenance-bearing, measured values, not an empty shell.
  const text = JSON.stringify(legacy)
  expect(text).toContain('"totalCount":1')
  expect(text).toContain("aaaaaaaa-aaaa-4aaa-8aaa-000000000002")
  expect(text).toContain('"tokensPerAcceptedTask":20')
})

test("adding N progress rows folds only those N rows", async () => {
  const fixture = fixtureWithHistory(800)
  const connection = writeConnection(fixture)
  ensureDecisionProjectionSchema(connection)
  const first = await foldDecisionProgress(connection.db, fixture.projectDirectory, { batch: 100 })
  expect(first.written).toBe(matchingRows(fixture))

  addFacts(fixture, fixture.attempts.failed.id, 37, 9_000, "next")
  decisionProjectionStats.reset()
  const fold = await foldDecisionProgress(connection.db, fixture.projectDirectory)
  expect(fold.sourceRows).toBe(37)
  expect(fold.written).toBe(37)
  expect(decisionProjectionStats.foldSourceRows).toBe(37)

  // A read after the fold parses stored facts only; a read before it would parse the tail.
  addFacts(fixture, fixture.attempts.failed.id, 5, 9_500, "tail")
  decisionProjectionStats.reset()
  capture(fixture.path, fixture.projectDirectory)
  expect(decisionProjectionStats.readSourceRows).toBe(5)
  expect(decisionProjectionStats.readProjectionRows).toBe(matchingRows(fixture) - 5)
})

test("an update or delete of a folded row is queued and applied once", async () => {
  const fixture = fixtureWithHistory(300)
  const connection = writeConnection(fixture)
  ensureDecisionProjectionSchema(connection)
  await foldDecisionProgress(connection.db, fixture.projectDirectory)
  sql(fixture, "UPDATE runner_progress SET payload=? WHERE message_id='p-call-10'", "[1]")
  sql(fixture, "DELETE FROM runner_progress WHERE message_id='p-call-11'")
  // Cumulative snapshots rewrite a row repeatedly; the queue holds the row once.
  sql(fixture, "UPDATE runner_progress SET at=at+1 WHERE message_id='p-call-10'")

  decisionProjectionStats.reset()
  capture(fixture.path, fixture.projectDirectory)
  expect(decisionProjectionStats.readSourceRows).toBe(1)

  decisionProjectionStats.reset()
  const fold = await foldDecisionProgress(connection.db, fixture.projectDirectory)
  expect(fold).toMatchObject({ sourceRows: 2, written: 1, removed: 1 })
  decisionProjectionStats.reset()
  capture(fixture.path, fixture.projectDirectory)
  expect(decisionProjectionStats.readSourceRows).toBe(0)
})

test("an unchanged revision reads no history", async () => {
  const fixture = fixtureWithHistory(400)
  const owner = new DecisionProjectionOwner(fixture.path)
  try {
    expect(await owner.foldWhenMoved(fixture.projectDirectory)).toBe(true)
    decisionProjectionStats.reset()
    expect(await owner.foldWhenMoved(fixture.projectDirectory)).toBe(false)
    expect(decisionProjectionStats.foldSourceRows).toBe(0)
    expect(decisionProjectionStats.foldPages).toBe(0)

    // A decision read with the stored snapshot current reads nothing either.
    const reader = createModelDecisionReader({
      projectDirectory: fixture.projectDirectory,
      openLedger: () => openReadOnlyObservationLedger(fixture.path, fixture.projectDirectory),
      async readPriceState(routes) {
        return {
          settings: priceSettings(),
          index: pricedIndex(routes as { route: (typeof ROUTES)[number] }[]),
          freshness: "current",
        }
      },
    })
    const input = ModelDecisionReadInputSchema.parse({
      schemaVersion: 2,
      scope: { projectDirectory: fixture.projectDirectory },
      filters: { persona: null, taskKind: null, period: { from: null, to: null } },
    })
    await reader.overview(input)
    decisionProjectionStats.reset()
    await reader.overview(input)
    await reader.overview(input)
    expect(decisionProjectionStats.readProjectionRows).toBe(0)
    expect(decisionProjectionStats.readSourceRows).toBe(0)
    reader.close()

    // A write moves the revision: the next pass folds exactly the new rows.
    addFacts(fixture, fixture.attempts.failed.id, 4, 20_000, "move")
    decisionProjectionStats.reset()
    expect(await owner.foldWhenMoved(fixture.projectDirectory)).toBe(true)
    expect(decisionProjectionStats.foldSourceRows).toBe(4)
  } finally {
    owner.close()
  }
})

test("after a restart the watermark resumes and no row is folded twice", async () => {
  const fixture = fixtureWithHistory(500)
  const total = matchingRows(fixture)
  const connection = writeConnection(fixture)
  ensureDecisionProjectionSchema(connection)
  decisionProjectionStats.reset()

  // The first process folds one page and stops (an abort stands for the process ending).
  const stop = new AbortController()
  const interrupted = foldDecisionProgress(connection.db, fixture.projectDirectory, {
    batch: 100,
    signal: stop.signal,
  })
  queueMicrotask(() => stop.abort())
  await expect(interrupted).rejects.toThrow()
  const watermark = connection.db
    .query<{ folded_seq: number }, []>("SELECT folded_seq FROM model_decision_progress_state")
    .get()!.folded_seq
  expect(watermark).toBeGreaterThan(0)
  expect(decisionProjectionStats.foldSourceRows).toBe(100)

  // A new owner (a restarted process) finishes from the stored watermark.
  const owner = new DecisionProjectionOwner(fixture.path)
  try {
    await owner.foldWhenMoved(fixture.projectDirectory)
  } finally {
    owner.close()
  }
  expect(decisionProjectionStats.foldSourceRows).toBe(total)
  expect(
    connection.db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM model_decision_progress")
      .get()!.n,
  ).toBe(total)
  const legacy = comparable(capture(withoutProjection(fixture), fixture.projectDirectory))
  expect(comparable(capture(fixture.path, fixture.projectDirectory))).toEqual(legacy)
})

test("installing the schema again keeps the stored rows and re-creates the triggers", async () => {
  const fixture = fixtureWithHistory(60)
  const connection = writeConnection(fixture)
  ensureDecisionProjectionSchema(connection)
  await foldDecisionProgress(connection.db, fixture.projectDirectory)
  connection.db.exec("DROP TRIGGER model_decision_progress_updated")
  // A reload that raises the declared generation runs the installer again.
  installDecisionProjectionSchema(connection.db)
  const before = connection.db
    .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM model_decision_progress")
    .get()!.n
  expect(before).toBe(matchingRows(fixture))
  sql(fixture, "UPDATE runner_progress SET payload='[]' WHERE message_id='p-call-1'")
  expect(
    connection.db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM model_decision_progress_dirty")
      .get()!.n,
  ).toBe(1)
  expect(
    connection.db
      .query<{ generation: number }, []>(
        "SELECT generation FROM schema_modules WHERE module='model-decision-projection'",
      )
      .get(),
  ).toEqual({ generation: 1 })
})

test("a folded decision read parses fewer bytes than the full read", async () => {
  const fixture = fixtureWithHistory(3_000)
  const connection = writeConnection(fixture)
  ensureDecisionProjectionSchema(connection)
  await foldDecisionProgress(connection.db, fixture.projectDirectory)
  const legacyPath = withoutProjection(fixture)

  const bytes = (path: string, statement: string) =>
    new Database(path, { strict: true, readonly: true })
      .query<{ rows: number; bytes: number }, []>(statement)
      .get()!
  const before = bytes(
    legacyPath,
    "SELECT COUNT(*) AS rows, SUM(LENGTH(payload)+LENGTH(sources_json)+LENGTH(event_ids_json)) AS bytes FROM runner_progress WHERE kind IN ('step','usage-snapshot')",
  )
  const after = bytes(
    fixture.path,
    "SELECT COUNT(*) AS rows, SUM(LENGTH(fact)) AS bytes FROM model_decision_progress",
  )
  decisionProjectionStats.reset()
  const legacyStart = performance.now()
  capture(legacyPath, fixture.projectDirectory)
  const legacyMs = performance.now() - legacyStart
  const legacyRows = decisionProjectionStats.readSourceRows
  decisionProjectionStats.reset()
  const foldedStart = performance.now()
  capture(fixture.path, fixture.projectDirectory)
  const foldedMs = performance.now() - foldedStart
  console.log(
    `decision read: before ${legacyRows} progress rows / ${before.bytes} B parsed, ` +
      `after ${decisionProjectionStats.readProjectionRows} stored facts / ${after.bytes} B ` +
      `and ${decisionProjectionStats.readSourceRows} progress rows; ` +
      `${legacyMs.toFixed(0)} ms -> ${foldedMs.toFixed(0)} ms`,
  )
  expect(legacyRows).toBe(before.rows)
  expect(decisionProjectionStats.readSourceRows).toBe(0)
  expect(after.bytes).toBeLessThan(before.bytes)
})
