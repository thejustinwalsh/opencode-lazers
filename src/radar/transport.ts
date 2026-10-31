import type {
  ObservationChange,
  ObservationScope,
  SnapshotResponse,
} from "../observability/contract.ts"

type RPCOptions = { location: { directory: string }; signal: AbortSignal }

export type RadarRPC = {
  snapshot(input: { scope: ObservationScope }, options: RPCOptions): Promise<SnapshotResponse>
  events: {
    subscribe(
      name: "changed",
      options: { signal: AbortSignal },
    ): AsyncIterable<{ data: ObservationChange }>
  }
}

export type RadarTransport = {
  snapshot(scope: ObservationScope, signal: AbortSignal): Promise<SnapshotResponse>
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
    changes: (signal) =>
      (async function* () {
        for await (const event of rpc().events.subscribe("changed", { signal })) yield event.data
      })(),
    online,
  }
}
