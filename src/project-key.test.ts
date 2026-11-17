import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  aliasesFor,
  normalizeRemote,
  projectIdsFor,
  projectIdsForKey,
  projectKeyFor,
  registerProject,
  resetProjectAliasCache,
  sameProject,
} from "./project-key.ts"
import { TaskRepository } from "./storage.ts"

const cleanups: (() => void)[] = []
afterEach(() => {
  resetProjectAliasCache()
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function temp(prefix: string) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

async function run(cwd: string, ...args: string[]) {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" })
  const out = await new Response(proc.stdout).text()
  expect(await proc.exited).toBe(0)
  return out.trim()
}

async function repo(remotes: Record<string, string> = {}) {
  const dir = temp("lazers-key-repo-")
  await run(dir, "init", "-q", "-b", "main")
  await run(
    dir,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "root",
  )
  for (const [name, url] of Object.entries(remotes)) await run(dir, "remote", "add", name, url)
  return dir
}

test("normalizeRemote unifies forms", () => {
  const expected = "github.com/owner/repo"
  for (const url of [
    "git@github.com:owner/repo.git",
    "git@github.com:owner/repo",
    "ssh://git@github.com/owner/repo.git",
    "ssh://git@GitHub.com:22/owner/repo",
    "https://github.com/owner/repo",
    "https://github.com/owner/repo.git",
    "https://user:token@GITHUB.com/owner/repo.git/",
    "HTTPS://GitHub.COM/owner/repo",
    "github.com:owner/repo.git",
  ])
    expect(normalizeRemote(url)).toBe(expected)
  expect(normalizeRemote("https://host.example/Owner/Repo.git")).toBe("host.example/Owner/Repo")
  expect(normalizeRemote("")).toBe("")
})

test("key fallback order: upstream remote, origin, only remote, root, path", async () => {
  const both = await repo({ origin: "git@github.com:o/origin.git", fork: "https://x.com/o/fork" })
  expect((await projectKeyFor(both)).key).toBe("github.com/o/origin")
  await run(both, "config", "branch.main.remote", "fork")
  expect((await projectKeyFor(both)).key).toBe("x.com/o/fork")

  const only = await repo({ upstream: "https://x.com/o/only.git" })
  expect((await projectKeyFor(only)).key).toBe("x.com/o/only")

  const ambiguous = await repo({ a: "https://x.com/o/a", b: "https://x.com/o/b" })
  const root = await run(ambiguous, "rev-list", "--max-parents=0", "HEAD")
  expect((await projectKeyFor(ambiguous)).key).toBe(`root:${root}`)

  const none = await repo()
  expect((await projectKeyFor(none)).key).toBe(
    `root:${await run(none, "rev-list", "--max-parents=0", "HEAD")}`,
  )

  const bare = temp("lazers-key-bare-")
  expect((await projectKeyFor(bare)).key).toBe(`path:${bare}`)
})

test("two clones with the same remote share a key", async () => {
  const a = await repo({ origin: "git@github.com:o/r.git" })
  const b = await repo({ origin: "https://GitHub.com/o/r" })
  expect((await projectKeyFor(a)).key).toBe((await projectKeyFor(b)).key)
})

function database() {
  const dir = temp("lazers-key-db-")
  return (projectDirectory: string) => {
    const repository = new TaskRepository(join(dir, "tasks.sqlite"), projectDirectory)
    cleanups.push(() => repository.close())
    return repository
  }
}

test("registration aliases every project id recorded for the directory", async () => {
  const directory = await repo({ origin: "git@github.com:o/r.git" })
  const repository = database()(directory)
  repository.atomic((db) => {
    db.exec(`CREATE TABLE runner_progress(project_directory TEXT, project_id TEXT);
             CREATE TABLE context_publications(project_directory TEXT, project_id TEXT)`)
    db.query("INSERT INTO runner_progress VALUES(?,?)").run(directory, "old-id")
    db.query("INSERT INTO runner_progress VALUES(?,?)").run("/elsewhere", "foreign-id")
    db.query("INSERT INTO context_publications VALUES(?,?)").run(directory, "older-id")
    db.query("INSERT INTO context_publications VALUES(?,?)").run(directory, "global")
    db.query("INSERT INTO tasks(id,project_directory,created_at,body) VALUES(?,?,?,?)").run(
      "t1",
      directory,
      "2026-01-01",
      JSON.stringify({ provenance: { projectID: "task-id" } }),
    )
  })
  const registration = await registerProject(repository, { directory, opencodeProjectID: "new-id" })
  expect(registration.key).toBe("github.com/o/r")
  expect(new Set(projectIdsForKey(repository, registration.key))).toEqual(
    new Set(["new-id", "old-id", "older-id", "task-id"]),
  )
  expect(aliasesFor(repository, "old-id")).toContain("new-id")
  expect(aliasesFor(repository, "foreign-id")).toEqual(["foreign-id"])
  expect(sameProject("old-id", "new-id")).toBe(true)
  expect(projectIdsFor("global")).toEqual(["global"])
  expect(sameProject("old-id", "foreign-id")).toBe(false)
  expect(projectIdsFor("unknown")).toEqual(["unknown"])
  expect(
    repository.read((db) => db.query("SELECT key FROM lazers_project_paths").all()).length,
  ).toBe(1)
  await registerProject(repository, { directory, opencodeProjectID: "new-id" })
})

test("reads accept rows recorded under an old alias after a restart", async () => {
  const directory = await repo()
  const repository = database()(directory)
  repository.atomic((db) => {
    db.exec("CREATE TABLE runner_progress(project_directory TEXT, project_id TEXT)")
    db.query("INSERT INTO runner_progress VALUES(?,?)").run(directory, "old-id")
  })
  const registration = await registerProject(repository, { directory, opencodeProjectID: "new-id" })
  expect(registration.key.startsWith("root:")).toBe(true)
  resetProjectAliasCache()
  expect(sameProject("old-id", "new-id")).toBe(false)
  // Startup race: before resolution finishes, the strict current id still matches itself.
  expect(sameProject("new-id", "new-id")).toBe(true)
  expect(projectIdsFor("new-id")).toEqual(["new-id"])
  // New process: the synchronous part of registration hydrates from the database.
  const pending = registerProject(repository, { directory, opencodeProjectID: "new-id" })
  expect(sameProject("old-id", "new-id")).toBe(true)
  const rows = repository.read((db) =>
    db
      .query(
        "SELECT project_id FROM runner_progress WHERE project_id IN (SELECT value FROM json_each(?))",
      )
      .all(JSON.stringify(projectIdsFor("new-id"))),
  )
  expect(rows).toHaveLength(1)
  await pending
})
