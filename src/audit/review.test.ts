import { afterEach, expect, test } from "bun:test"
import { access, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TaskRepository } from "../storage.ts"
import { fallowGuidance, fallowReview, type FallowReviewResult } from "./review.ts"
import type { FallowAnalyzer } from "./analyzer.ts"

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
  await run(dir, "add", "-A")
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

function repository(directory: string) {
  mkdirSync(join(directory, "data"), { recursive: true })
  const r = new TaskRepository(join(directory, "data", "tasks.sqlite"), directory)
  cleanups.push(() => r.close())
  return r
}

function deeplyNested(name: string): string {
  const depth = 9
  let body = "return 1\n"
  for (let i = depth; i >= 1; i--) body = `if (a > ${i}) {\n${body}}\n`
  return `export function ${name}(a: number): number {\n${body}return 0\n}\n`
}

async function baseRepo() {
  const dir = temp("lz-fallow-review-")
  await run(dir, "init", "-q", "-b", "main")
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture" }))
  return dir
}

test("a commit that adds a ~40-line duplicated block is anchored in the new file, naming the original", async () => {
  const dir = await baseRepo()
  const lines = Array.from({ length: 40 }, (_, i) => `console.log("line ${i}")`).join("\n")
  writeFileSync(join(dir, "original.ts"), `export function a() {\n${lines}\n}\n`)
  const base = await commit(dir, "base")
  writeFileSync(join(dir, "copy.ts"), `export function b() {\n${lines}\n}\n`)
  const artifact = await commit(dir, "copy the block into a new file")
  const result = await fallowReview({
    workspace: dir,
    baseCommit: base,
    artifact,
    repository: repository(dir),
  })
  expect(result.status).toBe("findings")
  const dup = result.introduced.find((f) => f.check === "duplication")
  expect(dup).toBeDefined()
  // Anchored in the file the task changed, not the pre-existing instance.
  expect(dup!.file).toBe("copy.ts")
  expect(dup!.others).toHaveLength(1)
  expect(dup!.others![0]!.file).toBe("original.ts")
  expect(dup!.measured).toBeUndefined()
  expect(dup!.limit).toBeUndefined()
  expect(dup!.subject).toMatch(/^\d+ lines$/)
}, 30_000)

test("a commit that adds a deeply nested function is introduced complexity", async () => {
  const dir = await baseRepo()
  const base = await commit(dir, "base")
  writeFileSync(join(dir, "nested.ts"), deeplyNested("deep"))
  const artifact = await commit(dir, "nest it")
  const result = await fallowReview({
    workspace: dir,
    baseCommit: base,
    artifact,
    repository: repository(dir),
  })
  expect(result.status).toBe("findings")
  const complexity = result.introduced.find((f) => f.check === "complexity" && f.subject === "deep")
  expect(complexity).toBeDefined()
  expect(complexity!.status).toBe("introduced")
  expect(complexity!.measures!.length).toBeGreaterThan(0)
  expect(complexity!.measures![0]!.metric).toBe("cognitive")
}, 30_000)

test("editing a file without touching its old over-limit function reports nothing", async () => {
  const dir = await baseRepo()
  writeFileSync(
    join(dir, "mixed.ts"),
    `${deeplyNested("deep")}\nexport function trivial() {\n  return "old"\n}\n`,
  )
  const base = await commit(dir, "base")
  writeFileSync(
    join(dir, "mixed.ts"),
    `${deeplyNested("deep")}\nexport function trivial() {\n  return "new"\n}\n`,
  )
  const artifact = await commit(dir, "edit trivial only")
  const result = await fallowReview({
    workspace: dir,
    baseCommit: base,
    artifact,
    repository: repository(dir),
  })
  expect(result.status).toBe("clean")
  expect(result.introduced).toEqual([])
  expect(result.concerns).toEqual([])
}, 30_000)

test("a broken analyzer yields unavailable, never a throw", async () => {
  const dir = await baseRepo()
  const base = await commit(dir, "base")
  writeFileSync(join(dir, "a.ts"), "export const a = 1\n")
  const artifact = await commit(dir, "add a")
  const broken: FallowAnalyzer = {
    complexity: () => Promise.reject(new Error("boom")),
    duplication: () => Promise.reject(new Error("boom")),
    deadCode: () => Promise.reject(new Error("boom")),
    cycles: () => Promise.reject(new Error("boom")),
  }
  const result: FallowReviewResult = await fallowReview({
    workspace: dir,
    baseCommit: base,
    artifact,
    repository: repository(dir),
    analyzer: broken,
  })
  expect(result.status).toBe("unavailable")
  expect(result.reason).toContain("boom")
}, 30_000)

test("the repository has no .fallow directory after a review", async () => {
  const dir = await baseRepo()
  const base = await commit(dir, "base")
  writeFileSync(join(dir, "a.ts"), "export const a = 1\n")
  const artifact = await commit(dir, "add a")
  await fallowReview({ workspace: dir, baseCommit: base, artifact, repository: repository(dir) })
  await expect(
    new Promise((resolve, reject) =>
      access(join(dir, ".fallow"), (err) => (err ? reject(err) : resolve(undefined))),
    ),
  ).rejects.toBeTruthy()
}, 30_000)

test("no changed analysable files is clean", async () => {
  const dir = await baseRepo()
  const base = await commit(dir, "base")
  writeFileSync(join(dir, "README.md"), "docs only")
  const artifact = await commit(dir, "docs")
  const result = await fallowReview({
    workspace: dir,
    baseCommit: base,
    artifact,
    repository: repository(dir),
  })
  expect(result).toEqual({
    status: "clean",
    introduced: [],
    concerns: [],
    thresholds: { cyclomatic: 20, cognitive: 15 },
    configSource: "defaults",
  })
})

test("fallowGuidance is deterministic, bounded, and matches the fixed template", () => {
  const result: FallowReviewResult = {
    status: "findings",
    introduced: [
      {
        id: "complexity:src/audit/probe-clone.ts:43:probeClassify",
        check: "complexity",
        status: "introduced",
        file: "src/audit/probe-clone.ts",
        line: 43,
        subject: "probeClassify",
        measured: 201,
        limit: 15,
        measures: [
          { metric: "cognitive", measured: 201, limit: 15 },
          { metric: "cyclomatic", measured: 58, limit: 20 },
        ],
        fix: "Split it into smaller named functions.",
      },
      {
        id: "duplication:src/audit/probe-clone.ts:1",
        check: "duplication",
        status: "introduced",
        file: "src/audit/probe-clone.ts",
        line: 1,
        endLine: 42,
        subject: "42 lines",
        others: [{ file: "src/audit/attribution.ts", line: 73, endLine: 114 }],
        fix: "Keep one implementation and import it instead of copying it.",
      },
    ],
    concerns: [],
    thresholds: { cyclomatic: 20, cognitive: 15 },
    configSource: "defaults",
  }
  const guidance = fallowGuidance(result)
  expect(guidance).toBe(
    [
      "Fallow review: 2 findings introduced by this task. Older findings are not counted.",
      "1. complexity src/audit/probe-clone.ts:43 `probeClassify` cognitive 201 (limit 15), cyclomatic 58 (limit 20).",
      "   Split it into smaller named functions.",
      "2. duplication src/audit/probe-clone.ts:1-42 repeats src/audit/attribution.ts:73-114 (42 lines).",
      "   Keep one implementation and import it instead of copying it.",
      "Fix these inside your write scope. Do not add fallow-ignore comments.",
    ].join("\n"),
  )
  expect(fallowGuidance(result)).toBe(guidance)
  expect(guidance.length).toBeLessThanOrEqual(1500)
})
