import { Changed } from "../observability/contract.ts"
import type { ObservationChange } from "../observability/contract.ts"

const eventType = "rpc.lazers.observability.changed"
export type TrajectoryChange =
  | ObservationChange
  | {
      projectID: string
      sequence: number
      resnapshotRequired: true
    }
export type TrajectoryEventSource = {
  subscribe(options: {
    types: readonly [typeof eventType]
    signal: AbortSignal
  }): AsyncIterable<{ type: string; location?: { directory: string }; data?: unknown }>
}

/** Native connection announcements include reconnections hidden by the RPC event wrapper. */
export async function* trajectoryChanges(
  source: TrajectoryEventSource,
  projectID: string,
  directory: string,
  signal: AbortSignal,
): AsyncIterable<TrajectoryChange> {
  for await (const event of source.subscribe({ types: [eventType], signal })) {
    if (signal.aborted) return
    if (event.type === "server.connected") {
      yield { projectID, sequence: 0, resnapshotRequired: true }
    } else if (event.type === eventType && event.location?.directory === directory) {
      const change = Changed.safeParse(event.data)
      if (change.success && change.data.projectID === projectID) yield change.data
    }
  }
}
