import type { Columns } from "../frame.ts"
import { sourceRef, type SourceRef } from "../source.ts"
import { RADAR_SESSIONS_SOURCE, radarSessionColumns } from "./host-sessions-ref.ts"

/**
 * The Radar sources, the part a consumer without a database needs: names, columns and filters.
 * The GUI imports this file; `radar.ts` defines the sources from the same columns.
 *
 * Reused, not redefined: the attempt's call lanes are `observability.liveHistory` (`toolsOnly`
 * for the tool lane), the lifecycle's plans are `tasks.plans`, and a plan's nodes are
 * `tasks.schedule` with `planID` and order `plan`.
 */
export const RADAR_SOURCES = {
  assignments: "radar.assignments",
  attempt: "radar.attempt",
  nativeCalls: "radar.nativeCalls",
  group: "radar.group",
  workload: "radar.workload",
  journal: "radar.journal",
  scheduler: "radar.scheduler",
  planEvents: "radar.planEvents",
  nodes: "radar.nodes",
} as const

/** The view the caller reads from: a session view reads only what that session may see. */
export type RadarScope = { kind: "session" | "project" | "all"; sessionID: string }

/** Every Radar filter: the project is set by the service, whatever the caller sends. */
type Scoped = { projectDirectory: string; scope: RadarScope }

/** Active attempts: preparing, running or verifying. A session view reads its own session's. */
export type RadarAssignmentsFilter = Scoped & { sessionID?: string }
/** The attempt of one session (worker pane). */
export type RadarAttemptFilter = Scoped & { sessionID: string }
/** One session's canonical tool calls; `nativeOnly` leaves out local invocations. */
export type RadarNativeCallsFilter = Scoped & { sessionID: string; nativeOnly?: boolean }
export type RadarGroup = "needs-you" | "failed" | "queued"
export type RadarGroupFilter = Scoped & { group: RadarGroup }
export type RadarProjectFilter = Scoped
export type RadarJournalFilter = Scoped & { attemptID?: string }
/** The nodes of one plan, with their persisted machine snapshot. */
export type RadarNodesFilter = Scoped & { planID: string }
/** The latest recorded transition per lifecycle edge of one plan node. */
export type RadarPlanEventsFilter = Scoped & { planID: string; taskID: string }

const assignmentColumns = {
  id: "text",
  session_id: "text",
  plan_id: "text",
  task_id: "text",
  number: "int",
  state: "text",
  started_at: "int",
  tool_count: "int",
  /** The admitted model, from the attempt policy. */
  model: "json",
  /** An Architect takeover attempt. */
  takeover: "bool",
  reference: "text",
  title: "text",
  node_state: "text",
  node_reason: "text",
  plan_state: "text",
  plan_reason: "text",
  concern: "json",
  /** The concern rule's recommended action and its reason, when one was recorded. */
  concern_action: "text",
  concern_because: "text",
} as const satisfies Columns
export const radarAssignmentColumns = assignmentColumns
export const radarAttemptDetail = {
  workspace: "text",
  base_commit: "text",
  artifact: "text",
} as const satisfies Columns

export const radarNativeCallColumns = {
  id: "int",
  session_id: "text",
  identity_kind: "text",
  call_id: "text",
  /** The key the old tool-detail read used: native, else context, else invocation id. */
  detail_call_id: "text",
  message_id: "text",
  agent: "text",
  tool: "text",
  attempt_id: "text",
  status: "text",
  detail: "text",
  error: "text",
  first_observed_at: "int",
  last_observed_at: "int",
} as const satisfies Columns

export const radarGroupColumns = {
  task_id: "text",
  seq: "int",
  reference: "text",
  title: "text",
} as const satisfies Columns

export const radarWorkloadColumns = {
  project_directory: "text",
  /** False while the project's task list is not indexed: the counts are then unknown, not zero. */
  ready: "bool",
  queued: "int",
  needs_you: "int",
  failed: "int",
} as const satisfies Columns

export const radarJournalColumns = {
  change_id: "int",
  session_id: "text",
  attempt_id: "text",
  source_seq: "int",
  source_kind: "text",
  change_kind: "text",
  status: "text",
  source_at: "int",
} as const satisfies Columns

export const radarSchedulerColumns = {
  project_directory: "text",
  status: "text",
  participants: "int",
  updated_at: "int",
} as const satisfies Columns

export const radarPlanEventColumns = {
  /** The `task_events` id of the edge's latest transition: the selection key. */
  id: "int",
  plan_id: "text",
  task_id: "text",
  event: "text",
  from_state: "text",
  to_state: "text",
  attempt_id: "text",
  at: "float",
} as const satisfies Columns
/** The trajectory event of the transition (`reason`, `version`), for the selected edge. */
export const radarPlanEventDetail = { detail: "json" } as const satisfies Columns

export const radarNodeColumns = {
  plan_id: "text",
  task_id: "text",
  ordinal: "int",
  state: "text",
  version: "int",
  reason: "text",
  machine_version: "text",
  /** The persisted XState snapshot (`{ status, value }`); the statechart highlights its value. */
  snapshot: "json",
} as const satisfies Columns

export const radarRefs = {
  assignments: sourceRef({ name: RADAR_SOURCES.assignments, columns: assignmentColumns }),
  attempt: sourceRef({
    name: RADAR_SOURCES.attempt,
    columns: assignmentColumns,
    detail: radarAttemptDetail,
  }),
  nativeCalls: sourceRef({ name: RADAR_SOURCES.nativeCalls, columns: radarNativeCallColumns }),
  group: sourceRef({ name: RADAR_SOURCES.group, columns: radarGroupColumns }),
  workload: sourceRef({ name: RADAR_SOURCES.workload, columns: radarWorkloadColumns }),
  journal: sourceRef({ name: RADAR_SOURCES.journal, columns: radarJournalColumns }),
  scheduler: sourceRef({ name: RADAR_SOURCES.scheduler, columns: radarSchedulerColumns }),
  planEvents: sourceRef({
    name: RADAR_SOURCES.planEvents,
    columns: radarPlanEventColumns,
    detail: radarPlanEventDetail,
  }),
  nodes: sourceRef({ name: RADAR_SOURCES.nodes, columns: radarNodeColumns }),
  /** `radar.sessions` over `host_session_state` (`host-sessions.ts`, Task 3). */
  sessions: sourceRef({ name: RADAR_SESSIONS_SOURCE, columns: radarSessionColumns }),
} satisfies Record<keyof typeof RADAR_SOURCES | "sessions", SourceRef<never, Columns>>
