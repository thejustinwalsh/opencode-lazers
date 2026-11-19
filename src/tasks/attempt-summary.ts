import type { Database } from "bun:sqlite"
import { z } from "zod"

/** Tool-call ticks one summary carries; a longer attempt has no lane rather than a partial one. */
export const SUMMARY_TICKS = 1_000

/**
 * What the Tasks pane shows of the latest attempt: when it was last active, one tick per tool
 * call (failed ones flagged) and the files it edited. A compact read of `runner_progress`, never a
 * trajectory: one indexed range per attempt, at most `SUMMARY_TICKS + 1` rows.
 */
export const AttemptSummary = z.strictObject({
  /** Epoch ms of the attempt's newest recorded progress; absent when none was recorded. */
  lastActivityAt: z.number().finite().optional(),
  /** Tool-call times in order; empty when the attempt has too many calls to draw. */
  ticks: z
    .array(z.strictObject({ at: z.number().finite(), failed: z.literal(true).optional() }))
    .max(SUMMARY_TICKS),
  /** Distinct files the attempt edited or patched; absent when none or when `ticks` is empty. */
  files: z.int().positive().optional(),
})
export type AttemptSummary = z.infer<typeof AttemptSummary>

/** The attempt's model as `provider/id` parts, from its recorded policy; absent when unrecorded. */
export const AttemptModel = z.strictObject({
  providerID: z.string().min(1),
  id: z.string().min(1),
  variant: z.string().min(1).optional(),
})
export type AttemptModel = z.infer<typeof AttemptModel>

export function attemptModel(policy: string): AttemptModel | undefined {
  try {
    const model = (JSON.parse(policy) as { model?: unknown } | null)?.model
    const parsed = AttemptModel.safeParse(model)
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

type ToolRow = {
  at: number
  status: string | null
  operation: string | null
  paths: string | null
}

/**
 * Reads the summary through `runner_progress_attempt_seq (project_directory, attempt_id, seq)`:
 * one newest-row lookup and one bounded range of tool rows.
 */
export function readAttemptSummary(
  db: Database,
  projectDirectory: string,
  attemptID: string,
): AttemptSummary {
  const last = db
    .query<{ at: number }, [string, string]>(
      "SELECT at FROM runner_progress WHERE project_directory=? AND attempt_id=? ORDER BY seq DESC LIMIT 1",
    )
    .get(projectDirectory, attemptID)
  const rows = db
    .query<ToolRow, [string, string, number]>(
      `SELECT at,json_extract(payload,'$.status') AS status,
              json_extract(payload,'$.fileTargets.operation') AS operation,
              json_extract(payload,'$.fileTargets.paths') AS paths
         FROM runner_progress
        WHERE project_directory=? AND attempt_id=? AND kind='tool' AND call_id IS NOT NULL
        ORDER BY seq LIMIT ?`,
    )
    .all(projectDirectory, attemptID, SUMMARY_TICKS + 1)
  const complete = rows.length <= SUMMARY_TICKS
  const files = new Set<string>()
  if (complete)
    for (const row of rows) {
      if (row.operation !== "edit" && row.operation !== "patch") continue
      try {
        const paths = JSON.parse(row.paths ?? "[]") as unknown
        if (Array.isArray(paths))
          for (const path of paths) if (typeof path === "string" && path) files.add(path)
      } catch {
        /* an unreadable target list names no file */
      }
    }
  return {
    ...(last ? { lastActivityAt: last.at } : {}),
    ticks: complete
      ? rows.map((row) => ({
          at: row.at,
          ...(row.status === "failed" ? { failed: true as const } : {}),
        }))
      : [],
    ...(files.size ? { files: files.size } : {}),
  }
}
