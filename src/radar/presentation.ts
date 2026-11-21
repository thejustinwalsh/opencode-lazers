import type { TaskMachineDefinition } from "../runner/task-machine-config.ts"
import { activeState } from "./projection.ts"
import type { ObservationNode } from "./projection.ts"

/** Retain live inputs even while the same selected-state Show stays mounted. */
export function flowStateInspector(
  node: () => ObservationNode | undefined,
  machine: () => TaskMachineDefinition | undefined,
  stateID: () => string,
) {
  return () => {
    const currentNode = node()
    const currentMachine = machine()
    const selected = stateID()
    let current: string | undefined
    if (currentNode && currentMachine) {
      if (!currentNode.machineSupported || currentNode.machineVersion !== currentMachine.version)
        current = "Unsupported machine"
      else if (!currentNode.snapshot) current = undefined
      else if (
        !currentNode.snapshotMatchesState ||
        currentNode.snapshot.value !== currentNode.state
      )
        current = "Snapshot mismatch"
      else current = activeState(currentNode, currentMachine) === selected ? "Yes" : "No"
    }
    return {
      current,
      initial: currentMachine?.initialState === selected ? "Yes" : "No",
      matchesRecordedState: currentNode?.state === selected,
      reason: currentNode?.reason ?? undefined,
      machine: currentMachine?.version,
      taskID: currentNode?.taskID,
    }
  }
}

/** Restore independent pane scrolling only after its current content has mounted. */
export class ScrollRestoration {
  private generation = 0
  private key = ""
  private applied = ""

  constructor(
    private readonly schedule: (callback: () => void) => void = (callback) =>
      queueMicrotask(callback),
  ) {}

  restored(key: string) {
    return Boolean(key) && this.applied === key
  }

  restore(
    key: string,
    ready: boolean,
    element: { scrollTop: number; scrollLeft?: number } | undefined,
    position: number | { top: number; left: number },
  ) {
    if (key !== this.key || !ready) this.applied = ""
    this.key = key
    const generation = ++this.generation
    if (!key || !ready || !element || this.restored(key)) return
    this.schedule(() => {
      if (generation !== this.generation) return
      element.scrollTop = typeof position === "number" ? position : position.top
      if (typeof position !== "number" && element.scrollLeft !== undefined)
        element.scrollLeft = position.left
      this.applied = key
    })
  }
}
