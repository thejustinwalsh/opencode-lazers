import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { parity as typeScriptParity } from "../../../../test/code-review/cccc-fixtures/languages/sample.ts"
import { canarySource } from "../../../../test/code-review/cccc-fixtures/privacy/canary.ts"
import {
  analyzeCcccComparison,
  CCCC_LANGUAGES,
  CCCC_TOOL,
  CCCC_VERSION,
  createCcccWorkerAnalyzer,
  languageOf,
} from "./index.ts"
import type {
  CcccChangedFile,
  CcccComparisonSnapshot,
  CcccFileReport,
  CcccFunctionReport,
  CcccProviderOptions,
  CcccSide,
  CcccSnapshotReader,
} from "./types.ts"

const fixtures = fileURLToPath(
  new URL("../../../../test/code-review/cccc-fixtures/", import.meta.url),
)

const languageFixtures = [
  ["typescript", "sample.ts"],
  ["javascript", "sample.js"],
  ["rust", "sample.rs"],
  ["go", "sample.go"],
  ["php", "sample.php"],
  ["ruby", "sample.rb"],
  ["scheme", "sample.scm"],
  ["racket", "sample.rkt"],
  ["commonlisp", "sample.lisp"],
  ["emacslisp", "sample.el"],
  ["clojure", "sample.clj"],
  ["kotlin", "sample.kt"],
  ["python", "sample.py"],
  ["zig", "sample.zig"],
  ["c", "sample.c"],
  ["cpp", "sample.cpp"],
  ["perl", "sample.pl"],
  ["swift", "sample.swift"],
  ["java", "sample.java"],
  ["dart", "sample.dart"],
  ["scala", "sample.scala"],
] as const

function functionReport(
  name: string,
  line: number,
  cognitive: number,
  cyclomatic: number,
  kind = "function",
): CcccFunctionReport {
  return { name, kind, line, cognitive, cyclomatic }
}

function fileReport(
  side: CcccSide,
  path: string,
  functions: CcccFunctionReport[],
  lineCount = 80,
): CcccFileReport {
  return {
    side,
    path,
    language: "typescript",
    lineCount,
    cognitive: functions.reduce((sum, fn) => sum + fn.cognitive, 0),
    cyclomatic: functions.reduce((sum, fn) => sum + fn.cyclomatic, 0),
    functions,
    parseErrors: { count: 0, lines: [] },
  }
}

function snapshotReader(
  snapshot: CcccComparisonSnapshot,
  sources: Partial<Record<CcccSide, Record<string, string>>>,
  extra: Partial<CcccSnapshotReader> = {},
): CcccSnapshotReader {
  return {
    readComparison: async () => snapshot,
    readSource: async (_id, side, path) => sources[side]?.[path],
    ...extra,
  }
}

function snapshot(
  changedFiles: CcccChangedFile[],
  comparisonID = "comparison-1",
): CcccComparisonSnapshot {
  return {
    comparisonID,
    baseRevision: "base-sha",
    headRevision: "head-sha",
    changedFiles,
  }
}

function sourceLines(count: number): string {
  return Array.from({ length: count }, (_, index) => `// line ${index + 1}`).join("\n")
}

function fakeAnalyzer(
  reports: CcccFileReport[],
): NonNullable<CcccProviderOptions["analyzeSources"]> {
  return async () => reports
}

function languageFixturePath(file: string): string {
  return file === "sample.js" ? "sample.js.txt" : file
}

describe("cccc provider comparison", () => {
  it("keeps the executable fixtures reachable without exposing their source", () => {
    expect(typeScriptParity(true)).toBe(1)
    expect(typeof canarySource).toBe("function")
  })

  it("preserves the complex comparison scores in non-code source fixtures", async () => {
    const [base, head] = await Promise.all([
      readFile(`${fixtures}complexity-increased/base/src/shipping.ts.txt`, "utf8"),
      readFile(`${fixtures}complexity-increased/head/src/shipping.ts.txt`, "utf8"),
    ])
    const reports = await createCcccWorkerAnalyzer()(
      [
        { side: "base", path: "src/shipping.ts", source: base },
        { side: "head", path: "src/shipping.ts", source: head },
      ],
      { signal: new AbortController().signal, timeoutMs: 120_000 },
    )

    expect(reports.find((report) => report.side === "base")).toMatchObject({
      cognitive: 2,
      cyclomatic: 3,
    })
    expect(reports.find((report) => report.side === "head")).toMatchObject({
      cognitive: 20,
      cyclomatic: 13,
    })
  })

  it("keeps the Oaink thresholds, decreases, and changed-line boundary", async () => {
    const changed = snapshot([{ path: "src/complex.ts", status: "modified", changedLines: [3] }])
    const reports = [
      fileReport("base", "src/complex.ts", [
        functionReport("shipping", 1, 2, 3),
        functionReport("high", 10, 16, 20),
        functionReport("decreased", 20, 12, 12),
        functionReport("untouched", 30, 22, 25),
      ]),
      fileReport("head", "src/complex.ts", [
        functionReport("shipping", 1, 6, 8),
        functionReport("high", 10, 17, 22),
        functionReport("decreased", 20, 8, 7),
        functionReport("untouched", 30, 24, 27),
      ]),
    ]
    const result = await analyzeCcccComparison(
      snapshotReader(changed, {
        base: { "src/complex.ts": sourceLines(80) },
        head: { "src/complex.ts": sourceLines(80) },
      }),
      changed.comparisonID,
      { analyzeSources: fakeAnalyzer(reports) },
    )

    expect(result.status).toBe("complete")
    expect(result.comparisonID).toBe("comparison-1")
    expect(result.revisions).toEqual({ base: "base-sha", head: "head-sha" })
    expect(result.tool).toEqual({ name: CCCC_TOOL, version: CCCC_VERSION })
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]).toMatchObject({
      name: "shipping",
      severity: "info",
      tier: "primary",
      cyclomatic: { base: 3, head: 8, delta: 5 },
      cognitive: { base: 2, head: 6, delta: 4 },
      complexityAxis: 0.267,
    })
    expect(result.summary).toMatchObject({
      functions: { base: 4, head: 4, delta: 0 },
      functionsIncreased: 1,
      files: 1,
    })
  })

  it("marks above-threshold increases primary warnings and honors configured deltas", async () => {
    const changed = snapshot([{ path: "src/complex.ts", status: "modified", changedLines: [12] }])
    const reports = [
      fileReport("base", "src/complex.ts", [functionReport("large", 10, 16, 18)]),
      fileReport("head", "src/complex.ts", [functionReport("large", 10, 17, 18)]),
    ]
    const result = await analyzeCcccComparison(
      snapshotReader(changed, {
        base: { "src/complex.ts": sourceLines(80) },
        head: { "src/complex.ts": sourceLines(80) },
      }),
      changed.comparisonID,
      {
        settings: {
          timeoutMs: 1000,
          complexity: { cyclomatic: 20, cognitive: 15, primaryDelta: 0 },
        },
        analyzeSources: fakeAnalyzer(reports),
      },
    )

    expect(result.findings[0]).toMatchObject({
      severity: "warning",
      tier: "primary",
      complexityAxis: 0.067,
    })
  })

  it("reads immutable renamed-side paths and locates the finding on the head path", async () => {
    const changed = snapshot([
      {
        path: "src/new.ts",
        previousPath: "src/old.ts",
        status: "renamed",
        changedLines: [3],
      },
    ])
    const reports = [
      fileReport("base", "src/old.ts", [functionReport("shipping", 1, 2, 3)]),
      fileReport("head", "src/new.ts", [functionReport("shipping", 1, 8, 9)]),
    ]
    const result = await analyzeCcccComparison(
      snapshotReader(changed, {
        base: { "src/old.ts": "x".repeat(200) },
        head: { "src/new.ts": "x".repeat(200) },
      }),
      changed.comparisonID,
      { analyzeSources: fakeAnalyzer(reports) },
    )

    expect(result.findings[0]?.location.path).toBe("src/new.ts")
    expect(result.findings[0]?.base.path).toBe("src/old.ts")
  })

  it("pairs moved identities and same-name methods by nearest line", async () => {
    const changed = snapshot([
      { path: "src/member.ts", status: "modified", changedLines: [22, 35] },
    ])
    const reports = [
      fileReport("base", "src/member.ts", [
        functionReport("beforeMove", 3, 4, 5, "method"),
        functionReport("step", 10, 1, 2, "method"),
        functionReport("step", 20, 5, 6, "method"),
        functionReport("oldName", 40, 2, 2, "method"),
      ]),
      fileReport("head", "src/member.ts", [
        functionReport("step", 11, 1, 2, "method"),
        functionReport("step", 21, 9, 10, "method"),
        functionReport("afterMove", 35, 4, 5, "method"),
        functionReport("newName", 45, 20, 20, "method"),
      ]),
    ]
    const result = await analyzeCcccComparison(
      snapshotReader(
        changed,
        {
          base: { "src/member.ts": sourceLines(80) },
          head: { "src/member.ts": sourceLines(80) },
        },
        {
          functionIdentity: async ({ side, line }) =>
            (side === "base" && line === 3) || (side === "head" && line === 35)
              ? "symbol:moved"
              : undefined,
        },
      ),
      changed.comparisonID,
      { analyzeSources: fakeAnalyzer(reports) },
    )

    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]).toMatchObject({
      name: "step",
      location: { line: 21 },
      base: { line: 20 },
      cyclomatic: { base: 6, head: 10, delta: 4 },
    })
  })

  it("reports missing source and changed-line coverage as degraded, not clean", async () => {
    const changed = snapshot([
      { path: "src/a.ts", status: "modified" },
      { path: "src/missing.ts", status: "modified", changedLines: [2] },
      { path: "docs/readme.md", status: "modified", changedLines: [1] },
    ])
    const result = await analyzeCcccComparison(
      snapshotReader(changed, {
        base: { "src/a.ts": "function a() {}", "src/missing.ts": "function missing() {}" },
        head: { "src/a.ts": "function a() {}" },
      }),
      changed.comparisonID,
      {
        analyzeSources: async () => [
          fileReport("base", "src/a.ts", [functionReport("a", 1, 1, 1)], 1),
          fileReport("head", "src/a.ts", [functionReport("a", 1, 1, 1)], 1),
          fileReport("base", "src/missing.ts", [functionReport("missing", 1, 1, 1)], 1),
        ],
      },
    )

    expect(result.status).toBe("degraded")
    expect(result.coverage).toMatchObject({
      supportedFiles: 2,
      analyzedFiles: 2,
      unsupportedFiles: 1,
      unavailableFiles: 1,
      unclassifiedFiles: 1,
    })
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "changed-lines-unavailable",
      "source-unavailable",
      "unsupported-extension",
    ])
    expect(result.findings).toHaveLength(0)
  })

  it("does not report a cancelled or stale generation as complete", async () => {
    const changed = snapshot([{ path: "src/a.ts", status: "modified", changedLines: [2] }])
    const sources = {
      base: { "src/a.ts": "function a() {}" },
      head: { "src/a.ts": "function a() {}" },
    }
    const aborted = new AbortController()
    aborted.abort()
    const cancelled = await analyzeCcccComparison(
      snapshotReader(changed, sources),
      changed.comparisonID,
      { signal: aborted.signal },
    )
    expect(cancelled.failure?.code).toBe("cancelled")

    let currentChecks = 0
    const stale = await analyzeCcccComparison(
      snapshotReader(changed, sources, {
        isCurrent: () => ++currentChecks === 1,
      }),
      changed.comparisonID,
      {
        analyzeSources: async (inputs) =>
          inputs.map((input) =>
            fileReport(input.side, input.path, [functionReport("a", 1, 1, 1)], 1),
          ),
      },
    )
    expect(stale.failure?.code).toBe("stale-comparison")
  })

  it("discards a comparison that goes stale while function identities are read", async () => {
    const changed = snapshot([{ path: "src/a.ts", status: "modified", changedLines: [2] }])
    let currentChecks = 0
    const result = await analyzeCcccComparison(
      snapshotReader(
        changed,
        {
          base: { "src/a.ts": sourceLines(4) },
          head: { "src/a.ts": sourceLines(4) },
        },
        {
          isCurrent: () => ++currentChecks < 3,
          functionIdentity: async ({ side }) => `symbol:${side}`,
        },
      ),
      changed.comparisonID,
      {
        analyzeSources: async (inputs) =>
          inputs.map((input) =>
            fileReport(input.side, input.path, [functionReport("a", 1, 1, 1)], 4),
          ),
      },
    )

    expect(currentChecks).toBe(3)
    expect(result.status).toBe("failed")
    expect(result.failure?.code).toBe("stale-comparison")
  })

  it("rejects invalid threshold configuration with a typed local failure", async () => {
    const changed = snapshot([{ path: "src/a.ts", status: "added" }])
    const result = await analyzeCcccComparison(
      snapshotReader(changed, { head: { "src/a.ts": "function a() {}" } }),
      changed.comparisonID,
      {
        settings: {
          timeoutMs: 100,
          complexity: { cyclomatic: 20, cognitive: 15, primaryDelta: -1 },
        },
      },
    )

    expect(result.status).toBe("failed")
    expect(result.failure?.code).toBe("invalid-settings")
  })

  it("redacts credential-shaped labels and paths without returning source text", async () => {
    const path = "src/ghp_1234567890abcdefghijklmnop.ts"
    const token = "github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    const changed = snapshot([{ path, status: "added" }])
    const result = await analyzeCcccComparison(
      snapshotReader(changed, {
        head: { [path]: `function canary() { return "${token}" }` },
      }),
      changed.comparisonID,
      {
        analyzeSources: async () => [
          fileReport("head", path, [functionReport("ghp_1234567890abcdefghijklmnop", 1, 1, 1)], 1),
        ],
      },
    )

    const output = JSON.stringify(result)
    expect(output).not.toContain("ghp_1234567890abcdefghijklmnop")
    expect(output).not.toContain(token)
    expect(output).not.toContain("return")
    expect(result.reports[0]?.path).toContain("<redacted>")
  })
})

describe("cccc WASM worker", () => {
  it("routes and reports functions for all 21 language adapters", async () => {
    expect(CCCC_LANGUAGES).toHaveLength(21)
    const files = await Promise.all(
      languageFixtures.map(async ([language, file]) => ({
        side: "head" as const,
        path: `fixture.${file.slice(file.lastIndexOf(".") + 1)}`,
        source: await readFile(`${fixtures}languages/${languageFixturePath(file)}`, "utf8"),
        language,
      })),
    )
    const reports = await createCcccWorkerAnalyzer()(files, {
      signal: new AbortController().signal,
      timeoutMs: 120_000,
    })

    expect(reports).toHaveLength(21)
    for (const file of files) {
      const report = reports.find((entry) => entry.path === file.path)
      expect(languageOf(file.path)).toBe(file.language)
      expect(report?.language).toBe(file.language)
      expect(report?.functions.length).toBeGreaterThan(0)
    }
  })

  it("retains parser recovery counts and locations but omits source text", async () => {
    const path = "src/broken.ts"
    const source = await readFile(`${fixtures}recovery/broken.txt`, "utf8")
    const changed = snapshot([{ path, status: "added" }])
    const result = await analyzeCcccComparison(
      snapshotReader(changed, { head: { [path]: source } }),
      changed.comparisonID,
    )

    expect(result.coverage.parseErrors).toBeGreaterThan(0)
    expect(result.coverage.parseErrorFiles).toBe(1)
    expect(result.reports[0]?.parseErrors.count).toBeGreaterThan(0)
    expect(JSON.stringify(result)).not.toContain("damaged")
  })

  it("keeps secret canaries out of the real WASM and worker result", async () => {
    const path = "src/canary.ts"
    const source = await readFile(`${fixtures}privacy/canary.ts`, "utf8")
    const changed = snapshot([{ path, status: "added" }])
    const result = await analyzeCcccComparison(
      snapshotReader(changed, { head: { [path]: source } }),
      changed.comparisonID,
    )
    const output = JSON.stringify(result)

    expect(output).not.toContain("ghp_AAAAAAAAAAAAAAAAAAAA")
    expect(output).not.toContain("github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ")
    expect(output).not.toContain("const token")
  })

  it("releases each worker after repeated WASM analyses", async () => {
    const worker = createCcccWorkerAnalyzer()
    const files = [
      {
        side: "head" as const,
        path: "src/sample.ts",
        source: "function sample(flag: boolean) { if (flag) return 1; return 0 }",
      },
    ]
    for (let index = 0; index < 3; index++) {
      const reports = await worker(files, {
        signal: new AbortController().signal,
        timeoutMs: 120_000,
      })
      expect(reports[0]?.functions[0]?.name).toBe("sample")
    }
  })

  it("terminates an active worker on cancellation", async () => {
    const controller = new AbortController()
    const pending = createCcccWorkerAnalyzer()(
      [
        {
          side: "head",
          path: "src/sample.ts",
          source: "function sample() { return 1 }",
        },
      ],
      { signal: controller.signal, timeoutMs: 120_000 },
    )
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: "cancelled" })
  })
})
