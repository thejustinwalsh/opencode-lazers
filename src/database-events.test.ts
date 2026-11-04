import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseChangeHub, databaseChanges } from "./database-events.ts"

async function until(condition: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (condition()) return
    await Bun.sleep(5)
  }
  throw new Error("Database notification was not received")
}

test("database notifications share a feed, ignore unrelated files and reach independent connections", async () => {
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
    writeFileSync(join(directory, "unrelated.txt"), "not a database write")
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

test("writes from another process invalidate without a polling interval", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lazers-db-process-events-"))
  const path = join(directory, "tasks.sqlite")
  const db = new Database(path)
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE values_test(value INTEGER)")
  let changes = 0
  const hub = new DatabaseChangeHub()
  const close = hub.subscribe(
    path,
    () => {
      changes++
    },
    () => {},
  )
  try {
    await until(() => changes > 0)
    const before = changes
    const process = Bun.spawn(
      [
        Bun.which("bun")!,
        "-e",
        'import {Database} from "bun:sqlite"; const db=new Database(process.argv[1]); db.exec("INSERT INTO values_test VALUES(3)"); db.close()',
        path,
      ],
      { stdout: "ignore", stderr: "pipe" },
    )
    expect(await process.exited).toBe(0)
    await until(() => changes > before)
    expect(db.query("SELECT value FROM values_test").get()).toEqual({ value: 3 })
  } finally {
    close()
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("independently loaded modules reuse the same process feed", async () => {
  const copy = await import(
    new URL(`./database-events.ts?copy=${crypto.randomUUID()}`, import.meta.url).href
  )
  expect(copy.databaseChanges).toBe(databaseChanges)
})
