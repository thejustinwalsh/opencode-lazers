import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { registerProject, resetProjectAliasCache } from "../project-key.ts"
import { TaskRepository } from "../storage.ts"
import { ProjectCodeError, projectForDirectory, projects, setProjectCode } from "./registry.ts"

const cleanups: (() => void)[] = []
afterEach(() => {
  resetProjectAliasCache()
  for (const cleanup of cleanups.splice(0)) cleanup()
})

const root = () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "lazers-registry-")))
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

async function git(cwd: string, ...args: string[]) {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" })
  await proc.exited
}

/** A checkout named `name` whose remote makes its project key. */
async function checkout(parent: string, name: string, remote: string) {
  const directory = join(parent, name)
  mkdirSync(directory, { recursive: true })
  await git(directory, "init", "-q", "-b", "main")
  await git(directory, "remote", "add", "origin", remote)
  return directory
}

function open(path: string, directory: string) {
  const repository = new TaskRepository(path, directory)
  cleanups.push(() => repository.close())
  return repository
}

test("a new project gets a code and a name from its folder", async () => {
  const parent = root()
  const directory = await checkout(parent, "opencode-native-settlement", "git@github.com:a/ons.git")
  const repository = open(join(parent, "db.sqlite"), directory)
  const { key } = await registerProject(repository, { directory, opencodeProjectID: "p1" })
  expect(projects(repository)).toEqual([
    { key, code: "ONS", name: "opencode-native-settlement", paths: [directory] },
  ])
  expect(projectForDirectory(repository, directory)?.code).toBe("ONS")
})

test("a second project with the same folder name gets a numbered code, kept across restarts", async () => {
  const parent = root()
  const path = join(parent, "db.sqlite")
  const first = await checkout(
    join(parent, "one"),
    "opencode-native-settlement",
    "git@h.com:a/x.git",
  )
  const second = await checkout(
    join(parent, "two"),
    "opencode-native-settlement",
    "git@h.com:b/y.git",
  )
  let repository = open(path, first)
  await registerProject(repository, { directory: first, opencodeProjectID: "p1" })
  await registerProject(open(path, second), { directory: second, opencodeProjectID: "p2" })
  const codes = () => projects(repository).map((project) => project.code)
  expect(codes()).toEqual(["ONS", "ONS2"])
  repository.close()
  resetProjectAliasCache()
  repository = open(path, first)
  await registerProject(repository, { directory: first, opencodeProjectID: "p1" })
  await registerProject(open(path, second), { directory: second, opencodeProjectID: "p2" })
  expect(codes()).toEqual(["ONS", "ONS2"])
})

test("a second checkout of one remote is one project with two paths", async () => {
  const parent = root()
  const a = await checkout(join(parent, "a"), "app-core", "git@h.com:o/app-core.git")
  const b = await checkout(join(parent, "b"), "app-core-copy", "git@h.com:o/app-core.git")
  const repository = open(join(parent, "db.sqlite"), a)
  await registerProject(repository, { directory: a, opencodeProjectID: "p1" })
  await registerProject(open(join(parent, "db.sqlite"), b), {
    directory: b,
    opencodeProjectID: "p2",
  })
  const rows = projects(repository)
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ code: "AC", name: "app-core" })
  expect(rows[0]!.paths.sort()).toEqual([a, b].sort())
  expect(projectForDirectory(repository, b)?.code).toBe("AC")
})

/** Rebuild a generation 1 database: no code or name columns, three projects with references. */
function legacy(path: string, owned: Record<string, number>) {
  const repository = new TaskRepository(path, "/seed")
  repository.atomic((db) => {
    db.exec(
      "DROP INDEX lazers_projects_code; ALTER TABLE lazers_projects DROP COLUMN code; ALTER TABLE lazers_projects DROP COLUMN name",
    )
    db.exec("UPDATE schema_modules SET generation=1 WHERE module='projects'")
    let n = 0
    for (const [folder, count] of Object.entries(owned)) {
      const directory = `/work/${folder}`
      db.query("INSERT INTO lazers_projects(key,created_at) VALUES(?,?)").run(
        `path:${directory}`,
        `2026-01-0${++n}`,
      )
      db.query("INSERT INTO lazers_project_paths VALUES(?,?,?)").run(
        directory,
        `path:${directory}`,
        "t",
      )
      for (let i = 1; i <= count; i++) {
        const id = `${folder}-${i}`
        db.query("INSERT INTO tasks(id,project_directory,created_at,body) VALUES(?,?,?,?)").run(
          id,
          directory,
          "t",
          "{}",
        )
        db.query("INSERT INTO task_references VALUES(?,?,?,?)").run(directory, id, `LZ-${i}`, i)
      }
    }
  })
  repository.close()
}

test("migrating generation 1 gives LZ to the project with the most references", () => {
  const parent = root()
  const path = join(parent, "db.sqlite")
  legacy(path, { "native-settlement": 2, "opencode-lazers": 251, runntime: 2 })
  const repository = open(path, "/work/opencode-lazers")
  expect(projects(repository).map((p) => [p.name, p.code])).toEqual([
    ["native-settlement", "NS"],
    ["opencode-lazers", "LZ"],
    ["runntime", "RUN"],
  ])
})

test("setProjectCode validates and refuses a code another project holds", async () => {
  const parent = root()
  const a = await checkout(join(parent, "a"), "alpha-app", "git@h.com:o/a.git")
  const b = await checkout(join(parent, "b"), "beta-app", "git@h.com:o/b.git")
  const repository = open(join(parent, "db.sqlite"), a)
  const { key } = await registerProject(repository, { directory: a, opencodeProjectID: "p1" })
  await registerProject(repository, { directory: b, opencodeProjectID: "p2" })
  for (const bad of ["lz", "TOOLONG", "A", "AB-1", ""])
    expect(() => setProjectCode(repository, key, bad)).toThrow("PROJECT_CODE_INVALID")
  expect(() => setProjectCode(repository, key, "BA")).toThrow(ProjectCodeError)
  expect(() => setProjectCode(repository, key, "BA")).toThrow("PROJECT_CODE_TAKEN")
  setProjectCode(repository, key, "ALP")
  expect(projects(repository)[0]!.code).toBe("ALP")
})
