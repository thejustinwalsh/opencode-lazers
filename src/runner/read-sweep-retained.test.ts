import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { meterDatabase } from "./read-meter.fixture.ts"
import { priorOwnedFilesystemPaths } from "./retained-verification-execution.ts"
import {
  ensureRetainedVerificationTables,
  hasUnremovedResource,
} from "./retained-verification/store.ts"

/** Read-meter tests for retained-verification reads (design/data-handling.md, principles 1 and 8). */

/** `READ_SWEEP_NUMBERS=1 bun test ...` prints the before and after counts the report quotes. */
const show = (name: string, before: unknown, after: unknown) => {
  if (process.env.READ_SWEEP_NUMBERS)
    console.log(
      `[read-sweep] ${name} before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
    )
}

test("an unfinished-resource check reads one row; the list answered the same", () => {
  const db = new Database(":memory:")
  ensureRetainedVerificationTables(db)
  const insert = db.query(
    `INSERT INTO runner_retained_verification_resources
       (project_directory,operation_id,phase,check_id,resource_name,canonical_path,device,inode,state,created_at,updated_at)
     VALUES('/p','op','task','c1',?,?,1,?,?,0,0)`,
  )
  const columns = db
    .query<{ name: string }, []>("PRAGMA table_info(runner_retained_verification_resources)")
    .all()
    .map((column) => column.name)
  expect(columns).toContain("check_id")
  for (let index = 0; index < 200; index++)
    insert.run(`r${index}`, `/tmp/r${index}`, index, "removed")
  const { db: metered, meter } = meterDatabase(db)
  const list = (phase: string, check?: string) =>
    db
      .query<{ state: string }, string[]>(
        `SELECT state FROM runner_retained_verification_resources WHERE operation_id=? AND phase=?${check ? " AND check_id=?" : ""}`,
      )
      .all("op", phase, ...(check ? [check] : []))
      .some((resource) => resource.state !== "removed")
  expect(hasUnremovedResource(metered, "op", "task")).toBe(list("task"))
  expect(hasUnremovedResource(metered, "op", "task", "c1")).toBe(list("task", "c1"))
  expect(hasUnremovedResource(metered, "op", "task")).toBe(false)
  insert.run("live", "/tmp/live", 999, "active")
  expect(hasUnremovedResource(metered, "op", "task")).toBe(true)
  expect(hasUnremovedResource(metered, "op", "task", "c1")).toBe(true)
  expect(hasUnremovedResource(metered, "op", "task", "other-check")).toBe(false)
  expect(hasUnremovedResource(metered, "op", "combined")).toBe(false)
  show("unremovedResource", { rows: 201 }, { rows: meter.rows })
  // 200 removed rows are never returned; each call returns at most one.
  expect(meter.rows).toBeLessThanOrEqual(4)
  expect(list("task")).toBe(true)
  db.close()
})

test("prior owned resources are the other runs' live paths; removed history is not read", () => {
  const db = new Database(":memory:")
  db.exec(`CREATE TABLE owned_resources (
    resource_id TEXT PRIMARY KEY, project_directory TEXT NOT NULL, request_id TEXT NOT NULL,
    run_id TEXT NOT NULL, resource_key TEXT NOT NULL, generation INTEGER NOT NULL,
    fingerprint TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`)
  let n = 0
  const put = (payload: string, project = "/p") =>
    db
      .query("INSERT INTO owned_resources VALUES(?,?,?,?,?,1,'f',?,0,0)")
      .run(`id${++n}`, project, `req${n}`, "run", `key${n}`, payload)
  const resource = (fields: Record<string, unknown>) => JSON.stringify(fields)
  for (let index = 0; index < 300; index++)
    put(resource({ runID: "old", state: "removed", resourceKey: `filesystem:/tmp/old${index}` }))
  put(resource({ runID: "mine", state: "active", resourceKey: "filesystem:/tmp/mine" }))
  put(resource({ runID: "other", state: "active", resourceKey: "filesystem:/tmp/other" }))
  put(resource({ runID: "other", state: "creating", resourceKey: "port:8080" }))
  put(resource({ runID: "other", state: "active", resourceKey: "filesystem:relative/path" }))
  put(resource({ runID: 7, state: "active", resourceKey: "filesystem:/tmp/numeric" }))
  put(resource({ state: "active", resourceKey: "filesystem:/tmp/no-run" }))
  put("not json")
  put("null")
  put(resource({ runID: "other", state: "active", resourceKey: "filesystem:/tmp/elsewhere" }), "/q")

  const everything = (project: string, run: string): (string | null)[] =>
    db
      .query<{ payload: string }, [string]>(
        "SELECT payload FROM owned_resources WHERE project_directory=?",
      )
      .all(project)
      .flatMap(({ payload }) => {
        try {
          const parsed = JSON.parse(payload) as {
            runID?: unknown
            resourceKey?: unknown
            state?: unknown
          }
          if (parsed.runID === run || parsed.state === "removed") return []
          if (
            typeof parsed.resourceKey !== "string" ||
            !parsed.resourceKey.startsWith("filesystem:")
          )
            return [null]
          const path = parsed.resourceKey.slice("filesystem:".length)
          return path.startsWith("/") ? [path] : [null]
        } catch {
          return [null]
        }
      })
  const { db: metered, meter } = meterDatabase(db)
  const got = priorOwnedFilesystemPaths(metered, "/p", "mine")
  expect(got).toEqual(everything("/p", "mine"))
  expect(got).toContain("/tmp/other")
  expect(got).toContain(null)
  show("ownedResources", { rows: 309 }, meter.of(/owned_resources/))
  expect(meter.of(/owned_resources/).rows).toBe(8)
  expect(priorOwnedFilesystemPaths(db, "/p", "other")).toEqual(everything("/p", "other"))
  expect(priorOwnedFilesystemPaths(db, "/empty", "x")).toEqual([])
  db.close()
})
