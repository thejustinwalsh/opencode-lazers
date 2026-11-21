import { RadarLocationNotLoadedError } from "./project.ts"
import type {
  LiveRadarResponse,
  ObservationChange,
  ObservationScope,
} from "../observability/contract.ts"

type RPCOptions = { location: { directory: string }; signal: AbortSignal }

export type RadarMonitorRPC = {
  liveRadar(
    input: { scope: ObservationScope; includeUnmanagedSessions: boolean },
    options: RPCOptions,
  ): Promise<LiveRadarResponse>
  events: {
    subscribe(
      name: "changed",
      options: { signal: AbortSignal },
    ): AsyncIterable<{ location?: { directory: string }; data: ObservationChange }>
  }
}

export type RadarMonitorTransport = {
  liveRadar(
    scope: ObservationScope,
    includeUnmanagedSessions: boolean,
    signal: AbortSignal,
  ): Promise<LiveRadarResponse>
  changes(signal: AbortSignal): AsyncIterable<ObservationChange>
  online(): boolean
}

/**
 * The monitor's live read: the sessions half of the Radar until `radar.sessions` replaces it (Task
 * 3). The worker pane and the Map groups read streams (`radar-streams.ts`).
 */
export function createRadarMonitorTransport(
  rpc: () => RadarMonitorRPC,
  directory: string,
  online: () => boolean,
  projectID: string,
  /** Location-scoped calls boot an unloaded location; skip them unless it is loaded. */
  locationLoaded: () => Promise<boolean> = async () => true,
): RadarMonitorTransport {
  const requireLoaded = async () => {
    if (!(await locationLoaded())) throw new RadarLocationNotLoadedError(directory)
  }
  return {
    liveRadar: async (scope, includeUnmanagedSessions, signal) => {
      await requireLoaded()
      return rpc().liveRadar(
        { scope, includeUnmanagedSessions },
        { location: { directory }, signal },
      )
    },
    changes: (signal) =>
      (async function* () {
        for await (const event of rpc().events.subscribe("changed", { signal })) {
          if (signal.aborted) return
          if (event.data.projectID === projectID) yield event.data
        }
      })(),
    online,
  }
}
