import type { Columns } from "../frame.ts"
import { sourceRef, type SourceRef } from "../source.ts"

/**
 * `observability.liveHistory`, the part a consumer without a database needs: the name, the
 * columns of a row, the filter and the row's shape as a history item. The GUI imports this file;
 * `live-history.ts` defines the source from the same columns, so they cannot drift apart.
 */
export const LIVE_HISTORY_SOURCE = "observability.liveHistory"

export const liveHistoryColumns = {
  seq: "int",
  at: "float",
  recorded_at: "float",
  kind: "text",
  source: "text",
  message_id: "text",
  call_id: "text",
  tool: "text",
  status: "text",
  agent: "text",
  result: "text",
  error: "text",
  route_provider: "text",
  route_model: "text",
  route_variant: "text",
  file_targets_json: "json",
  observations_json: "json",
  payload_available: "bool",
} as const satisfies Columns

export type LiveHistoryFilter = {
  projectDirectory: string
  attemptID: string
  sessionID: string
  /** The view the caller reads from; a session view reads only its own session. */
  scope: { kind: "session" | "project" | "all"; sessionID: string }
  /** Set by the service from the project's known ids; whatever the caller sends is replaced. */
  projectIDs?: string[]
  /** Only rows that carry a tool: the calls. */
  toolsOnly?: boolean
  /** Only rows observed before this time (epoch ms). */
  beforeAt?: number
}

export const liveHistoryRef: SourceRef<LiveHistoryFilter, typeof liveHistoryColumns> = sourceRef({
  name: LIVE_HISTORY_SOURCE,
  columns: liveHistoryColumns,
})

export type LiveHistoryRow = { readonly [K in keyof typeof liveHistoryColumns]: unknown }

export type LiveHistoryItem = {
  sequence: number
  at: number
  recordedAt: number | null
  kind: string
  source: string
  messageID: string | null
  callID: string | null
  tool: string | null
  status: string | null
  agent: string | null
  result: string | null
  error: string | null
  route: { providerID: string; modelID: string; variant: string | null } | null
  observations: {
    eventID: string | null
    eventType: string
    at: number | null
    status: string | null
  }[]
  payloadAvailable: boolean
  fileTargets?: {
    coverage: "observed" | "partial" | "omitted"
    operation: "read" | "edit" | "patch" | null
    paths: string[]
  }
}

/** A stream row as the history item the contract describes. */
export function liveHistoryItem(row: LiveHistoryRow): LiveHistoryItem {
  const fileTargets = row.file_targets_json as LiveHistoryItem["fileTargets"] | null
  return {
    sequence: row.seq as number,
    at: row.at as number,
    recordedAt: row.recorded_at as number | null,
    kind: row.kind as string,
    source: row.source as string,
    messageID: row.message_id as string | null,
    callID: row.call_id as string | null,
    tool: row.tool as string | null,
    status: row.status as string | null,
    agent: row.agent as string | null,
    result: row.result as string | null,
    error: row.error as string | null,
    route:
      row.route_provider === null
        ? null
        : {
            providerID: row.route_provider as string,
            modelID: row.route_model as string,
            variant: row.route_variant as string | null,
          },
    observations: row.observations_json as LiveHistoryItem["observations"],
    payloadAvailable: row.payload_available as boolean,
    ...(fileTargets ? { fileTargets } : {}),
  }
}
