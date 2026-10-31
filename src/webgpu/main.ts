import type { Plugin } from "@opencode/plugin/gui"
import { ModelCache, modelCacheDirectory } from "./cache.ts"
import { ModelFiles } from "./ipc.ts"
import { DECISION_FILES, DECISION_REVISION, decisionURL } from "./manifest.ts"
import { dirname, join } from "node:path"
import { ModelLease } from "./lease.ts"

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
  const lost = (window: number) => {
    void lease.lost(window).catch((error: unknown) => {
      ctx.log.write("error", "LAZERS cache ownership cleanup failed", { error: String(error) })
    })
  }
  const watch = (window: NonNullable<ReturnType<typeof ctx.windows.get>>) => {
    const disconnected = () => lost(window.id)
    window.webContents.on("render-process-gone", disconnected)
    // A reload destroys this renderer's GPU resources even when the BrowserWindow survives.
    window.webContents.on("did-navigate", disconnected)
    ctx.onCleanup(() => {
      window.webContents.removeListener("render-process-gone", disconnected)
      window.webContents.removeListener("did-navigate", disconnected)
    })
  }
  for (const window of ctx.windows.list()) watch(window)
  ctx.windows.on("open", watch)
  ctx.windows.on("close", (window) => lost(window.id))
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
    clear: async () => {
      await lease.clear(async () => {
        await cache.clear()
        await decisions.clear()
      })
    },
  })
  ctx.log.write("info", "LAZERS WebGPU cache available", { directory: cache.directory })
  return async () => {
    await Promise.all([cache.stop(), decisions.stop()])
  }
}
