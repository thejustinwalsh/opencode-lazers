import type { InferenceTraceEvent, TraceStage } from "./inference-trace.ts"
import {
  persistRendererDebugResult,
  RENDERER_DEBUG_TIMEOUT_MS,
  startRendererProfiler,
} from "./renderer-debug.ts"
import type {
  DebuggableRenderer,
  RendererArmedMetadata,
  RendererArmedStopTrigger,
  RendererDebugCorrelation,
  RendererDebugPersistenceOptions,
  RendererDebugResult,
  RendererProfilerDiagnostics,
  RendererProfilerCommandObservation,
  RendererProfilerCleanupObservation,
  RendererProfilerSession,
} from "./renderer-debug.ts"

export const RENDERER_ARMED_NEXT_JOB_MS = 60_000
export const RENDERER_ARMED_RECORDING_MS = 120_000
export const RENDERER_ARMED_SAMPLING_INTERVAL_US = 10_000
export const RENDERER_ARMED_STOP_MS = 2_000

const MAX_STAGE_HISTORY = 64
const MAX_ID_LENGTH = 100
const MAX_TRACE_TIME = 86_400_000
const TERMINAL_STAGES = new Set<TraceStage>([
  "complete",
  "cancelled",
  "context-overflow",
  "device-lost",
  "error",
])

export type RendererArmedCaptureStatus = {
  state: "idle" | "preparing" | "waiting" | "recording" | "stopping" | "complete"
  message: string
  captureID?: string
  lastStage?: string
  lastRequestID?: string
  lastJobID?: string
  stageCount: number
  stageHistoryDropped?: number
  captured?: boolean
  reason?: NonNullable<RendererDebugResult["reason"]>
  failure?: NonNullable<RendererDebugResult["failure"]>
  path?: string
  profilePath?: string
  stopTrigger?: RendererArmedStopTrigger
  outcome?: "captured" | "failed"
  triggeredAt?: number
  profilerCommands?: readonly RendererProfilerCommandObservation[]
  profilerCleanup?: RendererProfilerCleanupObservation
}

export type RendererArmedCaptureOptions = RendererDebugPersistenceOptions & {
  prepareTimeoutMs?: number
  nextJobMs?: number
  recordingMs?: number
  stopTimeoutMs?: number
  samplingIntervalUs?: number
  now?: () => number
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  cancel?: (timer: ReturnType<typeof setTimeout>) => void
  onFinalized?: (status: RendererArmedCaptureStatus) => void
}

type SafeTrace = {
  requestID: string
  jobID: string
  stage: TraceStage
  elapsedMs: number
  deltaMs: number
  mode?: string
  feature?: string
}

type StopRequest = {
  trigger: RendererArmedStopTrigger
  triggeredAt: number
  failure?: NonNullable<RendererDebugResult["failure"]>
  reason?: NonNullable<RendererDebugResult["reason"]>
}

type Entry = {
  windowID: number
  renderer: DebuggableRenderer
  correlation: RendererDebugCorrelation
  captureID: string
  armedAt: number
  state: RendererArmedCaptureStatus["state"]
  controller: AbortController
  session?: RendererProfilerSession
  timer?: ReturnType<typeof setTimeout>
  preparation?: Promise<void>
  finalization?: Promise<RendererArmedCaptureStatus>
  pendingStop?: StopRequest
  profilerDiagnostics?: RendererProfilerDiagnostics
  target?: SafeTrace
  jobStartedAt?: number
  profilerStartedAt?: number
  preparationRace: boolean
  ignoredJobs: Set<string>
  stageHistory: { stage: string; elapsedMs: number; deltaMs: number }[]
  stageHistoryDropped: number
  result?: RendererDebugResult
  lateDiagnosticsChanged?: boolean
  latePersistence?: Promise<void>
}

const boundedID = (value: unknown) =>
  typeof value === "string" && value.length > 0 ? value.slice(0, MAX_ID_LENGTH) : undefined

const traceTime = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(MAX_TRACE_TIME, Math.max(0, Math.trunc(value)))
    : 0

const safeTrace = (event: InferenceTraceEvent): SafeTrace | undefined => {
  const requestID = boundedID(event.requestID)
  const jobID = boundedID(event.jobID)
  if (!requestID || !jobID) return undefined
  return {
    requestID,
    jobID,
    stage: event.stage,
    elapsedMs: traceTime(event.elapsedMs),
    deltaMs: traceTime(event.deltaMs),
    ...(event.mode ? { mode: event.mode } : {}),
    ...(event.feature ? { feature: event.feature } : {}),
  }
}

const keyOf = (trace: Pick<SafeTrace, "requestID" | "jobID">) =>
  JSON.stringify([trace.requestID, trace.jobID])

const terminal = (stage: TraceStage) => TERMINAL_STAGES.has(stage)
const active = (entry: Entry) =>
  entry.state === "preparing" ||
  entry.state === "waiting" ||
  entry.state === "recording" ||
  entry.state === "stopping"

/** Main-process owner for one explicitly armed CPU profile per renderer window. */
export class RendererArmedCaptureManager {
  readonly #entries = new Map<number, Entry>()
  readonly #activeJobs = new Map<number, Map<string, SafeTrace>>()
  readonly #failedArmingWindows = new Set<number>()
  readonly #options: RendererArmedCaptureOptions
  readonly #now: () => number
  readonly #schedule: NonNullable<RendererArmedCaptureOptions["schedule"]>
  readonly #cancel: NonNullable<RendererArmedCaptureOptions["cancel"]>

  constructor(options: RendererArmedCaptureOptions) {
    this.#options = options
    this.#now = options.now ?? Date.now
    this.#schedule = options.schedule ?? ((callback, delay) => setTimeout(callback, delay))
    this.#cancel = options.cancel ?? clearTimeout
  }

  hasActive(windowID: number) {
    const entry = this.#entries.get(windowID)
    return entry !== undefined && active(entry)
  }

  suppressesAutomaticCapture(windowID: number) {
    return this.#failedArmingWindows.has(windowID)
  }

  status(windowID: number): RendererArmedCaptureStatus {
    const entry = this.#entries.get(windowID)
    if (!entry)
      return { state: "idle", message: "No renderer CPU capture is armed.", stageCount: 0 }
    if (entry.result) return this.#summary(entry, entry.result)
    return {
      state: entry.state,
      message:
        entry.state === "preparing"
          ? "Preparing the renderer CPU profiler; waiting for acknowledged enable and start."
          : entry.state === "waiting"
            ? "Profiler is armed; waiting up to 60 seconds for the next local inference job."
            : entry.state === "recording"
              ? "Recording the targeted local inference job."
              : entry.state === "stopping"
                ? "Stopping the renderer CPU profiler and saving bounded diagnostics."
                : "No renderer CPU capture is armed.",
      captureID: entry.captureID,
      ...(entry.target
        ? {
            lastStage: entry.target.stage,
            lastRequestID: entry.target.requestID,
            lastJobID: entry.target.jobID,
          }
        : {}),
      stageCount: entry.stageHistory.length,
      ...(entry.stageHistoryDropped ? { stageHistoryDropped: entry.stageHistoryDropped } : {}),
    }
  }

  async arm(
    windowID: number,
    renderer: DebuggableRenderer,
    correlation: RendererDebugCorrelation,
  ): Promise<RendererArmedCaptureStatus> {
    const existing = this.#entries.get(windowID)
    if (existing && active(existing)) return this.status(windowID)

    const running = this.#activeJobs.get(windowID)
    const entry: Entry = {
      windowID,
      renderer,
      correlation: {
        windowID,
        ...(correlation.rendererPID === undefined ? {} : { rendererPID: correlation.rendererPID }),
        lastStage: "none",
      },
      captureID: crypto.randomUUID(),
      armedAt: this.#now(),
      state: "preparing",
      controller: new AbortController(),
      preparationRace: false,
      ignoredJobs: new Set(running?.keys() ?? []),
      stageHistory: [],
      stageHistoryDropped: 0,
    }
    this.#entries.set(windowID, entry)
    entry.preparation = this.#prepare(entry)
    await entry.preparation
    return this.status(windowID)
  }

  trace(windowID: number, event: InferenceTraceEvent) {
    const trace = safeTrace(event)
    if (!trace) return
    const key = keyOf(trace)
    const running = this.#activeJobs.get(windowID) ?? new Map<string, SafeTrace>()
    const wasActive = running.has(key)
    const entry = this.#entries.get(windowID)

    if (entry && active(entry) && !entry.ignoredJobs.has(key)) {
      if (entry.state === "preparing" && !wasActive && !terminal(trace.stage)) {
        this.#bind(entry, trace, true)
      } else if (
        entry.state === "preparing" &&
        entry.target?.requestID === trace.requestID &&
        entry.target.jobID === trace.jobID
      ) {
        this.#appendStage(entry, trace)
      } else if (entry.state === "waiting" && !wasActive && !terminal(trace.stage)) {
        this.#bind(entry, trace, false)
        entry.state = "recording"
        this.#setTimer(
          entry,
          "recording-timeout",
          this.#options.recordingMs ?? RENDERER_ARMED_RECORDING_MS,
        )
      } else if (
        entry.state === "recording" &&
        entry.target &&
        entry.target.requestID === trace.requestID &&
        entry.target.jobID === trace.jobID
      ) {
        this.#appendStage(entry, trace)
        if (terminal(trace.stage))
          void this.#finalize(entry, { trigger: "terminal", triggeredAt: this.#now() })
      }
    }

    if (terminal(trace.stage)) {
      running.delete(key)
      if (running.size === 0) this.#activeJobs.delete(windowID)
    } else {
      running.set(key, trace)
      this.#activeJobs.set(windowID, running)
    }
  }

  stop(windowID: number): Promise<RendererArmedCaptureStatus> {
    const entry = this.#entries.get(windowID)
    if (!entry || !active(entry)) return Promise.resolve(this.status(windowID))
    const trigger = entry.state === "recording" ? "manual-stop" : "manual-disarm"
    return this.#requestStop(entry, {
      trigger,
      triggeredAt: this.#now(),
      ...(!entry.target
        ? { reason: "manual-stop-before-job" as const, failure: "job-wait" as const }
        : {}),
    })
  }

  lifecycleLost(windowID: number, trigger: "unresponsive" | "lifecycle-loss" | "cleanup") {
    if (trigger === "lifecycle-loss" || trigger === "cleanup") this.#activeJobs.delete(windowID)
    const entry = this.#entries.get(windowID)
    if (!entry || !active(entry)) return Promise.resolve(this.status(windowID))
    const noTarget = !entry.target
    return this.#requestStop(entry, {
      trigger,
      triggeredAt: this.#now(),
      ...(noTarget
        ? {
            reason:
              trigger === "lifecycle-loss" || trigger === "cleanup"
                ? "lifecycle-lost"
                : "job-not-seen",
            failure:
              trigger === "lifecycle-loss" || trigger === "cleanup" ? "lifecycle" : "job-wait",
          }
        : {}),
    })
  }

  async close(windowID: number) {
    await this.lifecycleLost(windowID, "lifecycle-loss")
    this.#entries.delete(windowID)
    this.#activeJobs.delete(windowID)
    this.#failedArmingWindows.delete(windowID)
  }

  async shutdown() {
    await Promise.all(
      [...this.#entries.values()].filter(active).map((entry) =>
        this.#requestStop(entry, {
          trigger: "cleanup",
          triggeredAt: this.#now(),
          reason: "lifecycle-lost",
          failure: "lifecycle",
        }),
      ),
    )
  }

  async #prepare(entry: Entry) {
    const started = await startRendererProfiler(entry.renderer, {
      timeoutMs: this.#options.prepareTimeoutMs ?? RENDERER_DEBUG_TIMEOUT_MS,
      samplingIntervalUs: this.#options.samplingIntervalUs ?? RENDERER_ARMED_SAMPLING_INTERVAL_US,
      signal: entry.controller.signal,
      now: this.#now,
      onDiagnosticsChange: () => this.#persistLateDiagnostics(entry),
    })
    if (!started.ok) {
      entry.profilerDiagnostics = started.diagnostics
      this.#failedArmingWindows.add(entry.windowID)
      const request = entry.pendingStop
      const raced = entry.preparationRace
      const trigger = raced ? "preparation-race" : (request?.trigger ?? "arming-failure")
      const triggeredAt = request?.triggeredAt ?? this.#now()
      const result = await this.#persist(
        entry,
        {
          ...entry.correlation,
          captured: false,
          reason: raced ? "job-started-during-arming" : started.reason,
          failure: started.failure ?? "attach",
          profilerDiagnostics: started.diagnostics,
        },
        trigger,
        triggeredAt,
      )
      this.#complete(entry, result)
      return
    }

    entry.session = started.session
    entry.profilerDiagnostics = started.session.diagnostics
    this.#failedArmingWindows.delete(entry.windowID)
    void started.session.lost.then(() => {
      if (active(entry))
        void this.#requestStop(entry, {
          trigger: "lifecycle-loss",
          triggeredAt: this.#now(),
          reason: "lifecycle-lost",
          failure: "lifecycle",
        })
    })
    entry.profilerStartedAt = this.#now()
    if (entry.preparationRace) {
      entry.state = "waiting"
      await this.#finalize(entry, {
        trigger: entry.pendingStop?.trigger ?? "preparation-race",
        triggeredAt: entry.pendingStop?.triggeredAt ?? this.#now(),
        reason: "job-started-during-arming",
        failure: "profile",
      })
      return
    }
    if (entry.pendingStop) {
      entry.state = "waiting"
      await this.#finalize(entry, entry.pendingStop)
      return
    }
    entry.state = "waiting"
    this.#setTimer(entry, "next-job-timeout", this.#options.nextJobMs ?? RENDERER_ARMED_NEXT_JOB_MS)
  }

  #bind(entry: Entry, trace: SafeTrace, preparationRace: boolean) {
    if (entry.target) {
      if (entry.target.requestID === trace.requestID && entry.target.jobID === trace.jobID)
        this.#appendStage(entry, trace)
      return
    }
    entry.target = trace
    entry.preparationRace = preparationRace
    entry.jobStartedAt = this.#now()
    entry.correlation = {
      windowID: entry.windowID,
      ...(entry.correlation.rendererPID === undefined
        ? {}
        : { rendererPID: entry.correlation.rendererPID }),
      lastStage: trace.stage,
      lastRequestID: trace.requestID,
      lastJobID: trace.jobID,
    }
    this.#appendStage(entry, trace)
  }

  #appendStage(entry: Entry, trace: SafeTrace) {
    if (entry.stageHistory.length === MAX_STAGE_HISTORY) {
      entry.stageHistory.splice(1, 1)
      entry.stageHistoryDropped++
    }
    entry.stageHistory.push({
      stage: trace.stage,
      elapsedMs: trace.elapsedMs,
      deltaMs: trace.deltaMs,
    })
    if (entry.target) entry.target = trace
    entry.correlation = {
      windowID: entry.windowID,
      ...(entry.correlation.rendererPID === undefined
        ? {}
        : { rendererPID: entry.correlation.rendererPID }),
      lastStage: trace.stage,
      lastRequestID: trace.requestID,
      lastJobID: trace.jobID,
    }
  }

  #setTimer(entry: Entry, trigger: "next-job-timeout" | "recording-timeout", duration: number) {
    if (entry.timer) this.#cancel(entry.timer)
    entry.timer = this.#schedule(() => {
      void this.#finalize(entry, {
        trigger,
        triggeredAt: this.#now(),
        ...(!entry.target ? { reason: "job-not-seen" as const, failure: "job-wait" as const } : {}),
      })
    }, duration)
  }

  #requestStop(entry: Entry, request: StopRequest) {
    if (entry.finalization) return entry.finalization
    if (entry.state === "preparing") {
      entry.pendingStop ??= request
      entry.controller.abort()
      return (entry.preparation ?? Promise.resolve()).then(() => this.status(entry.windowID))
    }
    return this.#finalize(entry, request)
  }

  #finalize(entry: Entry, request: StopRequest): Promise<RendererArmedCaptureStatus> {
    if (entry.finalization) return entry.finalization
    if (entry.state === "preparing") return this.#requestStop(entry, request)
    entry.state = "stopping"
    if (entry.timer) {
      this.#cancel(entry.timer)
      entry.timer = undefined
    }
    entry.finalization = this.#finish(entry, request)
    return entry.finalization
  }

  async #finish(entry: Entry, request: StopRequest) {
    const noTarget = !entry.target
    const stop = entry.session
      ? await entry.session
          .stop(this.#options.stopTimeoutMs ?? RENDERER_ARMED_STOP_MS)
          .catch(() => ({
            ok: false as const,
            reason: "lifecycle-lost" as const,
            failure: "profiler-stop" as const,
            diagnostics: entry.profilerDiagnostics ?? { commands: [] },
          }))
      : undefined
    if (stop) entry.profilerDiagnostics = stop.diagnostics
    const stoppedAt = this.#now()
    const metadata = this.#metadata(entry, request.trigger, false, request.triggeredAt, stoppedAt)
    const canCapture = Boolean(stop?.ok && !noTarget && !entry.preparationRace)
    let report: RendererDebugResult
    if (canCapture && stop?.ok) {
      report = {
        ...entry.correlation,
        captured: true,
        profile: stop.profile,
        profilerDiagnostics: stop.diagnostics,
        armedCapture: this.#metadata(entry, request.trigger, true, request.triggeredAt, stoppedAt),
      }
    } else {
      const reason =
        stop && !stop.ok
          ? stop.reason
          : (request.reason ??
            (entry.preparationRace
              ? "job-started-during-arming"
              : noTarget
                ? request.trigger === "manual-disarm" || request.trigger === "manual-stop"
                  ? "manual-stop-before-job"
                  : request.trigger === "lifecycle-loss" || request.trigger === "cleanup"
                    ? "lifecycle-lost"
                    : "job-not-seen"
                : "error"))
      report = {
        ...entry.correlation,
        captured: false,
        reason,
        failure:
          stop && !stop.ok
            ? stop.failure
            : (request.failure ??
              (entry.preparationRace || noTarget
                ? request.trigger === "lifecycle-loss" || request.trigger === "cleanup"
                  ? "lifecycle"
                  : "job-wait"
                : "profile")),
        ...(stop ? { profilerDiagnostics: stop.diagnostics } : {}),
        armedCapture: metadata,
      }
    }
    const persisted = await this.#persist(entry, report, request.trigger, request.triggeredAt)
    this.#complete(entry, persisted)
    return this.status(entry.windowID)
  }

  #metadata(
    entry: Entry,
    stopTrigger: RendererArmedStopTrigger,
    captured: boolean,
    triggeredAt: number,
    stoppedAt: number,
  ): RendererArmedMetadata {
    return {
      captureID: entry.captureID,
      stopTrigger,
      outcome: captured ? "captured" : "failed",
      armedAt: entry.armedAt,
      triggeredAt,
      ...(entry.profilerStartedAt === undefined
        ? {}
        : { profilerStartedAt: entry.profilerStartedAt }),
      ...(entry.jobStartedAt === undefined ? {} : { jobStartedAt: entry.jobStartedAt }),
      stoppedAt,
      ...(entry.jobStartedAt === undefined
        ? {}
        : { recordingMs: Math.max(0, stoppedAt - entry.jobStartedAt) }),
      ...(entry.target
        ? {
            targetRequestID: entry.target.requestID,
            targetJobID: entry.target.jobID,
            ...(entry.target.mode ? { targetMode: entry.target.mode } : {}),
            ...(entry.target.feature ? { targetFeature: entry.target.feature } : {}),
          }
        : {}),
      stageHistory: [...entry.stageHistory],
      ...(entry.stageHistoryDropped ? { stageHistoryDropped: entry.stageHistoryDropped } : {}),
      profilerCommands: entry.profilerDiagnostics?.commands ?? [],
      ...(entry.profilerDiagnostics?.cleanup
        ? { profilerCleanup: entry.profilerDiagnostics.cleanup }
        : {}),
    }
  }

  async #persist(
    entry: Entry,
    report: RendererDebugResult,
    trigger: RendererArmedStopTrigger,
    triggeredAt: number,
    metadataPath?: string,
  ) {
    const armedCapture =
      report.armedCapture ??
      this.#metadata(entry, trigger, report.captured, triggeredAt, this.#now())
    return persistRendererDebugResult(
      { ...report, armedCapture },
      {
        ...this.#options,
        filePrefix: "renderer-armed-capture",
        ...(metadataPath ? { metadataPath } : {}),
      },
    )
  }

  #complete(entry: Entry, result: RendererDebugResult) {
    entry.state = "complete"
    const summaryResult = { ...result, profile: undefined }
    entry.result = summaryResult
    const status = this.#summary(entry, summaryResult)
    try {
      this.#options.onFinalized?.(status)
    } catch {
      // Diagnostics callbacks must not interfere with debugger ownership cleanup.
    }
    if (entry.lateDiagnosticsChanged) this.#persistLateDiagnostics(entry)
  }

  #persistLateDiagnostics(entry: Entry) {
    entry.lateDiagnosticsChanged = true
    if (!entry.result?.path || !entry.result.armedCapture) return
    const resultPath = entry.result.path
    const previous = entry.latePersistence ?? Promise.resolve()
    entry.latePersistence = previous
      .then(async () => {
        const result = entry.result
        if (!result || result.path !== resultPath || !result.armedCapture) return
        const updated = await this.#persist(
          entry,
          result,
          result.armedCapture.stopTrigger,
          result.armedCapture.triggeredAt,
          resultPath,
        )
        if (updated.path === resultPath && entry.result === result) entry.result = updated
      })
      .catch(() => {
        // A late native reply cannot invalidate the already persisted timeout/abort outcome.
      })
  }

  #summary(entry: Entry, result: RendererDebugResult): RendererArmedCaptureStatus {
    const metadata = result.armedCapture
    return {
      state: "complete",
      message: result.captured
        ? "Captured the next local inference job; its standalone CPU profile is saved."
        : `Renderer CPU capture failed${result.reason ? `: ${result.reason}` : ""}${result.failure ? ` (${result.failure})` : ""}.`,
      captureID: entry.captureID,
      ...(result.lastStage !== "none" ? { lastStage: result.lastStage } : {}),
      ...(result.lastRequestID ? { lastRequestID: result.lastRequestID } : {}),
      ...(result.lastJobID ? { lastJobID: result.lastJobID } : {}),
      stageCount: metadata?.stageHistory.length ?? entry.stageHistory.length,
      ...(metadata?.stageHistoryDropped
        ? { stageHistoryDropped: metadata.stageHistoryDropped }
        : {}),
      captured: result.captured,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.failure ? { failure: result.failure } : {}),
      ...(result.path ? { path: result.path } : {}),
      ...(result.profilePath ? { profilePath: result.profilePath } : {}),
      ...(metadata ? { stopTrigger: metadata.stopTrigger, outcome: metadata.outcome } : {}),
      ...(metadata
        ? {
            triggeredAt: metadata.triggeredAt,
            profilerCommands: metadata.profilerCommands,
            ...(metadata.profilerCleanup ? { profilerCleanup: metadata.profilerCleanup } : {}),
          }
        : {}),
    }
  }
}
