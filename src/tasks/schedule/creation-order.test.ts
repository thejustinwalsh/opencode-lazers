import { afterEach, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { createControlTables } from "../../projects/settings.ts"
import { HandoffStore } from "../../recovery/handoff/store.ts"
import { SCHEDULE_TRIGGERS, installScheduleTriggers } from "./schema.ts"
import { openFixture } from "./fixture.ts"
import type { Fixture } from "./fixture.ts"

const fixtures: Fixture[] = []
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close()
})
const open = () => {
  const fixture = openFixture()
  fixtures.push(fixture)
  return fixture
}
const triggersOn = (f: Fixture, table: string) =>
  f.repository.read((db) =>
    db
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name=? AND name LIKE 'task_schedule_q_%'",
      )
      .all(table)
      .map((row) => row.name),
  )
const expected = (table: string) => SCHEDULE_TRIGGERS.filter((spec) => spec.table === table).length

test("lazers_dispatch_pause: triggers appear whichever of the table and the projection comes first", () => {
  const f = open()
  expect(triggersOn(f, "lazers_dispatch_pause").length).toBe(expected("lazers_dispatch_pause"))
  // Table created after the projection: the table's own install adds the triggers.
  f.repository.atomic((db) => db.exec("DROP TABLE lazers_dispatch_pause"))
  expect(triggersOn(f, "lazers_dispatch_pause")).toEqual([])
  f.repository.atomic((db) => {
    installScheduleTriggers(db) // the projection's pass finds no table: nothing to install
    createControlTables(db)
  })
  expect(triggersOn(f, "lazers_dispatch_pause").length).toBe(expected("lazers_dispatch_pause"))
  // Table first, projection after: the projection's installer finds it.
  f.repository.atomic((db) => {
    for (const name of triggersOn(f, "lazers_dispatch_pause")) db.exec(`DROP TRIGGER ${name}`)
    installScheduleTriggers(db)
  })
  expect(triggersOn(f, "lazers_dispatch_pause").length).toBe(expected("lazers_dispatch_pause"))
})

test("recovery concern tables: both orders, and installing twice leaves one set", () => {
  const f = open()
  expect(triggersOn(f, "recovery_concern_versions")).toEqual([])
  new HandoffStore(f.repository)
  new HandoffStore(f.repository)
  for (const table of ["recovery_concern_versions", "recovery_concern_dispositions"])
    expect(triggersOn(f, table).length).toBe(expected(table))
  // The projection installs after the tables exist: its pass adds the same triggers once.
  f.repository.atomic((db) => {
    for (const table of ["recovery_concern_versions", "recovery_concern_dispositions"])
      for (const name of triggersOn(f, table)) db.exec(`DROP TRIGGER ${name}`)
    installScheduleTriggers(db)
    installScheduleTriggers(db)
  })
  for (const table of ["recovery_concern_versions", "recovery_concern_dispositions"])
    expect(triggersOn(f, table).length).toBe(expected(table))
})

test("every table the projection reads has its triggers once the stores are constructed", () => {
  const f = open()
  new HandoffStore(f.repository)
  for (const table of new Set(SCHEDULE_TRIGGERS.map((spec) => spec.table)))
    expect(triggersOn(f, table).length).toBe(expected(table))
})

/**
 * Where each source table is created. A table created in a new place fails here, so its owner
 * decides when its triggers install (call `installScheduleTriggers` after creating it).
 */
const CREATION_SITES: Record<string, string[]> = {
  tasks: ["src/storage.ts"],
  task_references: ["src/storage.ts"],
  task_dispositions: ["src/storage.ts"],
  task_classifications: ["src/storage.ts"],
  runner_plans: ["src/runner/store.ts"],
  runner_nodes: ["src/runner/store.ts"],
  runner_dependencies: ["src/runner/store.ts"],
  runner_attempts: ["src/runner/store.ts"],
  runner_adoptions: ["src/runner/store.ts"],
  runner_transitions: ["src/runner/store.ts"],
  runner_dispatch_controls: ["src/runner/store.ts"],
  lazers_dispatch_pause: ["src/projects/settings.ts"],
  recovery_concern_versions: ["src/recovery/handoff/store.ts"],
  recovery_concern_dispositions: ["src/recovery/handoff/store.ts"],
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory()
      ? walk(path)
      : /\.(ts|tsx)$/.test(name) && !/\.(test|fixture)\./.test(name)
        ? [path]
        : []
  })
}

test("source tables are created only where the projection knows about", () => {
  const root = join(import.meta.dir, "../../..")
  const found: Record<string, Set<string>> = {}
  for (const path of walk(join(root, "src"))) {
    const text = readFileSync(path, "utf8")
    for (const table of Object.keys(CREATION_SITES))
      if (new RegExp(`CREATE TABLE(?: IF NOT EXISTS)? ${table}\\b`).test(text))
        (found[table] ??= new Set()).add(path.slice(root.length + 1))
  }
  for (const [table, sites] of Object.entries(CREATION_SITES))
    expect([...(found[table] ?? [])]).toEqual(sites)
  // The runtime and storage create theirs before the projection installs; the others install
  // triggers themselves.
  expect(readFileSync(join(root, "src/projects/settings.ts"), "utf8")).toContain(
    "installScheduleTriggers",
  )
  expect(readFileSync(join(root, "src/recovery/handoff/store.ts"), "utf8")).toContain(
    "installScheduleTriggers",
  )
})
