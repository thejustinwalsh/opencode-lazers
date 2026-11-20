/**
 * One-time compaction of the LAZERS task database: switches it to `auto_vacuum=INCREMENTAL` and
 * returns every free page to the filesystem. After it, the retention pass hands space back in
 * small steps on its own.
 *
 *   bun scripts/compact-database.ts --db <tasks.sqlite>          report only (changes nothing)
 *   bun scripts/compact-database.ts --db <tasks.sqlite> --yes    compact
 *
 * It is a full VACUUM: it rewrites every live page while holding the write lock, so stop the
 * plugin (or reload OpenCode afterwards) and make sure no attempt is running. It needs free disk
 * for two copies of the live data (reported below) and refuses when that is not available. It is
 * never run at startup.
 */
import { Database } from "bun:sqlite"
import { statfsSync } from "node:fs"
import { dirname } from "node:path"
import { workIsActive } from "../src/retention/store.ts"
import {
  CompactionRefused,
  compactOnce,
  compactionDiskBytes,
  spaceState,
} from "../src/retention/vacuum.ts"

const mb = (bytes: number) => `${(bytes / 1e6).toFixed(0)} MB`

function arg(name: string) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

const path = arg("--db")
if (!path) {
  console.error("usage: bun scripts/compact-database.ts --db <tasks.sqlite> [--yes]")
  process.exit(2)
}

const probe = new Database(path, { readonly: true })
const state = spaceState(probe)
let active = false
try {
  active = workIsActive(probe)
} catch {
  /* A database without the runner tables has no running attempts. */
}
probe.close()
const stat = statfsSync(dirname(path))
const free = stat.bavail * stat.bsize
console.log(`file            ${mb(state.pageCount * state.pageSize)}`)
console.log(
  `free pages      ${mb(state.freelistPages * state.pageSize)} (reusable, not yet returned)`,
)
console.log(`auto_vacuum     ${state.autoVacuum}`)
console.log(`disk needed     ${mb(compactionDiskBytes(state))}, available ${mb(free)}`)
if (active) console.log("an attempt is preparing, running or verifying: wait for it to finish")

if (!process.argv.includes("--yes")) {
  console.log("report only; pass --yes to compact")
  process.exit(0)
}
if (active) process.exit(1)
try {
  const result = compactOnce(path, { freeDiskBytes: free })
  console.log(
    `compacted ${mb(result.beforeBytes)} -> ${mb(result.afterBytes)} in ${result.seconds.toFixed(1)} s; auto_vacuum=${result.autoVacuum}`,
  )
} catch (error) {
  console.error(error instanceof CompactionRefused ? `refused: ${error.message}` : String(error))
  process.exit(1)
}
