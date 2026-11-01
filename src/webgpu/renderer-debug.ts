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
    | "profiler-command-pending"
    | "profiler-state-uncertain"
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
    | "cleanup-failed"
  failure?:
    | "attach"
    | "profiler-enable"
    | "profiler-sampling"
    | "profiler-start"
    | "profiler-stop"
    | "job-wait"
    | "lifecycle"
    | "profile"
    | "profiler-cleanup"
  path?: string
  profilePath?: string
  profile?: RendererCPUProfile
  profileOmitted?: "too-large"
  armedCapture?: RendererArmedMetadata
  profilerDiagnostics?: RendererProfilerDiagnostics
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
  triggeredAt: number
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
  profilerCommands: readonly RendererProfilerCommandObservation[]
  profilerCleanup?: RendererProfilerCleanupObservation
}

export type RendererProfilerCommandMethod =
  "Profiler.enable" | "Profiler.setSamplingInterval" | "Profiler.start" | "Profiler.stop"

export type RendererProfilerCommandObservation = {
  method: RendererProfilerCommandMethod
  outcome: "succeeded" | "failed" | "timed-out" | "aborted"
  /** Time the native command was issued. */
  startedAt: number
  /** Time the result or timeout/abort was observed. */
  settledAt: number
  /** A timeout/abort does not cancel the native command. */
  nativePending?: boolean
  nativeOutcome?: "succeeded" | "failed"
  nativeSettledAt?: number
  profilerStateUncertain?: boolean
}

export type RendererProfilerCleanupObservation = {
  outcome: "detached" | "not-required" | "not-owned" | "failed"
  startedAt: number
  settledAt: number
}

export type RendererProfilerDiagnostics = {
  commands: RendererProfilerCommandObservation[]
  cleanup?: RendererProfilerCleanupObservation
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
> & { metadataPath?: string }

export type RendererProfilerStartOptions = {
  timeoutMs?: number
  signal?: AbortSignal
  samplingIntervalUs?: number
  now?: () => number
  onDiagnosticsChange?: (diagnostics: RendererProfilerDiagnostics) => void
}

export type RendererProfilerFailure = {
  ok: false
  reason:
    | NonNullable<RendererDebugResult["reason"]>
    | "devtools-open"
    | "debugger-attached"
    | "profiler-command-pending"
    | "profiler-state-uncertain"
    | "unavailable"
    | "error"
  failure?: RendererDebugResult["failure"]
  diagnostics: RendererProfilerDiagnostics
}

export type RendererProfilerStopResult =
  | { ok: true; profile: RendererCPUProfile; diagnostics: RendererProfilerDiagnostics }
  | {
      ok: false
      reason: NonNullable<RendererDebugResult["reason"]> | "timeout" | "aborted" | "error"
      failure: "profiler-stop" | "profile" | "profiler-cleanup" | "lifecycle"
      diagnostics: RendererProfilerDiagnostics
    }

export type RendererProfilerSession = {
  /** Resolves only if Electron reports that this profiler's debugger attachment was lost. */
  lost: Promise<void>
  diagnostics: RendererProfilerDiagnostics
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

type NativeOwnership = {
  attached: boolean
  ownershipLost: boolean
  pendingCommand: boolean
  profilerActive: boolean
  profilerStateUncertain: boolean
  lostListener?: (event: unknown, reason: string) => void
  profilerStartCommand?: RendererProfilerCommandObservation
}

const nativeOwnership = new WeakMap<RendererDebugger, NativeOwnership>()

const diagnostics = (): RendererProfilerDiagnostics => ({ commands: [] })

const markNoCleanupNeeded = (value: RendererProfilerDiagnostics, now: () => number) => {
  const at = now()
  value.cleanup = { outcome: "not-required", startedAt: at, settledAt: at }
}

const releaseNativeOwnership = (transport: RendererDebugger, owner: NativeOwnership) => {
  if (
    owner.pendingCommand ||
    owner.profilerActive ||
    owner.profilerStateUncertain ||
    nativeOwnership.get(transport) !== owner
  )
    return
  try {
    if (!transport.isAttached()) nativeOwnership.delete(transport)
  } catch {
    // An unconfirmed native attachment remains reserved; never permit overlap on uncertainty.
  }
}

const cleanupNativeOwnership = (
  transport: RendererDebugger,
  owner: NativeOwnership,
  value: RendererProfilerDiagnostics,
  now: () => number,
) => {
  const startedAt = now()
  let outcome: RendererProfilerCleanupObservation["outcome"]
  const removeLostListener = () => {
    try {
      transport.removeListener?.("detach", owner.lostListener!)
    } catch {
      // A failed observer cleanup does not authorize detaching an uncertain owner.
    }
  }
  if (!owner.attached || owner.ownershipLost) {
    outcome = "not-owned"
    removeLostListener()
  } else {
    try {
      if (!transport.isAttached()) {
        owner.attached = false
        owner.ownershipLost = true
        outcome = "not-owned"
      } else {
        removeLostListener()
        try {
          transport.detach()
        } catch {
          // Confirm the postcondition below; Electron may throw after the detach took effect.
        }
        if (transport.isAttached()) {
          outcome = "failed"
        } else {
          owner.attached = false
          owner.ownershipLost = true
          outcome = "detached"
        }
      }
    } catch {
      outcome = "failed"
    }
  }
  value.cleanup = { outcome, startedAt, settledAt: now() }
  releaseNativeOwnership(transport, owner)
  return value.cleanup
}

type OwnedNativeCommandOptions = {
  transport: RendererDebugger
  owner: NativeOwnership
  diagnostics: RendererProfilerDiagnostics
  method: RendererProfilerCommandMethod
  params?: Readonly<Record<string, unknown>>
  timeoutMs: number
  signal?: AbortSignal
  now: () => number
  onDiagnosticsChange?: (diagnostics: RendererProfilerDiagnostics) => void
}

const runOwnedCommand = async <T>(options: OwnedNativeCommandOptions): Promise<Attempt<T>> => {
  const startedAt = options.now()
  const observation: RendererProfilerCommandObservation = {
    method: options.method,
    outcome: "aborted",
    startedAt,
    settledAt: startedAt,
  }
  options.diagnostics.commands.push(observation)
  if (options.signal?.aborted) {
    if (options.method === "Profiler.stop") {
      observation.profilerStateUncertain = true
      options.owner.profilerStateUncertain = true
    }
    return { ok: false, timedOut: false, aborted: true }
  }

  let timeout: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  let nativeSettled = false
  let nativeResult: Attempt<T> | undefined
  let observationDecided = false
  const native = Promise.resolve()
    .then(() => options.transport.sendCommand(options.method, options.params) as Promise<T> | T)
    .then(
      (value): Attempt<T> => ({ ok: true, value }),
      (): Attempt<T> => ({ ok: false, timedOut: false, aborted: false }),
    )
    .then((result) => {
      nativeSettled = true
      nativeResult = result
      options.owner.pendingCommand = false
      if (options.method === "Profiler.start") {
        options.owner.profilerActive = result.ok
        options.owner.profilerStateUncertain = false
        options.owner.profilerStartCommand = result.ok ? observation : undefined
      } else if (options.method === "Profiler.stop") {
        options.owner.profilerActive = false
        options.owner.profilerStateUncertain = !result.ok
        observation.profilerStateUncertain = !result.ok
      }
      if (observationDecided && observation.nativePending) {
        observation.nativePending = false
        observation.nativeOutcome = result.ok ? "succeeded" : "failed"
        observation.nativeSettledAt = options.now()
        const profilerStateUncertain =
          options.method === "Profiler.start"
            ? result.ok
            : options.method === "Profiler.stop"
              ? !result.ok
              : false
        observation.profilerStateUncertain = profilerStateUncertain
        if (options.method === "Profiler.start")
          options.owner.profilerStateUncertain = profilerStateUncertain
        if (options.method === "Profiler.stop")
          options.owner.profilerStateUncertain = profilerStateUncertain
        try {
          options.onDiagnosticsChange?.(options.diagnostics)
        } catch {
          // Diagnostic updates must not interfere with native ownership cleanup.
        }
      }
      releaseNativeOwnership(options.transport, options.owner)
      return result
    })
  options.owner.pendingCommand = true

  const timedOut = new Promise<Attempt<T>>((resolve) => {
    timeout = setTimeout(
      () => resolve({ ok: false, timedOut: true, aborted: false }),
      options.timeoutMs,
    )
  })
  const aborted = new Promise<Attempt<T>>((resolve) => {
    abort = () => resolve({ ok: false, timedOut: false, aborted: true })
    options.signal?.addEventListener("abort", abort, { once: true })
  })
  const result = await Promise.race([native, timedOut, aborted])
  if (timeout) clearTimeout(timeout)
  if (abort) options.signal?.removeEventListener("abort", abort)

  observationDecided = true
  observation.settledAt = options.now()
  if (result.ok) {
    observation.outcome = "succeeded"
  } else if (result.aborted) {
    observation.outcome = "aborted"
  } else if (result.timedOut) {
    observation.outcome = "timed-out"
  } else {
    observation.outcome = "failed"
  }
  if (!result.ok && (result.aborted || result.timedOut)) {
    if (nativeSettled) {
      observation.nativeOutcome = nativeResult?.ok ? "succeeded" : "failed"
      observation.nativeSettledAt = options.now()
      const profilerStateUncertain =
        options.method === "Profiler.start"
          ? nativeResult?.ok === true
          : options.method === "Profiler.stop"
            ? nativeResult?.ok !== true
            : false
      observation.profilerStateUncertain = profilerStateUncertain
      if (options.method === "Profiler.start") {
        options.owner.profilerActive = nativeResult?.ok === true
        options.owner.profilerStateUncertain = profilerStateUncertain
      }
      if (options.method === "Profiler.stop") {
        options.owner.profilerActive = nativeResult?.ok !== true
        options.owner.profilerStateUncertain = profilerStateUncertain
      }
    } else {
      observation.nativePending = true
      if (options.method === "Profiler.start" || options.method === "Profiler.stop") {
        observation.profilerStateUncertain = true
        options.owner.profilerStateUncertain = true
        if (options.method === "Profiler.start") options.owner.profilerActive = false
      }
    }
  } else if (!result.ok && options.method === "Profiler.stop") {
    observation.profilerStateUncertain = true
    options.owner.profilerStateUncertain = true
  }
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
  const now = options.now ?? Date.now
  const commandDiagnostics = diagnostics()
  const fail = (
    reason: RendererProfilerFailure["reason"],
    failure?: RendererDebugResult["failure"],
  ): RendererProfilerFailure => {
    markNoCleanupNeeded(commandDiagnostics, now)
    return {
      ok: false,
      reason,
      ...(failure ? { failure } : {}),
      diagnostics: commandDiagnostics,
    }
  }
  const transport = renderer.debugger
  if (!transport) return fail("unavailable")
  const existingOwner = nativeOwnership.get(transport)
  if (existingOwner) {
    if (existingOwner.pendingCommand) return fail("profiler-command-pending", "attach")
    if (existingOwner.profilerActive || existingOwner.profilerStateUncertain)
      return fail("profiler-state-uncertain", "attach")
    try {
      if (transport.isAttached()) return fail("debugger-attached", "attach")
      nativeOwnership.delete(transport)
    } catch {
      return fail("unavailable", "attach")
    }
  }
  try {
    if (renderer.isDevToolsOpened?.()) return fail("devtools-open")
    if (transport.isAttached()) return fail("debugger-attached")
  } catch {
    return fail("unavailable")
  }

  if (options.signal?.aborted) return fail("aborted", "attach")

  const owner: NativeOwnership = {
    attached: false,
    ownershipLost: false,
    pendingCommand: false,
    profilerActive: false,
    profilerStateUncertain: false,
  }
  nativeOwnership.set(transport, owner)
  let resolveOwnershipLost!: () => void
  const ownershipLostPromise = new Promise<void>((resolve) => (resolveOwnershipLost = resolve))
  const lostListener = () => {
    if (!owner.attached) return
    owner.attached = false
    owner.ownershipLost = true
    if (owner.profilerActive) {
      owner.profilerStateUncertain = true
      if (owner.profilerStartCommand) owner.profilerStartCommand.profilerStateUncertain = true
    }
    resolveOwnershipLost()
    releaseNativeOwnership(transport, owner)
  }
  owner.lostListener = lostListener
  const failOwned = (
    reason: RendererProfilerFailure["reason"],
    failure: RendererDebugResult["failure"],
  ): RendererProfilerFailure => {
    cleanupNativeOwnership(transport, owner, commandDiagnostics, now)
    return { ok: false, reason, failure, diagnostics: commandDiagnostics }
  }
  try {
    transport.attach("1.3")
    owner.attached = true
    transport.on?.("detach", lostListener)
    const commands: {
      method: RendererProfilerCommandMethod
      params?: Readonly<Record<string, unknown>>
      failure: NonNullable<RendererDebugResult["failure"]>
    }[] = [{ method: "Profiler.enable", failure: "profiler-enable" }]
    if (options.samplingIntervalUs !== undefined)
      commands.push({
        method: "Profiler.setSamplingInterval",
        params: {
          interval: Math.min(10_000, Math.max(100, Math.trunc(options.samplingIntervalUs))),
        },
        failure: "profiler-sampling",
      })
    commands.push({ method: "Profiler.start", failure: "profiler-start" })
    for (const { method, params, failure } of commands) {
      const result = await runOwnedCommand<unknown>({
        transport,
        owner,
        diagnostics: commandDiagnostics,
        method,
        ...(params ? { params } : {}),
        timeoutMs: remaining(),
        signal: options.signal,
        now,
        onDiagnosticsChange: options.onDiagnosticsChange,
      })
      if (!result.ok) {
        return failOwned(failedReason(result), failure)
      }
      let attached: boolean
      try {
        attached = transport.isAttached()
      } catch {
        owner.ownershipLost = true
        owner.attached = false
        return failOwned("unavailable", failure)
      }
      if (owner.ownershipLost || !attached) {
        owner.ownershipLost = true
        owner.attached = false
        return failOwned("lifecycle-lost", failure)
      }
    }

    let stopping: Promise<RendererProfilerStopResult> | undefined
    const session: RendererProfilerSession = {
      lost: ownershipLostPromise,
      diagnostics: commandDiagnostics,
      stop: (stopTimeoutMs = RENDERER_DEBUG_TIMEOUT_MS, signal) => {
        if (stopping) return stopping
        const boundedStopMs = Math.min(MAX_TIMEOUT, Math.max(1, stopTimeoutMs))
        stopping = (async () => {
          let attached: boolean
          try {
            attached = !owner.ownershipLost && owner.attached && transport.isAttached()
          } catch {
            attached = false
          }
          if (!attached) {
            const cleanup = cleanupNativeOwnership(transport, owner, commandDiagnostics, now)
            return {
              ok: false,
              reason: "lifecycle-lost",
              failure: cleanup.outcome === "failed" ? "profiler-cleanup" : "lifecycle",
              diagnostics: commandDiagnostics,
            }
          }

          const stopped = await runOwnedCommand<unknown>({
            transport,
            owner,
            diagnostics: commandDiagnostics,
            method: "Profiler.stop",
            timeoutMs: boundedStopMs,
            signal,
            now,
            onDiagnosticsChange: options.onDiagnosticsChange,
          })
          const ownershipLost = owner.ownershipLost
          const cleanup = cleanupNativeOwnership(transport, owner, commandDiagnostics, now)
          if (!stopped.ok)
            return {
              ok: false,
              reason: failedReason(stopped),
              failure: "profiler-stop",
              diagnostics: commandDiagnostics,
            }
          if (ownershipLost)
            return {
              ok: false,
              reason: "lifecycle-lost",
              failure: "profiler-stop",
              diagnostics: commandDiagnostics,
            }

          const response = stopped.value
          const captured =
            response && typeof response === "object"
              ? profile((response as Record<string, unknown>).profile)
              : undefined
          if (cleanup.outcome === "failed")
            return {
              ok: false,
              reason: "cleanup-failed",
              failure: "profiler-cleanup",
              diagnostics: commandDiagnostics,
            }
          return captured && "profile" in captured
            ? { ok: true, profile: captured.profile, diagnostics: commandDiagnostics }
            : {
                ok: false,
                reason: captured?.reason ?? "profile-empty",
                failure: "profile",
                diagnostics: commandDiagnostics,
              }
        })()
        return stopping
      },
    }
    return { ok: true, session }
  } catch {
    return failOwned("error", "attach")
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
  const basePath =
    options.metadataPath ??
    join(
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
  let persistedReport: RendererDebugResult | undefined
  let lateDiagnosticsChanged = false
  let latePersistence = Promise.resolve()
  const onDiagnosticsChange = (current: RendererProfilerDiagnostics) => {
    lateDiagnosticsChanged = true
    const previous = persistedReport
    if (!previous?.path) return
    latePersistence = latePersistence
      .then(async () => {
        const latest = persistedReport
        if (!latest?.path || latest.path !== previous.path) return
        const updated = await persist(
          { ...latest, profilerDiagnostics: current },
          { ...options, metadataPath: latest.path },
        )
        if (updated.path === latest.path && persistedReport === latest) persistedReport = updated
      })
      .catch(() => {
        // A late native reply cannot invalidate the already persisted timeout/abort outcome.
      })
  }
  const started = await startRendererProfiler(renderer, {
    timeoutMs,
    signal,
    onDiagnosticsChange,
  })
  if (!started.ok) {
    const preflight =
      started.reason === "devtools-open" ||
      started.reason === "debugger-attached" ||
      started.reason === "profiler-command-pending" ||
      started.reason === "profiler-state-uncertain" ||
      started.reason === "unavailable"
    if (preflight)
      return {
        ...base,
        captured: false,
        reason: started.reason,
        ...(started.failure ? { failure: started.failure } : {}),
        profilerDiagnostics: started.diagnostics,
      }
    report = {
      ...base,
      captured: false,
      reason: started.reason,
      ...(started.failure ? { failure: started.failure } : { failure: "attach" }),
      profilerDiagnostics: started.diagnostics,
    }
  } else {
    await wait(Math.min(profileMs, remaining()), signal)
    const stopped = await started.session.stop(remaining(), signal)
    report = stopped.ok
      ? {
          ...base,
          captured: true,
          profile: stopped.profile,
          profilerDiagnostics: stopped.diagnostics,
        }
      : {
          ...base,
          captured: false,
          reason: stopped.reason,
          failure: stopped.failure,
          profilerDiagnostics: stopped.diagnostics,
        }
  }
  const saved = await persist(
    report ?? { ...base, captured: false, reason: "error", failure: "attach" },
    options,
  )
  persistedReport = saved
  if (lateDiagnosticsChanged && saved.path && saved.profilerDiagnostics)
    onDiagnosticsChange(saved.profilerDiagnostics)
  return saved
}
