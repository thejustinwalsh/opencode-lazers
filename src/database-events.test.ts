import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  DatabaseChangeHub,
  databaseChanges,
  RevisionPublisherHub,
  revisionPublishers,
} from "./database-events.ts"

async function until(condition: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (condition()) return
    await Bun.sleep(5)
  }
  throw new Error("Database notification was not received")
}

test("native database notifications share a feed and reach independent service connections", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lazers-db-events-"))
  const path = join(directory, "tasks.sqlite")
  const db = new Database(path)
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE values_test(value INTEGER)")
  const other = new Database(path)
  const hub = new DatabaseChangeHub()
  db.exec(`CREATE TABLE observation_revisions(revision INTEGER);
    INSERT INTO observation_revisions VALUES(0);
    CREATE TRIGGER revision AFTER INSERT ON values_test BEGIN
      UPDATE observation_revisions SET revision=revision+1;
    END`)
  hub.track(other, path)
  let first = 0,
    second = 0
  const failures: Error[] = []
  const closeFirst = hub.subscribe(
    path,
    () => {
      first++
    },
    (e) => failures.push(e),
  )
  const closeSecond = hub.subscribe(
    path,
    () => {
      second++
    },
    (e) => failures.push(e),
  )
  try {
    await until(() => first > 0 && second > 0)
    await Bun.sleep(30)
    const idle = [first, second]
    db.query("SELECT * FROM values_test").all()
    await Bun.sleep(100)
    expect([first, second]).toEqual(idle)
    other.exec("INSERT INTO values_test VALUES(1)")
    await until(() => first > idle[0]! && second > idle[1]!)
    closeFirst()
    const stopped = first,
      before = second
    other.exec("INSERT INTO values_test VALUES(2)")
    await until(() => second > before)
    expect(first).toBe(stopped)
    expect(failures).toEqual([])
  } finally {
    closeFirst()
    closeSecond()
    other.close()
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("independently loaded modules reuse the same process feed", async () => {
  const copy = await import(
    new URL(`./database-events.ts?copy=${crypto.randomUUID()}`, import.meta.url).href
  )
  expect(copy.databaseChanges).toBe(databaseChanges)
  expect(copy.revisionPublishers).toBe(revisionPublishers)
})

test("revision publishers hand off a failed pending emission and keep project topics distinct", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lazers-db-publishers-"))
  const path = join(directory, "tasks.sqlite")
  const db = new Database(path)
  db.exec(
    "CREATE TABLE observation_revisions(revision INTEGER); INSERT INTO observation_revisions VALUES(0)",
  )
  const changes = new DatabaseChangeHub()
  changes.track(db, path)
  const publishers = new RevisionPublisherHub(changes)
  const attempts: Array<[string, number]> = [],
    accepted: Array<[string, number]> = []
  const pending = Promise.withResolvers<void>()
  const version = () =>
    db.query<{ revision: number }, []>("SELECT revision FROM observation_revisions").get()!.revision
  const releases = [
    publishers.publishRevisions(path, "tasks:/a", {
      read: version,
      emit: (v) => {
        attempts.push(["first", v])
        return pending.promise
      },
    }),
    publishers.publishRevisions(path, "tasks:/a", {
      read: version,
      emit: async (v) => {
        attempts.push(["successor", v])
        accepted.push(["a", v])
      },
    }),
    publishers.publishRevisions(path, "tasks:/b", {
      read: version,
      emit: async (v) => {
        accepted.push(["b", v])
      },
    }),
  ]
  try {
    db.exec("UPDATE observation_revisions SET revision=1")
    await until(() => attempts.length === 1 && accepted.length === 1)
    releases[0]!()
    db.exec("UPDATE observation_revisions SET revision=2")
    pending.reject(new Error("disposed publisher failed before acknowledgement"))
    await Bun.sleep(1_050)
    await until(() => attempts.length === 2)
    expect(attempts).toEqual([
      ["first", 1],
      ["successor", 2],
    ])
    expect(accepted).toContainEqual(["a", 2])
    expect(accepted).toContainEqual(["b", 1])
    expect(accepted).toContainEqual(["b", 2])
    for (const close of releases) close()
    const before = accepted.length
    db.exec("UPDATE observation_revisions SET revision=3")
    await Bun.sleep(30)
    expect(accepted.length).toBe(before)
  } finally {
    for (const close of releases) close()
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
