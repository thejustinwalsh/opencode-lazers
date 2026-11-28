import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import {
  DEFAULT_JSCPD_IGNORES,
  effectiveJscpdConfig,
} from "../src/code-review/providers/jscpd/configuration.ts"
import {
  JSCPD_DETECTOR_IDS,
  type ClonePair,
  type DetectorReport,
  type JscpdConfig,
  type JscpdDetector,
  type WasmScanRequest,
} from "../src/code-review/providers/jscpd/contract.ts"

const root = fileURLToPath(new URL("..", import.meta.url))
const cache = join(root, ".cache/jscpd-release-oracle")
const expectedBinarySha256 = "7cd6e9de57fad65fa8fae1a4db79ca09ebf8b140e31a8fecab4acc5104024ccf"
const defaultCLI = join(cache, "jscpd")

interface NativeFileLocation {
  name: string
  startLoc: { line: number }
  endLoc: { line: number }
}

interface NativeDuplicate {
  fragment: string
  format: string
  kind: string
  lines: number
  tokens: number
  firstFile: NativeFileLocation
  secondFile: NativeFileLocation
}

interface NativeReport {
  duplicates: NativeDuplicate[]
}

const reportPath = (path: string) => path.replaceAll("\\", "/")

function safeRelativePath(path: string): boolean {
  if (!path || path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.includes("\0")) return false
  const parts = path.replaceAll("\\", "/").split("/")
  return parts.every((part) => part !== "" && part !== "." && part !== "..")
}

async function spawn(command: string[], cwd: string): Promise<{ code: number; stdout: string }> {
  const child = Bun.spawn(command, {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { code, stdout }
}

let validatedCLI: Promise<string> | undefined

function releaseCLI(): Promise<string> {
  validatedCLI ??= (async () => {
    const cli = resolve(process.env.JSCPD_RELEASE_CLI ?? defaultCLI)
    let binary: Buffer
    try {
      binary = await readFile(cli)
    } catch {
      throw new Error(
        "Pinned jscpd 5.4.0 release oracle is missing; set JSCPD_RELEASE_CLI to the verified binary.",
      )
    }
    if (createHash("sha256").update(binary).digest("hex") !== expectedBinarySha256)
      throw new Error("Pinned jscpd 5.4.0 release oracle failed its SHA-256 check.")
    const version = await spawn([cli, "--version"], root)
    if (version.code !== 0 || version.stdout.trim() !== "jscpd 5.4.0")
      throw new Error("Pinned jscpd release oracle has an unexpected version.")
    return cli
  })()
  return validatedCLI
}

function nativeConfig(config: JscpdConfig) {
  return {
    mode: config.mode,
    ignoreCase: config.ignoreCase,
    ignoreIdentifiers: config.ignoreIdentifiers,
    ignoreLiterals: config.ignoreLiterals,
    ignoreAnnotations: config.ignoreAnnotations,
    ...(config.formats?.length ? { format: [...config.formats] } : {}),
    ...(config.formatsExts ? { formatsExts: config.formatsExts } : {}),
    ...(config.formatsNames ? { formatsNames: config.formatsNames } : {}),
    ignore: [...(config.ignore ?? [])],
    ignorePattern: [...(config.codeIgnorePatterns ?? [])],
    crossFormats: (config.crossFormats ?? []).map((group) => [...group]),
    ...(config.maxLines === undefined ? {} : { maxLines: config.maxLines }),
    ...(config.maxSize === undefined ? { maxSize: config.maxSize } : {}),
    ...(config.maxGapLines === undefined ? {} : { maxGapLines: config.maxGapLines }),
    ...(config.similarity === undefined ? {} : { similarity: config.similarity }),
    noGitignore: config.noGitignore,
    skipLocal: config.skipLocal,
    skipIsolated: (config.skipIsolated ?? []).map((group) => [...group]),
    ...(config.pattern === undefined ? {} : { pattern: config.pattern }),
  }
}

async function writeCapturedFile(rootPath: string, path: string, contents: string): Promise<void> {
  if (!safeRelativePath(path)) throw new Error("Release oracle input has an invalid relative path.")
  const target = resolve(rootPath, path)
  if (!target.startsWith(`${rootPath}${sep}`))
    throw new Error("Release oracle input escapes its isolated fixture root.")
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, contents)
}

function detectorOptions(detector: JscpdDetector, config: JscpdConfig): string[] {
  const mode =
    detector === "strict" || detector === "mild" || detector === "weak"
      ? detector
      : (config.mode ?? "mild")
  const options = ["--mode", mode]
  if (detector === "renamed") options.push("--ignore-identifiers", "--ignore-literals")
  if (detector === "gap") options.push("--max-gap-lines", String(config.maxGapLines ?? 3))
  else if (config.maxGapLines !== undefined)
    options.push("--max-gap-lines", String(config.maxGapLines))
  if (detector === "ast") options.push("--similarity", String(config.similarity ?? 0.85))
  else if (config.similarity !== undefined) options.push("--similarity", String(config.similarity))
  if (detector === "cross-language") options.push("--cross-formats", "js-ts")
  if (config.skipLocal) options.push("--skip-local")
  return options
}

function identity(fragment: string): string {
  const normalized = fragment.replace(/\s+/g, " ").trim()
  const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 12)
  return `jscpd:${digest}`
}

function location(value: NativeFileLocation, format: string) {
  const path = value.name.endsWith(`:${format}`)
    ? value.name.slice(0, -(format.length + 1))
    : value.name
  if (
    !safeRelativePath(path) ||
    !Number.isInteger(value.startLoc?.line) ||
    !Number.isInteger(value.endLoc?.line) ||
    value.startLoc.line < 1 ||
    value.endLoc.line < value.startLoc.line
  )
    throw new Error("Pinned release oracle returned an invalid clone location.")
  return {
    path: reportPath(path),
    startLine: value.startLoc.line,
    endLine: value.endLoc.line,
  }
}

function releaseKind(kind: string, detector: JscpdDetector): ClonePair["kind"] {
  if (detector === "gap" && (kind === "similar" || kind === "gap")) return "gap"
  if (detector === "ast" && (kind === "similar" || kind === "ast")) return "similar"
  if (kind === "exact" || kind === "renamed" || kind === "similar" || kind === "gap") return kind
  throw new Error("Pinned release oracle returned an unsupported clone kind.")
}

function clonePair(value: NativeDuplicate, detector: JscpdDetector): ClonePair {
  if (
    typeof value.fragment !== "string" ||
    typeof value.format !== "string" ||
    !Number.isInteger(value.lines) ||
    !Number.isInteger(value.tokens) ||
    value.lines < 0 ||
    value.tokens < 0
  )
    throw new Error("Pinned release oracle returned an invalid clone record.")
  return {
    fingerprint: identity(value.fragment),
    format: value.format,
    kind: releaseKind(value.kind, detector),
    lines: value.lines,
    tokens: value.tokens,
    first: location(value.firstFile, value.format),
    second: location(value.secondFile, value.format),
  }
}

function nativeReport(value: unknown, detector: JscpdDetector): DetectorReport {
  if (!value || typeof value !== "object" || !Array.isArray((value as NativeReport).duplicates))
    throw new Error("Pinned release oracle returned an invalid JSON report.")
  return {
    detector,
    clones: (value as NativeReport).duplicates.map((duplicate) => clonePair(duplicate, detector)),
  }
}

async function runDetector(
  cli: string,
  scan: WasmScanRequest,
  detector: JscpdDetector,
  fixtureRoot: string,
  configPath: string,
  reportRoot: string,
): Promise<DetectorReport> {
  const output = join(reportRoot, detector)
  const config = effectiveJscpdConfig(scan.config)
  const args = [
    "--reporters",
    "json",
    "--output",
    output,
    "--config",
    configPath,
    "--silent",
    "--no-colors",
    "--no-tips",
    "--exit-code",
    "0",
    "--min-tokens",
    String(scan.minTokens),
    "--min-lines",
    String(scan.minLines),
    "--ignore",
    DEFAULT_JSCPD_IGNORES.join(","),
    "--workers",
    "1",
    ...detectorOptions(detector, config),
    ".",
  ]
  const result = await spawn([cli, ...args], fixtureRoot)
  if (result.code !== 0)
    throw new Error(`Pinned jscpd release oracle failed for detector ${detector}.`)
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(join(output, "jscpd-report.json"), "utf8")) as unknown
  } catch {
    throw new Error(`Pinned jscpd release oracle omitted the ${detector} JSON report.`)
  }
  return nativeReport(parsed, detector)
}

/** Run the verified native 5.4.0 release CLI; its source-bearing reports are always discarded. */
export async function runJscpdReleaseOracle(scan: WasmScanRequest): Promise<DetectorReport[]> {
  const cli = await releaseCLI()
  const runRoot = await mkdtemp(join(cache, "parity-run-"))
  try {
    const fixtureRoot = join(runRoot, "source")
    const reportRoot = join(runRoot, "report")
    const configPath = join(runRoot, "captured-jscpd.json")
    await mkdir(fixtureRoot, { recursive: true })
    await mkdir(reportRoot, { recursive: true })
    for (const file of scan.files) await writeCapturedFile(fixtureRoot, file.path, file.source)
    for (const file of scan.ignoreFiles)
      await writeCapturedFile(fixtureRoot, file.path, file.contents)
    await writeFile(
      configPath,
      `${JSON.stringify(nativeConfig(effectiveJscpdConfig(scan.config)))}\n`,
    )

    const uniqueDetectors = [...new Set(scan.detectors)]
    if (uniqueDetectors.some((detector) => !JSCPD_DETECTOR_IDS.includes(detector)))
      throw new Error("Release oracle request names an unsupported detector.")
    const reports: DetectorReport[] = []
    for (const detector of uniqueDetectors)
      reports.push(await runDetector(cli, scan, detector, fixtureRoot, configPath, reportRoot))
    return reports
  } finally {
    await rm(runRoot, { recursive: true, force: true })
  }
}
