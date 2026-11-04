import { Changed } from "./contract.ts"
import type { TaskPanelChange } from "./panel-state.ts"

const eventType = "rpc.lazers.tasks.changed"

export type TaskEventSource = {
  subscribe(options: {
    types: readonly [typeof eventType]
    signal: AbortSignal
  }): AsyncIterable<{ type: string; data?: unknown }>
}

/** The native shared stream announces every connection, including reconnects. */
export async function* taskChanges(
  source: TaskEventSource,
  projectDirectory: string,
  signal: AbortSignal,
): AsyncIterable<TaskPanelChange> {
  for await (const event of source.subscribe({ types: [eventType], signal })) {
    if (signal.aborted) return
    if (event.type === "server.connected") {
      yield { projectDirectory, version: 0, resnapshotRequired: true }
    } else if (event.type === eventType) {
      const change = Changed.safeParse(event.data)
      if (change.success && change.data.projectDirectory === projectDirectory) yield change.data
    }
  }
}
