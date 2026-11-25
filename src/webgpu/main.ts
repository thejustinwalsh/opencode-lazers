import type { Plugin } from "@opencode/plugin/gui"
import { Schema } from "effect"
import { ModelCache, modelCacheDirectory } from "./cache.ts"
import { ModelFiles } from "./ipc.ts"
import type { ModelLeaseAcquire, ModelLeaseIdentity } from "./ipc.ts"
import { DECISION_FILES, DECISION_REVISION, decisionURL } from "./manifest.ts"
import { dirname, join } from "node:path"
import { pid } from "node:process"
import { performance } from "node:perf_hooks"
import { ModelLease, ModelLeasePersistenceSchema } from "./lease.ts"
import type { InferenceTraceEvent } from "./inference-trace.ts"
import {
  captureRendererDebug,
  RENDERER_DEBUG_PROFILE_MS,
  RENDERER_DEBUG_TIMEOUT_MS,
} from "./renderer-debug.ts"
import {
  RendererArmedCaptureManager,
  RENDERER_ARMED_NEXT_JOB_MS,
  RENDERER_ARMED_RECORDING_MS,
  RENDERER_ARMED_SAMPLING_INTERVAL_US,
  RENDERER_ARMED_STOP_MS,
} from "./renderer-armed-capture.ts"
import { DesktopInferenceRelay } from "./relay/desktop.ts"
import { RendererActivity } from "./renderer-activity.ts"

const ProcessLeaseSchema = Schema.Struct({
  ...ModelLeasePersistenceSchema.fields,
  processIdentity: Schema.optionalKey(Schema.String),
})

const safeRendererPID = (window: { webContents: { getOSProcessId(): number } }) => {
  try {
    const pid = window.webContents.getOSProcessId()
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

export const setupMain: Plugin.MainSetup = (ctx) => {
  // Main-only: renderer module evaluation must not read Node process exports.
  const processIdentity = `${pid}:${performance.timeOrigin}`
  const rendererActivity = new RendererActivity(() =>
    ctx.windows.list().map((window) => window.webContents),
  )
  const inferenceRelay = new DesktopInferenceRelay(
    () => ctx.client,
    ctx.signal ?? new AbortController().signal,
    { onActivity: (active) => rendererActivity.set(active) },
  )
  const configured = ctx.options.dataDirectory
  if (configured !== undefined && typeof configured !== "string")
    throw new Error("dataDirectory must be a string")
  const cache = new ModelCache(modelCacheDirectory(configured))
  const decisions = new ModelCache(
    join(dirname(cache.directory), DECISION_REVISION),
    DECISION_FILES,
    fetch,
    decisionURL,
  )
  const persistedLease = ctx.storage.store("webgpu-model-lease", {
    schema: Schema.Unknown,
    initial: null,
  })
  const persistedValue = persistedLease.value
  const storedLease =
    persistedValue === null
      ? undefined
      : Schema.decodeUnknownSync(ProcessLeaseSchema)(persistedValue)
  // GPU allocations cannot survive the Desktop process. Durable cache files can.
  // Adopt untagged records conservatively: this may be an upgrade in a live
  // renderer. Stamping them makes the next Desktop restart recover automatically.
  const previousLease =
    storedLease && (!storedLease.processIdentity || storedLease.processIdentity === processIdentity)
      ? storedLease
      : undefined
  let providerEpoch = ""
  const lease = new ModelLease(
    async () => {
      await Promise.all([cache.stop(), decisions.stop()])
    },
    previousLease,
    (state) => {
      const current = persistedLease.value
      if (current !== null) {
        const currentLease = Schema.decodeUnknownSync(ProcessLeaseSchema)(current)
        const currentEpoch = currentLease.providerEpoch
        if (
          currentLease.processIdentity === processIdentity &&
          currentEpoch !== providerEpoch &&
          currentEpoch !== previousLease?.providerEpoch
        )
          throw new Error("A stale main-process provider cannot replace newer ownership state")
      }
      persistedLease.set({ ...state, processIdentity })
    },
  )
  providerEpoch = lease.providerEpoch
  lease.persist()
  const lastTrace = new Map<number, InferenceTraceEvent>()
  const freezeCaptures = new Set<number>()
  const diagnosticsDirectory = join(dirname(dirname(cache.directory)), "diagnostics")
  const writeLog = (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    data: Readonly<Record<string, unknown>>,
  ) => {
    try {
      ctx.log.write(level, message, data)
    } catch {
      // Diagnostics must never interrupt inference or lease cleanup.
    }
  }
  const leaseLogOperations = new Set<string>()
  const inFlightLeaseOperations = new Set<Promise<unknown>>()
  const trackLeaseOperation = <T>(operation: Promise<T>) => {
    inFlightLeaseOperations.add(operation)
    void operation.then(
      () => inFlightLeaseOperations.delete(operation),
      () => inFlightLeaseOperations.delete(operation),
    )
    return operation
  }
  const logLeaseOperation = (
    event: string,
    windowID: number,
    identity: {
      generationID: string
      generationSequence: number
      operationID: string
      providerEpoch: string
    },
    retirementID?: string,
  ) => {
    const key = `${event}:${identity.operationID}:${retirementID ?? ""}`
    if (leaseLogOperations.has(key)) return
    leaseLogOperations.add(key)
    if (leaseLogOperations.size > 32)
      leaseLogOperations.delete(leaseLogOperations.values().next().value!)
    writeLog("info", `LAZERS WebGPU lease ${event}`, {
      windowID,
      generationID: identity.generationID.slice(0, 100),
      generationSequence: identity.generationSequence,
      operationID: identity.operationID.slice(0, 100),
      providerEpoch: identity.providerEpoch.slice(0, 100),
      ...(retirementID ? { retirementID: retirementID.slice(0, 100) } : {}),
    })
  }
  const armedCaptures = new RendererArmedCaptureManager({
    directory: diagnosticsDirectory,
    onFinalized: (status) =>
      writeLog(status.captured ? "info" : "warn", "LAZERS armed renderer CPU capture", {
        ...(status.captureID ? { captureID: status.captureID } : {}),
        ...(status.lastStage ? { lastStage: status.lastStage } : {}),
        ...(status.lastRequestID ? { lastRequestID: status.lastRequestID } : {}),
        ...(status.lastJobID ? { lastJobID: status.lastJobID } : {}),
        captured: status.captured ?? false,
        ...(status.reason ? { reason: status.reason } : {}),
        ...(status.failure ? { failure: status.failure } : {}),
        ...(status.path ? { path: status.path } : {}),
        ...(status.profilePath ? { profilePath: status.profilePath } : {}),
        ...(status.stopTrigger ? { stopTrigger: status.stopTrigger } : {}),
        ...(status.outcome ? { outcome: status.outcome } : {}),
        ...(status.triggeredAt === undefined ? {} : { triggeredAt: status.triggeredAt }),
        ...(status.profilerCommands ? { profilerCommands: status.profilerCommands } : {}),
        ...(status.profilerCleanup ? { profilerCleanup: status.profilerCleanup } : {}),
        stageCount: status.stageCount,
        ...(status.stageHistoryDropped ? { stageHistoryDropped: status.stageHistoryDropped } : {}),
      }),
  })
  const lifecycleData = (window: NonNullable<ReturnType<typeof ctx.windows.get>>) => {
    const trace = lastTrace.get(window.id)
    const rendererPID = safeRendererPID(window)
    return {
      windowID: window.id,
      ...(rendererPID === undefined ? {} : { rendererPID }),
      lastStage: trace?.stage ?? "none",
      ...(trace?.requestID ? { lastRequestID: trace.requestID } : {}),
      ...(trace?.jobID ? { lastJobID: trace.jobID } : {}),
    }
  }
  const lost = (window: number, closed = false) => {
    const operation = (closed ? lease.closed(window) : lease.lost(window)).then(() => {})
    void trackLeaseOperation(operation).catch((error: unknown) => {
      writeLog("error", "LAZERS cache ownership cleanup failed", {
        windowID: window,
        error: String(error),
      })
    })
  }
  const watch = (window: NonNullable<ReturnType<typeof ctx.windows.get>>) => {
    rendererActivity.watch(window.webContents)
    const disconnected = () => lost(window.id)
    const unresponsive = () => {
      const correlation = lifecycleData(window)
      writeLog("warn", "LAZERS WebGPU renderer unresponsive", correlation)
      if (armedCaptures.hasActive(window.id)) {
        void armedCaptures.lifecycleLost(window.id, "unresponsive")
        return
      }
      if (armedCaptures.suppressesAutomaticCapture(window.id)) return
      if (freezeCaptures.has(window.id)) return
      freezeCaptures.add(window.id)
      void captureRendererDebug({
        renderer: window.webContents,
        correlation,
        directory: diagnosticsDirectory,
        signal: ctx.signal,
      })
        .then((result) => {
          writeLog(result.captured ? "info" : "warn", "LAZERS renderer debugger capture", {
            windowID: result.windowID,
            ...(result.rendererPID === undefined ? {} : { rendererPID: result.rendererPID }),
            lastStage: result.lastStage,
            ...(result.lastRequestID ? { lastRequestID: result.lastRequestID } : {}),
            ...(result.lastJobID ? { lastJobID: result.lastJobID } : {}),
            captured: result.captured,
            ...(result.reason ? { reason: result.reason } : {}),
            ...(result.path ? { path: result.path } : {}),
            profileCaptured: Boolean(result.profile),
          })
        })
        .catch(() => {
          writeLog("warn", "LAZERS renderer debugger capture", {
            ...correlation,
            captured: false,
            reason: "error",
          })
        })
    }
    const responsive = () => {
      freezeCaptures.delete(window.id)
      writeLog("info", "LAZERS WebGPU renderer responsive", lifecycleData(window))
    }
    const rendererGone = (_event: unknown, details: { reason?: string }) => {
      void armedCaptures.lifecycleLost(window.id, "lifecycle-loss")
      writeLog("error", "LAZERS WebGPU renderer process gone", {
        ...lifecycleData(window),
        ...(details.reason ? { reason: details.reason.slice(0, 80) } : {}),
      })
    }
    const navigated = () => {
      writeLog("info", "LAZERS WebGPU renderer navigated", lifecycleData(window))
      void armedCaptures.lifecycleLost(window.id, "lifecycle-loss")
      disconnected()
    }
    window.on("unresponsive", unresponsive)
    window.on("responsive", responsive)
    window.webContents.on("render-process-gone", rendererGone)
    window.webContents.on("render-process-gone", disconnected)
    // A reload destroys this renderer's GPU resources even when the BrowserWindow survives.
    window.webContents.on("did-navigate", navigated)
    ctx.onCleanup(() => {
      window.removeListener("unresponsive", unresponsive)
      window.removeListener("responsive", responsive)
      window.webContents.removeListener("render-process-gone", rendererGone)
      window.webContents.removeListener("render-process-gone", disconnected)
      window.webContents.removeListener("did-navigate", navigated)
    })
  }
  for (const window of ctx.windows.list()) watch(window)
  ctx.windows.on("open", watch)
  ctx.windows.on("close", (window) => {
    lastTrace.delete(window.id)
    freezeCaptures.delete(window.id)
    void armedCaptures.close(window.id)
    lost(window.id, true)
  })
  ctx.provide(ModelFiles, {
    identity: (_input, caller) => ({
      providerEpoch: lease.providerEpoch,
      windowID: caller.window,
      ...(lease.previousProviderEpoch && lease.previousProviderState
        ? {
            previousProviderEpoch: lease.previousProviderEpoch,
            previousProviderState: lease.previousProviderState,
          }
        : {}),
    }),
    registerGeneration: ({ generationID, generationSequence }, caller) => {
      caller.signal.throwIfAborted()
      const registration = lease.registerGeneration(caller.window, generationID, generationSequence)
      return registration === undefined ? undefined : trackLeaseOperation(registration)
    },
    status: async () => ({ ...(await cache.status()), occupied: lease.occupied() }),
    decisionStatus: async () => ({ ...(await decisions.status()), occupied: lease.occupied() }),
    acquire: (request: ModelLeaseAcquire, caller) => {
      caller.signal.throwIfAborted()
      const acquisition = trackLeaseOperation(lease.acquire(caller.window, request))
      logLeaseOperation(
        request.predecessor ? "handoff" : "acquire",
        caller.window,
        request,
        request.predecessor?.retirementID,
      )
      return acquisition
    },
    reconcileAcquire: async (identity, caller) => {
      caller.signal.throwIfAborted()
      const found = await lease.reconcileAcquire(caller.window, identity)
      return { lease: found ?? null }
    },
    ensure: async (identity: ModelLeaseIdentity, caller) => {
      caller.signal.throwIfAborted()
      lease.assert(caller.window, identity)
      await cache.ensure(caller.signal)
    },
    decisionEnsure: async (identity: ModelLeaseIdentity, caller) => {
      caller.signal.throwIfAborted()
      lease.assert(caller.window, identity)
      await decisions.ensure(caller.signal)
    },
    decisionRead: ({ id, offset, length, ...identity }, caller) => {
      caller.signal.throwIfAborted()
      lease.assert(caller.window, identity)
      return decisions.read(id, offset, length)
    },
    read: ({ id, offset, length, ...identity }, caller) => {
      caller.signal.throwIfAborted()
      lease.assert(caller.window, identity)
      return cache.read(id, offset, length)
    },
    release: ({ lease: identity, retirementID, rendererDisposalID }, caller) => {
      caller.signal.throwIfAborted()
      const retirement = trackLeaseOperation(
        lease.release(caller.window, {
          lease: identity,
          retirementID,
          rendererDisposalID,
        }),
      )
      logLeaseOperation("retirement", caller.window, identity, retirementID)
      return retirement
    },
    reconcileRelease: async (request, caller) => {
      caller.signal.throwIfAborted()
      const retirement = await lease.reconcileRelease(caller.window, request)
      return { retirement: retirement ?? null }
    },
    cancel: (identity, caller) => {
      caller.signal.throwIfAborted()
      lease.assert(caller.window, identity)
      cache.cancel()
      decisions.cancel()
    },
    trace: (event, caller) => {
      lastTrace.set(caller.window, event)
      armedCaptures.trace(caller.window, event)
      writeLog("info", "LAZERS WebGPU inference trace", {
        windowID: caller.window,
        ...event,
      })
    },
    rendererCaptureStatus: (_, caller) => armedCaptures.status(caller.window),
    armRendererCapture: async (_, caller) => {
      const window = ctx.windows.get(caller.window)
      if (!window) throw new Error("The renderer window is unavailable")
      return armedCaptures.arm(caller.window, window.webContents, lifecycleData(window))
    },
    stopRendererCapture: (_, caller) => armedCaptures.stop(caller.window),
    clear: async () => {
      await trackLeaseOperation(
        lease.clear(async () => {
          await cache.clear()
          await decisions.clear()
        }),
      )
    },
  })
  writeLog("info", "LAZERS WebGPU cache available", {
    directory: cache.directory,
    diagnosticsDirectory,
    rendererDebugProfileMs: RENDERER_DEBUG_PROFILE_MS,
    rendererDebugTimeoutMs: RENDERER_DEBUG_TIMEOUT_MS,
    rendererArmedNextJobMs: RENDERER_ARMED_NEXT_JOB_MS,
    rendererArmedRecordingMs: RENDERER_ARMED_RECORDING_MS,
    rendererArmedSamplingIntervalUs: RENDERER_ARMED_SAMPLING_INTERVAL_US,
    rendererArmedStopMs: RENDERER_ARMED_STOP_MS,
  })
  // Start owned relay timers and event subscriptions only after all fallible
  // setup work has completed, so failed initialization cannot leak resources.
  inferenceRelay.start()
  let stopping: Promise<void> | undefined
  return () => {
    if (stopping) return stopping
    lease.seal()
    stopping = (async () => {
      try {
        await inferenceRelay.close()
        while (inFlightLeaseOperations.size)
          await Promise.allSettled(Array.from(inFlightLeaseOperations))
        await armedCaptures.shutdown()
        await Promise.all([cache.stop(), decisions.stop()])
        lease.providerStopped()
      } catch (error) {
        try {
          lease.providerStopFailed()
        } catch {
          // A failed persistent write must leave the prior durable state unproven.
        }
        throw error
      } finally {
        rendererActivity.set(false)
      }
    })()
    return stopping
  }
}
