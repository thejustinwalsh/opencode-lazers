import type { Database } from "bun:sqlite"
import { fingerprint } from "../../identity.ts"
import type { TaskRepository } from "../../storage.ts"
import {
  CodeReviewReviewedBaselineSchema,
  type CodeReviewReviewedBaseline,
  type CodeReviewReviewedInput,
} from "../contract.ts"
import type { CodeReviewStore } from "../comparisons/store.ts"

type BaselineRow = {
  baseline_id: string
  task_id: string
  comparison_id: string
  identity_json: string
  reviewed_at: number
}

function baselineFromRow(row: BaselineRow, projectID: string): CodeReviewReviewedBaseline {
  return CodeReviewReviewedBaselineSchema.parse({
    baselineID: row.baseline_id,
    projectID,
    taskID: row.task_id,
    comparisonID: row.comparison_id,
    identity: JSON.parse(row.identity_json),
    reviewedAt: row.reviewed_at,
  })
}

function baselineRow(db: Database, repository: TaskRepository, baselineID: string) {
  return db
    .query<BaselineRow, [string, string]>(
      `SELECT baseline_id,task_id,comparison_id,identity_json,reviewed_at
       FROM code_review_reviewed_baselines
       WHERE project_directory=? AND baseline_id=?`,
    )
    .get(repository.projectDirectory, baselineID)
}

export class CodeReviewBaselineStore {
  constructor(
    readonly store: CodeReviewStore,
    readonly projectID: string,
  ) {}

  get(taskID: string, comparisonID: string): CodeReviewReviewedBaseline | undefined {
    const repository = this.store.repository
    const row = repository.read((db) =>
      db
        .query<BaselineRow, [string, string, string]>(
          `SELECT baseline_id,task_id,comparison_id,identity_json,reviewed_at
           FROM code_review_reviewed_baselines
           WHERE project_directory=? AND task_id=? AND comparison_id=?`,
        )
        .get(repository.projectDirectory, taskID, comparisonID),
    )
    return row ? baselineFromRow(row, this.projectID) : undefined
  }

  mark(comparisonID: string, requestID: string, signal: AbortSignal): CodeReviewReviewedBaseline {
    signal.throwIfAborted()
    const comparison = this.store.comparison(comparisonID)
    if (
      !comparison ||
      comparison.identity.projectID !== this.projectID ||
      !this.store.repository.get(comparison.identity.taskID)
    )
      throw new Error("Comparison is unavailable in this project")

    const repository = this.store.repository
    const identity = comparison.identity
    const baselineID = fingerprint({
      kind: "code-review-reviewed-baseline/v1",
      projectID: this.projectID,
      taskID: identity.taskID,
      comparisonID,
    })
    const baseline = repository.atomic((db) => {
      const priorRequest = db
        .query<{ baseline_id: string }, [string, string]>(
          `SELECT baseline_id FROM code_review_reviewed_requests
           WHERE project_directory=? AND request_id=?`,
        )
        .get(repository.projectDirectory, requestID)
      if (priorRequest) {
        const row = baselineRow(db, repository, priorRequest.baseline_id)
        if (!row || row.comparison_id !== comparisonID || row.task_id !== identity.taskID)
          throw new Error("Review requestID was already used for another comparison")
        return baselineFromRow(row, this.projectID)
      }

      let row = db
        .query<BaselineRow, [string, string, string]>(
          `SELECT baseline_id,task_id,comparison_id,identity_json,reviewed_at
           FROM code_review_reviewed_baselines
           WHERE project_directory=? AND task_id=? AND comparison_id=?`,
        )
        .get(repository.projectDirectory, identity.taskID, comparisonID)
      if (!row) {
        db.query(
          `INSERT INTO code_review_reviewed_baselines(
             project_directory,baseline_id,task_id,comparison_id,identity_json,reviewed_at
           ) VALUES(?,?,?,?,?,?)`,
        ).run(
          repository.projectDirectory,
          baselineID,
          identity.taskID,
          comparisonID,
          JSON.stringify(identity),
          Date.now(),
        )
        row = baselineRow(db, repository, baselineID)
      }
      if (!row) throw new Error("Reviewed baseline could not be stored")
      db.query(
        `INSERT INTO code_review_reviewed_requests(project_directory,request_id,baseline_id)
         VALUES(?,?,?)`,
      ).run(repository.projectDirectory, requestID, row.baseline_id)
      return baselineFromRow(row, this.projectID)
    })
    signal.throwIfAborted()
    return baseline
  }

  page(
    input: Pick<CodeReviewReviewedInput, "taskID" | "limit" | "cursor">,
    signal: AbortSignal,
  ): {
    taskID: string
    baselines: CodeReviewReviewedBaseline[]
    nextCursor: { reviewedAt: number; baselineID: string } | null
  } {
    signal.throwIfAborted()
    const repository = this.store.repository
    const limit = input.limit ?? 50
    const page = repository.read((db) => {
      if (input.cursor) {
        const cursor = db
          .query<{ present: number }, [string, string, string, number]>(
            `SELECT 1 AS present FROM code_review_reviewed_baselines
             WHERE project_directory=? AND task_id=? AND baseline_id=? AND reviewed_at=?`,
          )
          .get(
            repository.projectDirectory,
            input.taskID,
            input.cursor.baselineID,
            input.cursor.reviewedAt,
          )
        if (!cursor) throw new Error("Reviewed baseline cursor is unavailable for this task")
      }
      return db
        .query<BaselineRow, [string, string, number, string, number]>(
          `SELECT baseline_id,task_id,comparison_id,identity_json,reviewed_at
           FROM code_review_reviewed_baselines
           WHERE project_directory=? AND task_id=?
             AND (reviewed_at,baseline_id)>(?,?)
           ORDER BY reviewed_at,baseline_id
           LIMIT ?`,
        )
        .all(
          repository.projectDirectory,
          input.taskID,
          input.cursor?.reviewedAt ?? -1,
          input.cursor?.baselineID ?? "",
          limit + 1,
        )
    })
    signal.throwIfAborted()
    const rows = page.slice(0, limit)
    const last = rows.at(-1)
    return {
      taskID: input.taskID,
      baselines: rows.map((row) => baselineFromRow(row, this.projectID)),
      nextCursor:
        page.length > limit && last
          ? { reviewedAt: last.reviewed_at, baselineID: last.baseline_id }
          : null,
    }
  }
}
