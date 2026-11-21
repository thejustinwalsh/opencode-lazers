import type { ProjectsListing, ProjectView } from "./contract.ts"

/** A `projects.list` or `projects.global` row; stream rows read their fields from the frame. */
type Row = { readonly [column: string]: unknown }

const text = (value: unknown) => (typeof value === "string" ? value : "")
const pauseOf = (row: Row) =>
  row.paused
    ? {
        reason: text(row.pause_reason),
        by: text(row.pause_by),
        at: typeof row.pause_at === "number" ? row.pause_at : 0,
      }
    : null

/** The project as the Projects section shows it: the shape the `list` read returned. */
export function projectViewOf(row: Row): ProjectView {
  const revision = row.profile_revision
  return {
    key: text(row.key),
    code: text(row.code),
    name: text(row.name),
    checkouts: row.checkouts as string[],
    loaded: Boolean(row.loaded),
    pause: pauseOf(row),
    architectContact: row.architect_contact ? { reason: text(row.architect_contact_reason) } : null,
    settings: row.settings as ProjectView["settings"],
    profile:
      row.profile_state === "active" && typeof revision === "number"
        ? { state: "active", revision }
        : { state: "none" },
  }
}

export function globalViewOf(row: Row): Pick<ProjectsListing, "globalPause" | "globalSettings"> {
  return {
    globalPause: pauseOf(row),
    globalSettings: row.settings as ProjectsListing["globalSettings"],
  }
}
