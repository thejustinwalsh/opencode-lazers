import { afterEach, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { collectScopeChanges, sizeWarnings } from "./scope-git.ts"
import { classifyChanges } from "./scope.ts"

const cleanup: string[] = []
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true })
})

function repo() {
  const root = mkdtempSync(join(tmpdir(), "lazers-scope-git-"))
  cleanup.push(root)
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args],
      { cwd: root, encoding: "utf8" },
    ).trim()
  git("init", "--initial-branch=main")
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  const commit = (message: string) => {
    git("add", "--all")
    git("commit", "-m", message)
    return git("rev-parse", "HEAD")
  }
  return { root, git, write, commit }
}

const lines = (count: number) =>
  Array.from({ length: count }, (_, i) => `line ${i}`).join("\n") + "\n"

test("changes carry status and line counts, and renames are a delete plus an add", async () => {
  const r = repo()
  r.write("src/a/x.ts", lines(10))
  r.write("src/a/gone.ts", lines(3))
  r.write("README.md", "hello\n")
  const base = r.commit("base")
  r.write("src/a/x.ts", lines(10) + lines(4))
  r.write("src/a/new.ts", lines(7))
  r.git("rm", "-q", "src/a/gone.ts")
  r.write("README.md", "changed\n")
  const head = r.commit("work")
  const changes = await collectScopeChanges(r.root, base, head)
  expect(changes).toEqual([
    { path: "README.md", status: "modified", added: 1, removed: 1 },
    { path: "src/a/gone.ts", status: "deleted", added: 0, removed: 3 },
    { path: "src/a/new.ts", status: "added", added: 7, removed: 0 },
    { path: "src/a/x.ts", status: "modified", added: 4, removed: 0 },
  ])
  const classes = classifyChanges(changes, {
    edit: ["src/a/x.ts", "src/a/gone.ts"],
    create: [],
    protected: [],
  })
  expect(classes.map((change) => [change.path, change.class])).toEqual([
    ["README.md", "divergence"],
    ["src/a/gone.ts", "in-scope"],
    ["src/a/new.ts", "allowed-new"],
    ["src/a/x.ts", "in-scope"],
  ])
})

test("size warnings measure the two commits: a file crossing the limit, or a large file that grows", async () => {
  const r = repo()
  r.write("src/small.ts", lines(900))
  r.write("src/large.ts", lines(2000))
  r.write("src/large.test.ts", lines(2000))
  r.write("src/stable.ts", lines(2000))
  const base = r.commit("base")
  r.write("src/small.ts", lines(900) + lines(200))
  r.write("src/large.ts", lines(2000) + lines(80))
  r.write("src/large.test.ts", lines(2000) + lines(80))
  r.write("src/stable.ts", lines(2000) + lines(5))
  r.write("src/brand-new.ts", lines(1200))
  const head = r.commit("work")
  const changes = await collectScopeChanges(r.root, base, head)
  const warnings = await sizeWarnings(r.root, base, head, changes)
  expect(warnings.map((warning) => [warning.path, warning.kind])).toEqual([
    ["src/brand-new.ts", "crossed"],
    ["src/large.ts", "grew"],
    ["src/small.ts", "crossed"],
  ])
})
