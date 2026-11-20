import type { Database } from "bun:sqlite"
import { existsSync, readdirSync, rmSync, rmdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { rawReportPath } from "../audit/audit-raw.ts"

/**
 * Retention of audit runs of retired plans. A run is its rows (`audit_runs`, `audit_sections`,
 * `audit_findings`, `audit_decisions`) and its files under the plugin data folder: the raw
 * reports `audits/<runID>/<analysis>.json.gz` and the replaceable export `audits/<runID>.json`.
 *
 * Rows go first, in one transaction per batch of runs; files are removed only after that commit,
 * and a file is removed only when no `audit_sections` row names it. A failed removal leaves a
 * folder without rows, which the next pass finds and removes.
 */
export const AUDIT_RUNS_KIND = {
  id: "audit-runs",
  label: "Audit runs",
  detail: "audit runs of finished plans: their findings, decisions and compressed report files",
} as const

const TABLES = ["audit_runs", "audit_sections", "audit_findings", "audit_decisions"] as const
const inList = "(SELECT value FROM json_each(?))"

function present(db: Database) {
  return TABLES.every(
    (name) =>
      db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== null,
  )
}

/** A run id names a folder only when it cannot climb out of `audits/`. */
const safeID = (id: string) => id !== "" && !/[\\/]/.test(id) && id !== "." && id !== ".."

/** Finished runs whose task or attempt belongs to a retired plan. */
function retirableRuns(db: Database, retired: string[], limit: number): string[] {
  const json = JSON.stringify(retired)
  return db
    .query<{ id: string }, [string, string, number]>(
      `SELECT id FROM audit_runs
        WHERE json_extract(payload,'$.state') != 'collecting'
          AND (task_id IN (SELECT task_id FROM runner_nodes WHERE plan_id IN ${inList})
               OR attempt_id IN (SELECT id FROM runner_attempts WHERE plan_id IN ${inList}))
        ORDER BY rowid LIMIT ?`,
    )
    .all(json, json, limit)
    .map((row) => row.id)
}

function fileSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

function runFileBytes(dataDirectory: string, runID: string): number {
  if (!safeID(runID)) return 0
  let bytes = fileSize(join(dataDirectory, "audits", `${runID}.json`))
  try {
    for (const name of readdirSync(join(dataDirectory, "audits", runID)))
      bytes += fileSize(join(dataDirectory, "audits", runID, name))
  } catch {
    /* No folder: the run never wrote a file. */
  }
  return bytes
}

/** Folders of runs that no longer have a row: left by a removal that failed after its commit. */
function orphanFolders(db: Database, dataDirectory: string): string[] {
  let names: string[]
  try {
    names = readdirSync(join(dataDirectory, "audits"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
  const exists = db.query("SELECT 1 FROM audit_runs WHERE id=?")
  return names.filter((name) => safeID(name) && exists.get(name) === null)
}

function rowBytes(db: Database, ids: string[]): { rows: number; bytes: number } {
  if (!ids.length) return { rows: 0, bytes: 0 }
  const json = JSON.stringify(ids)
  const one = (sql: string) =>
    db.query<{ n: number; b: number | null }, [string]>(sql).get(json) ?? { n: 0, b: 0 }
  const parts = [
    one(
      `SELECT COUNT(*) AS n, SUM(length(CAST(payload AS BLOB))+length(id)+96) AS b FROM audit_runs WHERE id IN ${inList}`,
    ),
    one(
      `SELECT COUNT(*) AS n, SUM(length(CAST(payload AS BLOB))+COALESCE(length(CAST(summary AS BLOB)),0)+COALESCE(length(CAST(error AS BLOB)),0)+length(analysis)+64) AS b FROM audit_sections WHERE run_id IN ${inList}`,
    ),
    one(
      `SELECT COUNT(*) AS n, SUM(length(CAST(details AS BLOB))+length(finding_id)+length(category)+COALESCE(length(path),0)+64) AS b FROM audit_findings WHERE run_id IN ${inList}`,
    ),
    one(
      `SELECT COUNT(*) AS n, SUM(length(CAST(payload AS BLOB))+length(finding_id)+96) AS b FROM audit_decisions WHERE run_id IN ${inList}`,
    ),
  ]
  return {
    rows: parts.reduce((sum, part) => sum + part.n, 0),
    bytes: parts.reduce((sum, part) => sum + (part.b ?? 0), 0),
  }
}

/** Rows and bytes (rows plus files) a purge would remove. Reads only. */
export function measureAuditRuns(
  db: Database,
  input: { retired: string[]; dataDirectory: string },
): { rows: number; bytes: number } {
  if (!present(db)) return { rows: 0, bytes: 0 }
  const ids = retirableRuns(db, input.retired, Number.MAX_SAFE_INTEGER)
  const totals = { rows: 0, bytes: 0 }
  for (let start = 0; start < ids.length; start += 500) {
    const sized = rowBytes(db, ids.slice(start, start + 500))
    totals.rows += sized.rows
    totals.bytes += sized.bytes
  }
  const orphans = orphanFolders(db, input.dataDirectory)
  for (const id of [...ids, ...orphans]) totals.bytes += runFileBytes(input.dataDirectory, id)
  totals.rows += orphans.length
  return totals
}

/**
 * Removes a run's files, but never one that an `audit_sections` row still names. Returns the
 * bytes freed. The folder goes when it is left empty, the export when the run row is gone.
 */
function removeFiles(db: Database, dataDirectory: string, runID: string): number {
  if (!safeID(runID)) return 0
  let bytes = 0
  const folder = join(dataDirectory, "audits", runID)
  const named = new Set(
    db
      .query<{ analysis: string }, [string]>("SELECT analysis FROM audit_sections WHERE run_id=?")
      .all(runID)
      .map((row) => rawReportPath(dataDirectory, runID, row.analysis)),
  )
  let names: string[] = []
  try {
    names = readdirSync(folder)
  } catch {
    /* No folder. */
  }
  for (const name of names) {
    const path = join(folder, name)
    if (named.has(path)) continue
    bytes += fileSize(path)
    rmSync(path, { force: true })
  }
  try {
    rmdirSync(folder)
  } catch {
    /* Not empty (a file a section row still names) or already gone. */
  }
  if (db.query("SELECT 1 FROM audit_runs WHERE id=?").get(runID) === null) {
    const exported = join(dataDirectory, "audits", `${runID}.json`)
    bytes += fileSize(exported)
    rmSync(exported, { force: true })
  }
  return bytes
}

/**
 * One batch of runs: their rows in one transaction, then their files. `rows` is 0 when nothing
 * retirable remains (and when an orphan folder could not be removed, so a caller loops no more).
 */
export function retireAuditRunBatch(
  atomic: <T>(run: (db: Database) => T) => T,
  read: <T>(run: (db: Database) => T) => T,
  input: { retired: string[]; dataDirectory: string; batch: number },
): { rows: number; bytes: number } {
  const deleted = atomic((db) => {
    if (!present(db)) return { rows: 0, bytes: 0, ids: [] as string[] }
    const ids = retirableRuns(db, input.retired, input.batch)
    if (!ids.length) return { rows: 0, bytes: 0, ids }
    const sized = rowBytes(db, ids)
    const json = JSON.stringify(ids)
    for (const table of ["audit_findings", "audit_decisions", "audit_sections"])
      db.query(`DELETE FROM ${table} WHERE run_id IN ${inList}`).run(json)
    db.query(`DELETE FROM audit_runs WHERE id IN ${inList}`).run(json)
    return { ...sized, ids }
  })
  let { rows, bytes } = deleted
  // Folders of the runs just deleted are orphans now; only the ones that were orphans before count.
  const orphans = read((db) => (present(db) ? orphanFolders(db, input.dataDirectory) : []))
  for (const id of new Set([...deleted.ids, ...orphans])) {
    bytes += read((db) => removeFiles(db, input.dataDirectory, id))
    if (!deleted.ids.includes(id) && !existsSync(join(input.dataDirectory, "audits", id))) rows += 1
  }
  return { rows, bytes }
}
