import type { SnapshotResponse } from "../observability/contract.ts"
import { activeState } from "./projection.ts"
import type { ObservationNode } from "./projection.ts"

/** Retain live inputs even while the same selected-state Show stays mounted. */
export function flowStateInspector(
  node: () => ObservationNode | undefined,
  snapshot: () => SnapshotResponse | undefined,
  stateID: () => string,
) {
  return () => {
    const currentNode = node()
    const currentSnapshot = snapshot()
    const selected = stateID()
    let current = "Unavailable"
    if (currentNode && currentSnapshot) {
      if (
        !currentNode.machineSupported ||
        currentNode.machineVersion !== currentSnapshot.machine.version
      )
        current = "Unsupported machine"
      else if (!currentNode.snapshot) current = "Snapshot unavailable"
      else if (
        !currentNode.snapshotMatchesState ||
        currentNode.snapshot.value !== currentNode.state
      )
        current = "Snapshot mismatch"
      else current = activeState(currentNode, currentSnapshot) === selected ? "Yes" : "No"
    }
    return {
      current,
      initial: currentSnapshot?.machine.initialState === selected ? "Yes" : "No",
      matchesRecordedState: currentNode?.state === selected,
      reason: currentNode?.reason ?? "Unavailable",
      machine: currentSnapshot?.machine.version ?? "Unavailable",
      taskID: currentNode?.taskID ?? "Unavailable",
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
