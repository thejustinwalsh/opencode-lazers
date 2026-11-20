import { afterEach, expect, test } from "bun:test"
import { AuditHistory } from "./history.ts"
import { AnalyzerError } from "./wasm-analyzer.ts"
import { setFallowConfig } from "./config.ts"
import { dryRunFallowConfig, suggestFallowConfig } from "./fallow-config-tools.ts"
import { fallowHealthRun, healthRunOutput } from "./health.ts"
import { DUPLICATION_NOT_INCLUDED, fallowReport, type ReportRunners } from "./report.ts"
import { fallowReview } from "./review.ts"
import { fixture, nested, type Fixture } from "./review-fixtures.ts"
import {
  defaultFallowAnalyzer,
  fallowCombined,
  fallowHealthWithoutDuplication,
  fallowSection,
} from "./wasm-analyzer.ts"

const open: Fixture[] = []
afterEach(() => {
  for (const f of open.splice(0)) f.cleanup()
})
const actor = { sessionID: "architect", agent: "architect" }
const real: ReportRunners = {
  combined: fallowCombined,
  healthWithoutDuplication: fallowHealthWithoutDuplication,
  section: fallowSection,
}

async function storedOnly(config: object, files: Record<string, string> = {}) {
  const f = await fixture({
    base: { "src/index.ts": "console.log(1)\n", ...files },
    head: { "src/index.ts": "console.log(2)\n" },
    config: null,
  })
  open.push(f)
  setFallowConfig(f.repository, config, actor, "stored for the test")
  return f
}

test("a project whose only config is the stored LAZERS one gets the same config in the audit, the report and the health score", async () => {
  // A distinctive limit: it shows in each entry point's own output.
  const f = await storedOnly(
    { entry: ["src/index.ts"], health: { maxCognitive: 7 } },
    {
      "src/deep.ts": nested("deep", 4),
    },
  )
  const audit = await fallowReview({
    workspace: f.dir,
    baseCommit: f.base,
    artifact: f.head,
    repository: f.repository,
  })
  expect(audit.package?.config.source).toBe("lazers")
  expect(audit.package?.thresholds.cognitive).toBe(7)

  const history = new AuditHistory(f.repository)
  const report = await fallowReport(history, { requestID: "r", workspace: f.dir }, actor)
  const healthSection = history.sections(report.runID).find((s) => s.analysis === "health")!
  expect(
    (healthSection.report as { summary: { max_cognitive_threshold: number } }).summary
      .max_cognitive_threshold,
  ).toBe(7)

  const health = await fallowHealthRun(history, { requestID: "h", workspace: f.dir }, actor)
  const scoreSection = history.sections(health.runID).find((s) => s.analysis === "health")!
  expect(
    (scoreSection.report as { summary: { max_cognitive_threshold: number } }).summary
      .max_cognitive_threshold,
  ).toBe(7)
  // nested("deep", 4) has cognitive 10: over 7, under the default 15, so the stored limit is what flagged it.
  expect(
    (healthSection.report as { findings: { name: string }[] }).findings.some(
      (x) => x.name === "deep",
    ),
  ).toBe(true)
}, 120_000)

test("no config anywhere: the report and the health score fail with the typed error", async () => {
  const f = await fixture({
    base: { "src/index.ts": "1\n" },
    head: { "src/index.ts": "2\n" },
    config: null,
  })
  open.push(f)
  const history = new AuditHistory(f.repository)
  await expect(
    fallowReport(history, { requestID: "r", workspace: f.dir }, actor),
  ).rejects.toMatchObject({
    code: "FALLOW_CONFIG_MISSING",
  })
})

test("the suggested ignore patterns are keys the engine reads: a suggested ignore removes findings in the dry run", async () => {
  const f = await fixture({
    base: {
      "src/index.ts": `import { used } from "../generated/gen"\nconsole.log(used)\n`,
      "generated/gen.ts": "export const used = 1\nexport const neverUsed = 2\n",
    },
    head: {},
    config: { entry: ["src/index.ts"] },
  })
  open.push(f)
  const suggestion = await suggestFallowConfig(
    f.dir,
    f.repository.projectDirectory,
    defaultFallowAnalyzer,
  )
  expect(suggestion.config.ignorePatterns).toEqual(["generated/**"])
  // Every key the suggestion emits is one the engine's config schema defines.
  expect(
    Object.keys(suggestion.config).every((key) =>
      ["entry", "ignorePatterns", "rules"].includes(key),
    ),
  ).toBe(true)
  const withIgnore = await dryRunFallowConfig(f.dir, "p", suggestion.config, defaultFallowAnalyzer)
  const { ignorePatterns: _removed, ...without } = suggestion.config
  const withoutIgnore = await dryRunFallowConfig(f.dir, "p", without, defaultFallowAnalyzer)
  const exports = (r: typeof withIgnore) =>
    r.classes.find((c) => c.class === "dead-code:unused-export")?.total ?? 0
  expect(exports(withoutIgnore)).toBeGreaterThan(0)
  expect(exports(withIgnore)).toBe(0)
}, 120_000)

test("a health run end to end on a fixture: score, penalties, top findings, then a comparison", async () => {
  const f = await storedOnly({ entry: ["src/index.ts"] }, { "src/deep.ts": nested("deep", 9) })
  const history = new AuditHistory(f.repository)
  const first = await fallowHealthRun(
    history,
    { requestID: "a", workspace: f.dir, phase: "baseline" },
    actor,
  )
  expect(first.score).toBeGreaterThan(0)
  expect(first.grade).toMatch(/^[A-F]$/)
  expect(first.duplicationIncluded).toBe(true)
  expect(first.penalties.map((p) => p.metric)).toContain("duplication")
  expect(first.top.map((t) => t.metric).sort()).toEqual(
    first.penalties
      .filter((p) => p.penalty > 0)
      .map((p) => p.metric)
      .sort(),
  )
  const second = await fallowHealthRun(
    history,
    { requestID: "b", workspace: f.dir, phase: "follow-up" },
    actor,
  )
  expect(second.comparison?.baselineRunID).toBe(first.runID)
  expect(second.comparison?.scoreDelta).toBe(0)
  expect(
    healthRunOutput(history, second.runID, first.runID).comparison?.penaltyDeltas.length,
  ).toBeGreaterThan(0)
}, 180_000)

test("a project too large for the duplication index still gets a score, marked duplication not included", async () => {
  const f = await storedOnly({ entry: ["src/index.ts"] })
  const history = new AuditHistory(f.repository)
  const memory: ReportRunners = {
    ...real,
    combined: () =>
      Promise.reject(new AnalyzerError("analyzer-memory", "the project is too large for analysis")),
  }
  const run = await fallowHealthRun(
    history,
    { requestID: "big", workspace: f.dir },
    actor,
    undefined,
    memory,
  )
  expect(run.score).not.toBeNull()
  expect(run.duplicationIncluded).toBe(false)
  expect(run.errors).toContainEqual({ section: "duplication", message: DUPLICATION_NOT_INCLUDED })
  expect(run.penalties.find((p) => p.metric === "duplication")?.penalty ?? 0).toBe(0)
}, 180_000)
