import { createMachine, initialTransition, transition as xstateTransition } from "xstate"
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
      on: {
        DISPATCH: "running",
        BLOCK: "blocked",
        CANCEL: "cancelled",
        EXHAUST: "exhausted",
        ADOPT_ACCEPT: "accepted",
      },
    },
    running: {
      on: {
        VERIFY: "verifying",
        BLOCK: "blocked",
        FAIL: "failed",
        CANCEL: "cancelled",
        EXHAUST: "exhausted",
        RETRY: "ready",
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
    blocked: { on: { RECONCILE: "queued", CANCEL: "cancelled", RETRY: "ready" } },
    accepted: { type: "final" },
    failed: { on: { RESUME: "running", RETRY: "ready", ADOPT_ACCEPT: "accepted" } },
    cancelled: { on: { RESUME: "running", RETRY: "ready" } },
    exhausted: { on: { RESUME: "running", RETRY: "ready" } },
    incorporated: { type: "final" },
  },
})

export function transition(state: TaskState, event: string) {
  const snapshot = taskMachine.resolveState({ value: state, context: {} })
  const [next] = xstateTransition(taskMachine, snapshot, { type: event })
  if (next.value === state) throw new Error(`Invalid task transition ${state} → ${event}`)
  return {
    state: next.value as TaskState,
    snapshot: taskMachine.getPersistedSnapshot(next),
    machineVersion,
  }
}
export const initialSnapshot = () =>
  taskMachine.getPersistedSnapshot(initialTransition(taskMachine)[0])
