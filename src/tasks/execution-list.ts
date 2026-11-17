import type { TopologyResponse } from "../observability/contract.ts"
import type { TaskSummary } from "./contract.ts"
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
  sourcePlan?: TaskSummary["sourcePlan"]
  dispatchPause?: TaskSummary["dispatchPause"]
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
  fork?: ExecutionFork
}

export type ExecutionBranch = {
  id: string
  taskIDs: string[]
  rows: ExecutionListRow[]
  hiddenCount: number
}

export type ExecutionFork = {
  id: string
  joinID: string
  branches: ExecutionBranch[]
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
  if (input.search?.trim()) {
    for (const taskID of summaries.keys()) {
      const plan = planByTask.get(taskID)
      if (!plan) continue
      const pending = [...(nodeByTask.get(taskID)?.prerequisites ?? [])]
      while (pending.length) {
        const prerequisite = pending.pop()!
        if (!nodeByTask.has(prerequisite) || visible.has(prerequisite)) continue
        visible.add(prerequisite)
        contextual.add(prerequisite)
        pending.push(...(nodeByTask.get(prerequisite)?.prerequisites ?? []))
      }
    }
  }

  const rendered = new Set<string>()
  const groups = plans.flatMap((plan) => {
    const nodes = plan.nodes.toSorted((left, right) => left.ordinal - right.ordinal)
    const dependencies = nodes.flatMap((node) =>
      node.prerequisites.map((prerequisite) => ({ prerequisite, successor: node.taskID })),
    )
    const rows = composePlanRows({
      nodes,
      dependencies,
      visible,
      contextual,
      searching: Boolean(input.search?.trim()),
      rendered,
      makeRow: (node, contextOnly) => {
        const summary = summaries.get(node.taskID)
        const reason = node.reason ?? summary?.reason ?? null
        const waiting =
          !terminal.has(node.lifecycle) &&
          (node.decision === "waiting" || node.lifecycle === "blocked")
        return {
          taskID: node.taskID,
          title: summary?.objective ?? node.title,
          status: summary?.recordedState ?? summary?.status ?? node.lifecycle,
          reason,
          waiting,
          holdReason: waiting ? reason : null,
          ordinal: node.ordinal,
          ...((summary?.reference ?? node.reference)
            ? { reference: summary?.reference ?? node.reference }
            : {}),
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
      },
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
        contextOnly: false,
        prerequisites: [],
        successors: [],
      },
    ]
  })
  return { topologyAvailable: false, plans: groups, unplanned }
}

type ForkBlock = {
  rootID: string
  joinID: string
  branches: string[][]
}

type RelationshipNode = { taskID: string; ordinal: number }
type RelationshipEdge = { prerequisite: string; successor: string }
type RelationshipPlan = {
  nodes: readonly RelationshipNode[]
  dependencies: readonly RelationshipEdge[]
}

const terminal = new Set(["accepted", "incorporated", "failed", "exhausted", "cancelled"])

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

function adjacency<TNode extends RelationshipNode>(plan: {
  nodes: readonly TNode[]
  dependencies: readonly RelationshipEdge[]
}) {
  const nodes = [...plan.nodes].toSorted((left, right) => left.ordinal - right.ordinal)
  const order = new Map(nodes.map((node) => [node.taskID, node.ordinal]))
  const outgoing = new Map<string, string[]>()
  const incoming = new Map<string, string[]>()
  for (const edge of plan.dependencies) {
    outgoing.set(edge.prerequisite, [...(outgoing.get(edge.prerequisite) ?? []), edge.successor])
    incoming.set(edge.successor, [...(incoming.get(edge.successor) ?? []), edge.prerequisite])
  }
  const sort = (ids: string[]) =>
    ids.toSorted(
      (left, right) =>
        (order.get(left) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(right) ?? Number.MAX_SAFE_INTEGER),
    )
  for (const [id, values] of outgoing) outgoing.set(id, sort(values))
  for (const [id, values] of incoming) incoming.set(id, sort(values))
  return { nodes, order, outgoing, incoming }
}

function reachableFrom(start: string, outgoing: Map<string, string[]>) {
  const reached = new Set<string>()
  const pending = [...(outgoing.get(start) ?? [])]
  while (pending.length) {
    const id = pending.pop()!
    if (reached.has(id)) continue
    reached.add(id)
    pending.push(...(outgoing.get(id) ?? []))
  }
  return reached
}

/** Find only fork blocks whose branches are disjoint, linear paths to one nearest join. */
function forkBlocks(plan: RelationshipPlan): ForkBlock[] {
  const { nodes, order, outgoing, incoming } = adjacency(plan)
  const reachability = new Map<string, Set<string>>()
  const reachable = (id: string) => {
    let value = reachability.get(id)
    if (!value) {
      value = reachableFrom(id, outgoing)
      reachability.set(id, value)
    }
    return value
  }
  const blocks: ForkBlock[] = []
  const reserved = new Set<string>()

  for (const root of nodes) {
    const heads = outgoing.get(root.taskID) ?? []
    if (heads.length < 2) continue
    const common = heads
      .map((id) => reachable(id))
      .reduce((shared, set) => new Set([...shared].filter((id) => set.has(id))))
    const nearest = [...common].filter(
      (candidate) =>
        ![...common].some((other) => other !== candidate && reachable(other).has(candidate)),
    )
    if (nearest.length !== 1) continue
    const joinID = nearest[0]!
    const branches: string[][] = []
    let valid = true

    for (const head of heads) {
      const path: string[] = []
      const local = new Set<string>()
      let current = head
      while (current !== joinID) {
        if (local.has(current) || !reachable(current).has(joinID)) {
          valid = false
          break
        }
        local.add(current)
        path.push(current)
        const next = outgoing.get(current) ?? []
        if (next.length !== 1) {
          valid = false
          break
        }
        current = next[0]!
      }
      if (!valid || path.length === 0) break
      branches.push(path)
    }
    if (!valid) continue

    const branchIDs = branches.flat()
    if (new Set(branchIDs).size !== branchIDs.length || branchIDs.some((id) => reserved.has(id)))
      continue
    const branchTails = new Set(branches.map((path) => path[path.length - 1]!))
    const joinPrerequisites = new Set(incoming.get(joinID) ?? [])
    // A root-lane join may also wait on work outside this fork. Those edges stay
    // dependency references; they do not make the two linear branches overlap.
    if ([...branchTails].some((id) => !joinPrerequisites.has(id))) continue
    if (
      heads.some(
        (head) =>
          (incoming.get(head) ?? []).length !== 1 || incoming.get(head)?.[0] !== root.taskID,
      )
    )
      continue

    for (const path of branches) {
      for (let index = 0; index < path.length; index++) {
        const id = path[index]!
        const next = path[index + 1] ?? joinID
        if (outgoing.get(id)?.length !== 1 || outgoing.get(id)?.[0] !== next) valid = false
        if (
          index > 0 &&
          (incoming.get(id)?.length !== 1 || incoming.get(id)?.[0] !== path[index - 1])
        )
          valid = false
      }
    }
    if (!valid) continue

    for (const id of branchIDs) reserved.add(id)
    branches.sort((left, right) => {
      const leftOrdinal = order.get(left[0]!) ?? 0
      const rightOrdinal = order.get(right[0]!) ?? 0
      return leftOrdinal - rightOrdinal
    })
    blocks.push({ rootID: root.taskID, joinID, branches })
  }
  return blocks
}

function composePlanRows<TNode extends RelationshipNode>(input: {
  nodes: readonly TNode[]
  dependencies: readonly RelationshipEdge[]
  visible: ReadonlySet<string>
  contextual: ReadonlySet<string>
  searching: boolean
  rendered: Set<string>
  makeRow: (node: TNode, contextOnly: boolean) => ExecutionListRow
}) {
  const plan = { nodes: input.nodes, dependencies: input.dependencies }
  const { nodes } = adjacency(plan)
  const blocks = forkBlocks(plan)
  const contextual = new Set(input.contextual)
  const activeBlocks = blocks.filter((block) => {
    if (
      input.rendered.has(block.rootID) ||
      input.rendered.has(block.joinID) ||
      block.branches.some((path) => path.some((id) => input.rendered.has(id)))
    )
      return false
    const descendantsVisible = block.branches.some((path) =>
      path.some((id) => input.visible.has(id)),
    )
    const rootVisible = input.visible.has(block.rootID)
    if (!descendantsVisible && !rootVisible) return false
    if (!rootVisible && descendantsVisible) contextual.add(block.rootID)
    if (input.searching) {
      for (const path of block.branches) {
        const lastVisible = path.reduce(
          (last, id, index) => (input.visible.has(id) ? index : last),
          -1,
        )
        if (lastVisible >= 0)
          for (const id of path.slice(0, lastVisible))
            if (!input.visible.has(id)) contextual.add(id)
      }
    }
    return true
  })

  const branchOwner = new Map<string, ForkBlock>()
  for (const block of activeBlocks)
    for (const path of block.branches) for (const id of path) branchOwner.set(id, block)

  const planRows = new Map<string, ExecutionListRow>()
  for (const node of nodes) {
    if (
      input.rendered.has(node.taskID) ||
      (!input.visible.has(node.taskID) && !contextual.has(node.taskID))
    )
      continue
    input.rendered.add(node.taskID)
    planRows.set(node.taskID, input.makeRow(node, contextual.has(node.taskID)))
  }

  return nodes.flatMap((node) => {
    const taskRow = planRows.get(node.taskID)
    if (!taskRow || branchOwner.has(node.taskID)) return []
    const block = activeBlocks.find((candidate) => candidate.rootID === node.taskID)
    if (block) {
      const forkID = `${block.rootID}:${block.branches.map((path) => path[0]).join(",")}`
      taskRow.fork = {
        id: forkID,
        joinID: block.joinID,
        branches: block.branches.map((path) => {
          const rows = path.flatMap((id) => {
            const branchRow = planRows.get(id)
            return branchRow ? [branchRow] : []
          })
          return {
            id: path[0]!,
            taskIDs: rows.map((branchRow) => branchRow.taskID),
            rows,
            hiddenCount: path.length - rows.length,
          }
        }),
      }
    }
    return [taskRow]
  })
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
  const searching = Boolean(input.search?.trim())
  const visible = new Set([...summaryByID.keys(), ...(input.revealTaskIDs ?? [])])
  const rendered = new Set<string>()
  const planGroups: ExecutionPlanGroup[] = []

  const plans = topology.plans.toSorted((left, right) => {
    const running = (plan: Plan) =>
      !["blocked", "cancelled"].includes(plan.state) &&
      plan.nodes.some(
        (node) => ["running", "verifying"].includes(node.state) && visible.has(node.taskID),
      )
    return (
      Number(running(right)) - Number(running(left)) ||
      Number(right.state === "cancelling") - Number(left.state === "cancelling") ||
      (right.priority ?? 0) - (left.priority ?? 0) ||
      (left.queuePosition ?? 0) - (right.queuePosition ?? 0)
    )
  })
  for (const plan of plans) {
    const { nodes } = adjacency(plan)
    const rootRows = composePlanRows({
      nodes,
      dependencies: plan.dependencies,
      visible,
      contextual: new Set([...(input.revealTaskIDs ?? [])].filter((id) => !summaryByID.has(id))),
      searching,
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
      rows: scheduleByPlan.has(plan.id)
        ? rootRows
        : rootRows.toSorted((left, right) => {
            const running = (row: ExecutionListRow): boolean =>
              !row.waiting &&
              (["running", "verifying"].includes(row.status) ||
                Boolean(row.fork?.branches.some((branch) => branch.rows.some(running))))
            return Number(running(right)) - Number(running(left)) || left.ordinal - right.ordinal
          }),
      ...(scheduleByPlan.get(plan.id)
        ? {
            priority: scheduleByPlan.get(plan.id)!.priority,
            planOrder: scheduleByPlan.get(plan.id)!.planOrder,
            schedulingDecision: scheduleByPlan.get(plan.id)!.decision,
            schedulingReason: scheduleByPlan.get(plan.id)!.reason,
            afterPlans: scheduleByPlan.get(plan.id)!.afterPlans,
          }
        : {}),
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
        sourcePlan: summary?.sourcePlan,
        dispatchPause: summary?.dispatchPause,
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

  return { topologyAvailable: true, plans: planGroups, unplanned }
}

export function selectForkForTask(groups: ExecutionPlanGroup[], taskID: string) {
  for (const group of groups) {
    for (const root of group.rows) {
      const fork = root.fork
      if (fork?.branches.some((branch) => branch.rows.some((row) => row.taskID === taskID)))
        return { planID: group.planID, forkID: fork.id }
    }
  }
  return undefined
}
