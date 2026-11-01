import type { Plugin } from "@opencode/plugin/gui"
import { ModelCache, modelCacheDirectory } from "./cache.ts"
import { ModelFiles } from "./ipc.ts"
import { DECISION_FILES, DECISION_REVISION, decisionURL } from "./manifest.ts"
import { dirname, join } from "node:path"
import { ModelLease } from "./lease.ts"
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

const safeRendererPID = (window: { webContents: { getOSProcessId(): number } }) => {
  try {
    const pid = window.webContents.getOSProcessId()
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

export const setupMain: Plugin.MainSetup = (ctx) => {
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
  const lease = new ModelLease(async () => {
    await Promise.all([cache.stop(), decisions.stop()])
  })
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
  const lost = (window: number) => {
    void lease.lost(window).catch((error: unknown) => {
      writeLog("error", "LAZERS cache ownership cleanup failed", {
        windowID: window,
        error: String(error),
      })
    })
  }
  const watch = (window: NonNullable<ReturnType<typeof ctx.windows.get>>) => {
    const disconnected = () => lost(window.id)
    const unresponsive = () => {
      const correlation = lifecycleData(window)
      writeLog("warn", "LAZERS WebGPU renderer unresponsive", correlation)
      if (armedCaptures.hasActive(window.id)) {
        void armedCaptures.lifecycleLost(window.id, "unresponsive")
        return
      }
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
    lost(window.id)
  })
  ctx.provide(ModelFiles, {
    status: async () => ({ ...(await cache.status()), occupied: lease.occupied() }),
    decisionStatus: async () => ({ ...(await decisions.status()), occupied: lease.occupied() }),
    acquire: (_, caller) => lease.acquire(caller.window),
    ensure: async ({ owner: token }, caller) => {
      lease.assert(caller.window, token)
      await cache.ensure(caller.signal)
    },
    decisionEnsure: async ({ owner: token }, caller) => {
      lease.assert(caller.window, token)
      await decisions.ensure(caller.signal)
    },
    decisionRead: ({ owner: token, id, offset, length }, caller) => {
      lease.assert(caller.window, token)
      return decisions.read(id, offset, length)
    },
    read: ({ owner: token, id, offset, length }, caller) => {
      lease.assert(caller.window, token)
      return cache.read(id, offset, length)
    },
    release: ({ owner: token }, caller) => {
      return lease.release(caller.window, token)
    },
    cancel: ({ owner: token }, caller) => {
      lease.assert(caller.window, token)
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
      await lease.clear(async () => {
        await cache.clear()
        await decisions.clear()
      })
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
  return async () => {
    await armedCaptures.shutdown()
    await Promise.all([cache.stop(), decisions.stop()])
  }
}
