import { createMachine, initialTransition, transition as xstateTransition } from "xstate"
import type { TaskState } from "./schema.ts"
import { machineVersion, taskMachineConfig } from "./task-machine-config.ts"

export { machineVersion } from "./task-machine-config.ts"
/** Pure transitions only. External work is journaled before execution by the runtime. */
export const taskMachine = createMachine(taskMachineConfig)

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
