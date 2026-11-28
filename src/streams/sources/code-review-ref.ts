import type { Columns } from "../frame.ts"
import { sourceRef, type SourceRef } from "../source.ts"
import type { CodeReviewSide } from "../../code-review/contract.ts"

export const CODE_REVIEW_SOURCES = { files: "codeReview.files" } as const

export type CodeReviewScope = {
  kind: "project" | "session"
  sessionID: string
}

export type CodeReviewFilesFilter = {
  comparisonID: string
  side: CodeReviewSide
  scope: CodeReviewScope
  projectDirectory: string
  changedOnly?: boolean
}

/** Fields a GUI sends; the server supplies `projectDirectory` after authorization. */
type CodeReviewFilesRequest = Omit<CodeReviewFilesFilter, "projectDirectory">

export const codeReviewFileColumns = {
  comparison_id: "text",
  side: "text",
  path: "text",
  mode: "text",
  object_id: "text",
  size: "int",
  kind: "text",
  status: "text",
  changed: "bool",
  hunks: "json",
  attribution_task_ids: "json",
} as const satisfies Columns

export const codeReviewFilesRef: SourceRef<CodeReviewFilesRequest, typeof codeReviewFileColumns> =
  sourceRef({
    name: CODE_REVIEW_SOURCES.files,
    columns: codeReviewFileColumns,
  })
