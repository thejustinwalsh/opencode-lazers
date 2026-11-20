import { TrajectoryHistoryCache } from "./history.ts"
import { TrajectoryLiveCache } from "./live.ts"

/**
 * The history and live caches of one project core, under ONE byte budget. The core is already
 * one per project per process and generation (`core/registry.ts`), so these exist once per
 * project, not once per plugin copy. They previously took the whole `historyCacheMB` each, so a
 * project could hold twice the configured option; now the two share it.
 *
 * Split: history holds whole serialized reports and takes three quarters; live holds one
 * panel's serialized events per baseline and takes the rest. Not measured separately: the
 * budget they share is `DEFAULT_HISTORY_CACHE_MB`, measured on the owner's data.
 */
export function trajectoryCachePair(secret: Uint8Array, totalBytes: number) {
  const history = Math.floor(totalBytes * 0.75)
  return {
    history: new TrajectoryHistoryCache(secret, { maxBytes: history }),
    live: new TrajectoryLiveCache({ maxBytes: totalBytes - history }),
  }
}
