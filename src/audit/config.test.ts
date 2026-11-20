import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { TaskRepository } from "../storage.ts"
import {
  cleanupResolvedFallowConfig,
  getLatestFallowConfig,
  hasFallowConfig,
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
  const { dir, base } = await repoWithConfig({ health: { maxCyclomatic: 5 } })
  const r = repository(dir)
  setFallowConfig(r, { health: { maxCyclomatic: 99 } }, { sessionID: "s", agent: "a" }, "test")
  const resolved = await resolveFallowConfig({ directory: dir, baseCommit: base, repository: r })
  expect(resolved.source).toBe("repo")
  expect(resolved.config).toEqual({ health: { maxCyclomatic: 5 } })
  await cleanupResolvedFallowConfig(resolved)
})

test("cleaning up a resolved config removes its temp directory, not only the file", async () => {
  const { dir, base } = await repoWithConfig({ health: { maxCyclomatic: 5 } })
  const resolved = await resolveFallowConfig({
    directory: dir,
    baseCommit: base,
    repository: repository(dir),
  })
  const directory = dirname(resolved.configPath!)
  expect(existsSync(directory)).toBe(true)
  await cleanupResolvedFallowConfig(resolved)
  expect(existsSync(directory)).toBe(false)
  // A path outside a directory this module made is removed alone.
  const own = join(dir, "own.json")
  writeFileSync(own, "{}")
  await cleanupResolvedFallowConfig({ source: "repo", config: {}, configPath: own })
  expect(existsSync(own)).toBe(false)
  expect(existsSync(dir)).toBe(true)
})

test("a repo config changed in the working tree but not committed at base is ignored", async () => {
  const { dir, base } = await repoWithConfig({ health: { maxCyclomatic: 5 } })
  writeFileSync(join(dir, ".fallowrc.json"), JSON.stringify({ health: { maxCyclomatic: 1000 } }))
  const r = repository(dir)
  const resolved = await resolveFallowConfig({ directory: dir, baseCommit: base, repository: r })
  expect(resolved.config).toEqual({ health: { maxCyclomatic: 5 } })
  await cleanupResolvedFallowConfig(resolved)
})

test("stored LAZERS config is used when the repo has no config file", async () => {
  const { dir, base } = await repoWithConfig(undefined)
  const r = repository(dir)
  setFallowConfig(r, { health: { maxCyclomatic: 42 } }, { sessionID: "s", agent: "a" }, "test")
  const resolved = await resolveFallowConfig({ directory: dir, baseCommit: base, repository: r })
  expect(resolved.source).toBe("lazers")
  expect(resolved.config).toEqual({ health: { maxCyclomatic: 42 } })
  await cleanupResolvedFallowConfig(resolved)
})

test("neither source present is a typed error, never a silent default", async () => {
  const { dir, base } = await repoWithConfig(undefined)
  const r = repository(dir)
  await expect(
    resolveFallowConfig({ directory: dir, baseCommit: base, repository: r }),
  ).rejects.toMatchObject({ code: "FALLOW_CONFIG_MISSING" })
  expect(await hasFallowConfig({ directory: dir, ref: base, repository: r })).toBe(false)
  setFallowConfig(r, { entry: [] }, { sessionID: "s", agent: "a" }, "now there is one")
  expect(await hasFallowConfig({ directory: dir, ref: base, repository: r })).toBe(true)
})

test("a stored config keeps who set it and why", () => {
  const dir = temp("lz-fallow-config-reason-")
  const r = repository(dir)
  setFallowConfig(
    r,
    { a: 1 },
    { sessionID: "s1", agent: "architect" },
    "entry points cover the CLI",
  )
  expect(getLatestFallowConfig(r)).toMatchObject({
    agent: "architect",
    sessionID: "s1",
    reason: "entry points cover the CLI",
  })
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
  setFallowConfig(r, { a: 1 }, { sessionID: "s1", agent: "a1" }, "first")
  setFallowConfig(r, { a: 2 }, { sessionID: "s2", agent: "a2" }, "second")
  expect(getLatestFallowConfig(r)?.config).toEqual({ a: 2 })
  expect(listFallowConfigRevisions(r)).toHaveLength(2)
})

test("setFallowConfig rejects a non-object config", () => {
  const dir = temp("lz-fallow-config-invalid-")
  const r = repository(dir)
  expect(() => setFallowConfig(r, [1, 2], { sessionID: "s", agent: "a" }, "test")).toThrow(
    "config-invalid",
  )
})
