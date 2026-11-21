import { defineSource } from "../source.ts"
import {
  PROJECTS_SOURCES,
  projectGlobalColumns,
  projectListColumns,
  type ProjectsFilter,
} from "./projects-ref.ts"

/**
 * Registered projects in registry order (`created_at`, `key`), each with whether one of its
 * checkouts has a live core: its stored canonical checkouts matched against `project_presence`
 * (a handful of rows; the old read resolved every path with `realpathSync` per poll).
 */
const LIST = `(SELECT o.id AS id, o.key AS key, o.code AS code, o.name AS name,
    o.created_at AS created_at, o.checkouts AS checkouts,
    EXISTS(SELECT 1 FROM json_each(o.canonical_checkouts) c
      JOIN project_presence p ON p.canonical=c.value) AS loaded,
    o.paused AS paused, o.pause_reason AS pause_reason, o.pause_by AS pause_by,
    o.pause_at AS pause_at, o.architect_contact AS architect_contact,
    o.architect_contact_reason AS architect_contact_reason, o.settings AS settings,
    o.profile_state AS profile_state, o.profile_revision AS profile_revision
  FROM project_overview o) AS projects_list`

export const projectsListSource = defineSource({
  name: PROJECTS_SOURCES.list,
  table: LIST,
  tables: ["project_overview", "project_presence"],
  key: ["id"],
  orders: {
    registry: [
      { column: "created_at", direction: "asc" },
      { column: "key", direction: "asc" },
      { column: "id", direction: "asc" },
    ],
  },
  filter: (_input: ProjectsFilter) => ({ where: "1=1", params: [] }),
  columns: projectListColumns,
  count: { exact: "scan" },
})

export const projectsGlobalSource = defineSource({
  name: PROJECTS_SOURCES.global,
  table: "project_global",
  key: ["id"],
  orders: { key: [{ column: "id", direction: "asc" }] },
  filter: (_input: ProjectsFilter) => ({ where: "1=1", params: [] }),
  columns: projectGlobalColumns,
  count: { exact: "scan" },
})
