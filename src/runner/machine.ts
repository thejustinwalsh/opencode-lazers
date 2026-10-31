import { createMachine, getInitialSnapshot, getNextSnapshot } from "xstate"
import type { TaskState } from "./schema.ts"

export const machineVersion = "lazers-task/1"
/** Pure transitions only. External work is journaled before execution by the runtime. */
export const taskMachine = createMachine({
  id: "lazers-task",
  initial: "queued",
  states: {
    queued: {
      on: { READY: "ready", BLOCK: "blocked", CANCEL: "cancelled", INCORPORATE: "incorporated" },
    },
    ready: {
      on: { DISPATCH: "running", BLOCK: "blocked", CANCEL: "cancelled", EXHAUST: "exhausted" },
    },
    running: {
      on: {
        VERIFY: "verifying",
        BLOCK: "blocked",
        FAIL: "failed",
        CANCEL: "cancelled",
        EXHAUST: "exhausted",
      },
    },
    verifying: {
      on: {
        ACCEPT: "accepted",
        REPAIR: "ready",
        BLOCK: "blocked",
        FAIL: "failed",
        CANCEL: "cancelled",
        EXHAUST: "exhausted",
      },
    },
    blocked: { on: { RECONCILE: "queued", CANCEL: "cancelled" } },
    accepted: { type: "final" },
    failed: { type: "final" },
    cancelled: { type: "final" },
    exhausted: { on: { RESUME: "running" } },
    incorporated: { type: "final" },
  },
})

export function transition(state: TaskState, event: string) {
  const snapshot = taskMachine.resolveState({ value: state, context: {} })
  const next = getNextSnapshot(taskMachine, snapshot, { type: event })
  if (next.value === state) throw new Error(`Invalid task transition ${state} → ${event}`)
  return {
    state: next.value as TaskState,
    snapshot: taskMachine.getPersistedSnapshot(next),
    machineVersion,
  }
}
export const initialSnapshot = () =>
  taskMachine.getPersistedSnapshot(getInitialSnapshot(taskMachine))
