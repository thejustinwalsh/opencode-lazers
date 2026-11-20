import type { Database } from "bun:sqlite"
import { z } from "zod"
import { planPrioritySortSQL } from "./priority.ts"
import { retainedVerificationsForInspection } from "./retained-verification/store.ts"
import type {
  RetainedVerificationInspection,
  RetainedVerificationProjection,
} from "./retained-verification/store.ts"
import { decodePlanCursor, encodePlanCursor, type RunnerStore } from "./store.ts"
import type { VerificationTimeoutAmendment } from "./verification-timeout.ts"
import type { DelegatedAgentStatus } from "./delegated-agent-capacity.ts"
import { PlanInput, type ExecutionPlanWait } from "./schema.ts"

type DelegatedAgentInspection = DelegatedAgentStatus & {
  queuedRunnerTasks: Array<{ planID: string; taskID: string }>
}

const CompactInspectPlanInput = z.strictObject({
  planID: z.uuid().optional(),
  full: z.boolean().optional().default(false),
  /**
   * Full view only: rows per history list (activity, evidence, delivery), newest first page; for
   * the project-wide full view (no planID), plans per page.
   */
  limit: z.number().int().min(1).max(1000).optional(),
  /** Project-wide views: `paging.plans.next` from a prior result, for the next plans. */
  plansAfter: z.string().min(1).max(200).optional(),
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
    /** Absent for an Architect takeover, which records no tool or retry counts. */
    toolCount?: number
    retryCount?: number
    takeover?: true
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
      dispatchPause?: { reason: string; untilPlans: string[]; level?: "project" | "global" } | null
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
      dispatchPause?: { reason: string; untilPlans: string[]; level?: "project" | "global" } | null
    }
    waitingOnPlans: CompactWaitingPlan[]
    waitingOnPlansCount: number
    waitingOnPlansComplete: boolean
    counts: { nodes: number; nodesByState: Record<string, number> }
  }>
  /** `more` is true when plans follow: pass `next` back as `plansAfter`. Never a silent cut. */
  paging: { plans: { next: string | null; returned: number; more: boolean } }
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
  /** 1 when the stored body is JSON; the body itself is never read for the compact views. */
  bodyValid: number
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
  takeover: number
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

function waitingOnPlans(store: RunnerStore, plan: { body: string }) {
  let prerequisites: string[] | undefined
  try {
    const parsed = PlanInput.safeParse(JSON.parse(plan.body))
    if (parsed.success) prerequisites = parsed.data.afterPlans ?? []
  } catch {
    prerequisites = undefined
  }
  return store.waitingOnPlanFacts(prerequisites)
}

/**
 * The prerequisites a compact row waits on, from the `afterPlans` the row query already
 * extracted. The full view parses the whole body against the plan schema; plans are validated when
 * they are stored, so the extracted list is the same one. A body that is not JSON, or an
 * `afterPlans` that is not a list of strings, reads as unknown, as a failed parse does there.
 */
function waitingOnCompact(store: RunnerStore, plan: Pick<PlanRow, "bodyValid" | "afterPlans">) {
  let prerequisites: string[] | undefined
  if (plan.bodyValid) {
    if (plan.afterPlans === null) prerequisites = []
    else {
      const parsed = json(plan.afterPlans)
      if (Array.isArray(parsed) && parsed.every((id) => typeof id === "string"))
        prerequisites = parsed as string[]
    }
  }
  return store.waitingOnPlanFacts(prerequisites)
}

/**
 * Compact plan rows in display order. A page of `limit` rows after `after` reads `limit + 1` rows
 * so the caller knows whether more plans follow; `next` is then the cursor of the last row kept.
 * Only the columns and body fields a compact row shows are read, never the whole body.
 */
function planRows(
  store: RunnerStore,
  planID?: string,
  page?: { limit: number; after?: string },
): { rows: PlanRow[]; next: string | null } {
  const cursor = decodePlanCursor(page?.after)
  const priority = planPrioritySortSQL("body")
  const size = page ? page.limit : undefined
  const read = store.atomic((db) =>
    db
      .query<PlanRow & { plan_key: number; plan_rowid: number }, (string | number | null)[]>(
        `SELECT id,owner,revision,version,state,reason,model,artifact,json_valid(body) AS bodyValid,
          json_extract(body,'$.title') AS title,
          json_extract(body,'$.objective') AS objective,
          json_extract(body,'$.priority') AS priority,
          COALESCE(json_extract(body,'$.workspaceMode'),'shared') AS workspaceMode,
          json_extract(body,'$.afterPlans') AS afterPlans,
          json_extract(body,'$.integrationOrder') AS integrationOrder,
          ${priority} AS plan_key,rowid AS plan_rowid
         FROM runner_plans
         WHERE project_directory=? AND (? IS NULL OR id=?)
         ${cursor ? `AND (${priority}>? OR (${priority}=? AND rowid>?))` : ""}
         ORDER BY ${priority},rowid${size ? ` LIMIT ${size + 1}` : ""}`,
      )
      .all(
        store.repository.projectDirectory,
        planID ?? null,
        planID ?? null,
        ...(cursor ? [cursor.key, cursor.key, cursor.rowid] : []),
      ),
  )
  const kept = size ? read.slice(0, size) : read
  const last = kept.at(-1)
  return {
    rows: kept.map(({ plan_key: _key, plan_rowid: _rowid, ...row }) => row as PlanRow),
    next:
      size && read.length > size && last
        ? encodePlanCursor({ key: last.plan_key, rowid: last.plan_rowid })
        : null,
  }
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
          "SELECT id,task_id,number,state,started_at,tool_count,retry_count,token_count,cost,json_extract(policy,'$.takeover') IS NOT NULL AS takeover FROM runner_attempts WHERE plan_id=? ORDER BY started_at,number",
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
      dispatchPause: store.effectiveDispatchPause(plan.id) ?? null,
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
  const prerequisiteFacts = waitingOnCompact(store, plan)
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
            ? capacity.limit !== null && capacity.active >= capacity.limit
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
              ...(latestAttempt.takeover
                ? { takeover: true as const }
                : {
                    toolCount: latestAttempt.tool_count,
                    retryCount: latestAttempt.retry_count,
                  }),
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
  const prerequisiteFacts = waitingOnCompact(store, plan)
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
      dispatchPause: store.effectiveDispatchPause(plan.id) ?? null,
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

/**
 * Plans per page of the project-wide full view when `limit` is not given. Each plan row carries
 * its whole body, so a page is bounded by plans, not by bytes: 25 plans of the sizes the plan
 * schema allows stay far below the tool output limits. Estimated, not measured on live data; the
 * caller can ask for 1 to 1,000 per page and the cursor reaches every plan.
 */
export const FULL_VIEW_PLANS_PER_PAGE = 25

/**
 * Compact plans per page of the project-wide list when `limit` is not given. A compact row is
 * about 1 KB (identity, title, objective, schedule, node-state counts), so 200 rows stay near
 * 200 KB: estimated, not measured on live data. The list is never cut silently: a page that
 * stops early says `paging.plans.more: true` and carries the cursor to pass as `plansAfter`.
 */
export const COMPACT_PLANS_PER_PAGE = 200

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
    if (!input.planID) {
      const page = store.planPage(input.limit ?? FULL_VIEW_PLANS_PER_PAGE, input.plansAfter)
      return {
        plans: page.plans.map((plan) => {
          const prerequisiteFacts = waitingOnPlans(store, plan)
          return {
            ...plan,
            waitingOnPlans: prerequisiteFacts.plans,
            waitingOnPlansCount: prerequisiteFacts.count,
            waitingOnPlansComplete: prerequisiteFacts.complete,
          }
        }),
        paging: { plans: { next: page.next, returned: page.plans.length } },
        // The audit and capacity describe the project, not a plan: the first page carries them.
        ...(input.plansAfter === undefined
          ? { audit: store.audit(), delegatedAgentCapacity: capacity ?? null }
          : {}),
      }
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
  const page = input.planID
    ? undefined
    : { limit: input.limit ?? COMPACT_PLANS_PER_PAGE, after: input.plansAfter }
  const { rows: plans, next } = planRows(store, input.planID, page)
  if (input.planID && !plans.length) throw new Error("Plan not found")
  return input.planID
    ? compactPlan(store, plans[0]!, capacity)
    : {
        mode: "compact",
        delegatedAgentCapacity: capacity ?? null,
        plans: plans.map((plan) => compactPlanSummary(store, plan, capacity)),
        paging: { plans: { next, returned: plans.length, more: next !== null } },
      }
}
