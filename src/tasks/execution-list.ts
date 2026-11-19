import type { TopologyResponse } from "../observability/contract.ts"
import { comparePriority } from "../runner/priority.ts"
import type { TaskConcern, TaskSummary } from "./contract.ts"
import type { SchedulingNode, SchedulingPlan, SchedulingSnapshot } from "./scheduling-contract.ts"

type Plan = TopologyResponse["plans"][number]
type Node = Plan["nodes"][number]

export type ExecutionListRow = {
  taskID: string
  title: string
  status: string
  reason: string | null
  waiting: boolean
  holdReason: string | null
  ordinal: number
  reference?: string
  /** Epoch ms the running task's current attempt began; absent unless the read supplied it. */
  startedAt?: number
  /** Present when the task's recorded effort trips a concern rule. */
  concern?: TaskConcern
  sourcePlan?: TaskSummary["sourcePlan"]
  dispatchPause?: TaskSummary["dispatchPause"]
  dispatchPausePlanID?: string
  contextOnly: boolean
  prerequisites: string[]
  successors: string[]
  dependencyTasks?: Array<{
    taskID: string
    reference?: string
    title: string
    state: string
    waiting: boolean
  }>
  scheduling?: {
    decision: SchedulingNode["decision"]
    reason: string | null
    waitingOn: string[]
    waitingOnPlans?: string[]
    waitingOnPlansCount?: number
    waitingOnPlansComplete?: boolean
    reservationTaskIDs: string[]
    reservationTaskCount?: number
    reservationTaskIDsComplete?: boolean
    reservationTaskIDsScopeLimited?: boolean
  }
}

export type ExecutionPlanGroup = {
  planID: string
  planVersion: number
  planRevision?: number
  title: string
  hasRecordedTitle: boolean
  /** Recorded plan lifecycle, distinct from any task row state. */
  state?: string
  nonterminalCount: number
  totalCount: number
  rows: ExecutionListRow[]
  /** Scheduler priority, present only when the scheduling read covers this plan. */
  priority?: number
  planOrder?: number
  schedulingDecision?: SchedulingPlan["decision"]
  schedulingReason?: string | null
  afterPlans?: string[]
  afterPlansCount?: number
  afterPlansComplete?: boolean
}

export type ExecutionList = {
  plans: ExecutionPlanGroup[]
  unplanned: ExecutionListRow[]
  /** Rows for tasks not listed themselves: dependency-tree targets only. */
  related: ExecutionListRow[]
  topologyAvailable: boolean
}

function buildScheduledGroups(input: {
  tasks: TaskSummary[]
  search?: string
  revealTaskIDs?: ReadonlySet<string>
  scheduling?: SchedulingSnapshot
}): ExecutionList {
  const summaries = new Map(input.tasks.map((task) => [task.taskID, task]))
  const plans = input.scheduling?.plans ?? []
  const planByTask = new Map<string, SchedulingPlan>()
  const nodeByTask = new Map<string, SchedulingNode>()
  const successors = new Map<string, string[]>()
  for (const plan of plans) {
    for (const node of plan.nodes) {
      planByTask.set(node.taskID, plan)
      nodeByTask.set(node.taskID, node)
      for (const prerequisite of node.prerequisites)
        successors.set(prerequisite, [...(successors.get(prerequisite) ?? []), node.taskID])
    }
  }

  const visible = new Set([...summaries.keys(), ...(input.revealTaskIDs ?? [])])
  const contextual = new Set(
    [...(input.revealTaskIDs ?? [])].filter((taskID) => !summaries.has(taskID)),
  )
  const rendered = new Set<string>()
  const pauseOf = (plan: SchedulingPlan) =>
    // A dispatch pause belongs to the plan; the task page reports it on each listed task. Without
    // topology it is the only record of the pause, so it marks every queued or ready row.
    plan.nodes
      .map((node) => summaries.get(node.taskID)?.dispatchPause)
      .find((value) => value !== undefined)
  const makeNodeRow = (
    plan: SchedulingPlan,
    node: SchedulingNode,
    contextOnly: boolean,
  ): ExecutionListRow => {
    const pause = pauseOf(plan)
    const summary = summaries.get(node.taskID)
    const reason = node.reason ?? summary?.reason ?? null
    const waiting =
      !terminal.has(node.lifecycle) && (node.decision === "waiting" || node.lifecycle === "blocked")
    const status = summary?.recordedState ?? summary?.status ?? node.lifecycle
    return {
      taskID: node.taskID,
      title: summary?.objective ?? node.title,
      status,
      reason,
      waiting,
      holdReason: waiting ? reason : null,
      ordinal: node.ordinal,
      ...(pause && pausable.has(status) ? { dispatchPause: pause } : {}),
      ...((summary?.reference ?? node.reference)
        ? { reference: summary?.reference ?? node.reference }
        : {}),
      ...(summary?.startedAt !== undefined ? { startedAt: summary.startedAt } : {}),
      ...(summary?.concern ? { concern: summary.concern } : {}),
      contextOnly,
      prerequisites: node.prerequisites,
      successors: successors.get(node.taskID) ?? [],
      scheduling: {
        decision: node.decision,
        reason: schedulingReason(node, input.scheduling),
        waitingOn: node.waitingOn,
        waitingOnPlans: node.waitingOnPlans,
        ...(node.waitingOnPlansCount !== undefined
          ? { waitingOnPlansCount: node.waitingOnPlansCount }
          : {}),
        ...(node.waitingOnPlansComplete !== undefined
          ? { waitingOnPlansComplete: node.waitingOnPlansComplete }
          : {}),
        reservationTaskIDs: node.reservationTaskIDs,
        ...(node.reservationTaskCount !== undefined
          ? { reservationTaskCount: node.reservationTaskCount }
          : {}),
        ...(node.reservationTaskIDsComplete !== undefined
          ? { reservationTaskIDsComplete: node.reservationTaskIDsComplete }
          : {}),
        ...(node.reservationTaskIDsScopeLimited !== undefined
          ? { reservationTaskIDsScopeLimited: node.reservationTaskIDsScopeLimited }
          : {}),
      },
    }
  }
  const groups = plans.flatMap((plan) => {
    const nodes = plan.nodes.toSorted((left, right) => left.ordinal - right.ordinal)
    const rows = composePlanRows({
      nodes,
      visible,
      contextual,
      rendered,
      makeRow: (node, contextOnly) => makeNodeRow(plan, node, contextOnly),
    })
    if (!rows.length) return []
    return [
      {
        planID: plan.planID,
        planVersion: plan.planVersion,
        title: plan.title,
        hasRecordedTitle: true,
        state: plan.lifecycle,
        nonterminalCount: nodes.filter((node) => !terminal.has(node.lifecycle)).length,
        totalCount: nodes.length,
        rows,
        priority: plan.priority,
        planOrder: plan.planOrder,
        schedulingDecision: plan.decision,
        schedulingReason: plan.reason,
        afterPlans: plan.afterPlans,
        ...(plan.afterPlansCount !== undefined ? { afterPlansCount: plan.afterPlansCount } : {}),
        ...(plan.afterPlansComplete !== undefined
          ? { afterPlansComplete: plan.afterPlansComplete }
          : {}),
      },
    ]
  })

  const unplanned = input.tasks.flatMap((task, ordinal) => {
    if (nodeByTask.has(task.taskID)) return []
    return [
      {
        taskID: task.taskID,
        title: task.objective,
        status: task.recordedState ?? task.status,
        reason: task.reason,
        waiting: false,
        holdReason: null,
        ordinal,
        ...(task.reference ? { reference: task.reference } : {}),
        ...(task.dispatchPause && pausable.has(task.recordedState ?? task.status)
          ? { dispatchPause: task.dispatchPause, dispatchPausePlanID: task.dispatchPausePlanID }
          : {}),
        contextOnly: false,
        prerequisites: [],
        successors: [],
      },
    ]
  })
  const related = plans.flatMap((plan) =>
    plan.nodes.flatMap((node) =>
      rendered.has(node.taskID) ? [] : [makeNodeRow(plan, node, true)],
    ),
  )
  return { topologyAvailable: false, plans: sortPlanGroups(groups), unplanned, related }
}

type RelationshipNode = { taskID: string; ordinal: number }

const terminal = new Set(["accepted", "incorporated", "failed", "exhausted", "cancelled"])
/** Lifecycles a dispatch pause holds back; started or finished work is not paused. */
const pausable = new Set(["queued", "ready"])

function schedulingReason(node: SchedulingNode, snapshot: SchedulingSnapshot | undefined) {
  const referencesIncomplete = node.reservationTaskIDsComplete === false
  const planReferencesIncomplete = node.waitingOnPlansComplete === false
  const scopeLimited =
    node.reservationTaskIDsScopeLimited === true && snapshot?.scope.kind === "session"
  if (!referencesIncomplete && !planReferencesIncomplete && !scopeLimited) return node.reason
  const coverage: string[] = []
  if (referencesIncomplete) {
    const count = node.reservationTaskCount ?? node.reservationTaskIDs.length
    const shown = node.reservationTaskIDs.length
    if (!snapshot?.coverage.reservationsComplete) {
      coverage.push(
        count > 0
          ? `At least ${count} blocker task reference${count === 1 ? " is" : "s are"} known; reservation coverage is incomplete.${shown < count ? ` Showing ${shown}.` : ""}`
          : "Reservation coverage is incomplete; blocker references may be missing.",
      )
    } else if (count > shown) {
      coverage.push(
        `Showing ${shown} of ${count} blocker task references${snapshot.scope.kind === "session" ? " visible in this session" : ""}.`,
      )
    } else {
      coverage.push("Blocker reference completeness is unavailable.")
    }
  }
  if (planReferencesIncomplete) {
    const count = node.waitingOnPlansCount ?? node.waitingOnPlans?.length ?? 0
    const shown = node.waitingOnPlans?.length ?? 0
    coverage.push(
      `Showing ${shown} of ${count} prerequisite plan references${snapshot?.scope.kind === "session" ? " visible in this session" : ""}.`,
    )
  }
  if (scopeLimited) {
    const count = node.reservationTaskCount ?? node.reservationTaskIDs.length
    coverage.push(
      count === 0
        ? "No blocker references are visible in this session; known blockers outside this scope are not shown."
        : "Known blockers outside this session scope are not shown.",
    )
  }

  return [node.reason, ...coverage].filter((part): part is string => Boolean(part)).join(" ")
}

/** Priority first (1 is top, none last), then the scheduler's plan order. */
function sortPlanGroups(groups: ExecutionPlanGroup[]) {
  return groups.toSorted(
    (left, right) =>
      comparePriority(left.priority, right.priority) ||
      (left.planOrder ?? Number.MAX_SAFE_INTEGER) - (right.planOrder ?? Number.MAX_SAFE_INTEGER),
  )
}

function composePlanRows<TNode extends RelationshipNode>(input: {
  nodes: readonly TNode[]
  visible: ReadonlySet<string>
  contextual: ReadonlySet<string>
  rendered: Set<string>
  makeRow: (node: TNode, contextOnly: boolean) => ExecutionListRow
}) {
  const rows: ExecutionListRow[] = []
  for (const node of [...input.nodes].toSorted((left, right) => left.ordinal - right.ordinal)) {
    if (
      input.rendered.has(node.taskID) ||
      (!input.visible.has(node.taskID) && !input.contextual.has(node.taskID))
    )
      continue
    input.rendered.add(node.taskID)
    rows.push(input.makeRow(node, input.contextual.has(node.taskID)))
  }
  return rows
}

function relationMap(topology: TopologyResponse) {
  const prerequisites = new Map<string, string[]>()
  const successors = new Map<string, string[]>()
  for (const plan of topology.plans) {
    for (const edge of plan.dependencies) {
      prerequisites.set(edge.successor, [
        ...(prerequisites.get(edge.successor) ?? []),
        edge.prerequisite,
      ])
      successors.set(edge.prerequisite, [
        ...(successors.get(edge.prerequisite) ?? []),
        edge.successor,
      ])
    }
  }
  for (const [id, values] of prerequisites) prerequisites.set(id, [...new Set(values)])
  for (const [id, values] of successors) successors.set(id, [...new Set(values)])
  const byID = new Map(topology.plans.map((plan) => [plan.id, plan]))
  const dependencyTasks = new Map<string, NonNullable<ExecutionListRow["dependencyTasks"]>>()
  for (const plan of topology.plans) {
    for (const node of plan.nodes) {
      const samePlan = (prerequisites.get(node.taskID) ?? []).flatMap((id) => {
        const prior = plan.nodes.find((candidate) => candidate.taskID === id)
        return prior
          ? [
              {
                taskID: id,
                reference: prior.reference,
                title: prior.objective,
                state: prior.state,
                waiting: node.waitingOn.includes(id) || prior.state !== "accepted",
              },
            ]
          : []
      })
      const crossPlan = [
        ...new Set([...plan.afterPlans, ...(plan.dispatchPause?.untilPlans ?? [])]),
      ].flatMap((id) => {
        const prior = byID.get(id)
        if (!prior) return []
        const integrated = ["integrated", "cleaning", "cleanup-blocked"].includes(prior.state)
        return prior.nodes.map((candidate) => ({
          taskID: candidate.taskID,
          reference: candidate.reference,
          title: candidate.objective,
          state: integrated
            ? "integrated"
            : candidate.state === "accepted" && ["accepted", "running"].includes(prior.state)
              ? "awaiting integration"
              : prior.state === "running"
                ? candidate.state
                : prior.state,
          waiting: !integrated,
        }))
      })
      dependencyTasks.set(node.taskID, [
        ...new Map([...samePlan, ...crossPlan].map((value) => [value.taskID, value])).values(),
      ])
    }
  }
  return { prerequisites, successors, dependencyTasks }
}

function row(
  plan: Plan,
  node: Node,
  summary: TaskSummary | undefined,
  contextOnly: boolean,
  relations: ReturnType<typeof relationMap>,
  scheduling?: SchedulingNode,
  schedulingSnapshot?: SchedulingSnapshot,
): ExecutionListRow {
  const dependencyTasks = relations.dependencyTasks.get(node.taskID) ?? []
  const waiting =
    plan.state !== "cancelled" &&
    !terminal.has(node.state) &&
    (node.state === "blocked" ||
      summary?.status === "blocked" ||
      plan.state === "blocked" ||
      (!plan.dispatchPause &&
        ["queued", "ready"].includes(node.state) &&
        dependencyTasks.some((dependency) => dependency.waiting)))
  return {
    taskID: node.taskID,
    title: summary?.objective ?? node.objective,
    status: summary?.recordedState ?? node.state,
    reason: waiting
      ? (node.reason ?? plan.reason ?? summary?.reason ?? null)
      : (node.reason ?? summary?.reason ?? null),
    waiting,
    holdReason: waiting ? (plan.reason ?? node.reason ?? summary?.reason ?? null) : null,
    ordinal: node.ordinal,
    ...((summary?.reference ?? node.reference)
      ? { reference: summary?.reference ?? node.reference }
      : {}),
    ...(summary?.startedAt !== undefined ? { startedAt: summary.startedAt } : {}),
    ...(summary?.concern ? { concern: summary.concern } : {}),
    dependencyTasks,
    ...(["queued", "ready"].includes(node.state) && plan.dispatchPause
      ? { dispatchPause: plan.dispatchPause }
      : {}),
    sourcePlan: summary?.sourcePlan ?? node.sourcePlan,
    contextOnly,
    prerequisites: relations.prerequisites.get(node.taskID) ?? [],
    successors: relations.successors.get(node.taskID) ?? [],
    ...(scheduling
      ? {
          scheduling: {
            decision: scheduling.decision,
            reason: schedulingReason(scheduling, schedulingSnapshot),
            waitingOn: scheduling.waitingOn,
            waitingOnPlans: scheduling.waitingOnPlans,
            ...(scheduling.waitingOnPlansCount !== undefined
              ? { waitingOnPlansCount: scheduling.waitingOnPlansCount }
              : {}),
            ...(scheduling.waitingOnPlansComplete !== undefined
              ? { waitingOnPlansComplete: scheduling.waitingOnPlansComplete }
              : {}),
            reservationTaskIDs: scheduling.reservationTaskIDs,
            ...(scheduling.reservationTaskCount !== undefined
              ? { reservationTaskCount: scheduling.reservationTaskCount }
              : {}),
            ...(scheduling.reservationTaskIDsComplete !== undefined
              ? { reservationTaskIDsComplete: scheduling.reservationTaskIDsComplete }
              : {}),
            ...(scheduling.reservationTaskIDsScopeLimited !== undefined
              ? { reservationTaskIDsScopeLimited: scheduling.reservationTaskIDsScopeLimited }
              : {}),
          },
        }
      : {}),
  }
}

/**
 * Build a quiet list from complete scoped topology plus the summaries admitted by the current
 * filter/page. Summary rows control visibility; topology supplies only recorded relationships.
 */
export function buildExecutionList(input: {
  topology?: TopologyResponse
  tasks: TaskSummary[]
  search?: string
  revealTaskIDs?: ReadonlySet<string>
  scheduling?: SchedulingSnapshot
}): ExecutionList {
  const summaryByID = new Map(input.tasks.map((task) => [task.taskID, task]))
  const scheduleByPlan = new Map(input.scheduling?.plans.map((plan) => [plan.planID, plan]) ?? [])
  const scheduleByTask = new Map(
    input.scheduling?.plans.flatMap((plan) =>
      plan.nodes.map((node) => [node.taskID, node] as const),
    ) ?? [],
  )
  if (!input.topology) {
    return buildScheduledGroups(input)
  }

  const topology = input.topology
  const relations = relationMap(topology)
  const visible = new Set([...summaryByID.keys(), ...(input.revealTaskIDs ?? [])])
  const rendered = new Set<string>()
  const planGroups: ExecutionPlanGroup[] = []

  const plans = topology.plans.toSorted(
    (left, right) =>
      comparePriority(
        scheduleByPlan.get(left.id)?.priority ?? left.priority,
        scheduleByPlan.get(right.id)?.priority ?? right.priority,
      ) || (left.queuePosition ?? 0) - (right.queuePosition ?? 0),
  )
  for (const plan of plans) {
    const nodes = plan.nodes.toSorted((left, right) => left.ordinal - right.ordinal)
    const rootRows = composePlanRows({
      nodes,
      visible,
      contextual: new Set([...(input.revealTaskIDs ?? [])].filter((id) => !summaryByID.has(id))),
      rendered,
      makeRow: (node, contextOnly) =>
        row(
          plan,
          node,
          summaryByID.get(node.taskID),
          contextOnly,
          relations,
          scheduleByTask.get(node.taskID),
          input.scheduling,
        ),
    })
    if (!rootRows.length) continue

    const nonterminalCount = nodes.filter((node) => !terminal.has(node.state)).length
    planGroups.push({
      planID: plan.id,
      planVersion: plan.version,
      planRevision: plan.revision,
      title: scheduleByPlan.get(plan.id)?.title ?? plan.title ?? `Plan ${plan.id.slice(0, 8)}`,
      hasRecordedTitle: plan.title !== null || Boolean(scheduleByPlan.get(plan.id)?.title),
      state: plan.state,
      nonterminalCount,
      totalCount: nodes.length,
      rows: rootRows,
      ...(scheduleByPlan.get(plan.id)
        ? {
            priority: scheduleByPlan.get(plan.id)!.priority,
            planOrder: scheduleByPlan.get(plan.id)!.planOrder,
            schedulingDecision: scheduleByPlan.get(plan.id)!.decision,
            schedulingReason: scheduleByPlan.get(plan.id)!.reason,
            afterPlans: scheduleByPlan.get(plan.id)!.afterPlans,
          }
        : { priority: plan.priority }),
    })
  }

  const unplannedByID = new Map(topology.unplannedTasks.map((task) => [task.taskID, task]))
  const unplannedIDs = [
    ...input.tasks.map((task) => task.taskID),
    ...[...(input.revealTaskIDs ?? [])].filter((id) => unplannedByID.has(id)),
  ]
  const unplanned = unplannedIDs.flatMap((taskID, ordinal) => {
    if (rendered.has(taskID)) return []
    const summary = summaryByID.get(taskID)
    const projected = unplannedByID.get(taskID)
    if (!summary && !projected) return []
    rendered.add(taskID)
    return [
      {
        taskID,
        title: summary?.objective ?? projected!.title,
        status: summary?.recordedState ?? summary?.status ?? projected!.status,
        reason: summary?.reason ?? null,
        waiting: false,
        holdReason: null,
        ordinal,
        ...(summary?.reference ? { reference: summary.reference } : {}),
        ...(summary?.startedAt !== undefined ? { startedAt: summary.startedAt } : {}),
        ...(summary?.concern ? { concern: summary.concern } : {}),
        sourcePlan: summary?.sourcePlan,
        dispatchPause: summary?.dispatchPause,
        dispatchPausePlanID: summary?.dispatchPausePlanID,
        contextOnly: !summary,
        prerequisites: relations.prerequisites.get(taskID) ?? [],
        successors: relations.successors.get(taskID) ?? [],
        ...(scheduleByTask.get(taskID)
          ? {
              scheduling: {
                decision: scheduleByTask.get(taskID)!.decision,
                reason: schedulingReason(scheduleByTask.get(taskID)!, input.scheduling),
                waitingOn: scheduleByTask.get(taskID)!.waitingOn,
                waitingOnPlans: scheduleByTask.get(taskID)!.waitingOnPlans,
                ...(scheduleByTask.get(taskID)!.waitingOnPlansCount !== undefined
                  ? {
                      waitingOnPlansCount: scheduleByTask.get(taskID)!.waitingOnPlansCount,
                    }
                  : {}),
                ...(scheduleByTask.get(taskID)!.waitingOnPlansComplete !== undefined
                  ? {
                      waitingOnPlansComplete: scheduleByTask.get(taskID)!.waitingOnPlansComplete,
                    }
                  : {}),
                reservationTaskIDs: scheduleByTask.get(taskID)!.reservationTaskIDs,
                ...(scheduleByTask.get(taskID)!.reservationTaskCount !== undefined
                  ? { reservationTaskCount: scheduleByTask.get(taskID)!.reservationTaskCount }
                  : {}),
                ...(scheduleByTask.get(taskID)!.reservationTaskIDsComplete !== undefined
                  ? {
                      reservationTaskIDsComplete:
                        scheduleByTask.get(taskID)!.reservationTaskIDsComplete,
                    }
                  : {}),
                ...(scheduleByTask.get(taskID)!.reservationTaskIDsScopeLimited !== undefined
                  ? {
                      reservationTaskIDsScopeLimited:
                        scheduleByTask.get(taskID)!.reservationTaskIDsScopeLimited,
                    }
                  : {}),
              },
            }
          : {}),
      },
    ]
  })

  const related = topology.plans.flatMap((plan) =>
    plan.nodes.flatMap((node) =>
      rendered.has(node.taskID)
        ? []
        : [
            row(
              plan,
              node,
              undefined,
              true,
              relations,
              scheduleByTask.get(node.taskID),
              input.scheduling,
            ),
          ],
    ),
  )
  return { topologyAvailable: true, plans: planGroups, unplanned, related }
}
