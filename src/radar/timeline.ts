import type { SnapshotResponse } from "../observability/contract.ts"
import { activeState, timelineAttempts, timelineChecks } from "./projection.ts"
import type {
  ObservationPlan,
  RecordedTransition,
  TimelineAttempt,
  TimelineCheck,
} from "./projection.ts"

export type TimelineMark = {
  id: string
  kind: "attempt" | "execution" | "check" | "transition"
  label: string
  startAt: number | null
  endAt: number | null
  displayEndAt: number | null
  sequence: number | null
  openThroughObservation: boolean
  timingBasis?: string
  attempt?: TimelineAttempt
  check?: TimelineCheck
  transition?: RecordedTransition
}

export type TimelineLane = {
  id: string
  label: string
  taskID: string | null
  attemptID: string | null
  marks: TimelineMark[]
}

export type TimelineProjection = {
  lanes: TimelineLane[]
  startAt: number | null
  endAt: number | null
}

function objective(node: ObservationPlan["nodes"][number]) {
  const value = (node as typeof node & { objective?: unknown }).objective
  return typeof value === "string" && value.trim() ? value : node.taskID
}

function activeExecution(state: string) {
  return state === "running" || state === "verifying"
}

/** Build lanes only from records in this plan; open execution ends are observation-bound. */
export function timelineProjection(
  snapshot: SnapshotResponse,
  plan: ObservationPlan,
  extendActiveSpans: boolean,
): TimelineProjection {
  const observedAt = Date.parse(snapshot.observedAt)
  const validObservedAt = Number.isFinite(observedAt) ? observedAt : null
  const attempts = timelineAttempts(snapshot, plan.id)
  const checks = timelineChecks(snapshot, plan.id)
  const nodes = new Map(plan.nodes.map((node) => [node.taskID, node]))
  const lanes = new Map<string, TimelineLane>()
  const ensureLane = (
    taskID: string | null,
    attemptID: string | null,
    attempt?: TimelineAttempt,
  ) => {
    const id = attemptID ? `attempt:${attemptID}` : taskID ? `task:${taskID}` : `plan:${plan.id}`
    let lane = lanes.get(id)
    if (lane) return lane
    const task = taskID ? nodes.get(taskID) : undefined
    lane = {
      id,
      label: attempt
        ? `${task ? objective(task) : attempt.taskID} · attempt ${attempt.number}`
        : task
          ? objective(task)
          : (plan.title ?? plan.id),
      taskID,
      attemptID,
      marks: [],
    }
    lanes.set(id, lane)
    return lane
  }

  for (const attempt of attempts) {
    const lane = ensureLane(attempt.taskID, attempt.id, attempt)
    lane.marks.push({
      id: `attempt:${attempt.id}`,
      kind: "attempt",
      label: `Attempt ${attempt.number} · ${attempt.state}`,
      startAt: attempt.startedAt,
      endAt: null,
      displayEndAt: null,
      sequence: null,
      openThroughObservation: false,
      timingBasis: attempt.timingBasis,
      attempt,
    })
    for (const [index, execution] of attempt.executions.entries()) {
      const node = nodes.get(attempt.taskID)
      const openThroughObservation =
        execution.endedAt === null &&
        extendActiveSpans &&
        activeExecution(attempt.state) &&
        Boolean(
          node && activeExecution(node.state) && activeState(node, snapshot) === node.state,
        ) &&
        validObservedAt !== null
      lane.marks.push({
        id: `execution:${attempt.id}:${index}:${execution.startSequence ?? "unknown"}`,
        kind: "execution",
        label: `Execution ${index + 1}`,
        startAt: execution.startedAt,
        endAt: execution.endedAt,
        displayEndAt: execution.endedAt ?? (openThroughObservation ? validObservedAt : null),
        sequence: execution.startSequence,
        openThroughObservation,
        timingBasis: execution.timingBasis,
        attempt,
      })
    }
  }

  for (const check of checks) {
    const lane = ensureLane(check.taskID, check.attemptID)
    lane.marks.push({
      id: `check:${check.id}`,
      kind: "check",
      label: `${check.checkID} · ${check.state}`,
      startAt: check.startedAt,
      endAt: check.endedAt,
      displayEndAt: check.endedAt,
      sequence: null,
      openThroughObservation: false,
      timingBasis: check.timingBasis,
      check,
    })
  }

  for (const transition of snapshot.transitions) {
    if (transition.planID !== plan.id) continue
    const lane = ensureLane(transition.taskID, transition.attemptID)
    lane.marks.push({
      id: `transition:${transition.sequence}`,
      kind: "transition",
      label: `${transition.sequence} · ${transition.event}`,
      startAt: transition.recordedAt,
      endAt: null,
      displayEndAt: null,
      sequence: transition.sequence,
      openThroughObservation: false,
      transition,
    })
  }

  const orderedLanes: TimelineLane[] = []
  const included = new Set<string>()
  const addLane = (lane: TimelineLane | undefined) => {
    if (!lane || included.has(lane.id)) return
    included.add(lane.id)
    orderedLanes.push(lane)
  }
  for (const lane of lanes.values()) if (lane.id.startsWith("plan:")) addLane(lane)
  for (const attempt of attempts) addLane(lanes.get(`attempt:${attempt.id}`))
  for (const lane of lanes.values()) if (lane.id.startsWith("attempt:")) addLane(lane)
  for (const node of plan.nodes) addLane(lanes.get(`task:${node.taskID}`))
  for (const lane of lanes.values()) if (lane.id.startsWith("task:")) addLane(lane)
  const times = orderedLanes.flatMap((lane) =>
    lane.marks.flatMap((mark) =>
      [mark.startAt, mark.endAt, mark.displayEndAt].filter(
        (value): value is number => value !== null && Number.isFinite(value),
      ),
    ),
  )
  return {
    lanes: orderedLanes,
    startAt: times.length ? Math.min(...times) : null,
    endAt: times.length ? Math.max(...times) : null,
  }
}

export function timePercent(value: number, projection: TimelineProjection) {
  if (projection.startAt === null || projection.endAt === null) return 0
  if (projection.startAt === projection.endAt) return 50
  return Math.max(
    0,
    Math.min(100, ((value - projection.startAt) / (projection.endAt - projection.startAt)) * 100),
  )
}
