import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { keyedProposal } from "../../test/proposal.ts"
import { registerProject, resetProjectAliasCache } from "../project-key.ts"
import { TaskRepository } from "../storage.ts"
import { submitTask } from "../submission.ts"
import { projects, setProjectCode } from "./registry.ts"

const cleanups: (() => void)[] = []
afterEach(() => {
  resetProjectAliasCache()
  for (const cleanup of cleanups.splice(0)) cleanup()
})

const parent = () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "lazers-refs-")))
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

async function checkout(root: string, name: string, remote: string) {
  const directory = join(root, name)
  mkdirSync(directory, { recursive: true })
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["remote", "add", "origin", remote],
  ])
    await Bun.spawn(["git", "-C", directory, ...args], { stdout: "pipe", stderr: "pipe" }).exited
  return directory
}

async function open(db: string, directory: string, opencodeProjectID = directory) {
  const repository = new TaskRepository(db, directory)
  cleanups.push(() => repository.close())
  const { key } = await registerProject(repository, { directory, opencodeProjectID })
  return { repository, key, directory }
}

let counter = 0
function submit(repository: TaskRepository, directory: string) {
  const result = submitTask(repository, keyedProposal(`key-${++counter}`), () => ({
    projectID: "p",
    projectDirectory: directory,
    workspaceDirectory: directory,
    sessionID: "s",
    startingRevision: { kind: "unborn" as const },
  }))
  if (result.status !== "submitted") throw new Error("submission failed")
  return result
}

test("a project's tasks are numbered under its code", async () => {
  const root = parent()
  const ons = await checkout(root, "opencode-native-settlement", "git@h.com:a/ons.git")
  const { repository } = await open(join(root, "db.sqlite"), ons)
  expect(submit(repository, ons).reference).toBe("ONS-1")
  expect(submit(repository, ons).reference).toBe("ONS-2")
})

test("two checkouts of one project share one sequence", async () => {
  const root = parent()
  const db = join(root, "db.sqlite")
  const a = await checkout(join(root, "a"), "opencode-native-settlement", "git@h.com:a/ons.git")
  const b = await checkout(join(root, "b"), "ons-clone", "git@h.com:a/ons.git")
  const first = await open(db, a)
  const second = await open(db, b)
  submit(first.repository, a)
  submit(first.repository, a)
  const third = submit(second.repository, b)
  expect(third.reference).toBe("ONS-3")
  expect(first.repository.resolveReference("ONS-3")).toBe(third.taskID)
})

test("a re-coded project resolves its old references inside itself only", async () => {
  const root = parent()
  const db = join(root, "db.sqlite")
  const a = await checkout(root, "opencode-native-settlement", "git@h.com:a/ons.git")
  const b = await checkout(root, "other-thing", "git@h.com:a/other.git")
  const one = await open(db, a)
  const two = await open(db, b)
  const first = submit(one.repository, a)
  setProjectCode(one.repository, one.key, "NS")
  expect(submit(one.repository, a).reference).toBe("NS-2")
  expect(one.repository.referenceFor(first.taskID)).toBe("NS-1")
  expect(one.repository.resolveReference("ONS-1")).toBe(first.taskID)
  expect(one.repository.resolveReference("ons-1")).toBe(first.taskID)
  expect(one.repository.resolveReference("NS-1")).toBe(first.taskID)
  expect(two.repository.resolveReference("ONS-1")).toBeUndefined()
  expect(one.repository.get("ons-1")?.id).toBe(first.taskID)
})

/** Seed a generation 1 database where two projects both hold `LZ-1..n`. */
function legacy(db: string, folders: Record<string, number>) {
  const seed = new TaskRepository(db, "/seed")
  seed.atomic((d) => {
    d.exec(
      "DROP INDEX lazers_projects_code; ALTER TABLE lazers_projects DROP COLUMN code; ALTER TABLE lazers_projects DROP COLUMN name; DROP TABLE task_reference_aliases",
    )
    d.exec("UPDATE schema_modules SET generation=1 WHERE module='projects'")
    let n = 0
    for (const [folder, count] of Object.entries(folders)) {
      const directory = `/work/${folder}`
      d.query("INSERT INTO lazers_projects(key,created_at) VALUES(?,?)").run(
        `path:${directory}`,
        `2026-01-0${++n}`,
      )
      d.query("INSERT INTO lazers_project_paths VALUES(?,?,?)").run(
        directory,
        `path:${directory}`,
        "t",
      )
      for (let i = 1; i <= count; i++) {
        d.query("INSERT INTO tasks(id,project_directory,created_at,body) VALUES(?,?,?,?)").run(
          `${folder}-${i}`,
          directory,
          "t",
          "{}",
        )
        d.query("INSERT INTO task_references VALUES(?,?,?,?)").run(
          directory,
          `${folder}-${i}`,
          `LZ-${i}`,
          i,
        )
      }
    }
  })
  seed.close()
}

test("migration: the LZ project keeps its references; others are rewritten with the old ones as aliases", () => {
  const root = parent()
  const db = join(root, "db.sqlite")
  legacy(db, { "opencode-lazers": 5, "native-settlement": 2 })
  const lazers = new TaskRepository(db, "/work/opencode-lazers")
  const other = new TaskRepository(db, "/work/native-settlement")
  cleanups.push(
    () => lazers.close(),
    () => other.close(),
  )
  expect(projects(lazers).map((p) => p.code)).toEqual(["LZ", "NS"])
  expect(lazers.referenceFor("opencode-lazers-5")).toBe("LZ-5")
  expect(lazers.resolveReference("LZ-5")).toBe("opencode-lazers-5")
  expect(other.referenceFor("native-settlement-1")).toBe("NS-1")
  expect(other.resolveReference("LZ-1")).toBe("native-settlement-1")
  expect(other.resolveReference("NS-2")).toBe("native-settlement-2")
  expect(lazers.resolveReference("NS-1")).toBeUndefined()
})

test("an LZ project continues its sequence after existing references", async () => {
  const root = parent()
  const db = join(root, "db.sqlite")
  legacy(db, { "opencode-lazers": 200 })
  const repository = new TaskRepository(db, "/work/opencode-lazers")
  cleanups.push(() => repository.close())
  expect(repository.resolveReference("LZ-200")).toBe("opencode-lazers-200")
  expect(
    submitTask(repository, keyedProposal("fresh"), () => ({
      projectID: "p",
      projectDirectory: "/work/opencode-lazers",
      workspaceDirectory: "/work/opencode-lazers",
      sessionID: "s",
      startingRevision: { kind: "unborn" as const },
    })),
  ).toMatchObject({ reference: "LZ-201" })
})
