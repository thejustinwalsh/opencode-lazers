/**
 * Measures integer identity on a generated database shaped like the live history tables:
 * `bun scripts/measure-integer-keys.ts [--transitions 440000] [--progress 117000] [--page 1000]
 * [--dir <scratch directory>]`. It never touches a live database; it writes a fixture under the
 * given directory (default: a fresh temporary directory) and prints one JSON line per phase.
 *
 * Phases: `legacy` (rows without key columns, as written before), `columns` (upgrade adds the
 * nullable columns), `backfilled` (every row keyed, one timing per page), then the phases of
 * `scripts/explain-history-statements.ts` fixtures are separate. `projected` removes the text
 * columns the keys replace on a copy and reports the bytes the offline compaction would return.
 */
import { Database } from "bun:sqlite"
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { backfillPage, BACKFILL_TABLES } from "../src/runner/identity-backfill.ts"
import { TaskRepository } from "../src/storage.ts"
import { RunnerStore } from "../src/runner/store.ts"

const arg = (name: string, fallback: number) => {
  const index = process.argv.indexOf(`--${name}`)
  return index < 0 ? fallback : Number(process.argv[index + 1])
}
const transitionRows = arg("transitions", 440_000)
const progressRows = arg("progress", 117_000)
const pageRows = arg("page", 1_000)
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
const attempts = ids(attemptCount, () => uuid())
const sessions = ids(attemptCount, () => `ses_${hex(26)}`.slice(0, 30))
const events = ids(
  40,
  () =>
    `${hex(3).toUpperCase()}_${["REQUESTED", "ACCEPTED", "RECORDED", "OBSERVED"][Math.floor(random() * 4)]}`,
)
const pad = (target: number) => JSON.stringify({ note: hex(Math.max(0, target - 12)) })

function bytes() {
  const db = new Database(path, { readonly: true })
  try {
    const page = db.query<{ page_size: number }, []>("PRAGMA page_size").get()!.page_size
    const count = db.query<{ page_count: number }, []>("PRAGMA page_count").get()!.page_count
    const by = db
      .query<{ name: string; bytes: number }, []>(
        "SELECT name,sum(pgsize) AS bytes FROM dbstat GROUP BY name",
      )
      .all()
    const owner = new Map(
      db
        .query<{ name: string; tbl_name: string; type: string }, []>(
          "SELECT name,tbl_name,type FROM sqlite_master WHERE tbl_name IN ('runner_transitions','runner_progress')",
        )
        .all()
        .map((row) => [row.name, row] as const),
    )
    const result: Record<string, number> = {}
    for (const row of by) {
      const entry = owner.get(row.name)
      if (!entry) continue
      result[`${entry.tbl_name}.${entry.type === "table" ? "table" : row.name}`] = row.bytes
    }
    // sqlite_autoindex for the UNIQUE constraint belongs to its table by tbl_name.
    return { fileBytes: page * count, ...result }
  } finally {
    db.close()
  }
}

const report = (phase: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ phase, ...bytes(), ...extra }))

function dropRowTriggers(db: Database) {
  for (const { name } of db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name IN ('runner_transitions','runner_progress')",
    )
    .all())
    db.exec(`DROP TRIGGER ${name}`)
}

function seedLegacy() {
  const repository = new TaskRepository(path, projectDirectory)
  new RunnerStore(repository)
  repository.atomic((db) => {
    dropRowTriggers(db)
    for (const [table, column] of [
      ["runner_transitions", "plan_n"],
      ["runner_progress", "plan_n"],
      ["runner_progress", "attempt_n"],
    ])
      db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`)
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
         source,sources_json,kind,event_ids_json,call_id,message_id,dedupe_key,payload,latest_observed_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
        1_700_000_000_000 + index,
      )
    }
  })
  repository.close()
}

function openUpgraded() {
  const repository = new TaskRepository(path, projectDirectory)
  repository.atomic((db) => db.exec("DELETE FROM schema_modules WHERE module='runner'"))
  const started = performance.now()
  new RunnerStore(repository)
  return { repository, upgradeMs: performance.now() - started }
}

rmSync(path, { force: true })
const seedStarted = performance.now()
seedLegacy()
report("legacy", {
  transitionRows,
  progressRows,
  seedMs: Math.round(performance.now() - seedStarted),
})

const { repository, upgradeMs } = openUpgraded()
report("columns", { upgradeMs: Math.round(upgradeMs) })

for (const table of BACKFILL_TABLES) {
  const times: number[] = []
  let rows = 0
  for (;;) {
    const started = performance.now()
    const page = repository.atomic((db) => backfillPage(db, table, pageRows))
    const elapsed = performance.now() - started
    if (page.done) break
    times.push(elapsed)
    rows += page.rows
  }
  times.sort((a, b) => a - b)
  const sum = times.reduce((a, b) => a + b, 0)
  console.log(
    JSON.stringify({
      phase: "backfill",
      table,
      pageRows,
      pages: times.length,
      rows,
      totalMs: Math.round(sum),
      p50Ms: +times[Math.floor(times.length / 2)]!.toFixed(1),
      p95Ms: +times[Math.floor(times.length * 0.95)]!.toFixed(1),
      maxMs: +times.at(-1)!.toFixed(1),
    }),
  )
}
report("backfilled")
repository.close()

void copyFileSync
void statSync
console.error(`fixture: ${path}`)
