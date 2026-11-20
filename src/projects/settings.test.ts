import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TaskRepository } from "../storage.ts"
import { registerProject } from "../project-key.ts"
import {
  spendCeilingFor,
  globalSettings,
  projectSettings,
  setGlobalSetting,
  setProjectSetting,
} from "./settings.ts"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})
function repository() {
  const directory = mkdtempSync(join(tmpdir(), "lazers-settings-"))
  const repo = new TaskRepository(join(directory, "tasks.sqlite"), "/repo")
  cleanups.push(() => {
    repo.close()
    rmSync(directory, { recursive: true, force: true })
  })
  return repo
}

test("built-in defaults apply when nothing is stored or passed", () => {
  const repo = repository()
  expect(globalSettings(repo)).toEqual({ globalSlots: null, agingMs: 600_000, historyCacheMB: 128 })
  expect(projectSettings(repo, "k")).toEqual({ limit: null, weight: 1, spendCeilingTokens: null })
})

test("a stored value wins over a passed default; clearing falls back to the default", () => {
  const repo = repository()
  expect(globalSettings(repo, { historyCacheMB: 64 }).historyCacheMB).toBe(64)
  setGlobalSetting(repo, "historyCacheMB", 256)
  expect(globalSettings(repo, { historyCacheMB: 64 }).historyCacheMB).toBe(256)
  setGlobalSetting(repo, "historyCacheMB", undefined)
  expect(globalSettings(repo, { historyCacheMB: 64 }).historyCacheMB).toBe(64)
  expect(globalSettings(repo).historyCacheMB).toBe(128)
  setProjectSetting(repo, "k", "spendCeilingTokens", 5_000)
  expect(projectSettings(repo, "k", { spendCeilingTokens: 9_000 }).spendCeilingTokens).toBe(5_000)
  setProjectSetting(repo, "k", "spendCeilingTokens", undefined)
  expect(projectSettings(repo, "k", { spendCeilingTokens: 9_000 }).spendCeilingTokens).toBe(9_000)
})

test("a stored null overrides a passed default", () => {
  const repo = repository()
  setProjectSetting(repo, "k", "spendCeilingTokens", null)
  expect(projectSettings(repo, "k", { spendCeilingTokens: 9_000 }).spendCeilingTokens).toBeNull()
})

test("project settings of one key do not leak to another or to global", () => {
  const repo = repository()
  setProjectSetting(repo, "a", "weight", 3)
  setProjectSetting(repo, "a", "limit", 2)
  expect(projectSettings(repo, "a")).toMatchObject({ weight: 3, limit: 2 })
  expect(projectSettings(repo, "b")).toMatchObject({ weight: 1, limit: null })
  expect(globalSettings(repo)).toEqual({ globalSlots: null, agingMs: 600_000, historyCacheMB: 128 })
})

test("invalid values are refused and leave the stored value", () => {
  const repo = repository()
  expect(() => setProjectSetting(repo, "k", "weight", 0)).toThrow()
  expect(() => setProjectSetting(repo, "k", "weight", -1)).toThrow()
  expect(() => setProjectSetting(repo, "k", "limit", 0)).toThrow()
  expect(() => setGlobalSetting(repo, "globalSlots", 0)).toThrow()
  expect(() => setGlobalSetting(repo, "globalSlots", 1.5)).toThrow()
  setGlobalSetting(repo, "globalSlots", 4)
  expect(() => setGlobalSetting(repo, "globalSlots", 0)).toThrow()
  expect(globalSettings(repo).globalSlots).toBe(4)
  expect(() => setProjectSetting(repo, "global", "weight", 2)).toThrow()
})

test("an invalid passed default or a corrupt stored value is ignored", () => {
  const repo = repository()
  expect(globalSettings(repo, { historyCacheMB: -5 }).historyCacheMB).toBe(128)
  repo.atomic((db) =>
    db.query("INSERT INTO lazers_settings VALUES('global','agingMs','\"fast\"',0)").run(),
  )
  expect(globalSettings(repo).agingMs).toBe(600_000)
})

test("the spend ceiling is the stored project value, else the plugin option, else none", async () => {
  const repo = repository()
  expect(spendCeilingFor(repo, "/repo", 7_000)).toBe(7_000)
  expect(spendCeilingFor(repo, "/repo", undefined)).toBeUndefined()
  const { key } = await registerProject(repo, { directory: "/repo", opencodeProjectID: "p" })
  expect(spendCeilingFor(repo, "/repo", 7_000)).toBe(7_000)
  setProjectSetting(repo, key, "spendCeilingTokens", 3_000)
  expect(spendCeilingFor(repo, "/repo", 7_000)).toBe(3_000)
  setProjectSetting(repo, key, "spendCeilingTokens", null)
  expect(spendCeilingFor(repo, "/repo", 7_000)).toBeUndefined()
  setProjectSetting(repo, key, "spendCeilingTokens", undefined)
  expect(spendCeilingFor(repo, "/repo", 7_000)).toBe(7_000)
})
