import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

export interface RendererDebugger {
  isAttached(): boolean
  attach(protocolVersion?: string): void
  detach(): void
  sendCommand(method: string, params?: Readonly<Record<string, unknown>>): Promise<unknown>
}

export interface DebuggableRenderer {
  readonly debugger?: RendererDebugger
  isDevToolsOpened?(): boolean
}

export type RendererDebugCorrelation = {
  windowID: number
  rendererPID?: number
  lastStage: string
  lastRequestID?: string
  lastJobID?: string
}

export type RendererDebugResult = RendererDebugCorrelation & {
  captured: boolean
  reason?:
    | "devtools-open"
    | "debugger-attached"
    | "unavailable"
    | "timeout"
    | "aborted"
    | "error"
    | "profile-empty"
    | "profile-too-large"
    | "profile-invalid"
  failure?: "attach" | "profiler-enable" | "profiler-start" | "profiler-stop" | "profile"
  path?: string
  profilePath?: string
  profile?: RendererCPUProfile
  profileOmitted?: "too-large"
}

export type RendererCPUProfile = {
  nodes: readonly RendererProfileNode[]
  samples: readonly number[]
  timeDeltas: readonly number[]
  startTime: number
  endTime: number
}

type RendererProfileNode = {
  id: number
  callFrame: {
    functionName: string
    scriptId: string
    url: string
    lineNumber: number
    columnNumber: number
  }
  children: readonly number[]
  hitCount?: number
}

type CaptureOptions = {
  renderer: DebuggableRenderer
  correlation: RendererDebugCorrelation
  directory: string
  signal?: AbortSignal
  timeoutMs?: number
  profileMs?: number
  write?: (path: string, data: string) => Promise<void>
  makeDirectory?: (path: string) => Promise<void>
}

const MAX_PROFILE_NODES = 2_000
const MAX_PROFILE_SAMPLES = 20_000
const MAX_TEXT = 240
const MAX_OUTPUT_BYTES = 2_000_000
const MAX_TIMEOUT = 3_000
const MAX_PROFILE_MS = 1_000
export const RENDERER_DEBUG_TIMEOUT_MS = 2_000
export const RENDERER_DEBUG_PROFILE_MS = 500
let captureNumber = 0

const boundedText = (value: unknown, limit = MAX_TEXT) =>
  typeof value === "string" ? value.slice(0, limit) : undefined

const boundedInteger = (value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? value
    : undefined

const wait = (duration: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve()
    const finish = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", finish)
      resolve()
    }
    const timer = setTimeout(finish, duration)
    signal?.addEventListener("abort", finish, { once: true })
  })

type Attempt<T> = { ok: true; value: T } | { ok: false; timedOut: boolean; aborted: boolean }

const attempt = async <T>(
  operation: () => Promise<T> | T,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Attempt<T>> => {
  if (signal?.aborted) return { ok: false, timedOut: false, aborted: true }
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  const operationResult = Promise.resolve()
    .then(operation)
    .then(
      (value): Attempt<T> => ({ ok: true, value }),
      (): Attempt<T> => ({ ok: false, timedOut: false, aborted: false }),
    )
  const timeout = new Promise<Attempt<T>>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, timedOut: true, aborted: false }), timeoutMs)
  })
  const aborted = new Promise<Attempt<T>>((resolve) => {
    abort = () => resolve({ ok: false, timedOut: false, aborted: true })
    signal?.addEventListener("abort", abort, { once: true })
  })
  const result = await Promise.race([operationResult, timeout, aborted])
  if (timer) clearTimeout(timer)
  if (abort) signal?.removeEventListener("abort", abort)
  return result
}

const cleanURL = (value: unknown) => {
  if (typeof value !== "string" || /^(data|javascript):/i.test(value)) return ""
  return value.split(/[?#]/, 1)[0]!.slice(0, MAX_TEXT)
}

const profile = (
  value: unknown,
):
  | { profile: RendererCPUProfile }
  | { reason: "profile-empty" | "profile-too-large" | "profile-invalid" } => {
  if (!value || typeof value !== "object") return { reason: "profile-empty" }
  const candidate = value as Record<string, unknown>
  const {
    nodes: rawNodes,
    samples: rawSamples,
    timeDeltas: rawDeltas,
    startTime,
    endTime,
  } = candidate
  if (!Array.isArray(rawNodes) || !Array.isArray(rawSamples) || !rawSamples.length)
    return { reason: "profile-empty" }
  if (rawNodes.length > MAX_PROFILE_NODES || rawSamples.length > MAX_PROFILE_SAMPLES)
    return { reason: "profile-too-large" }
  if (
    !Array.isArray(rawDeltas) ||
    rawDeltas.length !== rawSamples.length ||
    typeof startTime !== "number" ||
    !Number.isFinite(startTime) ||
    startTime < 0 ||
    typeof endTime !== "number" ||
    !Number.isFinite(endTime) ||
    endTime < startTime
  )
    return { reason: "profile-invalid" }
  const nodes: RendererProfileNode[] = []
  const nodeIDs = new Set<number>()
  for (const raw of rawNodes) {
    if (!raw || typeof raw !== "object") return { reason: "profile-invalid" }
    const node = raw as Record<string, unknown>
    const id = boundedInteger(node.id, 1)
    if (
      id === undefined ||
      nodeIDs.has(id) ||
      !node.callFrame ||
      typeof node.callFrame !== "object"
    )
      return { reason: "profile-invalid" }
    const frame = node.callFrame as Record<string, unknown>
    const lineNumber = boundedInteger(frame.lineNumber, -1)
    const columnNumber = boundedInteger(frame.columnNumber, -1)
    const children = node.children ?? []
    if (
      typeof frame.functionName !== "string" ||
      typeof frame.scriptId !== "string" ||
      typeof frame.url !== "string" ||
      lineNumber === undefined ||
      columnNumber === undefined ||
      !Array.isArray(children) ||
      children.some((child) => boundedInteger(child, 1) === undefined) ||
      (node.hitCount !== undefined && boundedInteger(node.hitCount) === undefined)
    )
      return { reason: "profile-invalid" }
    nodeIDs.add(id)
    nodes.push({
      id,
      callFrame: {
        functionName: boundedText(frame.functionName)!,
        scriptId: boundedText(frame.scriptId)!,
        url: cleanURL(frame.url),
        lineNumber,
        columnNumber,
      },
      children,
      ...(node.hitCount === undefined ? {} : { hitCount: node.hitCount as number }),
    })
  }
  // Do not silently drop nodes/samples: doing so would corrupt the call tree and timing.
  if (
    nodes.some((node) => node.children.some((id) => !nodeIDs.has(id))) ||
    rawSamples.some((id) => boundedInteger(id, 1) === undefined || !nodeIDs.has(id)) ||
    rawDeltas.some((delta) => typeof delta !== "number" || !Number.isFinite(delta))
  )
    return { reason: "profile-invalid" }
  return { profile: { nodes, samples: rawSamples, timeDeltas: rawDeltas, startTime, endTime } }
}

const failedReason = (result: Attempt<unknown>) => {
  if (result.ok) return "error"
  return result.aborted ? "aborted" : result.timedOut ? "timeout" : "error"
}

const persist = async (
  report: RendererDebugResult,
  options: CaptureOptions,
): Promise<RendererDebugResult> => {
  let boundedReport = report
  const profileData = report.profile ? JSON.stringify(report.profile) : undefined
  if (profileData && Buffer.byteLength(profileData) > MAX_OUTPUT_BYTES) {
    boundedReport = {
      ...report,
      captured: false,
      reason: "profile-too-large",
      failure: "profile",
      profile: undefined,
      profileOmitted: "too-large",
    }
  }
  const basePath = join(
    options.directory,
    `renderer-unresponsive-${Date.now()}-${++captureNumber}.json`,
  )
  const path = basePath
  const profilePath =
    profileData && boundedReport.profile ? basePath.replace(/\.json$/, ".cpuprofile") : undefined
  try {
    const makeDirectory =
      options.makeDirectory ?? ((directory: string) => mkdir(directory, { recursive: true }))
    const write = options.write ?? writeFile
    await makeDirectory(options.directory)
    let persistedProfile = false
    if (profilePath && profileData) {
      try {
        await write(profilePath, profileData)
        persistedProfile = true
      } catch {
        // Preserve a metadata breadcrumb even when the larger profile artifact cannot be written.
        boundedReport = {
          ...boundedReport,
          captured: false,
          reason: "error",
          failure: "profile",
          profile: undefined,
        }
      }
    }
    const metadata = persistedProfile
      ? { ...boundedReport, profile: undefined, profilePath }
      : { ...boundedReport, profile: undefined }
    await write(path, JSON.stringify(metadata))
    return { ...boundedReport, path, ...(persistedProfile ? { profilePath } : {}) }
  } catch {
    return {
      ...boundedReport,
      captured: false,
      reason: "error",
      failure: "profile",
      profile: undefined,
    }
  }
}

/**
 * Capture one bounded renderer breadcrumb after an unresponsive event.
 * It uses only the CDP CPU profiler's call-frame graph and samples; it never
 * requests scope objects, page source, prompt text, or audio data.
 */
export async function captureRendererDebug(options: CaptureOptions): Promise<RendererDebugResult> {
  const { renderer, correlation, signal } = options
  const timeoutMs = Math.min(
    MAX_TIMEOUT,
    Math.max(100, options.timeoutMs ?? RENDERER_DEBUG_TIMEOUT_MS),
  )
  const profileMs = Math.min(
    MAX_PROFILE_MS,
    Math.max(100, options.profileMs ?? RENDERER_DEBUG_PROFILE_MS),
  )
  const deadline = Date.now() + timeoutMs
  const remaining = () => Math.max(1, deadline - Date.now())
  const transport = renderer.debugger
  const base = { ...correlation }
  if (!transport) return { ...base, captured: false, reason: "unavailable" }
  if (renderer.isDevToolsOpened?.()) return { ...base, captured: false, reason: "devtools-open" }
  try {
    if (transport.isAttached()) return { ...base, captured: false, reason: "debugger-attached" }
  } catch {
    return { ...base, captured: false, reason: "unavailable" }
  }

  let attached = false
  let report: RendererDebugResult | undefined
  try {
    if (signal?.aborted) report = { ...base, captured: false, reason: "aborted", failure: "attach" }
    else {
      transport.attach("1.3")
      attached = true
    }
    if (attached) {
      const enabled = await attempt(
        () => transport.sendCommand("Profiler.enable"),
        remaining(),
        signal,
      )
      if (!enabled.ok) {
        report = {
          ...base,
          captured: false,
          reason: failedReason(enabled),
          failure: "profiler-enable",
        }
      } else {
        const started = await attempt(
          () => transport.sendCommand("Profiler.start"),
          remaining(),
          signal,
        )
        if (!started.ok) {
          report = {
            ...base,
            captured: false,
            reason: failedReason(started),
            failure: "profiler-start",
          }
        } else {
          await wait(Math.min(profileMs, remaining()), signal)
          const stopped = await attempt(
            () => transport.sendCommand("Profiler.stop"),
            remaining(),
            signal,
          )
          if (!stopped.ok) {
            report = {
              ...base,
              captured: false,
              reason: failedReason(stopped),
              failure: "profiler-stop",
            }
          } else {
            const capturedProfile =
              stopped.value && typeof stopped.value === "object"
                ? profile((stopped.value as Record<string, unknown>).profile)
                : undefined
            report =
              capturedProfile && "profile" in capturedProfile
                ? { ...base, captured: true, profile: capturedProfile.profile }
                : {
                    ...base,
                    captured: false,
                    reason: capturedProfile?.reason ?? "profile-empty",
                    failure: "profile",
                  }
          }
        }
      }
    }
  } catch {
    report = { ...base, captured: false, reason: "error", failure: "attach" }
  } finally {
    if (attached) {
      try {
        transport.detach()
      } catch {
        // The renderer may have exited while the bounded capture was running.
      }
    }
  }
  return persist(
    report ?? { ...base, captured: false, reason: "error", failure: "attach" },
    options,
  )
}
