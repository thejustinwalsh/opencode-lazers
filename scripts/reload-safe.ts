import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { reloadSafety } from "../src/runner/reload-safety.ts"

/**
 * `bun scripts/reload-safe.ts [tasks.sqlite] [opencode.db]`: read-only; exits 0 when a reload is
 * safe, 1 when not. OpenCode's database is read to find Architect turns in flight.
 */
const data = join(homedir(), ".local/share/opencode")
const path = process.argv[2] ?? join(data, "plugins/lazers/tasks.sqlite")
const opencodePath = process.argv[3] ?? join(data, "opencode.db")
const db = new Database(path, { readonly: true })
const opencode = existsSync(opencodePath)
  ? new Database(opencodePath, { readonly: true })
  : undefined
const result = reloadSafety(db, opencode)
db.close()
opencode?.close()
console.log(result.line)
if (result.uncertainLine) console.log(result.uncertainLine)
process.exit(result.safe ? 0 : 1)
