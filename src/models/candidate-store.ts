import type { Database } from "bun:sqlite"
import { schemaModules } from "../database-schema.ts"
import { ensureProjectionStateSchema, resetProjectionState } from "../projections/lifecycle.ts"
import { queueRef, queueTableSQL } from "../projections/queue.ts"
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
 *                                                       │ CandidateBuilds (main thread, next turn)
 *   decision worker: stamps of the latest snapshots ─ same set as stored? ─ yes ─► null
 *                    └ no ─► parse the five bodies, build every candidate, compare digests
 *   main thread: changed rows, a page per transaction ─► deletions and the set stamp
 * ```
 *
 * The queue is drained only by `CandidateBuilds` (`candidate-builds.ts`), never in a writer's
 * transaction, and the parse and build run on the decision worker's read-only connection: the
 * main thread receives only changed rows and writes them in pages. The five saves of one refresh
 * commit in one event-loop turn, so one build follows.
 *
 * `detail` is the whole candidate as the comparison read returns it (cold, `window: 1`); the list
 * columns are the fields a picker filters, sorts and shows. `price_input`/`price_output` are the
 * native catalog's unconditional tier (USD per million tokens), NULL when that tier is absent or
 * incomplete: the price UI is omitted then, never shown as unknown. `variant` is NULL for the
 * model's own entry, which sorts first as in the comparison read.
 */
const MODULE = schemaModules["model-candidates"]
export const MODEL_CANDIDATES = "model-candidates"
export const MODEL_CANDIDATES_GENERATION = 1
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

/** A candidate row as stored: the list columns in table order, then digest and detail. */
export type CandidateRow = {
  candidateID: string
  values: [
    providerID: string,
    modelID: string,
    variant: string | null,
    name: string | null,
    enabled: number | null,
    contextTokens: number | null,
    priceInput: number | null,
    priceOutput: number | null,
    correspondence: string,
    benchmarkCorrespondence: string,
    digest: string,
    detail: string,
  ]
}

/** One build of a project's candidates: only rows whose digest moved, and the ids that remain. */
export type CandidateChanges = {
  snapshotSet: string
  candidateIDs: string[]
  changed: CandidateRow[]
  publicCoverage: string
  publicCatalog: string
}

/** The project's snapshot set, from refresh rows and snapshot metadata only (no body). */
function candidateSnapshotSet(db: Database, projectDirectory: string) {
  const stamps = readComparisonSourcesFrom(db, projectDirectory, undefined, { stampOnly: true })
  return JSON.stringify(stamps.map((read) => [read.source, read.snapshotState, read.snapshotID]))
}

const storedSet = (db: Database, projectDirectory: string) =>
  db
    .query<{ snapshot_set: string }, [string]>(
      "SELECT snapshot_set FROM model_candidate_sets WHERE project_directory=?",
    )
    .get(projectDirectory)?.snapshot_set

/**
 * Build a project's candidates and compare them with the stored digests; null when the stored set
 * is already the latest. Reads only: the decision worker runs it on its read-only connection
 * (parsing the five bodies there), and the main thread writes what it returns.
 */
export function computeCandidateChanges(
  db: Database,
  projectDirectory: string,
): CandidateChanges | null {
  const snapshotSet = candidateSnapshotSet(db, projectDirectory)
  if (storedSet(db, projectDirectory) === snapshotSet) return null
  const built = buildComparisonCandidates(readComparisonSourcesFrom(db, projectDirectory))
  const existing = db.query<{ digest: string }, [string, string]>(
    "SELECT digest FROM model_candidates WHERE project_directory=? AND candidate_id=?",
  )
  const changed: CandidateRow[] = []
  for (const candidate of built.candidates) {
    const detail = JSON.stringify(candidate)
    const digest = digestOf(detail)
    if (existing.get(projectDirectory, candidate.candidateID)?.digest === digest) continue
    const rates = nativeBaseRates(candidate)
    const enabled = candidate.native.enabled
    changed.push({
      candidateID: candidate.candidateID,
      values: [
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
      ],
    })
  }
  return {
    snapshotSet,
    candidateIDs: built.candidates.map((candidate) => candidate.candidateID),
    changed,
    publicCoverage: JSON.stringify(built.publicCoverage),
    publicCatalog: JSON.stringify(built.publicCatalog),
  }
}

/** Upsert a page of changed rows, in the caller's write transaction. Returns rows inserted. */
export function writeCandidatePage(
  db: Database,
  projectDirectory: string,
  rows: readonly CandidateRow[],
) {
  const upsert = db.query(
    `INSERT INTO model_candidates(project_directory,candidate_id,provider_id,model_id,variant,name,
       enabled,context_tokens,price_input,price_output,correspondence,benchmark_correspondence,
       digest,detail) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(project_directory,candidate_id) DO UPDATE SET provider_id=excluded.provider_id,
       model_id=excluded.model_id,variant=excluded.variant,name=excluded.name,
       enabled=excluded.enabled,context_tokens=excluded.context_tokens,
       price_input=excluded.price_input,price_output=excluded.price_output,
       correspondence=excluded.correspondence,benchmark_correspondence=excluded.benchmark_correspondence,
       digest=excluded.digest,detail=excluded.detail`,
  )
  for (const row of rows) upsert.run(projectDirectory, row.candidateID, ...row.values)
  return rows.length
}

/**
 * The last transaction of a build: remove vanished candidates and stamp the set. The queue entry
 * goes only when the latest set is the one built (a refresh during the build queues it again).
 */
export function finishCandidateBuild(
  db: Database,
  projectDirectory: string,
  changes: CandidateChanges,
) {
  const deleted = db
    .query(
      `DELETE FROM model_candidates WHERE project_directory=?
         AND candidate_id NOT IN (SELECT value FROM json_each(?))`,
    )
    .run(projectDirectory, JSON.stringify(changes.candidateIDs)).changes
  db.query(
    `INSERT INTO model_candidate_sets(project_directory,snapshot_set,candidate_count,public_coverage,
       public_catalog,built_at) VALUES(?,?,?,?,?,?)
     ON CONFLICT(project_directory) DO UPDATE SET snapshot_set=excluded.snapshot_set,
       candidate_count=excluded.candidate_count,public_coverage=excluded.public_coverage,
       public_catalog=excluded.public_catalog,built_at=excluded.built_at`,
  ).run(
    projectDirectory,
    changes.snapshotSet,
    changes.candidateIDs.length,
    changes.publicCoverage,
    changes.publicCatalog,
    Date.now(),
  )
  const current = candidateSnapshotSet(db, projectDirectory) === changes.snapshotSet
  if (current) db.query(`DELETE FROM ${MODEL_CANDIDATES_QUEUE} WHERE ref=?`).run(projectDirectory)
  return { deleted, current }
}

export type CandidateRefresh = {
  /** False when the stored set already matched the latest snapshots: nothing was read or written. */
  built: boolean
  candidates: number
  inserted: number
  updated: number
  deleted: number
}

/**
 * The whole build in one caller transaction, in process: tests, and tools that must wait. The
 * service builds through `CandidateBuilds` (compute in the decision worker, paged writes here).
 */
export function refreshModelCandidates(db: Database, projectDirectory: string): CandidateRefresh {
  const changes = computeCandidateChanges(db, projectDirectory)
  if (!changes)
    return {
      built: false,
      candidates:
        db
          .query<{ n: number }, [string]>(
            "SELECT candidate_count AS n FROM model_candidate_sets WHERE project_directory=?",
          )
          .get(projectDirectory)?.n ?? 0,
      inserted: 0,
      updated: 0,
      deleted: 0,
    }
  const exists = db.query<{ one: number }, [string, string]>(
    "SELECT 1 AS one FROM model_candidates WHERE project_directory=? AND candidate_id=?",
  )
  let updated = 0
  for (const row of changes.changed) if (exists.get(projectDirectory, row.candidateID)) updated++
  writeCandidatePage(db, projectDirectory, changes.changed)
  const { deleted } = finishCandidateBuild(db, projectDirectory, changes)
  return {
    built: true,
    candidates: changes.candidateIDs.length,
    inserted: changes.changed.length - updated,
    updated,
    deleted,
  }
}
