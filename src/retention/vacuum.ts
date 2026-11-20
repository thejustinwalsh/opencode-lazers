import { statfsSync } from "node:fs"
import { dirname } from "node:path"
import { Database } from "bun:sqlite"

/**
 * Giving deleted space back to the filesystem.
 *
 * SQLite reuses free pages but never shrinks the file by itself. With `auto_vacuum=INCREMENTAL`
 * the retention pass can hand pages back a few at a time with `PRAGMA incremental_vacuum(N)`. A
 * database created without that mode keeps its mode until one full `VACUUM` rebuilds it, which
 * rewrites every live page: never at startup, only as an explicit owner action
 * (`scripts/compact-database.ts`).
 */

/**
 * Pages released per step. Measured on a 250 MB fixture whose free pages were scattered (three of
 * four rows deleted, the worst case: each released page moves a live page into the hole): about
 * 12 us per page, so 2000 pages (8 MB at 4 KiB) take 25 to 30 ms, in line with the few tens of
 * milliseconds a single retention batch holds the write lock (see WINDOW in retention.ts).
 * Free pages at the end of the file release faster (256 pages: 2 ms).
 */
export const INCREMENTAL_VACUUM_PAGES = 2000

export type AutoVacuum = "none" | "full" | "incremental"

export type SpaceState = {
  autoVacuum: AutoVacuum
  pageSize: number
  pageCount: number
  freelistPages: number
}

export function spaceState(db: Database): SpaceState {
  const pragma = (name: string) =>
    (db.query<Record<string, number>, []>(`PRAGMA ${name}`).get() ?? {})[name] ?? 0
  const mode = pragma("auto_vacuum")
  return {
    autoVacuum: mode === 2 ? "incremental" : mode === 1 ? "full" : "none",
    pageSize: pragma("page_size"),
    pageCount: pragma("page_count"),
    freelistPages: pragma("freelist_count"),
  }
}

/**
 * Release up to `pages` free pages to the filesystem. Does nothing (returns 0) unless the
 * database is in incremental mode; the caller owns the transaction.
 */
export function incrementalVacuum(db: Database, pages = INCREMENTAL_VACUUM_PAGES): number {
  const before = spaceState(db)
  if (before.autoVacuum !== "incremental" || before.freelistPages === 0) return 0
  db.query(`PRAGMA incremental_vacuum(${Math.max(1, Math.floor(pages))})`).all()
  return (before.freelistPages - spaceState(db).freelistPages) * before.pageSize
}

/**
 * Free disk a full VACUUM needs. It builds a copy of the live pages in a temporary database, then
 * writes them back through the WAL: two copies of the live data on top of the current file.
 * Measured on a 1 GB fixture with 250 MB live: the directory peaked near 1.2 GB (file plus about
 * 200 MB), below this bound; a database with no free pages is the case that needs all of it.
 */
export function compactionDiskBytes(state: SpaceState): number {
  return 2 * (state.pageCount - state.freelistPages) * state.pageSize
}

export type Compaction = {
  beforeBytes: number
  afterBytes: number
  seconds: number
  autoVacuum: AutoVacuum
}

export class CompactionRefused extends Error {}

/**
 * The one-time full VACUUM that switches a database to incremental mode (and returns every free
 * page). Opens its own connection and holds the write lock for the duration, so the caller must
 * run it with the service idle; refuses when the disk cannot hold the temporary copies.
 */
export function compactOnce(
  path: string,
  options: { freeDiskBytes?: number; waitMs?: number } = {},
): Compaction {
  const db = new Database(path)
  try {
    db.exec(`PRAGMA busy_timeout = ${options.waitMs ?? 5000}`)
    const state = spaceState(db)
    const free =
      options.freeDiskBytes ??
      (() => {
        const stat = statfsSync(dirname(path))
        return stat.bavail * stat.bsize
      })()
    const needed = compactionDiskBytes(state)
    if (free < needed)
      throw new CompactionRefused(
        `needs ${needed} bytes of free disk next to the database, ${free} available`,
      )
    const started = performance.now()
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
    const beforeBytes = spaceState(db).pageCount * state.pageSize
    // The new mode is recorded by the rebuild that VACUUM performs.
    db.exec("PRAGMA auto_vacuum = INCREMENTAL")
    db.exec("VACUUM")
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
    const after = spaceState(db)
    return {
      beforeBytes,
      afterBytes: after.pageCount * after.pageSize,
      seconds: (performance.now() - started) / 1000,
      autoVacuum: after.autoVacuum,
    }
  } finally {
    db.close()
  }
}

/**
 * Whether another connection, in this or another process, has the database open. A connection in
 * WAL mode holds a shared lock on the file for its whole life, so leaving WAL (which needs the
 * exclusive lock) fails with "database is locked" while any other connection exists; a database
 * in a rollback journal fails the same way on `BEGIN EXCLUSIVE`. The probe waits for nothing
 * (`busy_timeout = 0`), changes nothing when it succeeds (WAL is restored) and takes no data
 * lock for longer than the probe itself.
 */
export function databaseInUse(path: string): boolean {
  const db = new Database(path)
  try {
    db.exec("PRAGMA busy_timeout = 0")
    const mode = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode
    if (mode === "wal") {
      db.exec("PRAGMA journal_mode = DELETE")
      db.exec("PRAGMA journal_mode = WAL")
    } else {
      db.exec("BEGIN EXCLUSIVE")
      db.exec("ROLLBACK")
    }
    return false
  } catch (error) {
    if (/locked|busy/i.test(String(error))) return true
    throw error
  } finally {
    db.close()
  }
}
