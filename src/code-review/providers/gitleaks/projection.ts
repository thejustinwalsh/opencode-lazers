import {
  GITLEAKS_VERSION,
  type GitleaksAllowlistChange,
  type GitleaksIntroducedFinding,
  type GitleaksLineRange,
  type GitleaksResult,
  type GitleaksResultIdentity,
  type GitleaksUnclassifiedFinding,
} from "./contract.ts"
import { safePath } from "./snapshot-input.ts"
import type { GitleaksWasmFinding, GitleaksWasmResult, GitleaksWasmSide } from "./wasm-contract.ts"

const ALLOW_MARKER = "gitleaks:allow"
const CODE = (text: string, limit = 90) => {
  const plain = text.replaceAll("`", "'")
  return `\`${plain.length > limit ? `${plain.slice(0, limit - 1)}…` : plain}\``
}

function clip(summary: string): string {
  if (summary.length <= 200) return summary
  const cut = summary.slice(0, 199)
  return (cut.split("`").length - 1) % 2 === 1 ? `${cut.slice(0, 198)}…\`` : `${cut}…`
}

function firstChangedLine(
  changes: Record<string, GitleaksLineRange[]>,
  path: string,
  start: number,
  end: number,
): number {
  for (const range of changes[path] ?? []) {
    if (start <= range.endLine && range.startLine <= end) return Math.max(start, range.startLine)
  }
  return start
}

function location(
  path: string,
  startLine: number,
  startCol: number,
  endLine: number,
  endCol: number,
  prLine = startLine,
) {
  return {
    side: "head" as const,
    path,
    range: { startLine, startCol, endLine, endCol },
    prPosition: { path, line: prLine, side: "RIGHT" as const },
  }
}

function introducedFinding(
  raw: GitleaksWasmFinding,
  changes: Record<string, GitleaksLineRange[]>,
  head: GitleaksWasmSide,
): GitleaksIntroducedFinding {
  const { location: source } = raw
  const sourcePath = head.files[raw.fileIndex]?.path ?? source.path
  const position = firstChangedLine(changes, sourcePath, source.startLine, source.endLine)
  return {
    kind: "secret.introduced",
    severity: "error",
    provenance: "heuristic",
    location: location(
      source.path,
      source.startLine,
      source.startCol,
      source.endLine,
      Math.max(source.endCol, source.startCol + 1),
      position,
    ),
    rule: raw.rule,
    description: raw.description,
    masked: raw.masked,
    fingerprint: raw.fingerprint,
    ...(raw.entropy === undefined ? {} : { entropy: raw.entropy }),
    summary: clip(
      `secret potentially leaked: ${CODE(raw.rule)} ${CODE(raw.masked)} at ${CODE(`${source.path}:${source.startLine}`)}`,
    ),
    evidence: `Gitleaks ${GITLEAKS_VERSION} detector; rule ${raw.rule}`,
  }
}

function unclassifiedFinding(
  raw: GitleaksWasmResult["unclassified"][number],
): GitleaksUnclassifiedFinding {
  const { location: source } = raw
  return {
    kind: "secret.unclassified",
    location: location(
      source.path,
      source.startLine,
      source.startCol,
      source.endLine,
      Math.max(source.endCol, source.startCol + 1),
    ),
    rule: raw.rule,
    description: raw.description,
    masked: raw.masked,
    fingerprint: raw.fingerprint,
    ...(raw.entropy === undefined ? {} : { entropy: raw.entropy }),
    reason: "incomplete-snapshot",
  }
}

function sourceLine(
  side: GitleaksWasmSide,
  path: string,
  line: number,
  fileIndex?: number,
): string {
  const content =
    fileIndex !== undefined
      ? (side.files[fileIndex]?.content ?? "")
      : path === ".gitleaks.toml"
        ? side.config
        : path === ".gitleaksignore"
          ? side.ignore
          : (side.files.find((file) => file.path === path)?.content ?? "")
  return (content.split("\n")[line - 1] ?? "").replace(/\r$/, "")
}

function inlineFinding(
  raw: GitleaksWasmResult["inline"][number],
  side: GitleaksWasmSide,
): GitleaksResult["inlineAllow"][number] {
  const matches = raw.matches.map(({ rule, masked, fingerprint }) => ({
    rule,
    masked,
    fingerprint,
  }))
  const line = sourceLine(side, raw.path, raw.line, raw.fileIndex)
  const shown = matches[0]
  return {
    kind: "secret.allow.inline",
    location: location(raw.path, raw.line, 0, raw.line, Math.max(line.length, 1)),
    matches,
    leftOut: raw.exact ? matches.length : null,
    exact: raw.exact,
    severity: shown ? "error" : raw.exact ? "info" : "unknown",
    provenance: shown ? "heuristic" : raw.exact ? "exact" : "heuristic",
    summary: clip(
      shown
        ? `secret potentially leaked, left out by a ${ALLOW_MARKER} comment: ${CODE(shown.rule)} ${CODE(shown.masked)} at ${CODE(`${raw.path}:${raw.line}`)}${matches.length > 1 ? ` and ${matches.length - 1} more` : ""}`
        : `${ALLOW_MARKER} comment at ${CODE(`${raw.path}:${raw.line}`)}`,
    ),
    evidence: shown
      ? `Gitleaks ${GITLEAKS_VERSION}; rule ${shown.rule}; comment written over in a copy`
      : `${ALLOW_MARKER} in the added line`,
  }
}

function allowlistFinding(
  raw: NonNullable<GitleaksWasmResult["allowlist"]>,
  changes: Record<string, GitleaksLineRange[]>,
  head: GitleaksWasmSide,
): GitleaksAllowlistChange {
  const files = raw.files.map(({ path, change }) => ({ path, change }))
  const first = files[0]!
  return {
    kind: "secret.allowlist.changed",
    location: allowlistLocation(first, changes, head),
    files,
    added: raw.added,
    totalAdded: raw.total,
    leftOut: raw.leftOut,
    exact: raw.exact,
    severity: raw.exact ? (raw.leftOut > 0 ? "error" : "warning") : "unknown",
    summary: allowlistSummary(raw, files),
    evidence: `Gitleaks ${GITLEAKS_VERSION}; allow list comparison`,
  }
}

function allowlistLocation(
  first: GitleaksAllowlistChange["files"][number],
  changes: Record<string, GitleaksLineRange[]>,
  head: GitleaksWasmSide,
): GitleaksAllowlistChange["location"] {
  const range = allowlistRange(first, changes, head)
  return {
    side: first.change === "removed" ? "base" : "head",
    path: first.path,
    ...(range ? { range } : {}),
    prPosition: range
      ? { path: first.path, line: range.startLine, side: "RIGHT" }
      : { path: first.path, file: true },
  }
}

function allowlistRange(
  first: GitleaksAllowlistChange["files"][number],
  changes: Record<string, GitleaksLineRange[]>,
  head: GitleaksWasmSide,
): GitleaksAllowlistChange["location"]["range"] {
  if (first.change === "removed") return undefined
  const change = changes[first.path]?.[0]
  if (!change) return undefined
  const text = sourceLine(head, first.path, change.endLine)
  return {
    startLine: change.startLine,
    startCol: 0,
    endLine: change.endLine,
    endCol: Math.max(text.length, 1),
  }
}

function allowlistSummary(
  raw: NonNullable<GitleaksWasmResult["allowlist"]>,
  files: GitleaksAllowlistChange["files"],
): string {
  const fileSummary = files.map((file) => `${CODE(file.path)} (${file.change})`).join(", ")
  const additions =
    raw.added.length === 0
      ? ""
      : `: ${raw.added
          .slice(0, 3)
          .map((item) => CODE(item, 60))
          .join(", ")}${raw.total > 3 ? ` and ${raw.total - 3} more` : ""}`
  const plural = raw.leftOut === 1 ? "match" : "matches"
  return clip(
    `Gitleaks allow list changed in ${fileSummary}${additions}; ${raw.leftOut} introduced ${plural} left out by the allow list of head`,
  )
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}

function safeMasked(value: unknown): value is string {
  return typeof value === "string" && value.includes("*")
}

function validFindingMetadata(value: Record<string, unknown>): boolean {
  return (
    typeof value.rule === "string" &&
    typeof value.description === "string" &&
    nonnegativeInteger(value.fileIndex) &&
    typeof value.fingerprint === "string" &&
    /^[0-9a-f]{32}$/.test(value.fingerprint) &&
    safeMasked(value.masked) &&
    (value.entropy === undefined ||
      (typeof value.entropy === "number" && Number.isFinite(value.entropy)))
  )
}

function validFindingLocation(source: Record<string, unknown>): boolean {
  return (
    typeof source.path === "string" &&
    safePath(source.path) &&
    positiveInteger(source.startLine) &&
    nonnegativeInteger(source.startCol) &&
    positiveInteger(source.endLine) &&
    nonnegativeInteger(source.endCol) &&
    (Number(source.endLine) > Number(source.startLine) ||
      Number(source.endCol) >= Number(source.startCol))
  )
}

function wasmFinding(value: unknown, fileCount: number): value is GitleaksWasmFinding {
  return (
    record(value) &&
    record(value.location) &&
    validFindingMetadata(value) &&
    Number(value.fileIndex) < fileCount &&
    validFindingLocation(value.location)
  )
}

function validInline(value: unknown, fileCount: number): boolean {
  return (
    record(value) &&
    typeof value.path === "string" &&
    safePath(value.path) &&
    nonnegativeInteger(value.fileIndex) &&
    Number(value.fileIndex) < fileCount &&
    positiveInteger(value.line) &&
    typeof value.exact === "boolean" &&
    Array.isArray(value.matches) &&
    value.matches.every(
      (match) =>
        record(match) &&
        typeof match.rule === "string" &&
        safeMasked(match.masked) &&
        typeof match.fingerprint === "string" &&
        /^[0-9a-f]{32}$/.test(match.fingerprint),
    )
  )
}

function validAllowlist(value: unknown): boolean {
  return (
    record(value) &&
    Array.isArray(value.files) &&
    value.files.length > 0 &&
    value.files.every(
      (file) =>
        record(file) &&
        typeof file.path === "string" &&
        safePath(file.path) &&
        ["added", "modified", "removed"].includes(String(file.change)),
    ) &&
    Array.isArray(value.added) &&
    value.added.every((item) => typeof item === "string") &&
    nonnegativeInteger(value.total) &&
    nonnegativeInteger(value.leftOut) &&
    typeof value.exact === "boolean"
  )
}

function validWasmIdentity(value: Record<string, unknown>, expected: GitleaksResultIdentity) {
  return (
    sanitizedIdentity(value.comparisonID, expected.comparisonID) &&
    sanitizedIdentity(value.baseRevision, expected.baseRevision) &&
    sanitizedIdentity(value.headRevision, expected.headRevision)
  )
}

function sanitizedIdentity(value: unknown, expected: string): boolean {
  if (value === expected) return true
  if (typeof value !== "string" || !value.includes("[redacted]")) return false
  const parts = value.split("[redacted]")
  if (!expected.startsWith(parts[0]!)) return false
  let cursor = parts[0]!.length
  for (let index = 1; index < parts.length; index++) {
    const part = parts[index]!
    if (index === parts.length - 1) {
      return expected.endsWith(part) && expected.length - part.length >= cursor
    }
    const next = expected.indexOf(part, cursor)
    if (next < cursor) return false
    cursor = next + part.length
  }
  return false
}

function validScannedFiles(value: unknown, baseFileCount: number, headFileCount: number): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (file) =>
        record(file) &&
        (file.side === "base" || file.side === "head") &&
        nonnegativeInteger(file.index) &&
        Number(file.index) < (file.side === "base" ? baseFileCount : headFileCount) &&
        typeof file.path === "string" &&
        safePath(file.path),
    )
  )
}

function validIntroduced(value: Record<string, unknown>, fileCount: number): boolean {
  return (
    Array.isArray(value.introduced) &&
    value.introduced.every((item) => wasmFinding(item, fileCount))
  )
}

function validUnclassified(value: Record<string, unknown>, fileCount: number): boolean {
  return (
    Array.isArray(value.unclassified) &&
    value.unclassified.every(
      (item) =>
        wasmFinding(item, fileCount) && record(item) && item.reason === "incomplete-snapshot",
    )
  )
}

function validInlineFindings(value: Record<string, unknown>, fileCount: number): boolean {
  return Array.isArray(value.inline) && value.inline.every((item) => validInline(item, fileCount))
}

function validWasmResult(
  value: unknown,
  expected: GitleaksResultIdentity,
  sides: { base: GitleaksWasmSide; head: GitleaksWasmSide },
): value is GitleaksWasmResult {
  return (
    record(value) &&
    validWasmIdentity(value, expected) &&
    validScannedFiles(value.scannedFiles, sides.base.files.length, sides.head.files.length) &&
    validIntroduced(value, sides.head.files.length) &&
    validUnclassified(value, sides.head.files.length) &&
    validInlineFindings(value, sides.head.files.length) &&
    (value.allowlist === undefined || validAllowlist(value.allowlist))
  )
}

export function projectGitleaksResult(
  raw: GitleaksWasmResult,
  changes: Record<string, GitleaksLineRange[]>,
  head: GitleaksWasmSide,
): Pick<GitleaksResult, "findings" | "unclassified" | "inlineAllow" | "allowlistChange"> {
  const findings = raw.introduced.map((finding) => introducedFinding(finding, changes, head))
  const unclassified = raw.unclassified.map(unclassifiedFinding)
  const inlineAllow = raw.inline.map((finding) => inlineFinding(finding, head))
  const allowlistChange = raw.allowlist ? allowlistFinding(raw.allowlist, changes, head) : undefined
  return {
    findings,
    unclassified,
    inlineAllow,
    ...(allowlistChange ? { allowlistChange } : {}),
  }
}

export function isValidGitleaksWasmResult(
  value: unknown,
  expected: GitleaksResultIdentity,
  sides: { base: GitleaksWasmSide; head: GitleaksWasmSide },
): value is GitleaksWasmResult {
  return validWasmResult(value, expected, sides)
}
