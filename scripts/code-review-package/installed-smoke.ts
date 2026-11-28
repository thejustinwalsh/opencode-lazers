import { fileURLToPath } from "node:url"
import { analyzeCcccComparison, CCCC_TOOL, CCCC_VERSION } from "opencode-lazers/code-review/cccc"
import {
  GITLEAKS_TOOL,
  GITLEAKS_VERSION,
  scanGitleaksComparison,
} from "opencode-lazers/code-review/gitleaks"
import { analyzeDuplicationComparison, JSCPD_TOOL } from "opencode-lazers/code-review/jscpd"
import {
  createStructuralDiffService,
  DIFFTASTIC_VERSION,
} from "opencode-lazers/code-review/structural"

export const installedSmokePath = fileURLToPath(import.meta.url)

function requireAnalysis(condition: unknown, producer: string): asserts condition {
  if (!condition) throw new Error(`Installed ${producer} analysis failed`)
}

async function checkStructural(): Promise<void> {
  const result = await createStructuralDiffService().compare({
    identity: { comparisonID: "installed-structural", sourceID: "fixture-v1" },
    request: {
      path: "src/value.ts",
      base: "export const value = 1\n",
      head: "export const value = 2\n",
    },
  })
  requireAnalysis(DIFFTASTIC_VERSION === "0.71.0", "structural")
  requireAnalysis(result !== undefined, "structural")
  requireAnalysis(result.diff.engineVersion === DIFFTASTIC_VERSION, "structural")
  requireAnalysis(result.diff.engine === "difftastic", "structural")
  requireAnalysis(result.diff.status === "changed", "structural")
  requireAnalysis(result.diff.degraded === undefined, "structural")
}

async function checkCccc(): Promise<void> {
  const base = [
    "interface Order { total: number; country: string; express: boolean }",
    "function shippingCost(order: Order): number {",
    "  if (order.total >= 100) return 0",
    "  return order.express ? 12 : 5",
    "}",
    "",
  ].join("\n")
  const head = [
    "interface Order { total: number; country: string; express: boolean }",
    "function shippingCost(order: Order): number {",
    "  if (order.total >= 100 && !order.express) return 0",
    "  let cost = 5",
    '  if (order.country === "NL" || order.country === "BE") {',
    "    cost = order.total > 10 ? 9 : 5",
    '  } else if (order.country === "US") {',
    "    if (order.total > 20) cost = 40",
    "    else if (order.total > 5) cost = 25",
    "    else cost = 15",
    "  } else {",
    "    for (const limit of [1, 5, 10, 20]) {",
    "      if (order.total > limit) cost += 6",
    "    }",
    "  }",
    "  if (order.express) {",
    '    cost = order.country === "NL" ? cost + 7 : cost * 2',
    "  }",
    "  return cost",
    "}",
    "",
  ].join("\n")
  const comparisonID = "installed-cccc"
  const path = "src/shipping.ts"
  const result = await analyzeCcccComparison(
    {
      readComparison: async () => ({
        comparisonID,
        baseRevision: "base",
        headRevision: "head",
        changedFiles: [{ path, status: "modified", changedLines: [3, 4, 5, 6, 7, 8, 9, 10] }],
      }),
      readSource: async (_id, side) => (side === "base" ? base : head),
    },
    comparisonID,
    {
      settings: {
        timeoutMs: 120_000,
        complexity: { cyclomatic: 50, cognitive: 30, primaryDelta: 0 },
      },
    },
  )
  requireAnalysis(result.tool.name === CCCC_TOOL, "cccc")
  requireAnalysis(result.tool.version === CCCC_VERSION && CCCC_VERSION === "1.7.0", "cccc")
  requireAnalysis(result.status === "complete", "cccc")
  requireAnalysis(
    result.reports.some((report) => report.side === "head" && report.cyclomatic > 0),
    "cccc",
  )
  requireAnalysis(result.summary.functionsIncreased > 0, "cccc")
}

function duplicationSource(): string {
  const slots = Array.from(
    { length: 14 },
    (_, index) => `  const slot${index} = values[${index}] ?? ${index}`,
  )
  const values = Array.from({ length: 14 }, (_, index) => `slot${index}`).join(", ")
  return [
    "export function measure(values: number[]): number {",
    "  const scaled = values.map((item) => item * 2 + 1)",
    "  const selected = scaled.filter((item) => item >= 0)",
    ...slots,
    "  const total = selected.reduce((sum, item) => sum + item, 0)",
    `  return total + ${values}`,
    "}",
    "",
  ].join("\n")
}

async function checkJscpd(): Promise<void> {
  const source = duplicationSource()
  const copies = [
    { path: "src/existing-a.ts", format: "typescript", source },
    { path: "src/existing-b.ts", format: "typescript", source },
  ]
  const added = { path: "src/added-copy.ts", format: "typescript", source }
  const result = await analyzeDuplicationComparison({
    comparisonID: "installed-jscpd",
    base: { files: copies, complete: true, ignoreFiles: [], ignoreFilesComplete: true },
    head: {
      files: [...copies, added],
      complete: true,
      ignoreFiles: [],
      ignoreFilesComplete: true,
    },
    changedLines: [{ path: added.path, startLine: 1, endLine: source.split("\n").length }],
  })
  requireAnalysis(result.tool.name === JSCPD_TOOL.name, "jscpd")
  requireAnalysis(
    result.tool.version === JSCPD_TOOL.version && JSCPD_TOOL.version === "5.4.0",
    "jscpd",
  )
  requireAnalysis(result.status === "complete", "jscpd")
  requireAnalysis(result.findings.length > 0, "jscpd")
  requireAnalysis(!JSON.stringify(result).includes(source), "jscpd")
}

async function checkGitleaks(): Promise<void> {
  const secret = ["AKIA", "QYLPMN5H", "HHFPZAM2"].join("")
  const sources = {
    "src/config.ts": `export const region = "eu";\nconst key = "${secret}";\n`,
  }
  const result = await scanGitleaksComparison({
    comparisonID: "installed-gitleaks",
    baseRevision: "base",
    headRevision: "head",
    changedFiles: [{ path: "src/config.ts", status: "modified" }],
    changedLines: {
      status: "complete",
      ranges: [{ path: "src/config.ts", ranges: [{ startLine: 2, endLine: 2 }] }],
    },
    read: async (side, path) => {
      if (path !== "src/config.ts") return { status: "absent" }
      return {
        status: "present",
        content: side === "base" ? 'export const region = "eu";\n' : sources[path],
      }
    },
  })
  requireAnalysis(result.tool.id === GITLEAKS_TOOL, "gitleaks")
  requireAnalysis(
    result.tool.version === GITLEAKS_VERSION && GITLEAKS_VERSION === "8.30.1",
    "gitleaks",
  )
  requireAnalysis(result.status === "complete", "gitleaks")
  requireAnalysis(
    result.findings.some((finding) => finding.kind === "secret.introduced"),
    "gitleaks",
  )
  requireAnalysis(!JSON.stringify(result).includes(secret), "gitleaks")
  requireAnalysis(!JSON.stringify(result).includes("const key"), "gitleaks")
}

export async function runInstalledSmoke(): Promise<void> {
  await checkStructural()
  await checkCccc()
  await checkJscpd()
  await checkGitleaks()
}
