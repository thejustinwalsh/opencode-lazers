import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  deadCodeFindings,
  detectEntryPoints,
  draftFallowConfig,
  dupesGroups,
  filterByResolvedPaths,
  healthFunctions,
  page,
  resolveToolPaths,
} from "./fallow-tools-support.ts"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

test("page slices and reports nextOffset only while more remain", () => {
  expect(page([1, 2, 3, 4, 5], { limit: 2, offset: 0 })).toEqual({
    items: [1, 2],
    total: 5,
    nextOffset: 2,
  })
  expect(page([1, 2, 3, 4, 5], { limit: 2, offset: 4 })).toEqual({
    items: [5],
    total: 5,
    nextOffset: null,
  })
})

test("dupesGroups ranks worst first by token count and caps instances at five", () => {
  const report = {
    clone_groups: [
      {
        token_count: 10,
        line_count: 5,
        instances: Array.from({ length: 7 }, (_, i) => ({
          file: "a.ts",
          start_line: i,
          end_line: i + 1,
          start_col: 0,
          end_col: 0,
        })),
      },
      {
        token_count: 100,
        line_count: 40,
        instances: [{ file: "b.ts", start_line: 1, end_line: 40, start_col: 0, end_col: 0 }],
      },
    ],
  } as never
  const groups = dupesGroups(report)
  expect(groups[0]!.tokens).toBe(100)
  expect(groups[1]!.instances).toHaveLength(5)
  expect(groups[1]!.moreInstances).toBe(2)
})

test("healthFunctions sorts by the requested metric, worst first", () => {
  const report = {
    findings: [
      {
        path: "a.ts",
        name: "f",
        line: 1,
        col: 1,
        cyclomatic: 3,
        cognitive: 20,
        line_count: 10,
        param_count: 0,
        exceeded: "cognitive",
        severity: "warn",
      },
      {
        path: "b.ts",
        name: "g",
        line: 1,
        col: 1,
        cyclomatic: 25,
        cognitive: 2,
        line_count: 5,
        param_count: 0,
        exceeded: "cyclomatic",
        severity: "warn",
      },
    ],
  } as never
  expect(healthFunctions(report, "cognitive")[0]!.name).toBe("f")
  expect(healthFunctions(report, "cyclomatic")[0]!.name).toBe("g")
})

test("deadCodeFindings excludes unused class members unless the config turns the rule on", () => {
  const report = {
    unused_files: [],
    unused_exports: [{ path: "a.ts", export_name: "x", line: 1, col: 1 }],
    unused_types: [],
    unused_dependencies: [],
    unused_class_members: [{ path: "a.ts", parent_name: "C", member_name: "m", line: 2, col: 1 }],
  } as never
  expect(deadCodeFindings(report, null).map((f) => f.kind)).toEqual(["export"])
  expect(
    deadCodeFindings(report, { rules: { "unused-class-members": "on" } }).map((f) => f.kind),
  ).toEqual(["export", "member"])
})

test("deadCodeFindings filters by requested kinds", () => {
  const report = {
    unused_files: [{ path: "dead.ts" }],
    unused_exports: [{ path: "a.ts", export_name: "x", line: 1, col: 1 }],
    unused_types: [],
    unused_dependencies: [],
    unused_class_members: [],
  } as never
  expect(deadCodeFindings(report, null, ["file"]).map((f) => f.kind)).toEqual(["file"])
})

test("draftFallowConfig proposes sorted entry points and turns class members off", () => {
  expect(draftFallowConfig(["b.ts", "a.ts"])).toEqual({
    entry: ["a.ts", "b.ts"],
    rules: { "unused-class-members": "off" },
  })
})

test("detectEntryPoints finds fixtures, cli.ts, worker references, and a script's .ts target", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "lz-entrypoints-")))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, "src"), { recursive: true })
  writeFileSync(join(dir, "src", "thing.fixture.ts"), "export default 1")
  writeFileSync(join(dir, "src", "cli.ts"), "console.log('cli')")
  writeFileSync(join(dir, "src", "host.ts"), "new Worker('./worker.ts')")
  writeFileSync(join(dir, "src", "untouched.ts"), "export const a = 1")
  writeFileSync(join(dir, "scripts.ts"), "console.log('script')")
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { build: "bun scripts.ts" } }))
  const found = await detectEntryPoints(dir)
  expect(found).toContain("src/thing.fixture.ts")
  expect(found).toContain("src/cli.ts")
  expect(found).toContain("src/host.ts")
  expect(found).toContain("scripts.ts")
  expect(found).not.toContain("src/untouched.ts")
})

function workspaceWithFiles() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "lz-tool-paths-")))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, "src", "audit", "nested"), { recursive: true })
  writeFileSync(join(dir, "src", "audit", "a.ts"), "export const a = 1\n")
  writeFileSync(join(dir, "src", "audit", "b.ts"), "export const b = 1\n")
  writeFileSync(join(dir, "src", "audit", "nested", "c.ts"), "export const c = 1\n")
  writeFileSync(join(dir, "src", "other.ts"), "export const other = 1\n")
  return dir
}

test("resolveToolPaths with no paths means no restriction", async () => {
  const dir = workspaceWithFiles()
  expect(await resolveToolPaths(dir, undefined)).toEqual({ files: undefined, empty: false })
  expect(await resolveToolPaths(dir, [])).toEqual({ files: undefined, empty: false })
})

test("resolveToolPaths expands a directory to the same files as listing them", async () => {
  const dir = workspaceWithFiles()
  const byDirectory = await resolveToolPaths(dir, ["src/audit"])
  const byFiles = await resolveToolPaths(dir, [
    "src/audit/a.ts",
    "src/audit/b.ts",
    "src/audit/nested/c.ts",
  ])
  expect(byDirectory.files).toEqual(byFiles.files)
  expect(byDirectory.files).toEqual(["src/audit/a.ts", "src/audit/b.ts", "src/audit/nested/c.ts"])
})

test("resolveToolPaths treats a trailing slash the same as none", async () => {
  const dir = workspaceWithFiles()
  const withSlash = await resolveToolPaths(dir, ["src/audit/"])
  const withoutSlash = await resolveToolPaths(dir, ["src/audit"])
  expect(withSlash).toEqual(withoutSlash)
})

test("resolveToolPaths follows a nested directory", async () => {
  const dir = workspaceWithFiles()
  const resolved = await resolveToolPaths(dir, ["src/audit/nested"])
  expect(resolved.files).toEqual(["src/audit/nested/c.ts"])
})

test("resolveToolPaths combines a directory and a separate file", async () => {
  const dir = workspaceWithFiles()
  const resolved = await resolveToolPaths(dir, ["src/audit/nested", "src/other.ts"])
  expect(resolved.files).toEqual(["src/audit/nested/c.ts", "src/other.ts"])
})

test("resolveToolPaths on '.' returns the whole tree without erroring", async () => {
  const dir = workspaceWithFiles()
  const resolved = await resolveToolPaths(dir, ["."])
  expect(resolved.files).toContain("src/other.ts")
  expect(resolved.files).toContain("src/audit/nested/c.ts")
  expect(resolved.empty).toBe(false)
})

test("resolveToolPaths on a non-existent path is empty, not an error", async () => {
  const dir = workspaceWithFiles()
  const resolved = await resolveToolPaths(dir, ["src/does-not-exist"])
  expect(resolved).toEqual({ files: [], empty: true })
})

test("resolveToolPaths rejects a path that escapes the workspace", async () => {
  const dir = workspaceWithFiles()
  await expect(resolveToolPaths(dir, ["../elsewhere"])).rejects.toThrow("path-outside-workspace")
  await expect(resolveToolPaths(dir, ["/etc/passwd"])).rejects.toThrow("path-outside-workspace")
})

test("filterByResolvedPaths keeps only findings whose file was resolved, or everything with no restriction", () => {
  const findings = [{ file: "a.ts" }, { file: "b.ts" }]
  expect(filterByResolvedPaths(findings, { files: undefined, empty: false })).toEqual(findings)
  expect(filterByResolvedPaths(findings, { files: ["a.ts"], empty: false })).toEqual([
    { file: "a.ts" },
  ])
})
