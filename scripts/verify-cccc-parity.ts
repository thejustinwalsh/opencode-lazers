import { deepStrictEqual, ok, strictEqual } from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { basename, dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import type {
  CcccComparisonSnapshot,
  CcccFileReport,
  CcccFunctionReport,
  CcccProviderResult,
  CcccSide,
  CcccSnapshotReader,
} from "../src/code-review/providers/cccc/types.ts"

const root = fileURLToPath(new URL("..", import.meta.url))
const vendorRoot = join(root, "vendor/cccc")
const fixtureRoot = join(root, "test/code-review/cccc-fixtures")
const nativeTarget = join(root, ".cache/cccc-native-target")
const nativeCli = join(nativeTarget, "release/cccc")
const nativeFixtureFiles = [
  "languages/sample.ts",
  "languages/sample.js.txt",
  "languages/sample.rs",
  "languages/sample.go",
  "languages/sample.php",
  "languages/sample.rb",
  "languages/sample.scm",
  "languages/sample.rkt",
  "languages/sample.lisp",
  "languages/sample.el",
  "languages/sample.clj",
  "languages/sample.kt",
  "languages/sample.py",
  "languages/sample.zig",
  "languages/sample.c",
  "languages/sample.cpp",
  "languages/sample.pl",
  "languages/sample.swift",
  "languages/sample.java",
  "languages/sample.dart",
  "languages/sample.scala",
  "complexity-increased/base/src/shipping.ts.txt",
  "complexity-increased/head/src/shipping.ts.txt",
  "rust-trait-impl/base/src/lib.rs",
  "rust-trait-impl/head/src/lib.rs",
] as const

const expectedLanguages = new Map([
  ["sample.ts", "typescript"],
  ["sample.js", "javascript"],
  ["sample.rs", "rust"],
  ["sample.go", "go"],
  ["sample.php", "php"],
  ["sample.rb", "ruby"],
  ["sample.scm", "scheme"],
  ["sample.rkt", "racket"],
  ["sample.lisp", "commonlisp"],
  ["sample.el", "emacslisp"],
  ["sample.clj", "clojure"],
  ["sample.kt", "kotlin"],
  ["sample.py", "python"],
  ["sample.zig", "zig"],
  ["sample.c", "c"],
  ["sample.cpp", "cpp"],
  ["sample.pl", "perl"],
  ["sample.swift", "swift"],
  ["sample.java", "java"],
  ["sample.dart", "dart"],
  ["sample.scala", "scala"],
])

async function run(
  command: string[],
  cwd = root,
  env: Record<string, string> = {},
): Promise<string> {
  const child = Bun.spawn(command, {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (status !== 0) throw new Error(`${command.join(" ")} exited ${status}: ${stderr.slice(-4000)}`)
  return stdout.trim()
}

async function buildNativeOracle(): Promise<void> {
  await run(
    ["cargo", "build", "--locked", "--release", "-p", "cccc-cli", "--bin", "cccc"],
    vendorRoot,
    { CARGO_TARGET_DIR: nativeTarget },
  )
}

async function materializeNativeFixture(fixture: string): Promise<string> {
  if (!fixture.endsWith(".txt")) return join(fixtureRoot, fixture)
  const nativePath = join(nativeTarget, "fixtures", fixture.slice(0, -".txt".length))
  await mkdir(dirname(nativePath), { recursive: true })
  await writeFile(nativePath, await readFile(join(fixtureRoot, fixture)))
  return nativePath
}

function fixtureName(fixture: string): string {
  return basename(fixture).replace(/\.txt$/, "")
}

interface NormalizedFunction {
  name: string
  kind: string
  line: number
  cognitive: number
  cyclomatic: number
  children: NormalizedFunction[]
}

function normalizeFunction(fn: CcccFunctionReport): NormalizedFunction {
  return {
    name: fn.name,
    kind: fn.kind,
    line: fn.line,
    cognitive: fn.cognitive,
    cyclomatic: fn.cyclomatic,
    children: (fn.children ?? []).map(normalizeFunction),
  }
}

function normalizeReport(report: {
  cognitive: number
  cyclomatic: number
  functions: CcccFunctionReport[]
  parse_errors?: string[]
  parseErrors?: { count: number; lines: number[] }
}) {
  return {
    cognitive: report.cognitive,
    cyclomatic: report.cyclomatic,
    functions: report.functions.map(normalizeFunction),
    parseErrorCount: parseErrorCount(report),
  }
}

function parseErrorCount(report: {
  parse_errors?: string[]
  parseErrors?: { count: number; lines: number[] }
}): number {
  if (report.parseErrors) return report.parseErrors.count
  return report.parse_errors?.length ?? 0
}

function readerFor(
  snapshot: CcccComparisonSnapshot,
  sources: Partial<Record<CcccSide, Record<string, string>>>,
): CcccSnapshotReader {
  return {
    readComparison: async () => snapshot,
    readSource: async (_id, side, path) => sources[side]?.[path],
  }
}

async function providerReport(
  api: {
    analyzeCcccComparison: typeof import("../src/code-review/providers/cccc/provider.ts").analyzeCcccComparison
  },
  snapshot: CcccComparisonSnapshot,
  sources: Partial<Record<CcccSide, Record<string, string>>>,
): Promise<CcccProviderResult> {
  return api.analyzeCcccComparison(readerFor(snapshot, sources), snapshot.comparisonID)
}

async function analyzeOainkFixture(
  api: Parameters<typeof providerReport>[0],
  caseName: "complexity-increased" | "rust-trait-impl",
  path: string,
  baseFixture: string,
  headFixture: string,
  changedLines: number[],
): Promise<{ base: CcccFileReport; head: CcccFileReport }> {
  const base = await readFile(join(fixtureRoot, baseFixture), "utf8")
  const head = await readFile(join(fixtureRoot, headFixture), "utf8")
  const snapshot: CcccComparisonSnapshot = {
    comparisonID: `parity-${caseName}`,
    baseRevision: "fixture-base",
    headRevision: "fixture-head",
    changedFiles: [{ path, status: "modified", changedLines }],
  }
  const result = await providerReport(api, snapshot, {
    base: { [path]: base },
    head: { [path]: head },
  })
  ok(result.status !== "failed", `${caseName} provider failed: ${result.failure?.code}`)
  const baseReport = result.reports.find((report) => report.side === "base")
  const headReport = result.reports.find((report) => report.side === "head")
  ok(baseReport, `${caseName} base report missing`)
  ok(headReport, `${caseName} head report missing`)
  return { base: baseReport, head: headReport }
}

const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
  exports: Record<string, string | { types: string; default: string }>
}
const apiExport = manifest.exports["./code-review/cccc"]
ok(apiExport && typeof apiExport === "object", "public cccc package export is missing")
strictEqual(apiExport.types, "./src/code-review/providers/cccc/index.ts")
strictEqual(
  apiExport.default,
  "./dist/code-review-cccc.js",
  "package runtime export target changed",
)
const api = (await import("opencode-lazers/code-review/cccc")) as Parameters<
  typeof providerReport
>[0]

await buildNativeOracle()
const nativeInputs = new Map<string, string>()
for (const fixture of nativeFixtureFiles)
  nativeInputs.set(fixture, await materializeNativeFixture(fixture))
const nativePaths = nativeFixtureFiles.map((fixture) => relative(root, nativeInputs.get(fixture)!))
const nativeOutput = JSON.parse(
  await run([nativeCli, "--no-config", "--no-ignore", "--no-cache", "--", ...nativePaths]),
) as { files: Array<{ path: string } & ReturnType<typeof normalizeReport>> }
const nativeReports = new Map(nativeOutput.files.map((report) => [report.path, report]))
strictEqual(nativeReports.size, nativeFixtureFiles.length, "native cccc omitted fixture reports")

const languageSources: Record<string, string> = {}
const changedFiles = []
for (const fixture of nativeFixtureFiles.slice(0, 21)) {
  const path = `src/${fixtureName(fixture)}`
  languageSources[path] = await readFile(join(fixtureRoot, fixture), "utf8")
  changedFiles.push({ path, status: "added" as const })
}
const languagesSnapshot: CcccComparisonSnapshot = {
  comparisonID: "parity-all-languages",
  baseRevision: "fixture-base",
  headRevision: "fixture-head",
  changedFiles,
}
const languageResult = await providerReport(api, languagesSnapshot, {
  head: languageSources,
})
ok(languageResult.status !== "failed", `packaged API failed: ${languageResult.failure?.code}`)
strictEqual(languageResult.reports.length, 21, "WASM did not report all 21 language inputs")

for (const fixture of nativeFixtureFiles.slice(0, 21)) {
  const path = `src/${fixtureName(fixture)}`
  const nativePath = relative(root, nativeInputs.get(fixture)!)
  const native = nativeReports.get(nativePath)
  const wasm = languageResult.reports.find((report) => report.path === path)
  ok(native, `native fixture report missing: ${fixture}`)
  ok(wasm, `WASM fixture report missing: ${fixture}`)
  const expectedLanguage = expectedLanguages.get(fixtureName(fixture))
  ok(expectedLanguage, `language fixture classification missing: ${fixture}`)
  strictEqual(wasm.language, expectedLanguage, fixture)
  ok(wasm.functions.length > 0, `language adapter emitted no functions: ${fixture}`)
  deepStrictEqual(
    normalizeReport(wasm),
    normalizeReport(native),
    `native/WASM mismatch: ${fixture}`,
  )
}

const shipping = await analyzeOainkFixture(
  api,
  "complexity-increased",
  "src/shipping.ts",
  "complexity-increased/base/src/shipping.ts.txt",
  "complexity-increased/head/src/shipping.ts.txt",
  Array.from({ length: 22 }, (_, index) => index + 9),
)
const nativeShippingBase = nativeReports.get(
  relative(root, nativeInputs.get("complexity-increased/base/src/shipping.ts.txt")!),
)
const nativeShippingHead = nativeReports.get(
  relative(root, nativeInputs.get("complexity-increased/head/src/shipping.ts.txt")!),
)
ok(nativeShippingBase && nativeShippingHead, "native shipping fixture reports missing")
deepStrictEqual(normalizeReport(shipping.base), normalizeReport(nativeShippingBase))
deepStrictEqual(normalizeReport(shipping.head), normalizeReport(nativeShippingHead))
strictEqual(shipping.base.cognitive, 2)
strictEqual(shipping.base.cyclomatic, 3)
strictEqual(shipping.head.cognitive, 20)
strictEqual(shipping.head.cyclomatic, 13)

const rust = await analyzeOainkFixture(
  api,
  "rust-trait-impl",
  "src/lib.rs",
  "rust-trait-impl/base/src/lib.rs",
  "rust-trait-impl/head/src/lib.rs",
  [12, 13, 14, 15, 16, 17],
)
const nativeRustBase = nativeReports.get(
  relative(root, join(fixtureRoot, "rust-trait-impl/base/src/lib.rs")),
)
const nativeRustHead = nativeReports.get(
  relative(root, join(fixtureRoot, "rust-trait-impl/head/src/lib.rs")),
)
ok(nativeRustBase && nativeRustHead, "native Rust fixture reports missing")
deepStrictEqual(normalizeReport(rust.base), normalizeReport(nativeRustBase))
deepStrictEqual(normalizeReport(rust.head), normalizeReport(nativeRustHead))
strictEqual(rust.base.cognitive, 0)
strictEqual(rust.base.cyclomatic, 1)
strictEqual(rust.head.cognitive, 1)
strictEqual(rust.head.cyclomatic, 2)

console.log(
  `cccc native/WASM parity passed: ${languageResult.reports.length} language adapters and 2 comparison fixtures`,
)
