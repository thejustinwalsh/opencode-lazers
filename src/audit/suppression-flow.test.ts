import { afterEach, expect, test } from "bun:test"
import { renderNotice, renderRepair } from "./fallow-render.ts"
import { fallowPlanReview } from "./review-plan.ts"
import { commitAll, fixture, write, type Fixture } from "./review-fixtures.ts"
import { fallowReview } from "./review.ts"
import { attributeFindingsToTasks } from "./task-attribution.ts"
import { setFallowThreads } from "./wasm-analyzer.ts"

const open: Fixture[] = []
afterEach(() => {
  for (const f of open.splice(0)) f.cleanup()
})

const INDEX = `import { other } from "./ahead"\nconsole.log(other)\n`
const AHEAD = [
  "export const other = 0",
  "// fallow-ignore-next-line unused-export -- consumed by LZ-231",
  "export const ahead = 1",
  "// fallow-ignore-next-line unused-export",
  "export const noReason = 2",
  "",
].join("\n")

/** base, then task one (adds the code ahead), then task two (consumes `ahead`, leaves the comment). */
async function plan() {
  const f = await fixture({
    base: { "src/index.ts": INDEX, "src/ahead.ts": "export const other = 0\n" },
    head: { "src/ahead.ts": AHEAD },
  })
  open.push(f)
  const first = f.head
  write(f.dir, {
    "src/index.ts": `import { other, ahead } from "./ahead"\nconsole.log(other, ahead)\n`,
  })
  const second = await commitAll(f.dir, "task two consumes ahead and leaves the comment")
  return { f, first, second }
}
const review = (f: Fixture, base: string, artifact: string) =>
  fallowReview({ workspace: f.dir, baseCommit: base, artifact, repository: f.repository })

test("code added ahead with a reasoned suppression is a warning with its reason, not a failure; a missing reason is called out", async () => {
  // The adding task alone: base and its own commit.
  const adder = await fixture({
    base: { "src/index.ts": INDEX, "src/ahead.ts": "export const other = 0\n" },
    head: { "src/ahead.ts": AHEAD },
  })
  open.push(adder)
  const result = await review(adder, adder.base, adder.head)
  const pkg = result.package!
  expect(pkg.verdict).toBe("warn")
  expect(pkg.summary.errors).toBe(0)
  const added = pkg.findings.filter((x) => x.rule === "added-suppression")
  expect(added.map((x) => x.suppression?.reason).sort()).toEqual(["consumed by LZ-231", undefined])
  expect(added.every((x) => x.severity === "warn")).toBe(true)
  const notice = renderNotice(pkg, undefined)
  expect(notice).toContain("reason: consumed by LZ-231")
  expect(notice).toContain("NO REASON GIVEN")
  expect(added.find((x) => !x.suppression?.reason)?.suggestion).toContain(
    "-- consumed by <task reference>",
  )

  // Without the comment the export is an error, and the repair text shows the exact comment to write.
  const bare = await fixture({
    base: { "src/index.ts": INDEX, "src/ahead.ts": "export const other = 0\n" },
    head: { "src/ahead.ts": "export const other = 0\nexport const ahead = 1\n" },
  })
  open.push(bare)
  const error = (await review(bare, bare.base, bare.head)).package!
  expect(error.verdict).toBe("fail")
  expect(renderRepair(error)).toContain(
    "// fallow-ignore-next-line unused-export -- consumed by <task reference>",
  )
}, 120_000)

test("the consumer's own audit says the suppression is stale; removing it leaves the audit clean", async () => {
  const { f, first } = await plan()
  const consumer = await review(f, first, "HEAD")
  const stale = consumer.package!.findings.find((x) => x.rule === "stale-suppression")!
  expect(stale).toMatchObject({
    file: "src/ahead.ts",
    line: 2,
    severity: "warn",
    attribution: "introduced",
  })
  expect(stale.message).toContain("consumed by LZ-231")
  expect(consumer.package!.verdict).toBe("warn")

  write(f.dir, {
    "src/ahead.ts": AHEAD.replace(
      "// fallow-ignore-next-line unused-export -- consumed by LZ-231\n",
      "",
    ),
  })
  await commitAll(f.dir, "consumer removes the comment")
  const fixed = await review(f, first, "HEAD")
  expect(fixed.package!.findings.filter((x) => x.rule === "stale-suppression")).toEqual([])
}, 180_000)

test("at the plan's end a consumed-but-left comment goes to the consumer, an unconsumed one to the adder", async () => {
  const { f, first, second } = await plan()
  const result = await fallowPlanReview({
    workspace: f.dir,
    baseCommit: f.base,
    artifact: second,
    repository: f.repository,
  })
  const tasks = [
    { taskID: "adder", base: f.base, artifact: first },
    { taskID: "consumer", base: first, artifact: second },
  ]
  const attributed = await attributeFindingsToTasks(f.dir, tasks, result)
  const findings = attributed.package!.findings
  expect(findings.find((x) => x.rule === "stale-suppression")).toMatchObject({ taskID: "consumer" })
  const unconsumed = findings.find((x) => x.rule === "unconsumed-suppression")!
  expect(unconsumed).toMatchObject({ taskID: "adder", line: 4, severity: "warn" })
  expect(unconsumed.message).toContain("no reason was given")
}, 180_000)

test("a plan that ends with its suppressed export unused reports it against the adding task", async () => {
  const f = await fixture({
    base: { "src/index.ts": INDEX, "src/ahead.ts": "export const other = 0\n" },
    head: { "src/ahead.ts": AHEAD },
  })
  open.push(f)
  const result = await fallowPlanReview({
    workspace: f.dir,
    baseCommit: f.base,
    artifact: f.head,
    repository: f.repository,
  })
  const attributed = await attributeFindingsToTasks(
    f.dir,
    [{ taskID: "adder", base: f.base, artifact: f.head }],
    result,
  )
  const unconsumed = attributed.package!.findings.filter((x) => x.rule === "unconsumed-suppression")
  expect(unconsumed).toHaveLength(2)
  expect(unconsumed.every((x) => x.taskID === "adder")).toBe(true)
  expect(unconsumed.map((x) => x.suppression?.reason).sort()).toEqual([
    "consumed by LZ-231",
    undefined,
  ])
}, 180_000)

test("the flow gives the same package with threads on and off", async () => {
  const { f, first } = await plan()
  setFallowThreads("on")
  const on = await review(f, first, "HEAD")
  setFallowThreads("off")
  const off = await review(f, first, "HEAD")
  setFallowThreads("on")
  const strip = (r: typeof on) => ({ ...r.package!, timings: undefined })
  expect(strip(off)).toEqual(strip(on))
}, 180_000)
