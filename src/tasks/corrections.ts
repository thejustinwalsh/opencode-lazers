import type { Database } from "bun:sqlite"
import { acquireSharedConnection } from "../storage.ts"

import {
  TaskCorrectionInspection,
  TaskCorrectionRecord,
  TaskCorrectionRevisionIdentity,
  TaskCorrectionsSnapshot,
} from "../task-correction.ts"
import type {
  TaskCorrectionInspection as TaskCorrectionInspectionType,
  TaskCorrectionMembership,
  TaskCorrectionRevisionIdentity as TaskCorrectionRevisionIdentityType,
  TaskCorrectionsSnapshot as TaskCorrectionsSnapshotType,
} from "../task-correction.ts"

type CorrectionRow = {
  id: number
  project_directory: string
  task_id: string
  original_task_id: string | null
  request_id: string
  revision: number
  reason: string
  session_id: string
  agent: string
  created_at: string
}

function hasTable(db: Database, name: string): boolean {
  return Boolean(
    db
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
      )
      .get(name),
  )
}

function hasColumn(db: Database, table: string, column: string): boolean {
  return db
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .some((item) => item.name === column)
}

function revisionIdentity(
  projectDirectory: string,
  storage: TaskCorrectionRevisionIdentityType["storage"],
  revision: number | null,
  taskRevision: number | null,
) {
  return TaskCorrectionRevisionIdentity.parse({
    schemaVersion: 1,
    projectDirectory,
    storage,
    revision,
    taskRevision,
  })
}

/** Read all correction links and audit history from one SELECT-only SQLite snapshot. */
export function readTaskCorrections(
  db: Database,
  projectDirectory: string,
): TaskCorrectionsSnapshotType {
  return db
    .transaction(() => {
      const taskIDs = db
        .query<{ id: string }, [string]>(
          "SELECT id FROM tasks WHERE project_directory=? ORDER BY id COLLATE BINARY",
        )
        .all(projectDirectory)
        .map((row) => row.id)
      const taskIDSet = new Set(taskIDs)
      const available = hasTable(db, "task_corrections")
      const taskChanges = hasTable(db, "task_changes")
      const taskRevision = taskChanges
        ? (db
            .query<{ revision: number }, [string]>(
              hasColumn(db, "task_changes", "kind")
                ? "SELECT COALESCE(MAX(id),0) AS revision FROM task_changes WHERE project_directory=? AND kind='insert'"
                : "SELECT COALESCE(MAX(id),0) AS revision FROM task_changes WHERE project_directory=?",
            )
            .get(projectDirectory)!.revision ?? 0)
        : null
      const rows = available
        ? db
            .query<CorrectionRow, [string]>(
              `SELECT id, project_directory, task_id, original_task_id, request_id, revision,
                      reason, session_id, agent, created_at
               FROM task_corrections WHERE project_directory=? ORDER BY task_id, revision`,
            )
            .all(projectDirectory)
        : []
      const historyByTask = new Map<string, ReturnType<typeof TaskCorrectionRecord.parse>[]>(
        taskIDs.map((taskID) => [taskID, []]),
      )
      const parents = new Map<string, string>()
      let revision = 0
      for (const row of rows) {
        if (!taskIDSet.has(row.task_id))
          throw new Error("Task correction refers to a task outside this project")
        if (row.original_task_id !== null && !taskIDSet.has(row.original_task_id))
          throw new Error("Task correction original is missing from this project")
        const history = historyByTask.get(row.task_id)!
        const record = TaskCorrectionRecord.parse({
          id: row.id,
          taskID: row.task_id,
          originalTaskID: row.original_task_id,
          requestID: row.request_id,
          revision: row.revision,
          reason: row.reason,
          sessionID: row.session_id,
          agent: row.agent,
          createdAt: row.created_at,
        })
        if (record.revision !== history.length + 1)
          throw new Error("Task correction history is not contiguous")
        history.push(record)
        if (record.originalTaskID === null) parents.delete(record.taskID)
        else parents.set(record.taskID, record.originalTaskID)
        revision = Math.max(revision, record.id)
      }

      const rootByTask = new Map<string, string>()
      for (const taskID of taskIDs) {
        const seen = new Set<string>()
        let root = taskID
        while (parents.has(root)) {
          if (seen.has(root)) throw new Error("Task correction links contain a cycle")
          seen.add(root)
          root = parents.get(root)!
        }
        rootByTask.set(taskID, root)
      }
      const membersByRoot = new Map<string, string[]>()
      for (const taskID of taskIDs) {
        const root = rootByTask.get(taskID)!
        const members = membersByRoot.get(root) ?? []
        members.push(taskID)
        membersByRoot.set(root, members)
      }

      const tasks: TaskCorrectionMembership[] = taskIDs.map((taskID) => {
        const history = historyByTask.get(taskID)!
        const current = history.at(-1)
        return {
          taskID,
          rootTaskID: rootByTask.get(taskID)!,
          memberTaskIDs: membersByRoot.get(rootByTask.get(taskID)!)!,
          relation: !current
            ? "unreviewed"
            : current.originalTaskID === null
              ? "independent"
              : "linked",
          originalTaskID: current?.originalTaskID ?? null,
          revision: current?.revision ?? 0,
          history,
        }
      })
      return TaskCorrectionsSnapshot.parse({
        identity: revisionIdentity(
          projectDirectory,
          available ? "available" : "missing-table",
          available ? revision : null,
          taskRevision,
        ),
        tasks,
      })
    })
    .deferred()
}

function inspectTaskCorrections(
  snapshot: TaskCorrectionsSnapshotType,
  taskID: string,
): TaskCorrectionInspectionType {
  const task = snapshot.tasks.find((candidate) => candidate.taskID === taskID)
  if (!task)
    return TaskCorrectionInspection.parse({ status: "not_found", identity: snapshot.identity })
  return TaskCorrectionInspection.parse({
    status: "found",
    identity: snapshot.identity,
    task,
    members: snapshot.tasks.filter((candidate) => candidate.rootTaskID === task.rootTaskID),
  })
}

/** Open only an existing database in SELECT-only mode; never create or migrate it. */
export function openReadOnlyTaskCorrections(path: string, projectDirectory: string) {
  const shared = acquireSharedConnection(path, "readonly")
  const db = shared.db
  try {
    return {
      read() {
        return readTaskCorrections(db, projectDirectory)
      },
      inspect(taskID: string) {
        return inspectTaskCorrections(readTaskCorrections(db, projectDirectory), taskID)
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
