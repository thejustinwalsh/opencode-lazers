import type { Columns } from "../frame.ts"
import { sourceRef } from "../source.ts"

/**
 * The Projects section's sources (`project_overview`, `project_global`): names and columns for
 * the GUI. Like the `list` read they replace, they take no session and check none (owner
 * decision, 2026-11-21: carry over today's checks unchanged).
 */
export const PROJECTS_SOURCES = {
  list: "projects.list",
  global: "projects.global",
  revisions: "projects.revisions",
  proofs: "projects.proofs",
} as const

export type ProjectsFilter = Record<string, never>
/** A project's profile revisions; `state` narrows to the active one or the earlier ones. */
export type ProjectRevisionsFilter = { key: string; state?: "active" | "superseded" }
/** The proofs of one revision, by its `id`. */
export type ProjectProofsFilter = { revisionID: number }

export const projectListColumns = {
  id: "int",
  key: "text",
  code: "text",
  name: "text",
  created_at: "text",
  /** The project's checkouts in registration order. */
  checkouts: "json",
  /** A checkout has a live core in the service (`project_presence`). */
  loaded: "bool",
  paused: "bool",
  pause_reason: "text",
  pause_by: "text",
  pause_at: "int",
  architect_contact: "bool",
  architect_contact_reason: "text",
  /** Resolved settings: stored value, else the plugin option, else the built-in default. */
  settings: "json",
  profile_state: "text",
  profile_revision: "int",
} as const satisfies Columns

export const projectGlobalColumns = {
  id: "int",
  paused: "bool",
  pause_reason: "text",
  pause_by: "text",
  pause_at: "int",
  settings: "json",
} as const satisfies Columns

export const projectRevisionColumns = {
  id: "int",
  revision: "int",
  state: "text",
  author_kind: "text",
  session_id: "text",
  reason: "text",
  created_at: "int",
  /** When a later revision superseded it. */
  decided_at: "int",
} as const satisfies Columns
/** The profile document and the repository-map preview, for the revision a pane shows. */
export const projectRevisionDetail = {
  payload: "json",
  map_preview: "json",
} as const satisfies Columns

export const projectProofColumns = {
  /** The proof's rowid: the order it was recorded in. */
  ord: "int",
  command_key: "text",
  command: "text",
  effective_command: "text",
  outcome: "text",
  exit_code: "int",
  timed_out: "bool",
  duration_ms: "int",
  reason: "text",
  /** The last 4,096 bytes of each stream; a failed proof shows the last line. */
  stdout_tail: "text",
  stderr_tail: "text",
  tool_version: "text",
  ran_at: "int",
} as const satisfies Columns

export const projectsRefs = {
  list: sourceRef({ name: PROJECTS_SOURCES.list, columns: projectListColumns }),
  global: sourceRef({ name: PROJECTS_SOURCES.global, columns: projectGlobalColumns }),
  revisions: sourceRef({
    name: PROJECTS_SOURCES.revisions,
    columns: projectRevisionColumns,
    detail: projectRevisionDetail,
  }),
  proofs: sourceRef({ name: PROJECTS_SOURCES.proofs, columns: projectProofColumns }),
}
