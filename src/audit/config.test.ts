import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TaskRepository } from "../storage.ts"
import {
  cleanupResolvedFallowConfig,
  getLatestFallowConfig,
  listFallowConfigRevisions,
  resolveFallowConfig,
  setFallowConfig,
} from "./config.ts"

const cleanups: (() => void)[] = []
afterEach(() => {
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

async function commit(dir: string, message: string) {
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
    "-m",
    message,
  )
  return run(dir, "rev-parse", "HEAD")
}

async function repoWithConfig(config: object | undefined) {
  const dir = temp("lz-fallow-config-repo-")
  await run(dir, "init", "-q", "-b", "main")
  writeFileSync(join(dir, "README.md"), "x")
  if (config) writeFileSync(join(dir, ".fallowrc.json"), JSON.stringify(config))
  await run(dir, "add", "-A")
  const base = await commit(dir, "base")
  return { dir, base }
}

function repository(directory: string) {
  mkdirSync(join(directory, "data"), { recursive: true })
  const r = new TaskRepository(join(directory, "data", "tasks.sqlite"), directory)
  cleanups.push(() => r.close())
  return r
}

test("repo config file at the base commit wins over a stored LAZERS config", async () => {
  const { dir, base } = await repoWithConfig({ limits: { maxCyclomatic: 5 } })
  const r = repository(dir)
  setFallowConfig(r, { limits: { maxCyclomatic: 99 } }, { sessionID: "s", agent: "a" })
  const resolved = await resolveFallowConfig({ directory: dir, baseCommit: base, repository: r })
  expect(resolved.source).toBe("repo")
  expect(resolved.config).toEqual({ limits: { maxCyclomatic: 5 } })
  await cleanupResolvedFallowConfig(resolved)
})

test("a repo config changed in the working tree but not committed at base is ignored", async () => {
  const { dir, base } = await repoWithConfig({ limits: { maxCyclomatic: 5 } })
  writeFileSync(join(dir, ".fallowrc.json"), JSON.stringify({ limits: { maxCyclomatic: 1000 } }))
  const r = repository(dir)
  const resolved = await resolveFallowConfig({ directory: dir, baseCommit: base, repository: r })
  expect(resolved.config).toEqual({ limits: { maxCyclomatic: 5 } })
  await cleanupResolvedFallowConfig(resolved)
})

test("stored LAZERS config is used when the repo has no config file", async () => {
  const { dir, base } = await repoWithConfig(undefined)
  const r = repository(dir)
  setFallowConfig(r, { limits: { maxCyclomatic: 42 } }, { sessionID: "s", agent: "a" })
  const resolved = await resolveFallowConfig({ directory: dir, baseCommit: base, repository: r })
  expect(resolved.source).toBe("lazers")
  expect(resolved.config).toEqual({ limits: { maxCyclomatic: 42 } })
  await cleanupResolvedFallowConfig(resolved)
})

test("neither source present falls back to defaults with dead code off", async () => {
  const { dir, base } = await repoWithConfig(undefined)
  const r = repository(dir)
  const resolved = await resolveFallowConfig({ directory: dir, baseCommit: base, repository: r })
  expect(resolved.source).toBe("defaults")
  expect(resolved.config).toBeNull()
  expect(resolved.deadCodeEnabled).toBe(false)
  expect(resolved.configPath).toBeUndefined()
})

test("a config whose extends is a remote URL is rejected", async () => {
  const { dir, base } = await repoWithConfig({ extends: "https://example.com/fallow.json" })
  const r = repository(dir)
  await expect(
    resolveFallowConfig({ directory: dir, baseCommit: base, repository: r }),
  ).rejects.toThrow("remote-extends-unsupported")
})

test("the LAZERS config store is append-only and keeps every revision", () => {
  const dir = temp("lz-fallow-config-store-")
  const r = repository(dir)
  setFallowConfig(r, { a: 1 }, { sessionID: "s1", agent: "a1" })
  setFallowConfig(r, { a: 2 }, { sessionID: "s2", agent: "a2" })
  expect(getLatestFallowConfig(r)?.config).toEqual({ a: 2 })
  expect(listFallowConfigRevisions(r)).toHaveLength(2)
})

test("setFallowConfig rejects a non-object config", () => {
  const dir = temp("lz-fallow-config-invalid-")
  const r = repository(dir)
  expect(() => setFallowConfig(r, [1, 2], { sessionID: "s", agent: "a" })).toThrow("config-invalid")
})
