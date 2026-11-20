import { homedir } from "node:os"
import { join } from "node:path"
import { auditLive } from "../src/tasks/schedule/live-audit.ts"

/**
 * Compare the old Tasks list's order and chip membership with the stored list for every project of
 * a database, writing nothing.
 *
 *   bun scripts/task-schedule-audit.ts [path to tasks.sqlite]
 *
 * The file is opened `mode=ro`; the projection is built in an attached memory database and the
 * old order is the SQL kept in `src/tasks/schedule/live-audit.ts`. Exit 1 when the order differs
 * or a chip differs for a reason other than the intentional one.
 */
const path =
  process.argv.slice(2).find((arg) => !arg.startsWith("--")) ??
  join(homedir(), ".local/share/opencode/plugins/lazers/tasks.sqlite")
let divergent = 0
for (const report of auditLive(path)) {
  console.log(JSON.stringify(report, null, 2))
  const unexplained = Object.keys(report.kinds).filter((kind) => !kind.includes("(intentional)"))
  if (!report.scheduleOrder.equal || unexplained.length) divergent++
}
process.exit(divergent ? 1 : 0)
