import type { SnapshotResponse } from "../observability/contract.ts"
import type { TaskSummary } from "./contract.ts"

type Plan = SnapshotResponse["plans"][number]
type Node = Plan["nodes"][number]

export type ExecutionListRow = {
  taskID: string
  title: string
  status: string
  reason: string | null
  ordinal: number
  reference?: string
  contextOnly: boolean
  prerequisites: string[]
  successors: string[]
  fork?: ExecutionFork
}

export type ExecutionBranch = {
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
  activeCount: number
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

const completed = new Set(["accepted", "incorporated", "cancelled"])

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
    if (
      joinPrerequisites.size !== branchTails.size ||
      [...branchTails].some((id) => !joinPrerequisites.has(id))
    )
      continue
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

function relationMap(topology: SnapshotResponse) {
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
  return { prerequisites, successors }
}

function row(
  node: Node,
  summary: TaskSummary | undefined,
  contextOnly: boolean,
  relations: ReturnType<typeof relationMap>,
): ExecutionListRow {
  return {
    taskID: node.taskID,
    title: summary?.objective ?? node.objective,
    status: node.state,
    reason: node.reason ?? summary?.reason ?? null,
    ordinal: node.ordinal,
    ...(summary?.reference ? { reference: summary.reference } : {}),
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
  topology?: SnapshotResponse
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
        status: task.status,
        reason: task.reason,
        ordinal,
        ...(task.reference ? { reference: task.reference } : {}),
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

  for (const plan of topology.plans) {
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
        row(node, summaryByID.get(node.taskID), contextual.has(node.taskID), relations),
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

    const activeCount = nodes.filter((node) => !completed.has(node.state)).length
    planGroups.push({
      planID: plan.id,
      planVersion: plan.version,
      planRevision: plan.revision,
      title: plan.title ?? "Recorded plan",
      hasRecordedTitle: plan.title !== null,
      activeCount,
      totalCount: nodes.length,
      rows: rootRows,
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
    return [
      {
        taskID,
        title: summary?.objective ?? projected!.title,
        status: summary?.status ?? projected!.status,
        reason: summary?.reason ?? null,
        ordinal,
        ...(summary?.reference ? { reference: summary.reference } : {}),
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
