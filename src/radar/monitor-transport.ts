import { RadarLocationNotLoadedError } from "./project.ts"
import type {
  LiveHistoryResponse,
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
  liveHistory(
    input: { scope: ObservationScope; sessionID: string; limit: number; cursor?: string },
    options: RPCOptions,
  ): Promise<LiveHistoryResponse>
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
  liveHistory(
    scope: ObservationScope,
    sessionID: string,
    cursor: string | undefined,
    signal: AbortSignal,
  ): Promise<LiveHistoryResponse>
  changes(signal: AbortSignal): AsyncIterable<ObservationChange>
  online(): boolean
}

/** The monitor's primary adapter intentionally has no legacy snapshot/radar methods. */
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
    liveHistory: async (scope, sessionID, cursor, signal) => {
      await requireLoaded()
      return rpc().liveHistory(
        { scope, sessionID, limit: 20, ...(cursor ? { cursor } : {}) },
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
