import { Database } from "bun:sqlite"
import { homedir } from "node:os"
import { join } from "node:path"
import { reloadSafety } from "../src/runner/reload-safety.ts"

/** `bun scripts/reload-safe.ts [tasks.sqlite]`: read-only; exits 0 when a reload is safe, 1 when not. */
const path = process.argv[2] ?? join(homedir(), ".local/share/opencode/plugins/lazers/tasks.sqlite")
const db = new Database(path, { readonly: true })
const result = reloadSafety(db)
db.close()
console.log(result.line)
process.exit(result.safe ? 0 : 1)
