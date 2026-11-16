import type { TopologyResponse } from "../observability/contract.ts"
import type { TaskSummary } from "./contract.ts"

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
  planRevision: number
  title: string
  hasRecordedTitle: boolean
  /** Recorded plan lifecycle, distinct from any task row state. */
  state: string
  /** Recorded scheduler priority; higher dispatches first among eligible plans. */
  priority: number
  nonterminalCount: number
  totalCount: number
  rows: ExecutionListRow[]
}

export type ExecutionList = {
  plans: ExecutionPlanGroup[]
  unplanned: ExecutionListRow[]
  topologyAvailable: boolean
}

type ForkBlock = {
  rootID: string
  joinID: string
  branches: string[][]
}

const terminal = new Set(["accepted", "incorporated", "failed", "exhausted", "cancelled"])

function adjacency(plan: Plan) {
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
function forkBlocks(plan: Plan): ForkBlock[] {
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
}): ExecutionList {
  const summaryByID = new Map(input.tasks.map((task) => [task.taskID, task]))
  if (!input.topology) {
    return {
      topologyAvailable: false,
      plans: [],
      unplanned: input.tasks.map((task, ordinal) => ({
        taskID: task.taskID,
        title: task.objective,
        status: task.recordedState ?? task.status,
        reason: task.reason,
        waiting: false,
        holdReason: null,
        ordinal,
        ...(task.reference ? { reference: task.reference } : {}),
        sourcePlan: task.sourcePlan,
        dispatchPause: task.dispatchPause,
        contextOnly: false,
        prerequisites: [],
        successors: [],
      })),
    }
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
    const blocks = forkBlocks(plan)
    const contextual = new Set(
      [...(input.revealTaskIDs ?? [])].filter((id) => !summaryByID.has(id)),
    )
    const activeBlocks = blocks.filter((block) => {
      if (
        rendered.has(block.rootID) ||
        rendered.has(block.joinID) ||
        block.branches.some((path) => path.some((id) => rendered.has(id)))
      )
        return false
      const descendantsVisible = block.branches.some((path) => path.some((id) => visible.has(id)))
      const rootVisible = visible.has(block.rootID)
      if (!descendantsVisible && !rootVisible) return false
      if (!rootVisible && descendantsVisible) contextual.add(block.rootID)
      if (searching) {
        for (const path of block.branches) {
          const lastVisible = path.reduce((last, id, index) => (visible.has(id) ? index : last), -1)
          if (lastVisible >= 0)
            for (const id of path.slice(0, lastVisible)) if (!visible.has(id)) contextual.add(id)
        }
      }
      return true
    })

    const branchOwner = new Map<string, ForkBlock>()
    for (const block of activeBlocks)
      for (const path of block.branches) for (const id of path) branchOwner.set(id, block)

    const planRows = new Map<string, ExecutionListRow>()
    for (const node of nodes) {
      if (rendered.has(node.taskID) || (!visible.has(node.taskID) && !contextual.has(node.taskID)))
        continue
      rendered.add(node.taskID)
      planRows.set(
        node.taskID,
        row(plan, node, summaryByID.get(node.taskID), contextual.has(node.taskID), relations),
      )
    }

    const rootRows = nodes.flatMap((node) => {
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
    if (!rootRows.length) continue

    const nonterminalCount = nodes.filter((node) => !terminal.has(node.state)).length
    planGroups.push({
      planID: plan.id,
      planVersion: plan.version,
      planRevision: plan.revision,
      title: plan.title ?? `Plan ${plan.id.slice(0, 8)}`,
      hasRecordedTitle: plan.title !== null,
      state: plan.state,
      priority: plan.priority ?? 0,
      nonterminalCount,
      totalCount: nodes.length,
      rows: rootRows.toSorted((left, right) => {
        const running = (row: ExecutionListRow): boolean =>
          !row.waiting &&
          (["running", "verifying"].includes(row.status) ||
            Boolean(row.fork?.branches.some((branch) => branch.rows.some(running))))
        return Number(running(right)) - Number(running(left)) || left.ordinal - right.ordinal
      }),
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
