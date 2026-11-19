import type { Database } from "bun:sqlite"
import { z } from "zod"
import { planPrioritySortSQL } from "./priority.ts"
import { retainedVerificationsForInspection } from "./retained-verification/store.ts"
import type {
  RetainedVerificationInspection,
  RetainedVerificationProjection,
} from "./retained-verification/store.ts"
import type { RunnerStore } from "./store.ts"
import type { VerificationTimeoutAmendment } from "./verification-timeout.ts"
import type { DelegatedAgentStatus } from "./delegated-agent-capacity.ts"
import { PlanInput, type ExecutionPlanWait } from "./schema.ts"

type DelegatedAgentInspection = DelegatedAgentStatus & {
  queuedRunnerTasks: Array<{ planID: string; taskID: string }>
}

const CompactInspectPlanInput = z.strictObject({
  planID: z.uuid().optional(),
  full: z.boolean().optional().default(false),
  /** Full view only: rows per history list (activity, evidence, delivery); newest first page. */
  limit: z.number().int().min(1).max(1000).optional(),
  /** Full view only: `paging.<list>.next` from a prior result, to read the next older page. */
  activityBefore: z.number().int().min(0).optional(),
  evidenceBefore: z.number().int().min(0).optional(),
  deliveryBefore: z.number().int().min(0).optional(),
})
const JournalInspectPlanInput = z.strictObject({
  planID: z.uuid(),
  view: z.literal("journal"),
  limit: z.number().int().min(1).max(100).optional().default(50),
  cursor: z.string().min(1).max(8192).optional(),
})
export const SourceMessagesInspectPlanSchema = z.strictObject({
  planID: z.uuid(),
  view: z.literal("source-messages"),
  sourceSessionID: z.string().min(1).max(200),
  messageIDs: z
    .array(z.string().min(1).max(2048))
    .min(1)
    .max(10)
    .refine(
      (messageIDs) => new Set(messageIDs).size === messageIDs.length,
      "Select each native message ID once",
    ),
})
export const InspectPlanInput = z.union([
  CompactInspectPlanInput,
  JournalInspectPlanInput,
  SourceMessagesInspectPlanSchema,
])
export type InspectPlanInput = z.infer<typeof InspectPlanInput>

export type CompactWaitingPlan = ExecutionPlanWait
export type CompactNode = {
  taskID: string
  ordinal: number
  state: string
  version: number
  reason: string | null
  waitingOn: string[]
  attempts: number
  latestAttempt: {
    id: string
    number: number
    state: string
    startedAt: number
    toolCount: number
    retryCount: number
  } | null
}
export type CompactPlanDetail = {
  mode: "compact"
  plan: {
    id: string
    owner: string
    revision: number
    version: number
    title: string | null
    objective: string
    state: string
    reason: string | null
    model: unknown
    artifact: string | null
    schedule: {
      priority: number
      workspaceMode: string
      afterPlans: string[]
      integrationOrder: string[]
      dependencies: DependencyRow[]
      dispatchPause?: { reason: string; untilPlans: string[] } | null
    }
  }
  waitingOnPlans: CompactWaitingPlan[]
  waitingOnPlansCount: number
  waitingOnPlansComplete: boolean
  counts: Record<string, unknown>
  nodes: CompactNode[]
  latestOutcomes: Record<string, unknown>[]
  checks: Record<string, unknown>[]
  verificationDeadlines: VerificationTimeoutAmendment[]
}
export type CompactInspectionSummary = {
  mode: "compact"
  plans: Array<{
    id: string
    owner: string
    revision: number
    version: number
    title: string | null
    objective: string
    state: string
    reason: string | null
    model: unknown
    artifact: string | null
    schedule: {
      priority: number
      workspaceMode: string
      afterPlans: string[]
      integrationOrder: string[]
      dispatchPause?: { reason: string; untilPlans: string[] } | null
    }
    waitingOnPlans: CompactWaitingPlan[]
    waitingOnPlansCount: number
    waitingOnPlansComplete: boolean
    counts: { nodes: number; nodesByState: Record<string, number> }
  }>
}

type PlanRow = {
  id: string
  owner: string
  revision: number
  version: number
  state: string
  reason: string | null
  model: string | null
  artifact: string | null
  body: string
  title: string | null
  objective: string
  priority: number | null
  workspaceMode: string
  afterPlans: string | null
  integrationOrder: string
}
type NodeRow = {
  task_id: string
  ordinal: number
  state: string
  version: number
  reason: string | null
  artifact: string | null
}
type DependencyRow = { prerequisite: string; successor: string }
type AttemptRow = {
  id: string
  task_id: string
  number: number
  state: string
  started_at: number
  tool_count: number
  retry_count: number
  token_count: number | null
  cost: number | null
}
type EffectRow = {
  id: string
  task_id: string | null
  attempt_id: string | null
  kind: string
  state: string
  receipt: string | null
}
type TransitionRow = {
  task_id: string | null
  event: string
  payload: string
  created_at: number
}
const json = (value: string | null): unknown => {
  if (!value) return undefined
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

const arrayJSON = <T>(value: string | null, fallback: T[]): T[] => {
  const parsed = json(value)
  return Array.isArray(parsed) ? (parsed as T[]) : fallback
}

const model = (value: string | null): unknown => {
  const parsed = json(value)
  return parsed && typeof parsed === "object" ? parsed : null
}

function waitingOnPlans(store: RunnerStore, plan: Pick<PlanRow, "body">) {
  let prerequisites: string[] | undefined
  try {
    const parsed = PlanInput.safeParse(JSON.parse(plan.body))
    if (parsed.success) prerequisites = parsed.data.afterPlans ?? []
  } catch {
    prerequisites = undefined
  }
  return store.waitingOnPlanFacts(prerequisites)
}

function planRows(store: RunnerStore, planID?: string): PlanRow[] {
  return store.atomic((db) =>
    db
      .query<PlanRow, (string | null)[]>(
        `SELECT id,owner,revision,version,state,reason,model,artifact,body,
          json_extract(body,'$.title') AS title,
          json_extract(body,'$.objective') AS objective,
          json_extract(body,'$.priority') AS priority,
          COALESCE(json_extract(body,'$.workspaceMode'),'shared') AS workspaceMode,
          json_extract(body,'$.afterPlans') AS afterPlans,
          json_extract(body,'$.integrationOrder') AS integrationOrder
         FROM runner_plans
         WHERE project_directory=? AND (? IS NULL OR id=?)
         ORDER BY ${planPrioritySortSQL("body")},rowid`,
      )
      .all(store.repository.projectDirectory, planID ?? null, planID ?? null),
  )
}

function nodeLatestTransitions(db: Database, planID: string) {
  const latest = new Map<string, TransitionRow>()
  const query = db.query<TransitionRow, [string, string]>(
    "SELECT task_id,event,payload,created_at FROM runner_transitions WHERE plan_id=? AND task_id=? ORDER BY id DESC LIMIT 1",
  )
  for (const node of db
    .query<{ task_id: string }, [string]>("SELECT task_id FROM runner_nodes WHERE plan_id=?")
    .all(planID)) {
    const row = query.get(planID, node.task_id)
    if (row) latest.set(node.task_id, row)
  }
  return latest
}

function compactPlan(store: RunnerStore, plan: PlanRow, capacity?: DelegatedAgentInspection) {
  const { nodes, dependencies, attempts, effects, transitionCounts, latestByTask } = store.atomic(
    (db) => ({
      nodes: db
        .query<NodeRow, [string]>(
          "SELECT task_id,ordinal,state,version,reason,artifact FROM runner_nodes WHERE plan_id=? ORDER BY ordinal",
        )
        .all(plan.id),
      dependencies: db
        .query<DependencyRow, [string]>(
          "SELECT prerequisite,successor FROM runner_dependencies WHERE plan_id=? ORDER BY prerequisite,successor",
        )
        .all(plan.id),
      attempts: db
        .query<AttemptRow, [string]>(
          "SELECT id,task_id,number,state,started_at,tool_count,retry_count,token_count,cost FROM runner_attempts WHERE plan_id=? ORDER BY started_at,number",
        )
        .all(plan.id),
      effects: db
        .query<EffectRow, [string]>(
          "SELECT id,task_id,attempt_id,kind,state,receipt FROM runner_effects WHERE plan_id=? ORDER BY rowid",
        )
        .all(plan.id),
      // Aggregated in SQL over runner_transitions_plan_event; never materializes history.
      transitionCounts: db
        .query<{ event: string; n: number }, [string]>(
          "SELECT event,COUNT(*) AS n FROM runner_transitions WHERE plan_id=? GROUP BY event",
        )
        .all(plan.id),
      // One indexed point read per task (runner_transitions_task_latest).
      latestByTask: nodeLatestTransitions(db, plan.id),
    }),
  )

  const prerequisites = new Map<string, string[]>()
  for (const dependency of dependencies) {
    const list = prerequisites.get(dependency.successor) ?? []
    list.push(dependency.prerequisite)
    prerequisites.set(dependency.successor, list)
  }
  const attemptsByTask = new Map<string, AttemptRow[]>()
  for (const attempt of attempts) {
    const list = attemptsByTask.get(attempt.task_id) ?? []
    list.push(attempt)
    attemptsByTask.set(attempt.task_id, list)
  }
  const nodeStates = new Map(nodes.map((node) => [node.task_id, node.state]))
  const lastTransition = latestByTask

  const checks = new Map<string, Record<string, unknown>>()
  for (const effect of effects) {
    if (!effect.kind.includes("verify")) continue
    const envelope = json(effect.receipt)
    const result =
      envelope && typeof envelope === "object" && "result" in envelope
        ? (envelope as { result?: unknown }).result
        : envelope
    const check =
      result && typeof result === "object" && "check" in result
        ? (result as { check?: unknown }).check
        : undefined
    const summary: Record<string, unknown> = {
      kind: effect.kind,
      state: effect.state,
      taskID: effect.task_id,
      attemptID: effect.attempt_id,
    }
    if (check && typeof check === "object") {
      for (const key of ["exitCode", "timedOut", "stopCause", "unchanged"])
        if (key in check) summary[key] = (check as Record<string, unknown>)[key]
      if ("verificationDeadline" in check)
        summary.verificationDeadline = (check as Record<string, unknown>).verificationDeadline
    }
    checks.set(`${effect.task_id ?? "plan"}:${effect.attempt_id ?? "none"}:${effect.kind}`, summary)
  }

  const countBy = (values: string[]) =>
    values.reduce<Record<string, number>>((counts, value) => {
      counts[value] = (counts[value] ?? 0) + 1
      return counts
    }, {})
  const activeStates = new Set(["preparing", "running", "verifying"])
  const latestOutcomes = nodes.map((node) => {
    const latest = lastTransition.get(node.task_id)
    const payload = latest ? json(latest.payload) : undefined
    const outcome: Record<string, unknown> = { taskID: node.task_id, event: latest?.event ?? null }
    if (payload && typeof payload === "object") {
      for (const key of ["status", "outcome", "reason"])
        if (key in payload) outcome[key] = (payload as Record<string, unknown>)[key]
    }
    return outcome
  })

  const planDetail = {
    id: plan.id,
    owner: plan.owner,
    revision: plan.revision,
    version: plan.version,
    title: plan.title,
    objective: plan.objective,
    state: plan.state,
    reason: plan.reason,
    model: model(plan.model),
    artifact: plan.artifact,
    schedule: {
      priority: plan.priority ?? 0,
      workspaceMode: plan.workspaceMode,
      afterPlans: arrayJSON<string>(plan.afterPlans, []),
      dispatchPause: store.dispatchPause(plan.id) ?? null,
      integrationOrder: arrayJSON<string>(plan.integrationOrder, []),
      dependencies,
      delegatedAgentCapacity: capacity
        ? {
            limit: capacity.limit,
            active: capacity.active,
            queued: capacity.queued,
            reason: capacity.reason,
          }
        : null,
    },
  }
  const prerequisiteFacts = waitingOnPlans(store, plan)
  return {
    mode: "compact" as const,
    plan: planDetail,
    waitingOnPlans: prerequisiteFacts.plans,
    waitingOnPlansCount: prerequisiteFacts.count,
    waitingOnPlansComplete: prerequisiteFacts.complete,
    counts: {
      nodes: nodes.length,
      attempts: attempts.length,
      activeAttempts: attempts.filter((attempt) => activeStates.has(attempt.state)).length,
      effects: effects.length,
      pendingEffects: effects.filter((effect) => ["intended", "uncertain"].includes(effect.state))
        .length,
      attemptsByState: countBy(attempts.map((attempt) => attempt.state)),
      effectsByState: countBy(effects.map((effect) => effect.state)),
      transitionsByEvent: Object.fromEntries(transitionCounts.map((row) => [row.event, row.n])),
    },
    nodes: nodes.map((node) => {
      const waitingOn = (prerequisites.get(node.task_id) ?? []).filter(
        (taskID) => nodeStates.get(taskID) !== "accepted",
      )
      const taskAttempts = attemptsByTask.get(node.task_id) ?? []
      const latestAttempt = taskAttempts.at(-1)
      return {
        taskID: node.task_id,
        ordinal: node.ordinal,
        state:
          plan.state === "blocked" && ["queued", "ready"].includes(node.state)
            ? "blocked"
            : node.state,
        version: node.version,
        reason:
          node.reason ??
          (capacity?.queuedRunnerTasks.some(
            (candidate) => candidate.planID === plan.id && candidate.taskID === node.task_id,
          )
            ? capacity.active >= capacity.limit
              ? `Waiting for delegated-agent capacity (${capacity.active} of ${capacity.limit} slots in use).`
              : "Waiting for admission behind earlier delegated-agent work."
            : plan.state === "blocked"
              ? plan.reason
              : null),
        waitingOn,
        attempts: taskAttempts.length,
        latestAttempt: latestAttempt
          ? {
              id: latestAttempt.id,
              number: latestAttempt.number,
              state: latestAttempt.state,
              startedAt: latestAttempt.started_at,
              toolCount: latestAttempt.tool_count,
              retryCount: latestAttempt.retry_count,
            }
          : null,
      }
    }),
    latestOutcomes,
    checks: [...checks.values()],
    verificationDeadlines: store.verificationTimeoutAmendments(plan.id),
  }
}

function compactPlanSummary(
  store: RunnerStore,
  plan: PlanRow,
  capacity?: DelegatedAgentInspection,
) {
  const states = store.atomic((db) =>
    db
      .query<{ state: string; count: number }, [string]>(
        "SELECT state,COUNT(*) AS count FROM runner_nodes WHERE plan_id=? GROUP BY state ORDER BY state",
      )
      .all(plan.id),
  )
  const prerequisiteFacts = waitingOnPlans(store, plan)
  return {
    id: plan.id,
    owner: plan.owner,
    revision: plan.revision,
    version: plan.version,
    title: plan.title,
    objective: plan.objective,
    state: plan.state,
    reason: plan.reason,
    model: model(plan.model),
    artifact: plan.artifact,
    schedule: {
      priority: plan.priority ?? 0,
      workspaceMode: plan.workspaceMode,
      afterPlans: arrayJSON<string>(plan.afterPlans, []),
      dispatchPause: store.dispatchPause(plan.id) ?? null,
      integrationOrder: arrayJSON<string>(plan.integrationOrder, []),
      delegatedAgentCapacity: capacity
        ? {
            limit: capacity.limit,
            active: capacity.active,
            queued: capacity.queued,
            reason: capacity.reason,
          }
        : null,
    },
    waitingOnPlans: prerequisiteFacts.plans,
    waitingOnPlansCount: prerequisiteFacts.count,
    waitingOnPlansComplete: prerequisiteFacts.complete,
    counts: {
      nodes: states.reduce((total, entry) => total + entry.count, 0),
      nodesByState: Object.fromEntries(states.map((entry) => [entry.state, entry.count])),
    },
  }
}

type InspectablePlan = {
  id: string
  body: string
  revision: number
  version: number
  state: string
}

function retainedNextSteps(
  operation: RetainedVerificationProjection,
  plan: InspectablePlan,
  nodeStates: ReadonlyMap<string, string>,
) {
  const nextSteps: Record<string, unknown>[] = []
  if (operation.recordStatus !== "recorded" || !operation.operationID) return nextSteps
  if (["pending", "task-checks"].includes(operation.state))
    nextSteps.push({
      action: "wait",
      owner: "runtime",
      operationID: operation.operationID,
      condition: "Runtime owns check progress and records pass or fail; nothing else is exposed.",
    })
  if (
    ["accepted", "failed", "cancelled"].includes(operation.state) &&
    operation.planRevision === plan.revision &&
    operation.taskID &&
    operation.taskRevision &&
    operation.attemptID &&
    operation.candidateArtifact &&
    ["blocked", "accepted", "cleanup-blocked"].includes(plan.state) &&
    !["cancelled", "exhausted", "incorporated"].includes(
      nodeStates.get(operation.taskID) ?? "unknown",
    )
  )
    nextSteps.push({
      action: "verify-retained",
      basedOn: { operationID: operation.operationID },
      planRevision: operation.planRevision,
      taskID: operation.taskID,
      taskRevision: operation.taskRevision,
      attemptID: operation.attemptID,
      candidateArtifact: operation.candidateArtifact,
      condition:
        "Conditional: this is a new call on a commit, never a retry of the recorded one; runtime admission rechecks the current owner, plan revision and exact latest attempt/candidate.",
    })
  return nextSteps
}

function decorateRetainedInspection(
  inspection: RetainedVerificationInspection,
  plan: InspectablePlan,
  nodeStates: ReadonlyMap<string, string>,
) {
  return {
    ...inspection,
    latest: inspection.latest.map((operation) => ({
      ...operation,
      nextSteps: retainedNextSteps(operation, plan, nodeStates),
    })),
  }
}

function retainedInspection(store: RunnerStore, plan: InspectablePlan) {
  return store.atomic((db) =>
    retainedVerificationsForInspection(db, store.repository.projectDirectory, plan.id),
  )
}

export function inspectPlan(
  store: RunnerStore,
  input: InspectPlanInput,
  capacity?: DelegatedAgentInspection,
) {
  if ("view" in input && input.view === "journal")
    return store.architectSourceJournalPage(input.planID, input.limit, input.cursor)
  if ("view" in input)
    throw new Error("Selected source messages require an authenticated active Architect read")
  if (input.full) {
    if (!input.planID)
      return {
        plans: store.plans().map((plan) => {
          const prerequisiteFacts = waitingOnPlans(store, plan)
          return {
            ...plan,
            waitingOnPlans: prerequisiteFacts.plans,
            waitingOnPlansCount: prerequisiteFacts.count,
            waitingOnPlansComplete: prerequisiteFacts.complete,
          }
        }),
        audit: store.audit(),
        delegatedAgentCapacity: capacity ?? null,
      }
    const detail = store.detail(input.planID, {
      limit: input.limit,
      activityBefore: input.activityBefore,
      evidenceBefore: input.evidenceBefore,
      deliveryBefore: input.deliveryBefore,
    })
    const prerequisiteFacts = waitingOnPlans(store, detail.plan)
    return {
      ...detail,
      waitingOnPlans: prerequisiteFacts.plans,
      waitingOnPlansCount: prerequisiteFacts.count,
      waitingOnPlansComplete: prerequisiteFacts.complete,
      delegatedAgentCapacity: capacity ?? null,
      retainedVerifications: decorateRetainedInspection(
        retainedInspection(store, detail.plan),
        detail.plan,
        new Map(detail.nodes.map((node) => [node.task_id, node.state])),
      ),
    }
  }
  const plans = planRows(store, input.planID)
  if (input.planID && !plans.length) throw new Error("Plan not found")
  return input.planID
    ? compactPlan(store, plans[0]!, capacity)
    : {
        mode: "compact",
        delegatedAgentCapacity: capacity ?? null,
        plans: plans.map((plan) => compactPlanSummary(store, plan, capacity)),
      }
}
