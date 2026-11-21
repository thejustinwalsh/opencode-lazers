import type { TaskMachineDefinition } from "../runner/task-machine-config.ts"
import { activeState, observedTransition } from "./projection.ts"
import type { ObservationNode, RecordedTransition } from "./projection.ts"

const WIDTH = 360
const CENTER = WIDTH / 2
const NODE_WIDTH = 148
const NODE_HEIGHT = 38
const TOP = 34
const STEP = 78

export type StatechartNode = {
  id: string
  x: number
  y: number
  width: number
  height: number
  active: boolean
  initial: boolean
  final: boolean
}

export type StatechartEdge = {
  id: string
  event: string
  from: string
  to: string
  path: string
  arrow: string
  labelX: number
  labelY: number
  labelAnchor: "start" | "end"
  recorded?: RecordedTransition
}

export type StatechartLayout = {
  width: number
  height: number
  nodes: StatechartNode[]
  edges: StatechartEdge[]
}

/** Stable ordered SVG layout of the task machine; layout adds no states or edges. */
export function statechartLayout(
  machine: TaskMachineDefinition,
  node: ObservationNode,
  recordedTransitions: readonly RecordedTransition[],
): StatechartLayout {
  const active = activeState(node, machine)
  const definitions = machine.states
  const rowByID = new Map(definitions.map((state, index) => [state.id, index]))
  const nodes = definitions.map((state, index) => ({
    id: state.id,
    x: CENTER - NODE_WIDTH / 2,
    y: TOP + index * STEP,
    width: NODE_WIDTH,
    height: NODE_HEIGHT,
    active: state.id === active,
    initial: state.id === machine.initialState,
    final: state.type === "final",
  }))
  const transitions = definitions.flatMap((state) =>
    state.transitions.map((transition, index) => ({ state, transition, index })),
  )
  const outgoing = new Map<string, number>()
  const incoming = new Map<string, number>()
  const loopCounts = new Map<number, number>()
  const bypassCounts = new Map<number, number>()
  for (const item of transitions) {
    outgoing.set(item.state.id, (outgoing.get(item.state.id) ?? 0) + 1)
    incoming.set(item.transition.target, (incoming.get(item.transition.target) ?? 0) + 1)
  }
  const edgeSlots = new Map<string, number>()
  const targetSlots = new Map<string, number>()
  const edges = transitions.flatMap(({ state, transition, index }, globalIndex) => {
    const fromRow = rowByID.get(state.id)
    const toRow = rowByID.get(transition.target)
    if (fromRow === undefined || toRow === undefined) return []
    const sourceSlot = edgeSlots.get(state.id) ?? 0
    edgeSlots.set(state.id, sourceSlot + 1)
    const targetSlot = targetSlots.get(transition.target) ?? 0
    targetSlots.set(transition.target, targetSlot + 1)
    const fromY = TOP + fromRow * STEP
    const toY = TOP + toRow * STEP
    const backward = toRow <= fromRow
    const bypass = toRow > fromRow + 1
    let path: string
    let arrow: string
    let labelX: number
    let labelY: number
    let labelAnchor: "start" | "end"
    if (backward) {
      const loop = loopCounts.get(fromRow) ?? 0
      loopCounts.set(fromRow, loop + 1)
      const side = loop % 2 === 0 ? -1 : 1
      const laneX =
        side < 0 ? 18 + Math.floor(loop / 2) * 13 : WIDTH - 18 - Math.floor(loop / 2) * 13
      const sourceX = side < 0 ? CENTER - NODE_WIDTH / 2 : CENTER + NODE_WIDTH / 2
      const targetX = sourceX
      path = `M ${sourceX} ${fromY + NODE_HEIGHT / 2} C ${laneX} ${fromY + NODE_HEIGHT / 2 + 16}, ${laneX} ${toY - NODE_HEIGHT / 2 - 16}, ${targetX} ${toY - NODE_HEIGHT / 2}`
      labelX = side < 0 ? laneX + 4 : laneX - 4
      labelY = (fromY + toY) / 2
      labelAnchor = side < 0 ? "start" : "end"
      const arrowX = labelAnchor === "start" ? CENTER - NODE_WIDTH / 2 : CENTER + NODE_WIDTH / 2
      const arrowY = toY - NODE_HEIGHT / 2
      arrow = `M ${arrowX - 4} ${arrowY - 7} L ${arrowX} ${arrowY} L ${arrowX + 4} ${arrowY - 7}`
    } else if (bypass) {
      const side = globalIndex % 2 === 0 ? -1 : 1
      const lane = bypassCounts.get(side) ?? 0
      bypassCounts.set(side, lane + 1)
      const laneX = side < 0 ? 12 + lane * 12 : WIDTH - 12 - lane * 12
      const edgeX = side < 0 ? CENTER - NODE_WIDTH / 2 : CENTER + NODE_WIDTH / 2
      path = `M ${edgeX} ${fromY} C ${laneX} ${fromY}, ${laneX} ${toY}, ${edgeX} ${toY}`
      labelX = laneX + (side < 0 ? 4 : -4)
      labelY = (fromY + toY) / 2
      labelAnchor = side < 0 ? "start" : "end"
      arrow =
        side < 0
          ? `M ${edgeX - 7} ${toY - 4} L ${edgeX} ${toY} L ${edgeX - 7} ${toY + 4}`
          : `M ${edgeX + 7} ${toY - 4} L ${edgeX} ${toY} L ${edgeX + 7} ${toY + 4}`
    } else {
      const sourceTotal = outgoing.get(state.id) ?? 1
      const targetTotal = incoming.get(transition.target) ?? 1
      const sourceOffset = (sourceSlot - (sourceTotal - 1) / 2) * 12
      const targetOffset = (targetSlot - (targetTotal - 1) / 2) * 12
      const startX = CENTER + sourceOffset
      const endX = CENTER + targetOffset
      const startY = fromY + NODE_HEIGHT / 2
      const endY = toY - NODE_HEIGHT / 2
      const middleY = (startY + endY) / 2
      path = `M ${startX} ${startY} C ${startX} ${middleY}, ${endX} ${middleY}, ${endX} ${endY}`
      const side = (globalIndex + index) % 2 === 0 ? -1 : 1
      labelX = side < 0 ? 7 : WIDTH - 7
      labelY = startY + 12 + Math.floor(index / 2) * 12
      labelAnchor = side < 0 ? "start" : "end"
      arrow = `M ${endX - 4} ${endY - 7} L ${endX} ${endY} L ${endX + 4} ${endY - 7}`
    }
    const recorded = observedTransition(recordedTransitions, node, transition, state.id)
    return [
      {
        id: `${state.id}:${transition.event}:${transition.target}:${globalIndex}`,
        event: transition.event,
        from: state.id,
        to: transition.target,
        path,
        arrow,
        labelX,
        labelY,
        labelAnchor,
        ...(recorded ? { recorded } : {}),
      },
    ]
  })
  return {
    width: WIDTH,
    height: TOP + Math.max(definitions.length, 1) * STEP,
    nodes,
    edges,
  }
}
