import { Changed } from "./contract.ts"
import type { TaskPanelChange } from "./panel-state.ts"

const eventType = "rpc.lazers.tasks.changed"
const nativeActivityEventTypes = [
  "session.created",
  "session.deleted",
  "session.moved",
  "session.archived",
  "session.unarchived",
  "session.status",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.inbox.enqueued",
  "session.inbox.delivered",
  "session.inbox.cancelled",
  "session.inbox.delivery.changed",
  "permission.asked",
  "permission.replied",
  "form.created",
  "form.replied",
  "form.cancelled",
] as const
const eventTypes = [eventType, ...nativeActivityEventTypes] as const

export type TaskEventSource = {
  subscribe(options: {
    types: typeof eventTypes
    signal: AbortSignal
  }): AsyncIterable<{ type: string; data?: unknown }>
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function sessionID(type: string, data: unknown): string | undefined {
  const payload = object(data)
  const id = type === "form.created" ? object(payload?.form)?.sessionID : payload?.sessionID
  return typeof id === "string" && id.length > 0 ? id : undefined
}

/** The native shared stream announces every connection, including reconnects. */
export async function* taskChanges(
  source: TaskEventSource,
  projectDirectory: string,
  signal: AbortSignal,
): AsyncIterable<TaskPanelChange> {
  for await (const event of source.subscribe({ types: eventTypes, signal })) {
    if (signal.aborted) return
    if (event.type === "server.connected") {
      yield { projectDirectory, version: 0, resnapshotRequired: true }
    } else if (event.type === eventType) {
      const change = Changed.safeParse(event.data)
      if (change.success && change.data.projectDirectory === projectDirectory) yield change.data
    } else if ((nativeActivityEventTypes as readonly string[]).includes(event.type)) {
      const id = sessionID(event.type, event.data)
      if (id) yield { projectDirectory, version: 0, activitySessionID: id }
    }
  }
}
