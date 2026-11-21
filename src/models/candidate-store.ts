import type { Database } from "bun:sqlite"
import { schemaModules } from "../database-schema.ts"
import { ensureProjectionStateSchema, resetProjectionState } from "../projections/lifecycle.ts"
import type { ProjectionSpec } from "../projections/owner.ts"
import { drainQueue, queueRef, queueTableSQL, type QueueDrain } from "../projections/queue.ts"
import type { TaskRepository } from "../storage.ts"
import { buildComparisonCandidates } from "./comparison-read.ts"
import { installModelEvidenceTables, readComparisonSourcesFrom } from "./source-store.ts"

/**
 * `model_candidates`: one row per (project, provider, model, variant) of the comparison, built
 * once per evidence snapshot set instead of on every comparison read, so the picker and the
 * catalog read rows instead of five parsed snapshot bodies.
 *
 * ```
 * saveSnapshot ─► model_evidence_refreshes.latest_snapshot_id ─trigger─► model_candidates_dirty(project)
 *                                                                              │ owner drain (next turn)
 *   stamps of the project's latest snapshots ─ same set as stored? ─ yes ─► nothing written
 *                                              └ no ─► parse the five bodies, build every candidate,
 *                                                      compare digests, write only changed rows,
 *                                                      delete vanished ones, stamp the set
 * ```
 *
 * The queue is drained only by the projection owner, never in a writer's transaction: a build parses
 * the five bodies (measured on the live copy: about 100 ms with 1,466 candidates), and that must not
 * land inside an unrelated runner write. The five saves of one refresh commit in one event-loop
 * turn, so the owner hears the queue once and builds once.
 *
 * `detail` is the whole candidate as the comparison read returns it (cold, `window: 1`); the list
 * columns are the fields a picker filters, sorts and shows. `price_input`/`price_output` are the
 * native catalog's unconditional tier (USD per million tokens), NULL when that tier is absent or
 * incomplete: the price UI is omitted then, never shown as unknown. `variant` is NULL for the
 * model's own entry, which sorts first as in the comparison read.
 */
const MODULE = schemaModules["model-candidates"]
const MODEL_CANDIDATES = "model-candidates"
const MODEL_CANDIDATES_GENERATION = 1
export const MODEL_CANDIDATES_QUEUE = "model_candidates_dirty"

const TABLES_SQL = `
  CREATE TABLE model_candidates (
    id INTEGER PRIMARY KEY,
    project_directory TEXT NOT NULL,
    candidate_id TEXT NOT NULL,
    provider_id TEXT NOT NULL, model_id TEXT NOT NULL, variant TEXT,
    name TEXT, enabled INTEGER, context_tokens INTEGER,
    price_input REAL, price_output REAL,
    correspondence TEXT NOT NULL, benchmark_correspondence TEXT NOT NULL,
    digest TEXT NOT NULL,
    detail TEXT NOT NULL,
    UNIQUE(project_directory, candidate_id)
  );
  CREATE INDEX model_candidates_order
    ON model_candidates(project_directory, provider_id, model_id, variant, id);
  CREATE INDEX model_candidates_enabled
    ON model_candidates(project_directory, enabled, provider_id, model_id, variant, id);
  CREATE TABLE model_candidate_sets (
    id INTEGER PRIMARY KEY,
    project_directory TEXT NOT NULL UNIQUE,
    snapshot_set TEXT NOT NULL,
    candidate_count INTEGER NOT NULL,
    public_coverage TEXT NOT NULL,
    public_catalog TEXT NOT NULL,
    built_at INTEGER NOT NULL
  );
  ${queueTableSQL(MODEL_CANDIDATES_QUEUE)}
`

type TriggerSpec = { name: string; on: string; event: string; when?: string; body: string }
const queue = (ref: string) => queueRef(MODEL_CANDIDATES_QUEUE, ref)

/** A project's candidates change only when the snapshot a source points at changes. */
const MODEL_CANDIDATES_TRIGGERS: readonly TriggerSpec[] = [
  {
    name: "model_candidates_q_refresh_insert",
    on: "model_evidence_refreshes",
    event: "INSERT",
    when: "NEW.latest_snapshot_id IS NOT NULL",
    body: queue("NEW.project_directory"),
  },
  {
    name: "model_candidates_q_refresh_update",
    on: "model_evidence_refreshes",
    event: "UPDATE OF latest_snapshot_id",
    when: "NEW.latest_snapshot_id IS NOT OLD.latest_snapshot_id",
    body: queue("NEW.project_directory"),
  },
  {
    name: "model_candidates_q_refresh_delete",
    on: "model_evidence_refreshes",
    event: "DELETE",
    body: queue("OLD.project_directory"),
  },
  {
    // The selection falls back to the newest stored snapshot when a source has no refresh row,
    // and a deleted latest snapshot reads as missing: either changes the set.
    name: "model_candidates_q_snapshot_delete",
    on: "model_evidence_snapshots",
    event: "DELETE",
    body: queue("OLD.project_directory"),
  },
  {
    name: "model_candidates_q_snapshot_insert",
    on: "model_evidence_snapshots",
    event: "INSERT",
    when: `NOT EXISTS (SELECT 1 FROM model_evidence_refreshes r
             WHERE r.project_directory=NEW.project_directory AND r.source=NEW.source)`,
    body: queue("NEW.project_directory"),
  },
]

function installModelCandidatesSchema(db: Database) {
  installModelEvidenceTables(db)
  for (const spec of MODEL_CANDIDATES_TRIGGERS) db.exec(`DROP TRIGGER IF EXISTS ${spec.name}`)
  db.exec(`DROP TABLE IF EXISTS model_candidates; DROP TABLE IF EXISTS model_candidate_sets;
    DROP TABLE IF EXISTS ${MODEL_CANDIDATES_QUEUE};`)
  db.exec(TABLES_SQL)
  for (const spec of MODEL_CANDIDATES_TRIGGERS)
    db.exec(
      `CREATE TRIGGER ${spec.name} AFTER ${spec.event} ON ${spec.on}
       ${spec.when ? `WHEN ${spec.when}` : ""} BEGIN ${spec.body} END;`,
    )
  resetProjectionState(db, MODEL_CANDIDATES)
}

/** Install through the module registry (one transaction, generation checked). */
export function ensureModelCandidatesSchema(repository: TaskRepository) {
  ensureProjectionStateSchema(repository)
  repository.installSchema("model-candidates", MODULE.generation, MODULE.tables, (db) =>
    installModelCandidatesSchema(db),
  )
}

type Candidate = ReturnType<typeof buildComparisonCandidates>["candidates"][number]

/** The unconditional native tier, both rates present; otherwise no price (the UI omits it). */
function nativeBaseRates(candidate: Candidate) {
  const tier = candidate.native.prices?.tiers.find((entry) => entry.contextTierTokens === null)
  return tier && tier.input !== null && tier.output !== null
    ? { input: tier.input, output: tier.output }
    : null
}

const digestOf = (text: string) => Bun.hash(text).toString(36)

export type CandidateRefresh = {
  /** False when the stored set already matched the latest snapshots: nothing was read or written. */
  built: boolean
  candidates: number
  inserted: number
  updated: number
  deleted: number
}

/**
 * Bring one project's candidates to its latest snapshot set, in the caller's write transaction.
 * The stamp check reads refresh rows and snapshot metadata only; bodies are parsed only when the
 * set moved. Rows whose candidate is unchanged (same digest) are not written.
 */
export function refreshModelCandidates(db: Database, projectDirectory: string): CandidateRefresh {
  const none = { built: false, candidates: 0, inserted: 0, updated: 0, deleted: 0 }
  const stamps = readComparisonSourcesFrom(db, projectDirectory, undefined, { stampOnly: true })
  const snapshotSet = JSON.stringify(
    stamps.map((read) => [read.source, read.snapshotState, read.snapshotID]),
  )
  const stored = db
    .query<{ snapshot_set: string; candidate_count: number }, [string]>(
      "SELECT snapshot_set,candidate_count FROM model_candidate_sets WHERE project_directory=?",
    )
    .get(projectDirectory)
  if (stored?.snapshot_set === snapshotSet) return { ...none, candidates: stored.candidate_count }

  const built = buildComparisonCandidates(readComparisonSourcesFrom(db, projectDirectory))
  const existing = db.query<{ id: number; digest: string }, [string, string]>(
    "SELECT id,digest FROM model_candidates WHERE project_directory=? AND candidate_id=?",
  )
  const insert = db.query(
    `INSERT INTO model_candidates(project_directory,candidate_id,provider_id,model_id,variant,name,
       enabled,context_tokens,price_input,price_output,correspondence,benchmark_correspondence,
       digest,detail) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
  const update = db.query(
    `UPDATE model_candidates SET provider_id=?,model_id=?,variant=?,name=?,enabled=?,
       context_tokens=?,price_input=?,price_output=?,correspondence=?,benchmark_correspondence=?,
       digest=?,detail=? WHERE id=?`,
  )
  const result: CandidateRefresh = {
    built: true,
    candidates: built.candidates.length,
    inserted: 0,
    updated: 0,
    deleted: 0,
  }
  for (const candidate of built.candidates) {
    const detail = JSON.stringify(candidate)
    const digest = digestOf(detail)
    const row = existing.get(projectDirectory, candidate.candidateID)
    if (row?.digest === digest) continue
    const rates = nativeBaseRates(candidate)
    const enabled = candidate.native.enabled
    const values = [
      candidate.identity.providerID,
      candidate.identity.modelID,
      candidate.identity.variant,
      candidate.native.name,
      enabled === null ? null : enabled ? 1 : 0,
      candidate.native.contextTokens,
      rates?.input ?? null,
      rates?.output ?? null,
      candidate.correspondence.status,
      candidate.benchmarkCorrespondence.status,
      digest,
      detail,
    ] as const
    if (row) {
      update.run(...values, row.id)
      result.updated++
    } else {
      insert.run(projectDirectory, candidate.candidateID, ...values)
      result.inserted++
    }
  }
  result.deleted = db
    .query(
      `DELETE FROM model_candidates WHERE project_directory=?
         AND candidate_id NOT IN (SELECT value FROM json_each(?))`,
    )
    .run(projectDirectory, JSON.stringify(built.candidates.map((c) => c.candidateID))).changes
  db.query(
    `INSERT INTO model_candidate_sets(project_directory,snapshot_set,candidate_count,public_coverage,
       public_catalog,built_at) VALUES(?,?,?,?,?,?)
     ON CONFLICT(project_directory) DO UPDATE SET snapshot_set=excluded.snapshot_set,
       candidate_count=excluded.candidate_count,public_coverage=excluded.public_coverage,
       public_catalog=excluded.public_catalog,built_at=excluded.built_at`,
  ).run(
    projectDirectory,
    snapshotSet,
    built.candidates.length,
    JSON.stringify(built.publicCoverage),
    JSON.stringify(built.publicCatalog),
    Date.now(),
  )
  return result
}

/** One project per transaction: a build is the unit of work (see the module comment). */
function drainModelCandidates(db: Database): QueueDrain {
  return drainQueue(
    db,
    MODEL_CANDIDATES_QUEUE,
    (inner, ref) => void refreshModelCandidates(inner, ref),
    { budget: 1 },
  )
}

/**
 * Scoped to one project: the backfill is that project's first build (one page); the queue
 * catches every later snapshot change, for any project, whichever owner hears it first.
 */
export const modelCandidatesProjection: ProjectionSpec = {
  name: MODEL_CANDIDATES,
  generation: MODEL_CANDIDATES_GENERATION,
  backfill: [
    {
      name: "build",
      page(db, scope) {
        refreshModelCandidates(db, scope)
        return { next: 1, done: true }
      },
    },
  ],
  queue: { table: MODEL_CANDIDATES_QUEUE, drain: drainModelCandidates },
}
