import { databaseChanges } from "../database-events.ts"
import { runningTaskEffortFold } from "./effort-store.ts"
import { openReadOnlyTrajectoryStore } from "./store.ts"

/**
 * Whether a task's effort row is there for a reader: `stored`; `computing` (the effort fold of
 * this process has the task queued and has not written it within the wait); `not-computed` (no
 * effort fold runs in this process, so nothing will write it for this read).
 */
export type TaskEffortState = "stored" | "computing" | "not-computed"

/**
 * The longest a reader waits for a task's first effort row. A refresh of the largest live task
 * (3,619 progress rows, 3,619 transcript steps) measures a median 86 ms, 173 ms on a loaded
 * machine (`effort-store.test.ts`, `effort-transcript.test.ts`); a queue of other tasks ahead of
 * it is drained in batches of 20. The wait ends at the row's write, not at this bound.
 */
export const EFFORT_WAIT_MS = 2_000

function hasEffortRow(path: string, projectDirectory: string, taskID: string) {
  const connection = openReadOnlyTrajectoryStore(path, projectDirectory)
  try {
    return connection.store.read((db) =>
      Boolean(
        db
          .query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='trajectory_task_effort'")
          .get() &&
        db
          .query("SELECT 1 FROM trajectory_task_effort WHERE project_directory=? AND task_id=?")
          .get(projectDirectory, taskID),
      ),
    )
  } finally {
    connection.close()
  }
}

/**
 * Make sure a reader of `taskID` gets its effort when it is a moment away: when the row is
 * missing, queue the task on this process's effort fold and wait for the row's write, at most
 * `waitMs`. Resolves the state the reader reports beside the effort.
 */
export async function awaitTaskEffort(
  path: string,
  projectDirectory: string,
  taskID: string,
  waitMs = EFFORT_WAIT_MS,
): Promise<TaskEffortState> {
  if (hasEffortRow(path, projectDirectory, taskID)) return "stored"
  const fold = runningTaskEffortFold(path, projectDirectory)
  if (!fold) return "not-computed"
  return new Promise<TaskEffortState>((resolve) => {
    let done = false
    const finish = (state: TaskEffortState) => {
      if (done) return
      done = true
      clearTimeout(timer)
      unsubscribe()
      resolve(state)
    }
    const unsubscribe = databaseChanges.subscribeTables(path, (tables) => {
      if (tables.has("trajectory_task_effort") && hasEffortRow(path, projectDirectory, taskID))
        finish("stored")
    })
    const timer = setTimeout(
      () => finish(hasEffortRow(path, projectDirectory, taskID) ? "stored" : "computing"),
      waitMs,
    )
    fold.touch(taskID)
  })
}
