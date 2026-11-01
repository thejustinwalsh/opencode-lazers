import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

export interface RendererDebugger {
  isAttached(): boolean
  attach(protocolVersion?: string): void
  detach(): void
  sendCommand(method: string, params?: Readonly<Record<string, unknown>>): Promise<unknown>
  on?(event: "detach", listener: (event: unknown, reason: string) => void): unknown
  removeListener?(event: "detach", listener: (event: unknown, reason: string) => void): unknown
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
    | "job-not-seen"
    | "job-started-during-arming"
    | "manual-stop-before-job"
    | "lifecycle-lost"
  failure?:
    | "attach"
    | "profiler-enable"
    | "profiler-sampling"
    | "profiler-start"
    | "profiler-stop"
    | "job-wait"
    | "lifecycle"
    | "profile"
  path?: string
  profilePath?: string
  profile?: RendererCPUProfile
  profileOmitted?: "too-large"
  armedCapture?: RendererArmedMetadata
}

export type RendererArmedStopTrigger =
  | "terminal"
  | "manual-stop"
  | "manual-disarm"
  | "next-job-timeout"
  | "recording-timeout"
  | "unresponsive"
  | "preparation-race"
  | "lifecycle-loss"
  | "cleanup"
  | "arming-failure"

export type RendererArmedMetadata = {
  captureID: string
  stopTrigger: RendererArmedStopTrigger
  outcome: "captured" | "failed"
  armedAt: number
  profilerStartedAt?: number
  jobStartedAt?: number
  stoppedAt: number
  recordingMs?: number
  targetRequestID?: string
  targetJobID?: string
  targetMode?: string
  targetFeature?: string
  stageHistory: readonly { stage: string; elapsedMs: number; deltaMs: number }[]
  stageHistoryDropped?: number
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
  filePrefix?: string
}

export type RendererDebugPersistenceOptions = Pick<
  CaptureOptions,
  "directory" | "write" | "makeDirectory" | "filePrefix"
>

export type RendererProfilerStartOptions = {
  timeoutMs?: number
  signal?: AbortSignal
  samplingIntervalUs?: number
}

export type RendererProfilerFailure = {
  ok: false
  reason:
    | NonNullable<RendererDebugResult["reason"]>
    | "devtools-open"
    | "debugger-attached"
    | "unavailable"
    | "error"
  failure?: RendererDebugResult["failure"]
}

export type RendererProfilerStopResult =
  | { ok: true; profile: RendererCPUProfile }
  | {
      ok: false
      reason: NonNullable<RendererDebugResult["reason"]> | "timeout" | "aborted" | "error"
      failure: "profiler-stop" | "profile"
    }

export type RendererProfilerSession = {
  /** Resolves only if Electron reports that this profiler's debugger attachment was lost. */
  lost: Promise<void>
  stop(timeoutMs?: number, signal?: AbortSignal): Promise<RendererProfilerStopResult>
}

export type RendererProfilerStartResult =
  { ok: true; session: RendererProfilerSession } | RendererProfilerFailure

const MAX_PROFILE_NODES = 8_192
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

const detachOwnedDebugger = (transport: RendererDebugger) => {
  try {
    transport.detach()
  } catch {
    // The renderer may have exited while the bounded capture was running.
  }
}

/**
 * Acquire and start an owned CDP CPU profiler. A successful result means every
 * required command was acknowledged; a pre-existing debugger is never detached.
 */
export async function startRendererProfiler(
  renderer: DebuggableRenderer,
  options: RendererProfilerStartOptions = {},
): Promise<RendererProfilerStartResult> {
  const timeoutMs = Math.min(
    MAX_TIMEOUT,
    Math.max(100, options.timeoutMs ?? RENDERER_DEBUG_TIMEOUT_MS),
  )
  const deadline = Date.now() + timeoutMs
  const remaining = () => Math.max(1, deadline - Date.now())
  const transport = renderer.debugger
  if (!transport) return { ok: false, reason: "unavailable" }
  try {
    if (renderer.isDevToolsOpened?.()) return { ok: false, reason: "devtools-open" }
    if (transport.isAttached()) return { ok: false, reason: "debugger-attached" }
  } catch {
    return { ok: false, reason: "unavailable" }
  }

  let attached = false
  let ownershipLost = false
  let resolveOwnershipLost!: () => void
  const ownershipLostPromise = new Promise<void>((resolve) => (resolveOwnershipLost = resolve))
  const lostListener = () => {
    if (!attached) return
    attached = false
    ownershipLost = true
    resolveOwnershipLost()
  }
  const detach = () => {
    const owned = attached && !ownershipLost
    attached = false
    transport.removeListener?.("detach", lostListener)
    if (!owned) return
    try {
      if (transport.isAttached()) detachOwnedDebugger(transport)
    } catch {
      // If Electron cannot confirm the attachment, avoid detaching another owner.
    }
  }
  try {
    if (options.signal?.aborted) return { ok: false, reason: "aborted", failure: "attach" }
    transport.attach("1.3")
    attached = true
    transport.on?.("detach", lostListener)
    const commands: {
      method: string
      params?: Readonly<Record<string, unknown>>
      failure: NonNullable<RendererDebugResult["failure"]>
    }[] = [
      { method: "Profiler.enable", failure: "profiler-enable" },
      ...(options.samplingIntervalUs === undefined
        ? []
        : [
            {
              method: "Profiler.setSamplingInterval",
              params: {
                interval: Math.min(10_000, Math.max(100, Math.trunc(options.samplingIntervalUs))),
              },
              failure: "profiler-sampling" as const,
            },
          ]),
      { method: "Profiler.start", failure: "profiler-start" },
    ]
    for (const { method, params, failure } of commands) {
      const result = await attempt(
        () => transport.sendCommand(method, params),
        remaining(),
        options.signal,
      )
      if (!result.ok) {
        detach()
        return { ok: false, reason: failedReason(result), failure }
      }
      if (ownershipLost || !transport.isAttached()) {
        ownershipLost = true
        attached = false
        transport.removeListener?.("detach", lostListener)
        return { ok: false, reason: "lifecycle-lost", failure }
      }
    }

    let stopping: Promise<RendererProfilerStopResult> | undefined
    const session: RendererProfilerSession = {
      lost: ownershipLostPromise,
      stop: (stopTimeoutMs = RENDERER_DEBUG_TIMEOUT_MS, signal) => {
        if (stopping) return stopping
        const boundedStopMs = Math.min(MAX_TIMEOUT, Math.max(1, stopTimeoutMs))
        stopping = (async () => {
          try {
            if (ownershipLost || !attached || !transport.isAttached())
              return { ok: false, reason: "lifecycle-lost", failure: "profiler-stop" }
            const stopped = await Promise.race([
              attempt(() => transport.sendCommand("Profiler.stop"), boundedStopMs, signal),
              ownershipLostPromise.then(() => "ownership-lost" as const),
            ])
            if (stopped === "ownership-lost")
              return { ok: false, reason: "lifecycle-lost", failure: "profiler-stop" }
            if (!stopped.ok)
              return {
                ok: false,
                reason: failedReason(stopped),
                failure: "profiler-stop",
              }
            const response = stopped.value
            const captured =
              response && typeof response === "object"
                ? profile((response as Record<string, unknown>).profile)
                : undefined
            return captured && "profile" in captured
              ? { ok: true, profile: captured.profile }
              : {
                  ok: false,
                  reason: captured?.reason ?? "profile-empty",
                  failure: "profile",
                }
          } catch {
            return { ok: false, reason: "lifecycle-lost", failure: "profiler-stop" }
          } finally {
            detach()
          }
        })()
        return stopping
      },
    }
    return { ok: true, session }
  } catch {
    detach()
    return { ok: false, reason: "error", failure: "attach" }
  }
}

const persist = async (
  report: RendererDebugResult,
  options: RendererDebugPersistenceOptions,
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
      ...(report.armedCapture
        ? { armedCapture: { ...report.armedCapture, outcome: "failed" } }
        : {}),
    }
  }
  const basePath = join(
    options.directory,
    `${options.filePrefix ?? "renderer-unresponsive"}-${Date.now()}-${++captureNumber}.json`,
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
          ...(boundedReport.armedCapture
            ? { armedCapture: { ...boundedReport.armedCapture, outcome: "failed" } }
            : {}),
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
      ...(boundedReport.armedCapture
        ? { armedCapture: { ...boundedReport.armedCapture, outcome: "failed" } }
        : {}),
    }
  }
}

export const persistRendererDebugResult = (
  report: RendererDebugResult,
  options: RendererDebugPersistenceOptions,
) => persist(report, options)

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
  const base = { ...correlation }
  let report: RendererDebugResult | undefined
  const started = await startRendererProfiler(renderer, { timeoutMs, signal })
  if (!started.ok) {
    const preflight =
      started.reason === "devtools-open" ||
      started.reason === "debugger-attached" ||
      started.reason === "unavailable"
    if (preflight)
      return {
        ...base,
        captured: false,
        reason: started.reason,
        ...(started.failure ? { failure: started.failure } : {}),
      }
    report = {
      ...base,
      captured: false,
      reason: started.reason,
      ...(started.failure ? { failure: started.failure } : { failure: "attach" }),
    }
  } else {
    await wait(Math.min(profileMs, remaining()), signal)
    const stopped = await started.session.stop(remaining(), signal)
    report = stopped.ok
      ? { ...base, captured: true, profile: stopped.profile }
      : {
          ...base,
          captured: false,
          reason: stopped.reason,
          failure: stopped.failure,
        }
  }
  return persist(
    report ?? { ...base, captured: false, reason: "error", failure: "attach" },
    options,
  )
}
