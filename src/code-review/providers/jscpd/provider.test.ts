import { expect, test } from "bun:test"
import { analyzeDuplicationComparison } from "./provider.ts"
import {
  DEFAULT_DUPLICATION_SETTINGS,
  JSCPD_TOOL,
  type ClonePair,
  type JscpdComparisonInput,
  type JscpdSideReport,
  type WasmScanRequest,
} from "./contract.ts"
import { DuplicationAnalysisError } from "./worker-client.ts"

function pair(first: ClonePair["first"], second: ClonePair["second"], tokens = 80): ClonePair {
  return {
    fingerprint: "jscpd:0123456789ab",
    format: "typescript",
    kind: "exact",
    tokens,
    lines: 10,
    first,
    second,
  }
}

const files = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    path: `src/file-${index}.ts`,
    source: `captured-side-${index}`,
  }))

function input(): JscpdComparisonInput {
  return {
    comparisonID: "comparison-opaque-1",
    base: { files: files(2), complete: true },
    head: { files: files(3), complete: true },
    changedLines: [{ path: "src/new.ts", startLine: 1, endLine: 15 }],
  }
}

function scanReport(
  scan: WasmScanRequest,
  side: "base" | "head",
  partial = false,
): JscpdSideReport {
  const oldA = { path: "src/a.ts", startLine: 1, endLine: 10 }
  const oldB = { path: "src/b.ts", startLine: 1, endLine: 10 }
  const newFile = { path: "src/new.ts", startLine: 1, endLine: 10 }
  return {
    detectors: scan.detectors.map((detector) => ({
      detector,
      clones:
        detector === "strict" || detector === "mild"
          ? side === "base"
            ? [pair(oldA, oldB)]
            : [pair(oldA, oldB), pair(oldA, newFile)]
          : [],
    })),
    coverage: {
      filesReceived: scan.files.length,
      filesScanned: scan.files.length - Number(partial),
      filesUnsupported: Number(partial),
      filesIgnored: 0,
    },
  }
}

test("comparison counts complete side inventories and merges detector findings without source text", async () => {
  const scans: WasmScanRequest[] = []
  const result = await analyzeDuplicationComparison(input(), {
    runSide: async (scan) => {
      scans.push(scan)
      return scanReport(scan, scans.length === 1 ? "base" : "head")
    },
  })

  expect(scans).toHaveLength(2)
  expect(scans[0]?.minTokens).toBe(50)
  expect(scans[0]?.minLines).toBe(5)
  expect(scans[0]?.detectors).toEqual([
    "strict",
    "mild",
    "weak",
    "renamed",
    "gap",
    "ast",
    "cross-language",
  ])
  expect(result.status).toBe("complete")
  expect(result.comparisonID).toBe("comparison-opaque-1")
  expect(result.tool).toEqual(JSCPD_TOOL)
  expect(result.coverage.base.filesReceived).toBe(2)
  expect(result.coverage.head.filesReceived).toBe(3)
  expect(result.findings).toHaveLength(1)
  expect(result.findings[0]).toMatchObject({
    detector: "strict",
    detectors: ["strict", "mild"],
    baseInstances: 2,
    introducedInstances: 1,
    severity: "info",
    provenance: "exact",
  })
  expect(JSON.stringify(result)).not.toContain("captured-side")
})

test("side-specific configuration is passed through and classified", async () => {
  const value = input()
  value.base.config = { ignore: ["generated/**"] }
  value.head.config = { ignore: ["generated/**", "vendor/**"] }
  const scans: WasmScanRequest[] = []
  const result = await analyzeDuplicationComparison(value, {
    runSide: async (scan) => {
      scans.push(scan)
      return scanReport(scan, scans.length === 1 ? "base" : "head")
    },
  })

  expect(scans[0]?.config.ignore).toEqual(["**/.git/**", "**/node_modules/**", "generated/**"])
  expect(scans[1]?.config.ignore).toEqual([
    "**/.git/**",
    "**/node_modules/**",
    "generated/**",
    "vendor/**",
  ])
  expect(result.coverage.configurationChanged).toBe(true)
  expect(result.findings[0]?.configurationChanged).toBe(true)
})

test("unsupported source and incomplete inventories remain partial while retaining known findings", async () => {
  const value = input()
  value.base.complete = false
  const result = await analyzeDuplicationComparison(value, {
    runSide: async (scan) => scanReport(scan, scan.files.length === 2 ? "base" : "head", true),
  })

  expect(result.status).toBe("partial")
  expect(result.coverage.base.complete).toBe(false)
  expect(result.coverage.base.filesUnsupported).toBe(1)
  expect(result.findings).toHaveLength(1)
})

test("an analyzer failure is unavailable and never returns the failing error text", async () => {
  let calls = 0
  const result = await analyzeDuplicationComparison(input(), {
    runSide: async (scan) => {
      calls++
      if (calls === 2) throw new Error("private duplicated source")
      return scanReport(scan, "base")
    },
  })

  expect(result.status).toBe("unavailable")
  expect(result.comparisonID).toBe("comparison-opaque-1")
  expect(result.tool).toEqual(JSCPD_TOOL)
  expect(result.findings).toEqual([])
  expect("failure" in result ? result.failure : undefined).toEqual({
    code: "analyzer-unavailable",
    side: "head",
  })
  expect(JSON.stringify(result)).not.toContain("private duplicated source")
  expect(result.coverage.base.complete).toBe(true)
  expect(result.coverage.head.complete).toBe(false)
})

test("disabled detectors are visible as disabled and make no worker calls", async () => {
  const off = {
    strict: false,
    mild: false,
    weak: false,
    renamed: false,
    gap: false,
    ast: false,
    crossLanguage: false,
  }
  let calls = 0
  const result = await analyzeDuplicationComparison(input(), {
    settings: { ...DEFAULT_DUPLICATION_SETTINGS, detectors: off },
    runSide: async () => {
      calls++
      throw new DuplicationAnalysisError("worker-failed")
    },
  })

  expect(calls).toBe(0)
  expect(result.status).toBe("disabled")
  expect(result.coverage.requestedDetectors).toEqual([])
  expect(result.comparisonID).toBe("comparison-opaque-1")
  expect(result.tool).toEqual(JSCPD_TOOL)
  expect(result.findings).toEqual([])
})

test("invalid paths and config-shaped aborts do not reveal source content", async () => {
  const invalid = input()
  invalid.head.files[0]!.path = "../outside.ts"
  await expect(
    analyzeDuplicationComparison(invalid, {
      runSide: async () =>
        scanReport({ detectors: [], files: [], minLines: 5, minTokens: 50, config: {} }, "head"),
    }),
  ).rejects.toMatchObject({ code: "invalid-request" })

  const controller = new AbortController()
  controller.abort(new Error("private source"))
  await expect(
    analyzeDuplicationComparison(input(), { signal: controller.signal }),
  ).rejects.toMatchObject({ name: "AbortError" })
})

test("comparison identity remains attached when older analysis finishes after newer analysis", async () => {
  let releaseOlder: (() => void) | undefined
  let olderSideCalls = 0
  const olderInput = input()
  olderInput.comparisonID = "comparison-older"
  const older = analyzeDuplicationComparison(olderInput, {
    runSide: async (scan) => {
      const side = olderSideCalls++ === 0 ? "base" : "head"
      if (side === "base")
        await new Promise<void>((resolve) => {
          releaseOlder = resolve
        })
      return scanReport(scan, side)
    },
  })
  await Promise.resolve()
  const newerInput = input()
  newerInput.comparisonID = "comparison-newer"
  const newer = await analyzeDuplicationComparison(newerInput, {
    runSide: async (scan) => scanReport(scan, scan.files.length === 2 ? "base" : "head"),
  })

  releaseOlder?.()
  const olderResult = await older
  expect(newer.comparisonID).toBe("comparison-newer")
  expect(olderResult.comparisonID).toBe("comparison-older")
})

test("empty comparison identities are rejected", async () => {
  const value = input()
  value.comparisonID = "  "
  await expect(analyzeDuplicationComparison(value)).rejects.toMatchObject({
    code: "invalid-request",
  })
})
