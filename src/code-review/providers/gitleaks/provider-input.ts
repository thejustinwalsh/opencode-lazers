import { randomBytes } from "node:crypto"
import {
  type GitleaksChangedFile,
  type GitleaksComparisonReader,
  type GitleaksFailureCode,
  type GitleaksLineRange,
  type GitleaksResultIdentity,
  type GitleaksSettings,
  type GitleaksSide,
  type GitleaksSkippedInput,
} from "./contract.ts"
import {
  isSourceStatus,
  lineRanges,
  loadCapturedSide,
  MAX_WASM_REQUEST_BYTES,
  readCaptured,
  safePath,
  sourcePaths,
} from "./snapshot-input.ts"
import type { GitleaksWasmRequest, GitleaksWasmSide } from "./wasm-contract.ts"
import { safeGitleaksIdentity } from "./privacy.ts"

const utf8 = new TextEncoder()

export interface GitleaksPreparedInput {
  request: GitleaksWasmRequest
  identity: GitleaksResultIdentity
  changes: Record<string, GitleaksLineRange[]>
  head: GitleaksWasmSide
  skipped: GitleaksSkippedInput[]
}

export type GitleaksInputPreparation =
  | { ok: true; input: GitleaksPreparedInput }
  | { ok: false; code: GitleaksFailureCode; skipped: GitleaksSkippedInput[] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function validSettings(settings: GitleaksSettings): boolean {
  return (
    Number.isSafeInteger(settings.maxFileBytes) &&
    settings.maxFileBytes > 0 &&
    Number.isSafeInteger(settings.maxInputBytes) &&
    settings.maxInputBytes > 0 &&
    settings.maxInputBytes <= MAX_WASM_REQUEST_BYTES &&
    Number.isSafeInteger(settings.timeoutMs) &&
    settings.timeoutMs > 0
  )
}

function validChangedFilePath(value: Record<string, unknown>): boolean {
  return typeof value.path === "string" && safePath(value.path)
}

function validChangedFileStatus(value: Record<string, unknown>): boolean {
  return ["added", "modified", "removed", "renamed"].includes(String(value.status))
}

function validChangedFileOptions(value: Record<string, unknown>): boolean {
  return (
    (value.previousPath === undefined ||
      (typeof value.previousPath === "string" && safePath(value.previousPath))) &&
    (value.binary === undefined || typeof value.binary === "boolean") &&
    (value.status !== "renamed" || typeof value.previousPath === "string")
  )
}

function validChangedFile(value: unknown): value is GitleaksChangedFile {
  if (!isRecord(value)) return false
  if (
    !validChangedFilePath(value) ||
    !validChangedFileStatus(value) ||
    !validChangedFileOptions(value)
  )
    return false
  return true
}

function validChangedFiles(files: readonly unknown[]): boolean {
  const seen = new Set<string>()
  for (const file of files) {
    if (!validChangedFile(file) || seen.has(file.path)) return false
    seen.add(file.path)
  }
  return true
}

export function isValidGitleaksInput(
  reader: GitleaksComparisonReader,
  settings: GitleaksSettings,
): boolean {
  return (
    isRecord(reader) &&
    isRecord(settings) &&
    validSettings(settings) &&
    typeof reader.comparisonID === "string" &&
    reader.comparisonID.length > 0 &&
    typeof reader.baseRevision === "string" &&
    reader.baseRevision.length > 0 &&
    typeof reader.headRevision === "string" &&
    reader.headRevision.length > 0 &&
    Array.isArray(reader.changedFiles) &&
    validChangedFiles(reader.changedFiles) &&
    Boolean(reader.changedLines)
  )
}

function isSideFailure(
  value: Awaited<ReturnType<typeof loadCapturedSide>>,
): value is { code: GitleaksFailureCode; skipped?: GitleaksSkippedInput[] } {
  return "code" in value
}

function requestBase(
  reader: GitleaksComparisonReader,
  identity: GitleaksResultIdentity,
  base: GitleaksWasmSide,
  head: GitleaksWasmSide,
  changes: Record<string, GitleaksLineRange[]>,
  changesComplete: boolean,
): GitleaksWasmRequest {
  return {
    comparisonID: identity.comparisonID,
    baseRevision: identity.baseRevision,
    headRevision: identity.headRevision,
    salt: randomBytes(32).toString("hex"),
    base,
    head,
    changedFiles: reader.changedFiles.map((file) => ({
      path: file.path,
      previousPath: file.previousPath ?? "",
      status: file.status,
    })),
    headChanges: Object.fromEntries(
      Object.entries(changes).map(([path, ranges]) => [
        path,
        ranges.map(({ startLine, endLine }) => [startLine, endLine]),
      ]),
    ),
    baseComplete: true,
    headComplete: true,
    changesComplete,
  }
}

function fileSourceBytes(path: string, content: string): number {
  return utf8.encode(JSON.stringify({ path, content })).byteLength
}

interface SideReadOutcome {
  complete: boolean
  inputBytes: number
  fileCount: number
  code?: "cancelled"
}

async function readSideSources(
  reader: GitleaksComparisonReader,
  side: GitleaksSide,
  target: GitleaksWasmSide,
  changedFiles: readonly GitleaksChangedFile[],
  signal: AbortSignal,
  settings: GitleaksSettings,
  inputBytes: number,
  skipped: GitleaksSkippedInput[],
): Promise<SideReadOutcome> {
  let complete = true
  let fileCount = 0
  for (const path of sourcePaths(changedFiles, side)) {
    if (signal.aborted) return { complete: false, inputBytes, fileCount, code: "cancelled" }
    const source = await readCaptured(reader, side, path, signal)
    if (signal.aborted) return { complete: false, inputBytes, fileCount, code: "cancelled" }
    if (source.status !== "present") {
      skipped.push({ side, path, reason: "source-unavailable" })
      complete = false
      continue
    }
    const sourceSize = utf8.encode(source.content).byteLength
    if (sourceSize > settings.maxFileBytes) {
      skipped.push({ side, path, reason: "file-too-large" })
      complete = false
      continue
    }
    const addition = fileSourceBytes(path, source.content) + (fileCount > 0 ? 1 : 0)
    if (inputBytes + addition > settings.maxInputBytes) {
      skipped.push({ side, path, reason: "input-byte-limit" })
      complete = false
      continue
    }
    target.files.push({ path, content: source.content })
    fileCount++
    inputBytes += addition
  }
  return { complete, inputBytes, fileCount }
}

function markBinarySkips(
  changedFiles: readonly GitleaksChangedFile[],
  skipped: GitleaksSkippedInput[],
): { baseComplete: boolean; headComplete: boolean } {
  let baseComplete = true
  let headComplete = true
  for (const file of changedFiles) {
    if (!file.binary) continue
    skipped.push({ side: "comparison", path: file.path, reason: "binary" })
    if (isSourceStatus(file.status, "base")) baseComplete = false
    if (isSourceStatus(file.status, "head")) headComplete = false
  }
  return { baseComplete, headComplete }
}

function tooLarge(skipped: GitleaksSkippedInput[]): GitleaksInputPreparation {
  return {
    ok: false,
    code: "input-too-large",
    skipped: [...skipped, { side: "comparison", reason: "input-byte-limit" }],
  }
}

export async function prepareGitleaksInput(
  reader: GitleaksComparisonReader,
  settings: GitleaksSettings,
  signal: AbortSignal,
): Promise<GitleaksInputPreparation> {
  const skipped: GitleaksSkippedInput[] = []
  const baseLoad = await loadCapturedSide(reader, "base", signal, settings.maxFileBytes)
  if (isSideFailure(baseLoad))
    return { ok: false, code: baseLoad.code, skipped: baseLoad.skipped ?? skipped }
  const headLoad = await loadCapturedSide(reader, "head", signal, settings.maxFileBytes)
  if (isSideFailure(headLoad))
    return { ok: false, code: headLoad.code, skipped: headLoad.skipped ?? skipped }
  const ranges = lineRanges(reader)
  if (!ranges.complete) skipped.push({ side: "comparison", reason: "change-ranges-unavailable" })
  const identity = safeGitleaksIdentity(reader)
  const request = requestBase(
    reader,
    identity,
    baseLoad.side,
    headLoad.side,
    ranges.changes,
    ranges.complete,
  )
  let inputBytes = utf8.encode(JSON.stringify({ op: "gitleaks", payload: request })).byteLength
  if (inputBytes > settings.maxInputBytes || inputBytes > MAX_WASM_REQUEST_BYTES)
    return tooLarge(skipped)

  const binary = markBinarySkips(reader.changedFiles, skipped)
  const baseRead = await readSideSources(
    reader,
    "base",
    baseLoad.side,
    reader.changedFiles,
    signal,
    settings,
    inputBytes,
    skipped,
  )
  if (baseRead.code) return { ok: false, code: baseRead.code, skipped }
  inputBytes = baseRead.inputBytes
  const headRead = await readSideSources(
    reader,
    "head",
    headLoad.side,
    reader.changedFiles,
    signal,
    settings,
    inputBytes,
    skipped,
  )
  if (headRead.code) return { ok: false, code: headRead.code, skipped }
  request.baseComplete = binary.baseComplete && baseRead.complete
  request.headComplete = binary.headComplete && headRead.complete
  const exactBytes = utf8.encode(JSON.stringify({ op: "gitleaks", payload: request })).byteLength
  if (exactBytes > settings.maxInputBytes || exactBytes > MAX_WASM_REQUEST_BYTES)
    return tooLarge(skipped)

  return {
    ok: true,
    input: {
      request,
      identity,
      changes: ranges.changes,
      head: headLoad.side,
      skipped,
    },
  }
}
