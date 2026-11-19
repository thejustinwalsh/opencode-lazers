import { afterEach, expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { fallowPlanReview } from "./review-plan.ts"
import { attributeFindingsToTasks } from "./task-attribution.ts"
import { fixture, git, write, type Fixture } from "./review-fixtures.ts"

const open: Fixture[] = []
afterEach(() => {
  for (const f of open.splice(0)) f.cleanup()
})

const body = Array.from({ length: 40 }, (_, i) => `console.log("line ${i}")`).join("\n")
const helper = (name: string) => `export function ${name}() {\n${body}\n}\n`
const leftoverTemps = () =>
  readdirSync(tmpdir()).filter((name) => name.startsWith("lz-fallow-base"))

async function commitAll(dir: string, message: string) {
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

test("a helper added by two tasks is one duplication finding over the combined plan, attributed to both tasks", async () => {
  const f = await fixture({ base: { "src/index.ts": "console.log(1)\n" }, head: {} })
  open.push(f)
  write(f.dir, { "src/task-one.ts": helper("shared") })
  const first = await commitAll(f.dir, "task one adds the helper")
  write(f.dir, { "src/task-two.ts": helper("shared") })
  const second = await commitAll(f.dir, "task two adds the same helper")
  const before = leftoverTemps()
  const result = await fallowPlanReview({
    workspace: f.dir,
    baseCommit: f.base,
    artifact: second,
    repository: f.repository,
  })
  const clone = result.package!.findings.find((x) => x.class === "duplication")!
  expect(clone.attribution).toBe("introduced")
  const files = [clone.file, ...(clone.relatedLocations ?? []).map((l) => l.file)].sort()
  expect(files).toEqual(["src/task-one.ts", "src/task-two.ts"])

  const attributed = await attributeFindingsToTasks(
    f.dir,
    [
      { taskID: "task-1", base: f.base, artifact: first },
      { taskID: "task-2", base: first, artifact: second },
    ],
    result,
  )
  expect(attributed.package!.findings.find((x) => x.class === "duplication")!.taskIDs).toEqual([
    "task-1",
    "task-2",
  ])
  expect(leftoverTemps()).toEqual(before)
}, 90_000)

test("an import cycle two tasks close together is a finding on the combined plan", async () => {
  const f = await fixture({
    base: {
      "src/index.ts": `import "./a"\n`,
      "src/a.ts": "export const a = 1\n",
      "src/b.ts": "export const b = 1\n",
    },
    head: {},
  })
  open.push(f)
  write(f.dir, { "src/a.ts": `import { b } from "./b"\nexport const a = b\n` })
  await commitAll(f.dir, "task one: a imports b")
  write(f.dir, { "src/b.ts": `import { a } from "./a"\nexport const b = a\n` })
  const second = await commitAll(f.dir, "task two: b imports a")
  const result = await fallowPlanReview({
    workspace: f.dir,
    baseCommit: f.base,
    artifact: second,
    repository: f.repository,
  })
  expect(
    result.package!.findings.some(
      (x) => x.class === "architecture" && x.attribution === "introduced",
    ),
  ).toBe(true)
}, 90_000)
