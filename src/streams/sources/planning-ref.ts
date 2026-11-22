import type { Columns } from "../frame.ts"
import { sourceRef } from "../source.ts"

/**
 * The Plan panel's sources (`planning_plannings` and its child tables): names, columns and
 * filters for the GUI. The project is the service's own whatever the caller sends, as the
 * replaced `lz.planning` `get` checked.
 */
export const PLANNING_SOURCES = {
  list: "planning.list",
  detail: "planning.detail",
} as const

/** A session's plans, newest first (`created_at desc`, as the replaced `list` read). */
export type PlanningListFilter = { sessionID: string; projectKey?: string }
/** One plan by id, at its latest revision. A plan with no revision yet has no row. */
export type PlanningDetailFilter = { planningID: string; projectKey?: string }

export const planningListColumns = {
  id: "text",
  title: "text",
  state: "text",
  revision: "int",
  created_at: "int",
  updated_at: "int",
} as const satisfies Columns

export const planningDetailColumns = {
  id: "text",
  title: "text",
  state: "text",
  revision: "int",
} as const satisfies Columns

/** The latest revision's body and validation, and the child rows the view assembles from. */
export const planningDetailCold = {
  body: "json",
  validation: "json",
  /** `{ revision: fieldHashes }` for the shown revision and every finding's revision. */
  hashes: "json",
  findings: "json",
  questions: "json",
  reviews: "json",
  tasked: "json",
} as const satisfies Columns

export const planningRefs = {
  list: sourceRef<PlanningListFilter, typeof planningListColumns>({
    name: PLANNING_SOURCES.list,
    columns: planningListColumns,
  }),
  detail: sourceRef<PlanningDetailFilter, typeof planningDetailColumns>({
    name: PLANNING_SOURCES.detail,
    columns: planningDetailColumns,
    detail: planningDetailCold,
  }),
}
