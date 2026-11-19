import type { ExecutionListRow } from "../tasks/execution-list.ts"
import { taskStateView } from "../tasks/task-state.ts"
import type { TaskStateView } from "../tasks/task-state.ts"

/** A task node's and plan's recorded state, as the live and attempt reads carry it. */
export type TaskRead = {
  state: string
  reason: string | null
  planState: string
  planReason: string | null
}

const terminalNodes = new Set(["accepted", "incorporated", "failed", "exhausted", "cancelled"])

/** The task row `taskStateView` reads, rebuilt from the recorded node and plan state. */
export function taskRowFor(task: TaskRead, taskID: string): ExecutionListRow {
  const held =
    task.state === "blocked" || (task.planState === "blocked" && !terminalNodes.has(task.state))
  return {
    taskID,
    title: "",
    status: task.state,
    reason: task.reason,
    waiting: held,
    holdReason: held ? (task.reason ?? task.planReason) : null,
    ordinal: 0,
    contextOnly: false,
    prerequisites: [],
    successors: [],
  }
}

type Assigned = { assignment: { taskID: string; task?: TaskRead } | null }

/** The shared task state of a session's assignment, when the read carried the task's state. */
export function assignedTaskView(session: Assigned, task?: TaskRead): TaskStateView | undefined {
  const read = task ?? session.assignment?.task
  return read && session.assignment
    ? taskStateView(taskRowFor(read, session.assignment.taskID))
    : undefined
}

/** A worker whose task is waiting, paused or failed is not running, whatever its attempt row says. */
export function isHeldWorker(session: Assigned) {
  const view = assignedTaskView(session)
  return view?.explained === true
}
