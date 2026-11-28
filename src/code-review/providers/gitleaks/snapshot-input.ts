import { posix } from "node:path"
import type {
  GitleaksChangedFile,
  GitleaksComparisonReader,
  GitleaksFailureCode,
  GitleaksLineRange,
  GitleaksSide,
  GitleaksSkippedInput,
  GitleaksSourceRead,
} from "./contract.ts"
import type { GitleaksWasmSide } from "./wasm-contract.ts"

export const MAX_WASM_REQUEST_BYTES = 64 * 1024 * 1024
const ALLOWLIST_PATHS = new Set([".gitleaks.toml", ".gitleaksignore"])
const RULES_SECTION = /^\s*\[extend\]\s*(?:#.*)?$/m
const INLINE_EXTEND = /^\s*extend\s*=\s*\{([^}]*)\}/m
const EXTEND_PATH =
  /^\s*path\s*=\s*(?:"""([\s\S]*?)"""|'''([\s\S]*?)'''|"((?:\\.|[^"\\])*)"|'([^']*)')/m

export type GitleaksSideLoad = { side: GitleaksWasmSide }
export type GitleaksInputFailure = {
  code: GitleaksFailureCode
  skipped?: GitleaksSkippedInput[]
}

export function safePath(path: string): boolean {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !/[\0\r\n]/.test(path) &&
    posix.normalize(path) === path &&
    path !== "." &&
    path !== ".." &&
    !path.startsWith("../")
  )
}

function isAllowlist(path: string): boolean {
  return ALLOWLIST_PATHS.has(path)
}

export function isSourceStatus(status: GitleaksChangedFile["status"], side: GitleaksSide): boolean {
  return side === "head" ? status !== "removed" : status !== "added"
}

function pathForSide(file: GitleaksChangedFile, side: GitleaksSide): string {
  return side === "base" ? (file.previousPath ?? file.path) : file.path
}

export function sourcePaths(files: readonly GitleaksChangedFile[], side: GitleaksSide): string[] {
  const paths = new Set<string>()
  for (const file of files) {
    const path = pathForSide(file, side)
    if (!isSourceStatus(file.status, side) || file.binary || isAllowlist(path)) continue
    paths.add(path)
  }
  return [...paths].sort()
}

function extensionSectionBody(content: string): string {
  const section = RULES_SECTION.exec(content)
  const inline = INLINE_EXTEND.exec(content)
  if (!section) return inline?.[1] ?? ""
  const start = section.index + section[0].length
  const rest = content.slice(start)
  const end = rest.search(/^\s*\[/m)
  return end < 0 ? rest : rest.slice(0, end)
}

function decodeExtensionPath(body: string): string | undefined {
  const match = EXTEND_PATH.exec(body)
  if (!match) return undefined
  if (match[3] !== undefined) {
    try {
      const parsed: unknown = JSON.parse(`"${match[3]}"`)
      return typeof parsed === "string" ? parsed : undefined
    } catch {
      return undefined
    }
  }
  return match[1] ?? match[2] ?? match[4]
}

function extendPath(content: string): string | undefined {
  return decodeExtensionPath(extensionSectionBody(content))
}

function configIncludePath(path: string): string | undefined {
  if (!path || path.startsWith("/") || path.includes("\\") || /[\0\r\n]/.test(path))
    return undefined
  const normalized = posix.normalize(path)
  return safePath(normalized) ? normalized : undefined
}

export async function readCaptured(
  reader: GitleaksComparisonReader,
  side: GitleaksSide,
  path: string,
  signal: AbortSignal,
): Promise<GitleaksSourceRead> {
  if (signal.aborted) return { status: "unavailable" }
  try {
    const source = await reader.read(side, path, signal)
    if (typeof source !== "object" || source === null || !("status" in source))
      return { status: "unavailable" }
    if (source.status === "present" && typeof source.content === "string") return source
    if (source.status === "absent" || source.status === "unavailable") return source
    return { status: "unavailable" }
  } catch {
    return { status: "unavailable" }
  }
}

async function loadSideAllowLists(
  reader: GitleaksComparisonReader,
  side: GitleaksSide,
  signal: AbortSignal,
  maxFileBytes: number,
): Promise<{ config: string; configPresent: boolean; ignore: string } | GitleaksInputFailure> {
  const configRead = await readCaptured(reader, side, ".gitleaks.toml", signal)
  const ignoreRead = await readCaptured(reader, side, ".gitleaksignore", signal)
  if (signal.aborted) return { code: "cancelled" }
  const unavailable = unavailableAllowlist(configRead, ignoreRead, side)
  if (unavailable) return unavailable

  const config = configRead.status === "present" ? configRead.content : ""
  const ignore = ignoreRead.status === "present" ? ignoreRead.content : ""
  const tooLarge = oversizedAllowlist(config, ignore, side, maxFileBytes)
  if (tooLarge) return tooLarge

  return { config, configPresent: configRead.status === "present", ignore }
}

function unavailableAllowlist(
  config: GitleaksSourceRead,
  ignore: GitleaksSourceRead,
  side: GitleaksSide,
): GitleaksInputFailure | undefined {
  if (config.status !== "unavailable" && ignore.status !== "unavailable") return undefined
  const path = config.status === "unavailable" ? ".gitleaks.toml" : ".gitleaksignore"
  return {
    code: "config-unavailable",
    skipped: [{ side, path, reason: "source-unavailable" }],
  }
}

function oversizedAllowlist(
  config: string,
  ignore: string,
  side: GitleaksSide,
  maxFileBytes: number,
): GitleaksInputFailure | undefined {
  const sizes = {
    ".gitleaks.toml": new TextEncoder().encode(config).byteLength,
    ".gitleaksignore": new TextEncoder().encode(ignore).byteLength,
  }
  const oversized = Object.entries(sizes).find(([, size]) => size > maxFileBytes)
  if (!oversized) return undefined
  return {
    code: "config-too-large",
    skipped: [{ side, path: oversized[0], reason: "input-byte-limit" }],
  }
}

async function loadExtendedConfigs(
  reader: GitleaksComparisonReader,
  side: GitleaksSide,
  signal: AbortSignal,
  maxFileBytes: number,
  initialConfig: string,
): Promise<
  { ok: true; files: Record<string, string> } | { ok: false; failure: GitleaksInputFailure }
> {
  const configFiles: Record<string, string> = Object.create(null)
  const seen = new Set<string>([".gitleaks.toml"])
  // Gitleaks 8.30.1 caps extension traversal at two nested configs.
  let current = initialConfig
  for (let depth = 0; depth < 2; depth++) {
    const requested = extendPath(current)
    if (!requested) break
    const include = configIncludePath(requested)
    if (!include || seen.has(include)) {
      return {
        ok: false,
        failure: {
          code: "invalid-config",
          skipped: [{ side, path: ".gitleaks.toml", reason: "source-unavailable" }],
        },
      }
    }
    seen.add(include)
    const included = await readCaptured(reader, side, include, signal)
    if (signal.aborted) return { ok: false, failure: { code: "cancelled" } }
    if (included.status !== "present")
      return {
        ok: false,
        failure: {
          code: "config-unavailable",
          skipped: [{ side, path: include, reason: "source-unavailable" }],
        },
      }
    if (new TextEncoder().encode(included.content).byteLength > maxFileBytes)
      return {
        ok: false,
        failure: {
          code: "config-too-large",
          skipped: [{ side, path: include, reason: "input-byte-limit" }],
        },
      }
    configFiles[include] = included.content
    current = included.content
  }
  return { ok: true, files: configFiles }
}

export async function loadCapturedSide(
  reader: GitleaksComparisonReader,
  side: GitleaksSide,
  signal: AbortSignal,
  maxFileBytes: number,
): Promise<GitleaksSideLoad | GitleaksInputFailure> {
  const allowLists = await loadSideAllowLists(reader, side, signal, maxFileBytes)
  if ("code" in allowLists) return allowLists
  const configFiles = await loadExtendedConfigs(
    reader,
    side,
    signal,
    maxFileBytes,
    allowLists.config,
  )
  if (!configFiles.ok) return configFiles.failure
  return {
    side: {
      files: [],
      config: allowLists.config,
      configPresent: allowLists.configPresent,
      ignore: allowLists.ignore,
      configFiles: configFiles.files,
    },
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isLineRange(value: unknown): value is GitleaksLineRange {
  return (
    record(value) &&
    "startLine" in value &&
    "endLine" in value &&
    Number.isInteger(value.startLine) &&
    Number.isInteger(value.endLine) &&
    Number(value.startLine) >= 1 &&
    Number(value.endLine) >= Number(value.startLine)
  )
}

function parseRangeList(value: unknown): GitleaksLineRange[] | undefined {
  if (!Array.isArray(value)) return undefined
  const ranges: GitleaksLineRange[] = []
  for (const range of value) {
    if (!isLineRange(range)) return undefined
    ranges.push({ startLine: Number(range.startLine), endLine: Number(range.endLine) })
  }
  return ranges
}

function parseChangedRange(
  value: unknown,
): { path: string; ranges: GitleaksLineRange[] } | undefined {
  if (
    !record(value) ||
    typeof value.path !== "string" ||
    !safePath(value.path) ||
    !("ranges" in value)
  )
    return undefined
  const ranges = parseRangeList(value.ranges)
  return ranges ? { path: value.path, ranges } : undefined
}

export function lineRanges(reader: GitleaksComparisonReader): {
  complete: boolean
  changes: Record<string, GitleaksLineRange[]>
} {
  if (
    !reader.changedLines ||
    reader.changedLines.status !== "complete" ||
    !Array.isArray(reader.changedLines.ranges)
  )
    return { complete: false, changes: Object.create(null) }
  const changes: Record<string, GitleaksLineRange[]> = Object.create(null)
  for (const value of reader.changedLines.ranges as readonly unknown[]) {
    const parsed = parseChangedRange(value)
    if (!parsed) return { complete: false, changes: Object.create(null) }
    changes[parsed.path] = [...(changes[parsed.path] ?? []), ...parsed.ranges]
  }
  return { complete: true, changes }
}
