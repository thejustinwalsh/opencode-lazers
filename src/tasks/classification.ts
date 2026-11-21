import type { Database } from "bun:sqlite"

import { TaskClassificationAnnotationRecord } from "../task-classification.ts"
import type {
  TaskClassificationRevision,
  TaskClassificationSnapshot,
} from "../task-classification.ts"
import { TaskSpecSchema } from "../task.ts"
import type { TaskSpec } from "../task.ts"

export type ClassificationAnnotationRow = {
  id: number
  task_id: string
  request_id: string
  revision: number
  classification: string
  reason: string
  session_id: string
  agent: string
  created_at: string
}

type AnnotationRow = ClassificationAnnotationRow & { project_directory: string }

function hasTable(db: Database, name: string): boolean {
  return Boolean(
    db
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
      )
      .get(name),
  )
}

/**
 * A task's explicit baseline and its append-only corrections, from annotation rows the caller
 * already holds (ordered by revision). Pure: callers that load every annotation of a project in
 * one query use this instead of one SELECT per task.
 */
export function classificationSnapshotFor(
  task: TaskSpec,
  rows: readonly ClassificationAnnotationRow[],
): TaskClassificationSnapshot {
  const history: TaskClassificationRevision[] = [
    task.proposal.classification
      ? {
          revision: 1,
          classification: task.proposal.classification,
          provenance: {
            kind: "embedded",
            sessionID: task.provenance.sessionID,
            createdAt: task.createdAt,
          },
        }
      : {
          revision: 0,
          classification: null,
          provenance: { kind: "legacy" },
        },
  ]
  for (const row of rows) {
    const annotation = TaskClassificationAnnotationRecord.parse({
      id: row.id,
      taskID: row.task_id,
      requestID: row.request_id,
      revision: row.revision,
      classification: JSON.parse(row.classification),
      reason: row.reason,
      sessionID: row.session_id,
      agent: row.agent,
      createdAt: row.created_at,
    })
    const expectedRevision = history.at(-1)!.revision + 1
    if (annotation.revision !== expectedRevision)
      throw new Error("Task classification history is not contiguous")
    history.push({
      revision: annotation.revision,
      classification: annotation.classification,
      provenance: {
        kind: "annotation",
        requestID: annotation.requestID,
        sessionID: annotation.sessionID,
        agent: annotation.agent,
        reason: annotation.reason,
        createdAt: annotation.createdAt,
      },
    })
  }
  return { current: history.at(-1)!, history }
}

/** Project a task body's explicit baseline and its append-only corrections. */
export function taskClassificationFor(
  db: Database,
  projectDirectory: string,
  task: TaskSpec,
): TaskClassificationSnapshot {
  const rows = hasTable(db, "task_classifications")
    ? db
        .query<AnnotationRow, [string, string]>(
          `SELECT id, project_directory, task_id, request_id, revision, classification,
                  reason, session_id, agent, created_at
           FROM task_classifications WHERE project_directory=? AND task_id=? ORDER BY revision`,
        )
        .all(projectDirectory, task.id)
    : []
  return classificationSnapshotFor(task, rows)
}

/** Read task and classification metadata without running repository migrations. */
function readTaskClassification(
  db: Database,
  projectDirectory: string,
  taskID: string,
): { task: TaskSpec; classification: TaskClassificationSnapshot } | undefined {
  const row = db
    .query<{ body: string }, [string, string]>(
      "SELECT body FROM tasks WHERE project_directory=? AND id=?",
    )
    .get(projectDirectory, taskID)
  if (!row) return undefined
  const task = TaskSpecSchema.parse(JSON.parse(row.body))
  return { task, classification: taskClassificationFor(db, projectDirectory, task) }
}

/** Read classifications through a caller-acquired read-only connection; never creates or migrates. */
export function openReadOnlyTaskClassifications(
  shared: { db: Database; release(): void },
  projectDirectory: string,
) {
  const db = shared.db
  try {
    return {
      read(taskID: string) {
        return readTaskClassification(db, projectDirectory, taskID)
      },
      close() {
        shared.release()
      },
    }
  } catch (error) {
    shared.release()
    throw error
  }
}
