import type { RetentionPreview } from "./retention.ts"
import type { WorktreeCandidates } from "./worktrees.ts"

export type RetentionReadRequest =
  | { type: "status"; id: number; now: number; dataDirectory: string }
  | {
      type: "preview"
      id: number
      now: number
      days: number
      dataDirectory: string
      projectDirectory: string
    }
  | { type: "worktrees"; id: number; now: number; days: number; projectDirectory: string }
  | { type: "close" }

export type RetentionEstimateStatus = {
  presets: Array<{ days: number; rows: number; bytes: number }>
  superseded: { rows: number; bytes: number }
}

export type RetentionReadResult =
  | { type: "result"; id: number; value: RetentionEstimateStatus }
  | {
      type: "preview"
      id: number
      preview: RetentionPreview
      worktrees: WorktreeCandidates
    }
  | { type: "worktrees"; id: number; worktrees: WorktreeCandidates }
  | { type: "error"; id: number; message: string }
  | { type: "closed" }
