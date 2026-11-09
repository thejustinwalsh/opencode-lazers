import { z } from "zod"
import { PlanInput } from "./schema.ts"
import { retainedVerificationsForInspection } from "./retained-verification/store.ts"
import type {
  RetainedHumanEvidenceRequirements,
  RetainedVerificationInspection,
  RetainedVerificationProjection,
} from "./retained-verification/store.ts"
import type { RunnerStore } from "./store.ts"
import type { SourceQuarantine } from "./source-quarantine.ts"

const CompactInspectPlanInput = z.strictObject({
  planID: z.uuid().optional(),
  full: z.boolean().optional().default(false),
})
const JournalInspectPlanInput = z.strictObject({
  planID: z.uuid(),
  view: z.literal("journal"),
  limit: z.number().int().min(1).max(100).optional().default(50),
  cursor: z.string().min(1).max(8192).optional(),
})
const RetainedVerificationInspectPlanInput = z.strictObject({
  planID: z.uuid(),
  view: z.literal("retained-verifications"),
  taskIDs: z
    .array(z.uuid())
    .min(1)
    .max(100)
    .refine((taskIDs) => new Set(taskIDs).size === taskIDs.length)
    .optional(),
  limit: z.number().int().min(1).max(20).optional().default(10),
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
  RetainedVerificationInspectPlanInput,
  SourceMessagesInspectPlanSchema,
])
export type InspectPlanInput = z.infer<typeof InspectPlanInput>
export type SourceMessagesInspectPlanInput = z.infer<typeof SourceMessagesInspectPlanSchema>
type RetainedVerificationInspectPlanInput = z.infer<typeof RetainedVerificationInspectPlanInput>

export type CompactWaitingPlan = {
  planID: string
  state: string | null
  version: number | null
  reason: string | null
}
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
    }
  }
  waitingOnPlans: CompactWaitingPlan[]
  counts: Record<string, unknown>
  nodes: CompactNode[]
  latestOutcomes: Record<string, unknown>[]
  checks: Record<string, unknown>[]
  sourceQuarantines?: Array<{
    attemptID: string
    phase: string
    reason: string | null
    createdAt: number
    updatedAt: number
  }>
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
    }
    waitingOnPlans: CompactWaitingPlan[]
    counts: { nodes: number; nodesByState: Record<string, number> }
  }>
  audit: { watermark: number; findingCount: number; findingsByCode: Record<string, number> }
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
type WaitingPlanRow = { id: string; state: string; version: number; reason: string | null }

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

function waitingOnPlans(store: RunnerStore, plan: PlanRow): CompactWaitingPlan[] {
  const prerequisites = arrayJSON<string>(plan.afterPlans, [])
  if (!prerequisites.length) return []
  return store.atomic((db) =>
    prerequisites.flatMap((planID) => {
      const current = db
        .query<WaitingPlanRow, [string, string]>(
          "SELECT id,state,version,reason FROM runner_plans WHERE project_directory=? AND id=?",
        )
        .get(store.repository.projectDirectory, planID)
      if (current?.state === "integrated") return []
      return [
        {
          planID,
          state: current?.state ?? null,
          version: current?.version ?? null,
          reason: current?.reason ?? null,
        },
      ]
    }),
  )
}

function planRows(store: RunnerStore, planID?: string): PlanRow[] {
  return store.atomic((db) =>
    db
      .query<PlanRow, (string | null)[]>(
        `SELECT id,owner,revision,version,state,reason,model,artifact,
          json_extract(body,'$.title') AS title,
          json_extract(body,'$.objective') AS objective,
          json_extract(body,'$.priority') AS priority,
          COALESCE(json_extract(body,'$.workspaceMode'),'shared') AS workspaceMode,
          json_extract(body,'$.afterPlans') AS afterPlans,
          json_extract(body,'$.integrationOrder') AS integrationOrder
         FROM runner_plans
         WHERE project_directory=? AND (? IS NULL OR id=?)
         ORDER BY COALESCE(json_extract(body,'$.priority'),0) DESC,rowid`,
      )
      .all(store.repository.projectDirectory, planID ?? null, planID ?? null),
  )
}

function compactPlan(store: RunnerStore, plan: PlanRow) {
  const { nodes, dependencies, attempts, effects, transitions } = store.atomic((db) => ({
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
    transitions: db
      .query<TransitionRow, [string]>(
        "SELECT task_id,event,payload,created_at FROM runner_transitions WHERE plan_id=? ORDER BY id",
      )
      .all(plan.id),
  }))

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
  const lastTransition = new Map<string, TransitionRow>()
  for (const event of transitions) if (event.task_id) lastTransition.set(event.task_id, event)

  const checks = new Map<string, Record<string, unknown>>()
  for (const effect of effects) {
    if (!effect.kind.includes("verify")) continue
    const receipt = json(effect.receipt)
    const check =
      receipt && typeof receipt === "object" && "check" in receipt && receipt.check
        ? receipt.check
        : undefined
    const summary: Record<string, unknown> = {
      kind: effect.kind,
      state: effect.state,
      taskID: effect.task_id,
      attemptID: effect.attempt_id,
    }
    if (check && typeof check === "object") {
      for (const key of ["exitCode", "timedOut", "unchanged"])
        if (key in check) summary[key] = (check as Record<string, unknown>)[key]
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

  const quarantines = store.atomic((db) =>
    db
      .query<SourceQuarantine, [string]>(
        "SELECT * FROM runner_source_quarantines WHERE plan_id=? ORDER BY created_at",
      )
      .all(plan.id),
  )
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
      integrationOrder: arrayJSON<string>(plan.integrationOrder, []),
      dependencies,
    },
  }
  return {
    mode: "compact" as const,
    plan: planDetail,
    waitingOnPlans: waitingOnPlans(store, plan),
    counts: {
      nodes: nodes.length,
      attempts: attempts.length,
      activeAttempts: attempts.filter((attempt) => activeStates.has(attempt.state)).length,
      effects: effects.length,
      pendingEffects: effects.filter((effect) => ["intended", "uncertain"].includes(effect.state))
        .length,
      attemptsByState: countBy(attempts.map((attempt) => attempt.state)),
      effectsByState: countBy(effects.map((effect) => effect.state)),
      transitionsByEvent: countBy(transitions.map((event) => event.event)),
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
        reason: node.reason ?? (plan.state === "blocked" ? plan.reason : null),
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
    ...(quarantines.length
      ? {
          sourceQuarantines: quarantines.map((row) => ({
            attemptID: row.attempt_id,
            phase: row.phase,
            reason: row.hold_reason,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          })),
        }
      : {}),
  }
}

function compactPlanSummary(store: RunnerStore, plan: PlanRow) {
  const states = store.atomic((db) =>
    db
      .query<{ state: string; count: number }, [string]>(
        "SELECT state,COUNT(*) AS count FROM runner_nodes WHERE plan_id=? GROUP BY state ORDER BY state",
      )
      .all(plan.id),
  )
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
      integrationOrder: arrayJSON<string>(plan.integrationOrder, []),
    },
    waitingOnPlans: waitingOnPlans(store, plan),
    counts: {
      nodes: states.reduce((total, entry) => total + entry.count, 0),
      nodesByState: Object.fromEntries(states.map((entry) => [entry.state, entry.count])),
    },
  }
}

function compactAudit(store: RunnerStore) {
  const audit = store.audit()
  return {
    watermark: audit.watermark,
    findingCount: audit.findings.length,
    findingsByCode: audit.findings.reduce<Record<string, number>>((counts, finding) => {
      counts[finding.code] = (counts[finding.code] ?? 0) + 1
      return counts
    }, {}),
  }
}

type InspectablePlan = {
  id: string
  body: string
  revision: number
  version: number
  state: string
}

function retainedHumanRequirements(
  store: RunnerStore,
  plan: InspectablePlan,
  taskIDs: string[],
): RetainedHumanEvidenceRequirements {
  let parsedPlan: z.infer<typeof PlanInput>
  try {
    parsedPlan = PlanInput.parse(JSON.parse(plan.body))
  } catch {
    return new Map()
  }
  const combinedAssertionIDs = parsedPlan.acceptance
    .filter((assertion) => assertion.evidence.some((evidence) => evidence.kind === "human"))
    .map((assertion) => assertion.id)
  const requirements: [
    string,
    {
      planRevision: number
      planVersion: number
      taskRevision: number
      taskAssertionIDs: string[] | null
      combinedAssertionIDs: string[] | null
    },
  ][] = []
  for (const taskID of taskIDs) {
    const task = store.repository.get(taskID)
    const planTask = parsedPlan.nodes.find((node) => node.taskID === taskID)
    if (!task || !planTask || task.revision !== planTask.revision) continue
    requirements.push([
      taskID,
      {
        planRevision: plan.revision,
        planVersion: plan.version,
        taskRevision: task.revision,
        taskAssertionIDs: task.proposal.acceptance
          .filter((assertion) => assertion.evidence.some((evidence) => evidence.kind === "human"))
          .map((assertion) => assertion.id),
        combinedAssertionIDs,
      },
    ])
  }
  return new Map(requirements)
}

function retainedNextSteps(
  operation: RetainedVerificationProjection,
  plan: InspectablePlan,
  nodeStates: ReadonlyMap<string, string>,
) {
  const nextSteps: Record<string, unknown>[] = []
  if (operation.recordStatus !== "recorded" || !operation.operationID || !operation.generation)
    return nextSteps

  if (
    [
      "pending",
      "task-checks",
      "combined-checks",
      "waiting-human",
      "waiting-human-combined",
      "task-accepted",
      "held",
    ].includes(operation.state)
  )
    nextSteps.push({
      action: "cancel-retained-verification",
      operationID: operation.operationID,
      generation: operation.generation,
      condition:
        "Conditional: the current same-project Architect and runtime operation/owner fences must still authorize this exact operation.",
    })

  if (
    operation.humanEvidence.status === "known" &&
    operation.humanEvidence.phase &&
    operation.humanEvidence.missingAssertionIDs.length > 0
  )
    nextSteps.push({
      action: "human-evidence",
      operationID: operation.operationID,
      generation: operation.generation,
      phase: operation.humanEvidence.phase,
      taskID: operation.humanEvidence.phase === "task" ? operation.taskID : null,
      candidateArtifact:
        operation.humanEvidence.phase === "task"
          ? operation.candidateArtifact
          : operation.combinedArtifact,
      assertionIDs: operation.humanEvidence.missingAssertionIDs,
      condition:
        "Conditional: these exact human acceptance items are missing; current Architect, operation generation, phase and candidate bindings are rechecked by runtime.",
    })

  if (
    ["accepted", "failed", "cancelled"].includes(operation.state) &&
    operation.planRevision === plan.revision &&
    operation.planVersion === plan.version &&
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
      basedOn: { operationID: operation.operationID, generation: operation.generation },
      generation: "new",
      planRevision: operation.planRevision,
      taskID: operation.taskID,
      taskRevision: operation.taskRevision,
      attemptID: operation.attemptID,
      candidateArtifact: operation.candidateArtifact,
      condition:
        "Conditional: this is a fresh generation, never a same-generation retry; runtime admission rechecks current owner, plan, exact latest attempt/candidate and resource fences.",
    })

  if (["pending", "task-checks", "combined-checks", "task-accepted"].includes(operation.state))
    nextSteps.push({
      action: "wait",
      owner: "runtime",
      operationID: operation.operationID,
      generation: operation.generation,
      condition:
        "Runtime owns check progress and settlement; no same-generation resume/retry or public cleanup action is exposed.",
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
    history: {
      ...inspection.history,
      records: inspection.history.records.map((operation) => ({ ...operation, nextSteps: [] })),
    },
  }
}

function retainedInspection(
  store: RunnerStore,
  plan: InspectablePlan,
  taskIDs: string[] | undefined,
  limit: number,
  cursor?: string,
) {
  const planTasks = store.nodes(plan.id).map((node) => node.task_id)
  const requirements = retainedHumanRequirements(store, plan, planTasks)
  return store.atomic((db) =>
    retainedVerificationsForInspection(
      db,
      store.repository.projectDirectory,
      plan.id,
      taskIDs,
      limit,
      cursor,
      requirements,
    ),
  )
}

export function inspectPlan(store: RunnerStore, input: InspectPlanInput) {
  if ("view" in input && input.view === "journal")
    return store.architectSourceJournalPage(input.planID, input.limit, input.cursor)
  if ("view" in input && input.view === "retained-verifications") {
    const plan = store.plan(input.planID)
    if (!plan) throw new Error("Plan not found")
    const nodes = store.nodes(plan.id)
    const projection = retainedInspection(store, plan, input.taskIDs, input.limit, input.cursor)
    return decorateRetainedInspection(
      projection,
      plan,
      new Map(nodes.map((node) => [node.task_id, node.state])),
    )
  }
  if ("view" in input)
    throw new Error("Selected source messages require an authenticated active Architect read")
  if (input.full) {
    if (!input.planID) return { plans: store.plans(), audit: store.audit() }
    const detail = store.detail(input.planID)
    const projection = retainedInspection(store, detail.plan, undefined, 10)
    return {
      ...detail,
      retainedVerifications: decorateRetainedInspection(
        projection,
        detail.plan,
        new Map(detail.nodes.map((node) => [node.task_id, node.state])),
      ),
    }
  }
  const plans = planRows(store, input.planID)
  if (input.planID && !plans.length) throw new Error("Plan not found")
  return input.planID
    ? compactPlan(store, plans[0]!)
    : {
        mode: "compact",
        plans: plans.map((plan) => compactPlanSummary(store, plan)),
        audit: compactAudit(store),
      }
}
