import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openStream } from "../streams/client.ts"
import { readerPool } from "../streams/pool.ts"
import type { StreamContext } from "../streams/source.ts"
import { modelCandidatesSource } from "../streams/sources/models.ts"
import type { ModelCandidatesFilter } from "../streams/sources/models-ref.ts"
import { acquireSharedConnection, TaskRepository } from "../storage.ts"
import { evidenceSnapshot, seedEvidenceCorpus } from "./candidate.fixture.ts"
import {
  computeCandidateChanges,
  ensureModelCandidatesSchema,
  MODEL_CANDIDATES_QUEUE,
  refreshModelCandidates,
} from "./candidate-store.ts"
import { CandidateBuilds } from "./candidate-builds.ts"
import { createThreadedDecisionWorker } from "./decision-worker-client.ts"
import { projectionStatus } from "../projections/lifecycle.ts"
import { readModelComparison } from "./comparison-read.ts"
import { ModelEvidenceReadStore, ModelEvidenceStore } from "./source-store.ts"

const project = "/candidates-project"
const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function setup() {
  const root = mkdtempSync(join(tmpdir(), "lazers-model-candidates-"))
  const path = join(root, "tasks.sqlite")
  const repository = new TaskRepository(path, project)
  ensureModelCandidatesSchema(repository)
  const writer = new ModelEvidenceStore(path, project)
  const reader = new ModelEvidenceReadStore(path, project)
  cleanups.push(() => {
    reader.close()
    writer.close()
    repository.close()
    rmSync(root, { recursive: true, force: true })
  })
  return { root, path, repository, writer, reader }
}

/** Every candidate of the old read, page by page, as it reached the GUI. */
function oldCandidates(reader: ModelEvidenceReadStore, filters: Record<string, unknown> = {}) {
  const all = []
  let cursor: string | undefined
  do {
    const page = readModelComparison(reader, { limit: 3, filters, ...(cursor ? { cursor } : {}) })
    all.push(...page.candidates)
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  return all
}

type Row = {
  candidate_id: string
  provider_id: string
  model_id: string
  variant: string | null
  name: string | null
  enabled: number | null
  context_tokens: number | null
  price_input: number | null
  price_output: number | null
  correspondence: string
  benchmark_correspondence: string
  detail: string
}

const storedRows = (repository: TaskRepository) =>
  repository.read((db) =>
    db
      .query<Row, [string]>(
        `SELECT candidate_id,provider_id,model_id,variant,name,enabled,context_tokens,price_input,
           price_output,correspondence,benchmark_correspondence,detail FROM model_candidates
         WHERE project_directory=? ORDER BY provider_id,model_id,variant,id`,
      )
      .all(project),
  )

test("model_candidates parity: rows equal readModelComparison candidates (identity, order, every list field) for the recorded evidence fixture", () => {
  const { repository, writer, reader } = setup()
  seedEvidenceCorpus(writer, project)
  const result = repository.atomic((db) => refreshModelCandidates(db, project))
  const old = oldCandidates(reader)
  expect(old.length).toBeGreaterThan(8)
  expect(result).toMatchObject({ built: true, candidates: old.length, inserted: old.length })
  const rows = storedRows(repository)
  // Order and identity, then the whole candidate, byte for byte.
  expect(rows.map((row) => row.candidate_id)).toEqual(old.map((candidate) => candidate.candidateID))
  expect(rows.map((row) => row.detail)).toEqual(old.map((candidate) => JSON.stringify(candidate)))
  for (const [index, row] of rows.entries()) {
    const candidate = old[index]!
    const base = candidate.native.prices?.tiers.find((tier) => tier.contextTierTokens === null)
    expect(row).toMatchObject({
      provider_id: candidate.identity.providerID,
      model_id: candidate.identity.modelID,
      variant: candidate.identity.variant,
      name: candidate.native.name,
      enabled: candidate.native.enabled === null ? null : candidate.native.enabled ? 1 : 0,
      context_tokens: candidate.native.contextTokens,
      price_input: base?.input ?? null,
      price_output: base?.output ?? null,
      correspondence: candidate.correspondence.status,
      benchmark_correspondence: candidate.benchmarkCorrespondence.status,
    })
  }
  // The first page's public catalog and coverage are stored once per project.
  const first = readModelComparison(reader, { limit: 1 })
  const set = repository.read((db) =>
    db
      .query<{ public_catalog: string; public_coverage: string; candidate_count: number }, []>(
        "SELECT public_catalog,public_coverage,candidate_count FROM model_candidate_sets",
      )
      .get(),
  )!
  expect(set.candidate_count).toBe(old.length)
  expect(JSON.parse(set.public_catalog)).toEqual(first.publicCatalog!)
  expect(JSON.parse(set.public_coverage)).toEqual(first.publicCoverage!)
})

test("snapshot write: unchanged evidence rewrites zero candidate rows (count writes)", () => {
  const { repository, writer } = setup()
  const saved = seedEvidenceCorpus(writer, project)
  repository.atomic((db) => refreshModelCandidates(db, project))
  const changes = () =>
    repository.read((db) => db.query<{ n: number }, []>("SELECT total_changes() AS n").get()!.n)

  // The same snapshot set: stamps only, no body parse, no write.
  const before = changes()
  expect(repository.atomic((db) => refreshModelCandidates(db, project))).toMatchObject({
    built: false,
    inserted: 0,
    updated: 0,
    deleted: 0,
  })
  expect(changes()).toBe(before)

  // A new models.dev snapshot with the same records: a new set, built, but no candidate row moves
  // (candidates carry the models.dev record, not its snapshot id).
  const generations = writer.beginRefresh(["models-dev"])
  writer.saveSnapshot(
    evidenceSnapshot(
      "models-dev",
      project,
      generations["models-dev"],
      saved["models-dev"]!.records,
    ),
  )
  expect(repository.atomic((db) => refreshModelCandidates(db, project))).toMatchObject({
    built: true,
    inserted: 0,
    updated: 0,
    deleted: 0,
  })
})

test("a new native snapshot rewrites changed rows and deletes vanished ones", () => {
  const { repository, writer, reader } = setup()
  const saved = seedEvidenceCorpus(writer, project)
  repository.atomic((db) => refreshModelCandidates(db, project))
  const generations = writer.beginRefresh(["native-catalog"])
  // gpt-5 leaves the catalog; every remaining candidate's evidence names the new snapshot.
  const records = saved["native-catalog"]!.records.filter(
    (record) => !("id" in record && record.id === "gpt-5"),
  )
  writer.saveSnapshot(
    evidenceSnapshot("native-catalog", project, generations["native-catalog"], records),
  )
  const result = repository.atomic((db) => refreshModelCandidates(db, project))
  const old = oldCandidates(reader)
  // gpt-5 had its low and high variants.
  expect(result.deleted).toBe(2)
  expect(result.inserted).toBe(0)
  expect(storedRows(repository).map((row) => row.detail)).toEqual(
    old.map((candidate) => JSON.stringify(candidate)),
  )
})

test("missing price: a candidate no source prices has NULL price columns", () => {
  const { repository, writer } = setup()
  seedEvidenceCorpus(writer, project)
  repository.atomic((db) => refreshModelCandidates(db, project))
  const unpriced = storedRows(repository).filter((row) => row.model_id === "other-unmatched")
  expect(unpriced).toHaveLength(1)
  expect(unpriced[0]).toMatchObject({ price_input: null, price_output: null })
  const priced = storedRows(repository).find((row) => row.model_id === "gpt-5")!
  expect(priced).toMatchObject({ price_input: 1.25, price_output: 2.5 })
})

test("a saved snapshot queues its project; the worker builds it and the main thread writes it in pages", async () => {
  const { path, repository, writer, reader } = setup()
  const worker = createThreadedDecisionWorker({
    path,
    readPriceInputs: async () => {
      throw new Error("a candidate build reads no prices")
    },
  })
  const builds = new CandidateBuilds(path, worker)
  cleanups.push(() => {
    builds.close()
    worker.close()
  })
  const state = () =>
    repository.read((db) => projectionStatus(db, "model-candidates", project))?.state
  builds.ensure(project)
  await builds.settle()
  // Nothing stored yet: the first build found no snapshots, and the projection is ready.
  expect(storedRows(repository)).toEqual([])
  expect(state()).toBe("ready")
  seedEvidenceCorpus(writer, project)
  const queued = repository.read((db) =>
    db.query<{ ref: string }, []>(`SELECT ref FROM ${MODEL_CANDIDATES_QUEUE}`).all(),
  )
  expect(queued).toEqual([{ ref: project }])
  // An unrelated write transaction does not build the candidates (the build is the worker's).
  repository.atomic((db) => db.query("SELECT 1").get())
  expect(storedRows(repository)).toEqual([])
  await Bun.sleep(20)
  await builds.settle()
  const old = oldCandidates(reader)
  expect(storedRows(repository).map((row) => row.detail)).toEqual(
    old.map((candidate) => JSON.stringify(candidate)),
  )
  expect(builds.writes.get(project)!.rows).toBe(old.length)
  expect(
    repository.read((db) =>
      db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${MODEL_CANDIDATES_QUEUE}`).get(),
    )!.n,
  ).toBe(0)
  // Unchanged: the worker answers null and nothing is written.
  builds.writes.clear()
  await builds.build(project)
  expect(builds.writes.size).toBe(0)
})

test("a failing build stays queued with its error and a backoff, and a later build recovers", async () => {
  const { path, repository, writer } = setup()
  seedEvidenceCorpus(writer, project)
  let fail = true
  const builds = new CandidateBuilds(path, {
    async candidates(projectDirectory) {
      if (fail) throw new Error("worker gone")
      const shared = acquireSharedConnection(path, "readonly")
      try {
        return computeCandidateChanges(shared.db, projectDirectory)
      } finally {
        shared.release()
      }
    },
  })
  cleanups.push(() => builds.close())
  builds.ensure(project)
  await builds.settle()
  const parked = repository.read((db) =>
    db
      .query<{ attempts: number; error: string; next_at: number }, []>(
        `SELECT attempts,error,next_at FROM ${MODEL_CANDIDATES_QUEUE}`,
      )
      .get(),
  )!
  expect(parked.error).toBe("worker gone")
  expect(parked.next_at).toBeGreaterThan(Date.now())
  expect(repository.read((db) => projectionStatus(db, "model-candidates", project))).toMatchObject({
    state: "backfilling",
    last_error: "worker gone",
  })
  fail = false
  await builds.build(project)
  expect(storedRows(repository).length).toBeGreaterThan(8)
  expect(repository.read((db) => projectionStatus(db, "model-candidates", project))?.state).toBe(
    "ready",
  )
})

test("models.candidates walks the stored rows in the comparison order; enabled and provider filter", async () => {
  const { path, repository, writer, reader } = setup()
  seedEvidenceCorpus(writer, project)
  repository.atomic((db) => refreshModelCandidates(db, project))
  const pool = readerPool(path, { workers: 1 })
  cleanups.push(() => pool.close())
  const walk = async (filter: ModelCandidatesFilter, window: number, detail = false) => {
    const stream = openStream(pool, modelCandidatesSource, {
      filter,
      order: "catalog",
      window,
      transport: "copy",
    })
    await stream.ready()
    const seen: { candidate_id: string; detail?: unknown }[] = []
    const take = () => {
      for (const row of stream.items)
        if (!seen.some((item) => item.candidate_id === row.candidate_id))
          seen.push({
            candidate_id: row.candidate_id as string,
            ...(detail ? { detail: (row as Record<string, unknown>).detail } : {}),
          })
    }
    take()
    while (stream.after !== 0) {
      await stream.slide(window)
      take()
    }
    stream.close()
    return seen
  }
  const base = { projectDirectory: project, sessionID: "ses" }
  for (const window of [1, 2, 5, 60]) {
    const seen = await walk(base, window, window === 1)
    const old = oldCandidates(reader)
    expect(seen.map((row) => row.candidate_id)).toEqual(old.map((c) => c.candidateID))
    if (window === 1) expect(seen.map((row) => row.detail)).toEqual(old)
  }
  expect((await walk({ ...base, enabled: true }, 4)).map((row) => row.candidate_id)).toEqual(
    oldCandidates(reader, { enabled: true }).map((c) => c.candidateID),
  )
  expect((await walk({ ...base, enabled: false }, 4)).map((row) => row.candidate_id)).toEqual(
    oldCandidates(reader, { enabled: false }).map((c) => c.candidateID),
  )
  expect((await walk({ ...base, providerID: "openai" }, 2)).map((row) => row.candidate_id)).toEqual(
    oldCandidates(reader, { providerID: "openai" }).map((c) => c.candidateID),
  )
  expect(await walk({ ...base, projectDirectory: "/elsewhere" }, 5)).toEqual([])
})

test("models.candidates authorize: the comparison RPC's check, and the service's own project", async () => {
  const asked: string[] = []
  const context: StreamContext = {
    projectID: "p",
    projectDirectory: project,
    projectIds: (id) => [id],
    assertRead: async () => {
      throw new Error("not this check")
    },
    assertAction: async (sessionID, action) => {
      asked.push(`${sessionID} ${action}`)
    },
  }
  const filter = await modelCandidatesSource.authorize!(
    { projectDirectory: "/other", sessionID: "ses" },
    context,
  )
  expect(filter.projectDirectory).toBe(project)
  expect(asked).toEqual(["ses lz-read-model-comparison"])
  const { assertAction: _, ...without } = context
  await expect(
    Promise.resolve(
      modelCandidatesSource.authorize!({ projectDirectory: project, sessionID: "ses" }, without),
    ),
  ).rejects.toThrow("Models scope is unavailable")
})
