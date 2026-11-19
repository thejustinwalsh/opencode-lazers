import { afterEach, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TaskRepository } from "../storage.ts"
import { fallowPlanReview } from "./review-plan.ts"
import { attributeFindingsToTasks } from "./task-attribution.ts"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function temp(prefix: string) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

async function git(cwd: string, ...args: string[]) {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" })
  const out = await new Response(proc.stdout).text()
  expect(await proc.exited).toBe(0)
  return out.trim()
}

async function commit(dir: string, message: string) {
  await git(dir, "add", "-A")
  await git(
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
  return git(dir, "rev-parse", "HEAD")
}

function repository(directory: string) {
  mkdirSync(join(directory, "data"), { recursive: true })
  const r = new TaskRepository(join(directory, "data", "tasks.sqlite"), directory)
  cleanups.push(() => r.close())
  return r
}

async function baseRepo() {
  const dir = temp("lz-fallow-plan-")
  await git(dir, "init", "-q", "-b", "main")
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture" }))
  writeFileSync(join(dir, ".gitignore"), "data/\n")
  return dir
}

const helperBody = Array.from({ length: 40 }, (_, i) => `console.log("line ${i}")`).join("\n")
const helper = (name: string) => `export function ${name}() {\n${helperBody}\n}\n`

function leftoverTemps() {
  return readdirSync(tmpdir()).filter((name) => name.startsWith("lz-fallow-base"))
}

/** Fallow's cache is the one thing a review may leave in a tree, and it ignores itself. */
const ignoredCacheOnly = (directory: string) =>
  !existsSync(join(directory, ".fallow")) ||
  readFileSync(join(directory, ".fallow/.gitignore"), "utf8") === "*\n"

test("a helper added by two tasks is reported as duplication naming both files and both tasks", async () => {
  const dir = await baseRepo()
  writeFileSync(join(dir, "seed.ts"), "export const seed = 1\n")
  const base = await commit(dir, "base")
  writeFileSync(join(dir, "task-one.ts"), helper("shared"))
  const first = await commit(dir, "task one adds the helper")
  writeFileSync(join(dir, "task-two.ts"), helper("shared"))
  const second = await commit(dir, "task two adds the same helper")
  const before = leftoverTemps()
  const result = await fallowPlanReview({
    workspace: dir,
    baseCommit: base,
    artifact: second,
    repository: repository(dir),
  })
  expect(result.status).toBe("findings")
  const clone = result.introduced.find((finding) => finding.check === "duplication")!
  expect([clone.file, ...(clone.others ?? []).map((other) => other.file)].sort()).toEqual([
    "task-one.ts",
    "task-two.ts",
  ])
  const attributed = await attributeFindingsToTasks(
    dir,
    [
      { taskID: "task-1", base, artifact: first },
      { taskID: "task-2", base: first, artifact: second },
    ],
    result,
  )
  expect(attributed.introduced.find((f) => f.check === "duplication")?.taskIDs).toEqual([
    "task-1",
    "task-2",
  ])
  expect(ignoredCacheOnly(dir)).toBe(true)
  expect(leftoverTemps()).toEqual(before)
}, 60_000)

test("a finding in one task's file names just that task", async () => {
  const dir = await baseRepo()
  writeFileSync(join(dir, "seed.ts"), "export const seed = 1\n")
  const base = await commit(dir, "base")
  writeFileSync(join(dir, "only.ts"), "export const only = 1\n")
  const first = await commit(dir, "one")
  const result = await attributeFindingsToTasks(
    dir,
    [{ taskID: "task-1", base, artifact: first }],
    {
      status: "findings",
      introduced: [
        {
          id: "x",
          check: "complexity",
          status: "introduced",
          file: "only.ts",
          line: 1,
          subject: "f",
          fix: "",
        },
      ],
      concerns: [],
      thresholds: { cyclomatic: 20, cognitive: 15 },
      configSource: "defaults",
    },
  )
  expect(result.introduced[0]?.taskID).toBe("task-1")
  expect(result.introduced[0]?.taskIDs).toBeUndefined()
})

test("an import cycle added since the plan base is a concern, not an introduced finding", async () => {
  const dir = await baseRepo()
  writeFileSync(join(dir, "a.ts"), "export const a = 1\n")
  writeFileSync(join(dir, "b.ts"), "import { a } from './a.ts'\nexport const b = a + 1\n")
  const base = await commit(dir, "base: b imports a")
  writeFileSync(
    join(dir, "a.ts"),
    "import { b } from './b.ts'\nexport const a = 1\nexport const c = b\n",
  )
  const artifact = await commit(dir, "a now imports b")
  const result = await fallowPlanReview({
    workspace: dir,
    baseCommit: base,
    artifact,
    repository: repository(dir),
  })
  const cycle = result.concerns.find((finding) => finding.check === "cycle")
  expect(cycle?.subject).toContain("a.ts")
  expect(cycle?.subject).toContain("b.ts")
  expect(result.introduced.filter((finding) => finding.check === "cycle")).toEqual([])
  expect(ignoredCacheOnly(dir)).toBe(true)
}, 60_000)

test("a cycle that already existed at the base is not reported", async () => {
  const dir = await baseRepo()
  writeFileSync(
    join(dir, "a.ts"),
    "import { b } from './b.ts'\nexport const a = 1\nexport const c = b\n",
  )
  writeFileSync(join(dir, "b.ts"), "import { a } from './a.ts'\nexport const b = a + 1\n")
  const base = await commit(dir, "base with a cycle")
  writeFileSync(join(dir, "c.ts"), "export const unrelated = 1\n")
  const artifact = await commit(dir, "unrelated")
  const result = await fallowPlanReview({
    workspace: dir,
    baseCommit: base,
    artifact,
    repository: repository(dir),
  })
  expect(result.concerns.filter((finding) => finding.check === "cycle")).toEqual([])
}, 60_000)

test("dead code introduced since the base is a concern when the config declares entry points", async () => {
  const dir = await baseRepo()
  writeFileSync(join(dir, ".fallowrc.json"), JSON.stringify({ entry: ["index.ts"] }))
  writeFileSync(join(dir, "index.ts"), "import { used } from './lib.ts'\nconsole.log(used)\n")
  writeFileSync(join(dir, "lib.ts"), "export const used = 1\n")
  const base = await commit(dir, "base")
  writeFileSync(join(dir, "lib.ts"), "export const used = 1\nexport const orphan = 2\n")
  const artifact = await commit(dir, "add an export nothing imports")
  const result = await fallowPlanReview({
    workspace: dir,
    baseCommit: base,
    artifact,
    repository: repository(dir),
  })
  const dead = result.concerns.find((finding) => finding.check === "dead-code")
  expect(dead?.subject).toContain("orphan")
  expect(result.introduced.filter((finding) => finding.check === "dead-code")).toEqual([])
  expect(ignoredCacheOnly(dir)).toBe(true)
}, 60_000)
