import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import {
  BOUNDED_TABLES,
  compare,
  historyTables,
  parseAllowlist,
  report,
  scanFile,
  scanSources,
} from "./check-unbounded-reads.ts"

const history = historyTables()
const scan = (source: string) => scanFile("fixture.ts", source, history)

describe("history tables", () => {
  test("come from the schema inventory minus the bounded tables", () => {
    expect(history.has("runner_plans")).toBe(true)
    expect(history.has("runner_transitions")).toBe(true)
    expect(history.has("runner_dispatch_controls")).toBe(false)
    for (const bounded of Object.keys(BOUNDED_TABLES)) expect(history.has(bounded)).toBe(false)
  })
})

describe("scan", () => {
  test("flags SELECT * and an unbounded .all() on a history table", () => {
    const sites = scan(`
      db.query("SELECT * FROM runner_plans WHERE id=?").get(id)
      db.query<{ id: string }, []>("SELECT id FROM runner_attempts").all()
    `)
    expect(sites.map((site) => [site.kind, site.table])).toEqual([
      ["star", "runner_plans"],
      ["all", "runner_attempts"],
    ])
  })

  test("reports one site when one statement is both", () => {
    const sites = scan("db.query(`SELECT * FROM runner_nodes WHERE plan_id=?`).all(id)")
    expect(sites.map((site) => site.kind)).toEqual(["star+all"])
  })

  test("follows a prepared statement held in a variable and a statement held in a constant", () => {
    const sites = scan(`
      const COLUMNS = "SELECT id FROM runner_effects"
      const page = db.query("SELECT id FROM runner_progress WHERE seq>?")
      for (const row of page.all(0)) use(row)
      db.query(COLUMNS).all()
    `)
    expect(sites.map((site) => site.table)).toEqual(["runner_progress", "runner_effects"])
  })

  test("allows LIMIT, aggregates, bounded tables, PRAGMA and unknown local CTE names", () => {
    expect(
      scan(`
        db.query("SELECT id FROM runner_plans ORDER BY id LIMIT 50").all()
        db.query("SELECT COUNT(*) AS n FROM runner_plans").get()
        db.query("SELECT * FROM lazers_settings").all()
        db.query("PRAGMA table_info(runner_plans)").all()
        db.query("SELECT * FROM runner_dispatch_controls").all()
        Promise.all([])
      `),
    ).toEqual([])
  })

  test("skips migration functions and statements that only copy rows", () => {
    expect(
      scan(`
        function migrateOutboxReceipts(db) {
          db.query("SELECT id FROM runner_outbox").all()
        }
        db.exec("INSERT INTO runner_nodes (a) SELECT * FROM runner_nodes_old")
      `),
    ).toEqual([])
  })

  test("treats a table missing from the schema inventory as history", () => {
    expect(scan('db.query("SELECT a FROM grows_forever").all()').map((s) => s.table)).toEqual([
      "grows_forever",
    ])
  })
})

describe("allowlist", () => {
  const entries = parseAllowlist(
    [
      "# comment",
      "a.ts:10 | all | runner_plans | todo | SELECT id FROM runner_plans",
      "a.ts:20 | star | runner_nodes | one row by primary key | SELECT * FROM runner_nodes WHERE id=?",
    ].join("\n"),
  )
  const site = (line: number, kind: "all" | "star", table: string, statement: string) => ({
    file: "a.ts",
    line,
    kind,
    table,
    statement,
  })

  test("a moved line still matches", () => {
    const result = compare(
      [site(55, "all", "runner_plans", "SELECT id FROM runner_plans")],
      entries.slice(0, 1),
    )
    expect(report(result)).toEqual([])
  })

  test("a new site fails and names the fix", () => {
    const result = compare([site(5, "all", "runner_plans", "SELECT body FROM runner_plans")], [])
    expect(report(result)[0]).toMatch(/new unbounded \.all\(\) on runner_plans: a\.ts:5/)
  })

  test("a listed site that disappeared fails, so the list shrinks", () => {
    const result = compare([], entries)
    expect(report(result).map((line) => line.slice(0, 40))).toEqual([
      "allowlist entry has no site any more, de",
      "allowlist entry has no site any more, de",
    ])
  })

  test("an entry without a reason is malformed", () => {
    expect(() => parseAllowlist("a.ts:1 | all | runner_plans")).toThrow(/Malformed/)
  })
})

describe("the repository", () => {
  test("has no unbounded read outside the allowlist, and no stale allowlist line", () => {
    const root = fileURLToPath(new URL("..", import.meta.url))
    const entries = parseAllowlist(readFileSync(`${root}scripts/unbounded-reads.allowlist`, "utf8"))
    expect(report(compare(scanSources(root), entries))).toEqual([])
  })
})
