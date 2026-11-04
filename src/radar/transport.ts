import type {
  ObservationChange,
  ObservationScope,
  RadarResponse,
  SnapshotResponse,
} from "../observability/contract.ts"

type RPCOptions = { location: { directory: string }; signal: AbortSignal }

export type RadarRPC = {
  snapshot(input: { scope: ObservationScope }, options: RPCOptions): Promise<SnapshotResponse>
  radar(
    input: { scope: ObservationScope; includeUnmanagedSessions: boolean },
    options: RPCOptions,
  ): Promise<RadarResponse>
  events: {
    subscribe(
      name: "changed",
      options: { signal: AbortSignal },
    ): AsyncIterable<{ location?: { directory: string }; data: ObservationChange }>
  }
}

export type RadarTransport = {
  snapshot(scope: ObservationScope, signal: AbortSignal): Promise<SnapshotResponse>
  radar(
    scope: ObservationScope,
    includeUnmanagedSessions: boolean,
    signal: AbortSignal,
  ): Promise<RadarResponse>
  changes(signal: AbortSignal): AsyncIterable<ObservationChange>
  online(): boolean
}

/** Keep OpenCode's RPC/location details at the panel boundary. */
export function createRadarTransport(
  rpc: () => RadarRPC,
  directory: string,
  online: () => boolean,
): RadarTransport {
  return {
    snapshot: (scope, signal) => rpc().snapshot({ scope }, { location: { directory }, signal }),
    radar: (scope, includeUnmanagedSessions, signal) =>
      rpc().radar({ scope, includeUnmanagedSessions }, { location: { directory }, signal }),
    changes: (signal) =>
      (async function* () {
        for await (const event of rpc().events.subscribe("changed", { signal })) {
          if (signal.aborted) return
          // Every loaded worktree has its own observation sequence, even when
          // projectID is shared. Match the location used for our read methods.
          if (event.location?.directory === directory) yield event.data
        }
      })(),
    online,
  }
}
