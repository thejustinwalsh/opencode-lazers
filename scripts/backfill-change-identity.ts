/**
 * Offline, idempotent backfill of stable change identity.
 *
 *   bun scripts/backfill-change-identity.ts --db <tasks.sqlite> --repo <dir> [--dry-run]
 *
 * Records tree OID, patch-id and change id for every stored artifact, base and
 * combined SHA that still resolves in the repository, and writes the
 * `refs/notes/lazers` change-id notes. SHA columns are never modified.
 * `--dry-run` works on a temporary copy of the database and writes no notes, so
 * it is safe to point at a live database file. Stop the plugin before a real run.
 */
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { stampChangeIdentity, type StampReport } from "../src/runner/identity-stamp.ts"
import { installChangeIdentity } from "../src/runner/identity-store.ts"

export async function backfillChangeIdentity(input: {
  db: string
  repo: string
  dryRun?: boolean
}): Promise<StampReport> {
  let workDirectory: string | undefined
  let path = input.db
  if (input.dryRun) {
    workDirectory = mkdtempSync(join(tmpdir(), "lazers-backfill-"))
    path = join(workDirectory, "copy.sqlite")
    const source = new Database(input.db, { readonly: true })
    try {
      source.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`)
    } finally {
      source.close()
    }
  }
  const db = new Database(path)
  try {
    db.exec("PRAGMA busy_timeout=5000")
    installChangeIdentity(db)
    const access = {
      read: <T>(run: (db: Database) => T) => run(db),
      write: <T>(run: (db: Database) => T) => db.transaction(() => run(db))(),
    }
    return await stampChangeIdentity(access, input.repo, { dryRun: input.dryRun, notes: true })
  } finally {
    db.close()
    if (workDirectory) rmSync(workDirectory, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const value = (flag: string) => {
    const index = args.indexOf(flag)
    return index >= 0 ? args[index + 1] : undefined
  }
  const db = value("--db")
  const repo = value("--repo")
  if (!db || !repo) {
    console.error("usage: backfill-change-identity.ts --db <path> --repo <dir> [--dry-run]")
    process.exit(2)
  }
  const dryRun = args.includes("--dry-run")
  const report = await backfillChangeIdentity({ db, repo, dryRun })
  console.log(
    JSON.stringify(
      {
        mode: dryRun ? "dry-run" : "applied",
        resolvedShas: report.resolved,
        unresolvedShas: report.unresolved.length,
        notesWritten: report.notesWritten,
        changeIdsAssigned: report.changeIdsAssigned,
        rowsUpdated: report.rowsUpdated,
        unresolved: report.unresolved,
      },
      null,
      2,
    ),
  )
}
