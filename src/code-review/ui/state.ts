import { Store } from "@opencode/plugin/gui"
import { Schema } from "effect"
import type { ReviewRequest } from "./model/anchor.ts"

const Mode = Schema.Literals(["task", "attempt", "since", "live", "plan"])
const Side = Schema.Literals(["base", "head", "staged", "unstaged", "untracked"])
const Request = Schema.Struct({
  mode: Mode,
  attemptID: Schema.optionalKey(Schema.String),
  baseAttemptID: Schema.optionalKey(Schema.String),
  headAttemptID: Schema.optionalKey(Schema.String),
  planID: Schema.optionalKey(Schema.String),
})

/** A navigation into Review: a task, a comparison and optionally a file and lines to show. */
const Target = Schema.Struct({
  requestID: Schema.String,
  path: Schema.optionalKey(Schema.String),
  side: Schema.optionalKey(Side),
  startLine: Schema.optionalKey(Schema.Number),
  endLine: Schema.optionalKey(Schema.Number),
  comparisonID: Schema.optionalKey(Schema.String),
})

const View = Schema.Struct({
  taskID: Schema.NullOr(Schema.String),
  reference: Schema.optionalKey(Schema.String),
  request: Request,
  /** A navigation not yet applied to the view. */
  target: Schema.optionalKey(Schema.NullOr(Target)),
  /** The file at the top of the code when the reader left. */
  topPath: Schema.optionalKey(Schema.String),
  /** Paired panes: by width, always, or never. */
  layout: Schema.optionalKey(Schema.Literals(["auto", "split", "unified"])),
  wrap: Schema.optionalKey(Schema.Boolean),
  /** The file list is expanded. */
  files: Schema.optionalKey(Schema.Boolean),
  open: Schema.optionalKey(Schema.Boolean),
  size: Schema.optionalKey(Schema.Number),
})
export type ReviewView = typeof View.Type
export type ReviewNavigation = typeof Target.Type

export const initialReviewView: ReviewView = { taskID: null, request: { mode: "task" } }

export const reviewStores = {
  reviewView: Store.session(Schema.Struct({ projects: Schema.Record(Schema.String, View) }), {
    projects: {},
  }),
}

/** What opens Review on a task, from Tasks, Trajectory, Radar or a link. */
export type ReviewOpenRequest = {
  projectDirectory: string
  taskID: string
  reference?: string
  request?: ReviewRequest
  path?: string
  side?: ReviewNavigation["side"]
  startLine?: number
  endLine?: number
  comparisonID?: string
}

/** The view after a navigation: the task and comparison change; layout preferences stay. */
export function navigate(view: ReviewView, open: ReviewOpenRequest): ReviewView {
  const sameTask = view.taskID === open.taskID
  const request = open.request ?? (sameTask ? view.request : { mode: "task" as const })
  const target: ReviewNavigation = {
    requestID: crypto.randomUUID(),
    ...(open.path ? { path: open.path } : {}),
    ...(open.side ? { side: open.side } : {}),
    ...(open.startLine ? { startLine: open.startLine } : {}),
    ...(open.endLine ? { endLine: open.endLine } : {}),
    ...(open.comparisonID ? { comparisonID: open.comparisonID } : {}),
  }
  const { reference: _reference, topPath: _topPath, ...kept } = view
  const next: ReviewView = {
    ...(sameTask ? view : kept),
    taskID: open.taskID,
    request,
    target,
    ...(open.reference ? { reference: open.reference } : {}),
  }
  return next
}
