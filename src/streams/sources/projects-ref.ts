import type { Columns } from "../frame.ts"
import { sourceRef } from "../source.ts"

/**
 * The Projects section's sources (`project_overview`, `project_global`): names and columns for
 * the GUI. Like the `list` read they replace, they take no session and check none (owner
 * decision, 2026-11-21: carry over today's checks unchanged).
 */
export const PROJECTS_SOURCES = { list: "projects.list", global: "projects.global" } as const

export type ProjectsFilter = Record<string, never>

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

export const projectsRefs = {
  list: sourceRef({ name: PROJECTS_SOURCES.list, columns: projectListColumns }),
  global: sourceRef({ name: PROJECTS_SOURCES.global, columns: projectGlobalColumns }),
}
