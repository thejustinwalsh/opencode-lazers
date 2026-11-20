import { Database } from "bun:sqlite"
import { homedir } from "node:os"
import { realpathSync } from "node:fs"
import { join } from "node:path"
import { TaskRepository } from "../src/storage.ts"
import { TaskReads } from "../src/tasks/read.ts"
import { backfillPage } from "../src/tasks/schedule/backfill.ts"
import { compareReads } from "../src/tasks/schedule/parity.ts"

/**
 * Compare the old Tasks read with the schedule projection for every project of a database.
 *
 *   bun scripts/task-schedule-audit.ts <path to a COPY of tasks.sqlite>
 *
 * It opens the copy for writing (the projection is installed and backfilled in it), so it refuses
 * the live database. Copy the file somewhere under a temp directory first.
 */
const path = process.argv[2]
if (!path) throw new Error("usage: bun scripts/task-schedule-audit.ts <copy of tasks.sqlite>")
const live = join(homedir(), ".local/share/opencode/plugins/lazers/tasks.sqlite")
if (realpathSync(path) === realpathSync(live))
  throw new Error("Refusing the live database: audit a copy under a temp directory")

const projects = new Database(path, { readonly: true })
  .query<{ project_directory: string }, []>("SELECT DISTINCT project_directory FROM tasks")
  .all()
  .map((row) => row.project_directory)

let divergent = 0
for (const project of projects) {
  const repository = new TaskRepository(path, project)
  const reads = new TaskReads(repository)
  for (let pages = 0; ; pages++) {
    if (repository.atomic((db) => backfillPage(db, project)).done) break
    if (pages > 1_000_000) throw new Error("Backfill did not finish")
  }
  const found = compareReads(repository, reads)
  console.log(`${project}: ${found.length === 0 ? "equal" : `${found.length} divergences`}`)
  for (const item of found.slice(0, 5)) console.log("  ", JSON.stringify(item))
  divergent += found.length
  repository.close()
}
process.exit(divergent ? 1 : 0)
