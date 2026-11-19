import { afterEach, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import type { FallowAnalyzer } from "./analyzer.ts"
import type { FallowFinding } from "./contract.ts"
import { renderRepair } from "./fallow-render.ts"
import { fallowReview } from "./review.ts"
import { fixture, git, nested, type Fixture } from "./review-fixtures.ts"
import { setFallowThreads } from "./wasm-analyzer.ts"

const open: Fixture[] = []
afterEach(() => {
  for (const f of open.splice(0)) f.cleanup()
})
async function setup(input: Parameters<typeof fixture>[0]) {
  const f = await fixture(input)
  open.push(f)
  return f
}
const review = (f: Fixture) =>
  fallowReview({ workspace: f.dir, baseCommit: f.base, artifact: f.head, repository: f.repository })
const live = (pkg: { findings: FallowFinding[] }) =>
  pkg.findings.filter((x) => x.attribution !== "inherited")
const INDEX = `import { deep } from "./nested"\nconsole.log(deep(1))\n`

test("an introduced function over the limits is an error; the repair text says fix these", async () => {
  const f = await setup({
    base: { "src/index.ts": "console.log(1)\n" },
    head: { "src/index.ts": INDEX, "src/nested.ts": nested("deep", 9) },
  })
  const result = await review(f)
  const pkg = result.package!
  expect(pkg.verdict).toBe("fail")
  const finding = live(pkg).find((x) => x.class === "complexity")!
  expect(finding).toMatchObject({
    severity: "error",
    attribution: "introduced",
    file: "src/nested.ts",
    symbol: "deep",
  })
  expect(finding.measures?.[0]).toMatchObject({ metric: "cognitive", value: 45, threshold: 15 })
  expect(renderRepair(pkg)).toContain("Errors, fix these:")
}, 60_000)

test("an over-limit function the change did not touch is inherited context, not a finding", async () => {
  const f = await setup({
    base: {
      "src/index.ts": INDEX,
      "src/nested.ts": `${nested("deep", 9)}\nexport function trivial() {\n  return "old"\n}\n`,
    },
    head: {
      "src/nested.ts": `${nested("deep", 9)}\nexport function trivial() {\n  return "new"\n}\n`,
    },
  })
  const result = await review(f)
  expect(result.status).toBe("clean")
  expect(result.package!.summary).toMatchObject({ errors: 0, warnings: 0 })
  expect(result.package!.summary.inherited).toBeGreaterThan(0)
  expect(result.package!.findings.every((x) => x.attribution === "inherited")).toBe(true)
}, 60_000)

test("growth inside the same severity tier is a worsened warning; crossing a tier is introduced", async () => {
  const f = await setup({
    base: { "src/index.ts": `${INDEX}`, "src/nested.ts": nested("deep", 6) },
    head: { "src/nested.ts": nested("deep", 6, 2) },
  })
  const worsened = live((await review(f)).package!).find((x) => x.symbol === "deep")!
  expect(worsened).toMatchObject({ attribution: "worsened", severity: "warn" })
  expect(worsened.worsenedMetrics?.some((m) => m.metric === "cognitive")).toBe(true)

  const tier = await setup({
    base: { "src/index.ts": INDEX, "src/nested.ts": nested("deep", 6) },
    head: { "src/nested.ts": nested("deep", 7) },
  })
  expect(live((await review(tier)).package!).find((x) => x.symbol === "deep")).toMatchObject({
    attribution: "introduced",
    severity: "error",
  })
}, 60_000)

test("complexity in a test file never fails: warn, exempt", async () => {
  const f = await setup({
    base: { "src/index.ts": "console.log(1)\n" },
    head: { "test/big.test.ts": nested("big", 9) },
  })
  const finding = live((await review(f)).package!).find(
    (x) => x.class === "complexity" && x.file === "test/big.test.ts",
  )!
  expect(finding).toMatchObject({ severity: "warn", gateExemption: "test-file" })
}, 60_000)

test("a skipped test and a new suppression comment are diff-risk warnings", async () => {
  const f = await setup({
    base: {
      "src/index.ts": "console.log(1)\n",
      "src/a.test.ts": `test("a", () => { expect(1).toBe(1) })\n`,
    },
    head: {
      "src/a.test.ts": `test.skip("a", () => { expect(1).toBe(1) })\n// eslint-disable-next-line no-console\ntest("b", () => {})\n`,
    },
  })
  const risk = live((await review(f)).package!).filter((x) => x.class === "diff-risk")
  expect(risk.map((x) => x.rule).sort()).toEqual(["added-suppression", "weakened-tests:skip-only"])
  expect(risk.every((x) => x.severity === "warn" && x.suppress?.requiresReason)).toBe(true)
}, 60_000)

test("dependency findings appear only when the change touches the package.json that declares them", async () => {
  const declared = JSON.stringify({ name: "fixture", dependencies: { "never-used": "1.0.0" } })
  const touched = await setup({
    base: { "src/index.ts": "console.log(1)\n" },
    head: { "package.json": declared },
  })
  expect(
    live((await review(touched)).package!).find((x) => x.class === "dependency"),
  ).toMatchObject({ rule: "unused-dependency", attribution: "introduced", severity: "error" })

  const untouched = await setup({
    base: { "src/index.ts": "console.log(1)\n", "package.json": declared },
    head: { "src/index.ts": "console.log(2)\n" },
  })
  expect(live((await review(untouched)).package!).filter((x) => x.class === "dependency")).toEqual(
    [],
  )
}, 60_000)

const CLONE = (name: string) => `export function ${name}() {
  const out: number[] = []
  for (let i = 0; i < 10; i++) { out.push(i * 2); out.push(i * 3); out.push(i * 4) }
  const total = out.reduce((s, x) => s + x, 0)
  console.log("total", total, out.length, out[0], out[1], out[2], out[3])
  return total + out.length + out[0]! + out[1]! + out[2]! + out[3]!
}
`

test("duplication counts only when a hunk of the change wrote it", async () => {
  const added = await setup({
    base: { "src/index.ts": INDEX.replace("nested", "a"), "src/a.ts": CLONE("a") },
    head: { "src/b.ts": CLONE("b") },
  })
  const clone = live((await review(added)).package!).find((x) => x.class === "duplication")!
  expect(clone).toMatchObject({ file: "src/b.ts", severity: "warn", attribution: "introduced" })
  expect(clone.relatedLocations?.[0]?.file).toBe("src/a.ts")

  const preexisting = await setup({
    base: {
      "src/index.ts": "console.log(1)\n",
      "src/a.ts": `${CLONE("a")}export const x = 1\n`,
      "src/b.ts": CLONE("b"),
    },
    head: { "src/a.ts": `${CLONE("a")}export const x = 2\n` },
  })
  expect(
    live((await review(preexisting)).package!).filter((x) => x.class === "duplication"),
  ).toEqual([])
}, 60_000)

test("uncommitted edits in the working tree are audited, as lz-fallow-audit needs", async () => {
  const f = await setup({
    base: { "src/index.ts": "console.log(1)\n" },
    head: { "src/index.ts": INDEX, "src/nested.ts": nested("deep", 9) },
    uncommitted: true,
  })
  expect(live((await review(f)).package!).some((x) => x.symbol === "deep")).toBe(true)
}, 60_000)

test("a project with no Fallow config is unavailable with a typed reason", async () => {
  const f = await setup({
    base: { "src/index.ts": "console.log(1)\n" },
    head: { "src/index.ts": "console.log(2)\n" },
    config: null,
  })
  const result = await review(f)
  expect(result.status).toBe("unavailable")
  expect(result.reason).toContain("FALLOW_CONFIG_MISSING")
}, 60_000)

test("a broken analyzer, or a report that does not fit the schema, is unavailable, never a throw", async () => {
  const f = await setup({
    base: { "src/index.ts": "console.log(1)\n" },
    head: { "src/index.ts": "console.log(2)\n" },
  })
  const stub = (audit: () => Promise<unknown>) =>
    ({
      audit,
      complexity: () => Promise.reject(new Error("unused")),
      duplication: () => Promise.reject(new Error("unused")),
      deadCode: () => Promise.reject(new Error("unused")),
      cycles: () => Promise.reject(new Error("unused")),
      projectInfo: () => Promise.reject(new Error("unused")),
    }) as FallowAnalyzer
  const run = (analyzer: FallowAnalyzer) =>
    fallowReview({
      workspace: f.dir,
      baseCommit: f.base,
      artifact: f.head,
      repository: f.repository,
      analyzer,
    })
  expect((await run(stub(() => Promise.reject(new Error("boom"))))).reason).toContain("boom")
  expect((await run(stub(async () => ({ kind: "audit", surprise: true })))).reason).toContain(
    "analyzer-schema",
  )
}, 60_000)

test("the result is identical with threads on and off, and the review leaves the tree clean", async () => {
  const f = await setup({
    base: { "src/index.ts": "console.log(1)\n" },
    head: { "src/index.ts": INDEX, "src/nested.ts": nested("deep", 9) },
  })
  setFallowThreads("on")
  const on = await review(f)
  setFallowThreads("off")
  const off = await review(f)
  setFallowThreads("on")
  const strip = (r: typeof on) => ({ ...r.package!, timings: undefined })
  expect(strip(off)).toEqual(strip(on))
  expect(await git(f.dir, "status", "--porcelain")).toBe("")
  expect(existsSync(join(f.dir, ".fallow"))).toBe(true)
}, 120_000)
