/**
 * The task lifecycle as plain data: the runner's machine is built from it, and the Radar's
 * statechart reads it without bundling XState into the GUI.
 */
export const machineVersion = "lazers-task/1"
export const taskMachineConfig = {
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
        RETAINED_ACCEPT: "accepted",
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
        RETAINED_ACCEPT: "accepted",
      },
    },
    verifying: {
      on: {
        RESUME: "running",
        ACCEPT: "accepted",
        REPAIR: "ready",
        BLOCK: "blocked",
        FAIL: "failed",
        CANCEL: "cancelled",
        EXHAUST: "exhausted",
        RETAINED_ACCEPT: "accepted",
      },
    },
    blocked: {
      on: {
        RECONCILE: "queued",
        CANCEL: "cancelled",
        RETRY: "ready",
        RETAINED_ACCEPT: "accepted",
      },
    },
    accepted: { on: { RETAINED_REPAIR: "ready" } },
    failed: {
      on: {
        RESUME: "running",
        RETRY: "ready",
        ADOPT_ACCEPT: "accepted",
        RETAINED_ACCEPT: "accepted",
      },
    },
    cancelled: { on: { RESUME: "running", RETRY: "ready" } },
    exhausted: { on: { RESUME: "running", RETRY: "ready" } },
    incorporated: { type: "final" },
  },
} as const

type Config = typeof taskMachineConfig
export type TaskMachineState = keyof Config["states"]
export type TaskMachineDefinition = {
  id: string
  version: string
  initialState: TaskMachineState
  states: {
    id: TaskMachineState
    type: "atomic" | "final"
    transitions: { event: string; target: TaskMachineState }[]
  }[]
}

/** The states and their outgoing edges, in declaration order: what a statechart draws. */
export function taskMachineDefinition(): TaskMachineDefinition {
  const states = Object.entries(taskMachineConfig.states) as [
    TaskMachineState,
    { type?: string; on?: Record<string, string> },
  ][]
  return {
    id: taskMachineConfig.id,
    version: machineVersion,
    initialState: taskMachineConfig.initial,
    states: states.map(([id, state]) => ({
      id,
      type: state.type === "final" ? "final" : "atomic",
      transitions: Object.entries(state.on ?? {}).map(([event, target]) => ({
        event,
        target: target as TaskMachineState,
      })),
    })),
  }
}
