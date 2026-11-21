/**
 * Measures the online integer-key migration on a generated database shaped like the live history
 * tables: `bun scripts/measure-integer-keys.ts [--transitions 420000] [--progress 80000]
 * [--plans 1500] [--attempts 6000] [--dir <scratch directory>]`. It never touches a live database;
 * it writes a fixture under the given directory (default: a fresh temporary directory) and prints
 * one JSON line per phase, then a table of bytes per history table (rows plus its indexes) and
 * the file.
 *
 * The fixture is `auto_vacuum=INCREMENTAL`, like a database the compaction script has run on once.
 *
 * | Phase       | What happened                                                                   |
 * | ----------- | ------------------------------------------------------------------------------- |
 * | `legacy`    | rows as an older build wrote them: text ids, text-id indexes, no key columns    |
 * | `upgraded`  | the schema install added the nullable key columns, key tables and triggers      |
 * | `migrated`  | `advanceIdentityKeys` ran to the end: keyed, integer-indexed, text indexes gone |
 * | `reclaimed` | the retention pass's incremental vacuum handed the free pages back             |
 * | `vacuumed`  | (on a copy) a full `VACUUM`, what `scripts/compact-database.ts` would give      |
 */
import { Database } from "bun:sqlite"
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { incrementalVacuum } from "../src/retention/vacuum.ts"
import {
  BACKFILL_PAGE_ROWS,
  BACKFILL_TABLES,
  backfillPage,
} from "../src/runner/identity-backfill.ts"
import { advanceIdentityKeys } from "../src/runner/identity-migration.ts"
import { asLegacyHistory } from "../src/runner/identity.fixture.ts"
import { RunnerStore } from "../src/runner/store.ts"
import { TaskRepository } from "../src/storage.ts"

const arg = (name: string, fallback: number) => {
  const index = process.argv.indexOf(`--${name}`)
  return index < 0 ? fallback : Number(process.argv[index + 1])
}
const transitionRows = arg("transitions", 420_000)
const progressRows = arg("progress", 80_000)
const planCount = arg("plans", 1_500)
const attemptCount = arg("attempts", 6_000)
const dirArg = process.argv.indexOf("--dir")
const directory =
  dirArg < 0 ? mkdtempSync(join(tmpdir(), "lazers-int-keys-")) : process.argv[dirArg + 1]!
mkdirSync(directory, { recursive: true })
const path = join(directory, "tasks.sqlite")
const projectDirectory = "/Users/example/Documents/ChatGPT/opencode-lazers"

let seed = 12345
const random = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0
  return seed / 2 ** 32
}
const hex = (length: number) => {
  let out = ""
  while (out.length < length) out += Math.floor(random() * 2 ** 32).toString(16)
  return out.slice(0, length)
}
const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`
const ids = (count: number, make: () => string) => Array.from({ length: count }, make)
const plans = ids(planCount, uuid)
const tasks = ids(planCount * 4, uuid)
const attempts = ids(attemptCount, uuid)
const sessions = ids(attemptCount, () => `ses_${hex(26)}`)
const events = ids(
  40,
  () =>
    `${hex(3).toUpperCase()}_${["REQUESTED", "ACCEPTED", "RECORDED", "OBSERVED"][Math.floor(random() * 4)]}`,
)
const pad = (target: number) => JSON.stringify({ note: hex(Math.max(0, target - 12)) })

type Sizes = Record<string, number>

/** Bytes of each history table's rows and of each of its indexes, and of the whole file. */
function sizes(file = path): Sizes {
  const db = new Database(file, { readonly: true })
  try {
    const page = db.query<{ page_size: number }, []>("PRAGMA page_size").get()!.page_size
    const count = db.query<{ page_count: number }, []>("PRAGMA page_count").get()!.page_count
    const free = db.query<{ freelist_count: number }, []>("PRAGMA freelist_count").get()!
      .freelist_count
    const owner = new Map(
      db
        .query<{ name: string; tbl_name: string; type: string }, []>(
          "SELECT name,tbl_name,type FROM sqlite_master WHERE tbl_name IN ('runner_transitions','runner_progress')",
        )
        .all()
        .map((row) => [row.name, row] as const),
    )
    const result: Sizes = { file: page * count, free: page * free }
    for (const row of db
      .query<{ name: string; bytes: number }, []>(
        "SELECT name,sum(pgsize) AS bytes FROM dbstat GROUP BY name",
      )
      .all()) {
      const entry = owner.get(row.name)
      if (!entry) continue
      const table = entry.tbl_name
      const part = entry.type === "table" ? "rows" : "indexes"
      result[`${table}.${part}`] = (result[`${table}.${part}`] ?? 0) + row.bytes
    }
    for (const table of BACKFILL_TABLES)
      result[`${table}.total`] = (result[`${table}.rows`] ?? 0) + (result[`${table}.indexes`] ?? 0)
    return result
  } finally {
    db.close()
  }
}

const phases: Array<[string, Sizes]> = []
const report = (phase: string, extra: Record<string, unknown> = {}, file = path) => {
  const measured = sizes(file)
  phases.push([phase, measured])
  console.log(JSON.stringify({ phase, ...measured, ...extra }))
}

function seedLegacy() {
  const setup = new Database(path)
  setup.exec("PRAGMA auto_vacuum=INCREMENTAL; PRAGMA journal_mode=WAL")
  setup.close()
  const repository = new TaskRepository(path, projectDirectory)
  new RunnerStore(repository)
  repository.atomic((db) => {
    const insertPlan = db.query(
      "INSERT INTO runner_plans(id,project_directory,owner,revision,version,state,body) VALUES(?,?,'o',1,1,'integrated','{}')",
    )
    for (const plan of plans) insertPlan.run(plan, projectDirectory)
    const insertTransition = db.query(
      "INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at) VALUES(?,?,?,?,?,?)",
    )
    for (let index = 0; index < transitionRows; index++)
      insertTransition.run(
        plans[index % planCount]!,
        random() < 0.15 ? null : tasks[index % tasks.length]!,
        1 + (index % 7),
        events[index % events.length]!,
        pad(465),
        1_700_000_000_000 + index,
      )
    const insertProgress = db.query(
      `INSERT INTO runner_progress(project_directory,project_id,plan_id,task_id,attempt_id,session_id,at,recorded_at,
         source,sources_json,kind,event_ids_json,call_id,message_id,dedupe_key,payload)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    const projectID = hex(40)
    for (let index = 0; index < progressRows; index++) {
      const attempt = index % attemptCount
      insertProgress.run(
        projectDirectory,
        projectID,
        plans[attempt % planCount]!,
        tasks[attempt % tasks.length]!,
        attempts[attempt]!,
        sessions[attempt]!,
        1_700_000_000_000 + index,
        1_700_000_000_000 + index,
        "native-event",
        '["native-event"]',
        index % 3 === 0 ? "step" : "tool",
        `["evt_${hex(26)}"]`,
        `call_${hex(24)}`,
        `msg_${hex(26)}`,
        `${attempts[attempt]!}:${index}`,
        pad(2_000),
      )
    }
  })
  // As an older build left it: no keys, text-id indexes, every table at `backfilling`.
  asLegacyHistory(repository)
  repository.atomic((db) => {
    for (const trigger of ["runner_transitions_keys", "runner_progress_keys"])
      db.exec(`DROP TRIGGER IF EXISTS ${trigger}`)
    for (const [table, column] of [
      ["runner_transitions", "plan_n"],
      ["runner_progress", "plan_n"],
      ["runner_progress", "attempt_n"],
    ])
      db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`)
    db.exec("DELETE FROM schema_modules WHERE module='runner'")
  })
  repository.close()
  // Rows from the seed sit at the end of the file; a VACUUM lays the legacy file out compactly.
  const compact = new Database(path)
  compact.exec("VACUUM")
  compact.close()
}

rmSync(path, { force: true })
const seedStarted = performance.now()
seedLegacy()
report("legacy", {
  transitionRows,
  progressRows,
  seedMs: Math.round(performance.now() - seedStarted),
})

const repository = new TaskRepository(path, projectDirectory)
const upgradeStarted = performance.now()
new RunnerStore(repository)
report("upgraded", { installMs: Math.round(performance.now() - upgradeStarted) })

// Page cost: one page alone, timed, per table (the writer waits at most this long behind one).
const pageTimes: Record<string, number[]> = {}
for (const table of BACKFILL_TABLES) {
  const times: number[] = []
  for (let page = 0; page < 20; page++) {
    const started = performance.now()
    repository.atomic((db) => backfillPage(db, table, BACKFILL_PAGE_ROWS))
    times.push(performance.now() - started)
  }
  times.sort((a, b) => a - b)
  pageTimes[table] = times
}
console.log(
  JSON.stringify({
    phase: "page-cost",
    pageRows: BACKFILL_PAGE_ROWS,
    ...Object.fromEntries(
      Object.entries(pageTimes).map(([table, times]) => [
        table,
        { p50Ms: +times[10]!.toFixed(1), maxMs: +times.at(-1)!.toFixed(1) },
      ]),
    ),
  }),
)

const migrationStarted = performance.now()
let ticks = 0
let keyed = 0
const retired: string[] = []
for (;;) {
  ticks++
  // The retention idle step's slice at a quiet point.
  const progress = await advanceIdentityKeys(repository, 800)
  keyed += progress.rows
  retired.push(...progress.retired)
  if (progress.finished) break
}
report("migrated", {
  ticks,
  keyedRows: keyed,
  retired,
  ms: Math.round(performance.now() - migrationStarted),
})

const reclaimStarted = performance.now()
let reclaimed = 0
for (;;) {
  const step = repository.atomic((db) => incrementalVacuum(db))
  if (step === 0) break
  reclaimed += step
}
report("reclaimed", {
  reclaimedBytes: reclaimed,
  ms: Math.round(performance.now() - reclaimStarted),
})
repository.close()

const copy = join(directory, "vacuumed.sqlite")
copyFileSync(path, copy)
const vacuum = new Database(copy)
const vacuumStarted = performance.now()
vacuum.exec("VACUUM")
vacuum.close()
report("vacuumed", { ms: Math.round(performance.now() - vacuumStarted) }, copy)

const mb = (bytes: number | undefined) => `${((bytes ?? 0) / 1e6).toFixed(1)} MB`
const rows = [
  "runner_transitions.rows",
  "runner_transitions.indexes",
  "runner_transitions.total",
  "runner_progress.rows",
  "runner_progress.indexes",
  "runner_progress.total",
  "file",
]
console.log(`\n| bytes | ${phases.map(([phase]) => phase).join(" | ")} |`)
console.log(`| --- | ${phases.map(() => "---").join(" | ")} |`)
for (const row of rows)
  console.log(`| ${row} | ${phases.map(([, measured]) => mb(measured[row])).join(" | ")} |`)
console.error(`fixture: ${path}`)
