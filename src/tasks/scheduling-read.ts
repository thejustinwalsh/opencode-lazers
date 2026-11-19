import { randomUUID } from "node:crypto"
import { TaskSpecSchema } from "../task.ts"
import type { TaskSpec } from "../task.ts"
import { PlanInput } from "../runner/schema.ts"
import {
  evaluatePrerequisiteIntegrationAsync,
  evaluateTaskPrerequisiteIntegrationAsync,
} from "../runner/prerequisite-proof.ts"
import type { IntegrationDecision } from "../runner/prerequisite-proof.ts"
import type { RunnerStore, SchedulingFactSnapshot, SchedulingNodeFact } from "../runner/store.ts"
import { selectSchedulingCandidates } from "../runner/scheduling-selection.ts"
import type { SchedulingReservation } from "../runner/scheduling-selection.ts"
import { openReadOnlyTrajectoryStore } from "../trajectory/store.ts"
import {
  SchedulingInput,
  MAX_SCHEDULING_AFTER_PLAN_REFERENCES,
  MAX_SCHEDULING_PLAN_REFERENCES,
  MAX_SCHEDULING_RESERVATION_REFERENCES,
  SchedulingOutput,
  SchedulingSnapshot as SchedulingSnapshotSchema,
} from "./scheduling-contract.ts"
import type {
  SchedulingDecision,
  SchedulingInput as SchedulingInputType,
  SchedulingNode,
  SchedulingPage,
  SchedulingPlan,
  SchedulingScope,
  SchedulingSnapshot,
} from "./scheduling-contract.ts"

const MAX_PLANS = 1_000
const MAX_NODES = 10_000
const MAX_RESERVATIONS = 10_000
const MAX_CACHED_SNAPSHOTS = 4
const MAX_CACHED_PROJECTIONS = 4
const MAX_CACHED_PROOFS = 256
const SNAPSHOT_TTL_MS = 120_000

export type TaskSchedulingReadLimits = {
  maxPlans?: number
  maxNodes?: number
  maxReservations?: number
}

type CachedSnapshot = {
  scopeKey: string
  expiresAt: number
  snapshot: SchedulingSnapshot
}

type SchedulingBranch = { branch: string; head: string } | undefined

class SchedulingGitError extends Error {
  constructor(
    readonly status: number,
    readonly args: string[],
    message: string,
  ) {
    super(message)
    this.name = "SchedulingGitError"
  }
}

async function schedulingGit(directory: string, args: string[]) {
  const child = Bun.spawn(["git", ...args], {
    cwd: directory,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  })
  const [status, output, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (status !== 0)
    throw new SchedulingGitError(
      status,
      args,
      `git ${args[0]} failed: ${(error || "unknown").slice(0, 2_000)}`,
    )
  return output.trimEnd()
}

type SchedulingGitRunner = (directory: string, args: string[]) => Promise<string>

async function branchAndHead(
  directory: string,
  runGit: SchedulingGitRunner = schedulingGit,
): Promise<SchedulingBranch> {
  try {
    const [branch, head] = await Promise.all([
      runGit(directory, ["branch", "--show-current"]),
      runGit(directory, ["rev-parse", "HEAD"]),
    ])
    return { branch, head }
  } catch {
    return undefined
  }
}

function schedulingBasis(facts: SchedulingFactSnapshot) {
  // The task-change watermark also advances for writes unrelated to scheduling.
  // Keep the complete captured scheduling rows as the exact semantic cache basis.
  const { repositoryVersion: _repositoryVersion, ...semanticFacts } = facts
  return JSON.stringify(semanticFacts)
}

function materializeSnapshot(
  snapshot: SchedulingSnapshot,
  facts: SchedulingFactSnapshot,
  now: number,
) {
  return SchedulingSnapshotSchema.parse({
    ...snapshot,
    snapshotID: randomUUID(),
    repositoryVersion: facts.repositoryVersion,
    observedAt: now,
  })
}

function proofBasisKey(kind: "plan" | "task", values: unknown[]) {
  return JSON.stringify([kind, ...values])
}

type ProjectedPlan = {
  schedule: SchedulingPlan
  facts: SchedulingFactSnapshot["plans"][number]
  input?: ReturnType<typeof PlanInput.parse>
  nodes: SchedulingNode[]
  rawNodes: SchedulingNodeFact[]
  waitingPlanIDs: string[]
  workspaceMode: "shared" | "isolated"
  unknown: boolean
}

type ProofResult<T> = { value: T; cacheable: boolean }
type PlanSourceResult = {
  decision: "ready" | "waiting" | "unknown"
  reason: string | null
}
type BuiltProjection = { snapshot: SchedulingSnapshot; cacheable: boolean }

const safeReason = (value: unknown): string | null => {
  if (typeof value !== "string") return null
  const normalized = value
    // oxlint-disable-next-line no-control-regex -- Strip untrusted control characters from readable scheduling reasons.
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  return normalized ? normalized.slice(0, 400) : null
}

function parseCursor(value: string) {
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8")
    const parsed: unknown = JSON.parse(decoded)
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      "snapshotID" in parsed &&
      typeof parsed.snapshotID === "string" &&
      "offset" in parsed &&
      typeof parsed.offset === "number" &&
      Number.isInteger(parsed.offset) &&
      parsed.offset >= 0 &&
      "scopeKey" in parsed &&
      typeof parsed.scopeKey === "string"
    )
      return {
        snapshotID: parsed.snapshotID,
        offset: parsed.offset as number,
        scopeKey: parsed.scopeKey,
      }
  } catch {
    // The caller receives one bounded, safe invalid-cursor error below.
  }
  throw new Error("Scheduling cursor is invalid or expired; refresh the Tasks view")
}

function makeCursor(snapshotID: string, offset: number, scopeKey: string) {
  return Buffer.from(JSON.stringify({ snapshotID, offset, scopeKey })).toString("base64url")
}

function scopeKey(scope: SchedulingScope) {
  return JSON.stringify(scope)
}

function taskAncestors(
  taskID: string,
  dependencies: readonly { prerequisite: string; successor: string }[],
) {
  const incoming = new Map<string, string[]>()
  for (const edge of dependencies)
    incoming.set(edge.successor, [...(incoming.get(edge.successor) ?? []), edge.prerequisite])
  const result = new Set<string>()
  const visit = (id: string) => {
    for (const prerequisite of incoming.get(id) ?? []) {
      if (result.has(prerequisite)) continue
      result.add(prerequisite)
      visit(prerequisite)
    }
  }
  visit(taskID)
  return [...result]
}

function taskPrerequisites(
  taskID: string,
  dependencies: readonly { prerequisite: string; successor: string }[],
) {
  return dependencies.filter((edge) => edge.successor === taskID).map((edge) => edge.prerequisite)
}

async function planSourceDecision(
  prerequisites: readonly string[],
  facts: SchedulingFactSnapshot,
  head: string | undefined,
  prove: (
    prerequisites: readonly string[],
    rows: SchedulingFactSnapshot["planIntegrations"],
    head: string,
  ) => Promise<ProofResult<PlanSourceResult>>,
): Promise<ProofResult<PlanSourceResult>> {
  if (!prerequisites.length) return { value: { decision: "ready", reason: null }, cacheable: true }
  if (!facts.planIntegrationsComplete)
    return {
      value: { decision: "unknown", reason: "Prerequisite integration coverage is incomplete." },
      cacheable: true,
    }
  const rows = facts.planIntegrations.filter((row) => prerequisites.includes(row.plan_id))
  if (rows.length !== prerequisites.length)
    return {
      value: { decision: "unknown", reason: "A prerequisite plan is unavailable in this project." },
      cacheable: true,
    }
  if (!head)
    return {
      value: { decision: "unknown", reason: "Integrated source ancestry is unavailable." },
      cacheable: false,
    }
  return prove(prerequisites, rows, head)
}

type SnapshotBuildInput = {
  store: RunnerStore
  facts: SchedulingFactSnapshot
  scope: SchedulingScope
  observedAt: number
  branch: SchedulingBranch
  provePlan: (
    prerequisites: readonly string[],
    rows: SchedulingFactSnapshot["planIntegrations"],
    head: string,
  ) => Promise<ProofResult<PlanSourceResult>>
  proveTask: (
    branch: string,
    prerequisites: readonly string[],
    rows: SchedulingFactSnapshot["taskIntegrations"],
    head: string,
  ) => Promise<ProofResult<IntegrationDecision>>
}

/** What the plan-by-plan selection learns as it walks the plans in priority order. */
type SelectionState = {
  cacheable: boolean
  prefixKnown: boolean
  firstCandidateKnown: boolean
  selectionComplete: boolean
  firstUnknownReason: string | undefined
  selectedTaskIDs: string[]
  previouslySelectedReservations: SchedulingReservation[]
}

/** A higher-priority fact is unknown: later selections can no longer be trusted as the prefix. */
function markSelectionUnknown(state: SelectionState, reason: string | null | undefined) {
  state.prefixKnown = false
  state.selectionComplete = false
  state.firstUnknownReason ??= reason ?? undefined
}

function schedulingNodeView(
  node: SchedulingFactSnapshot["nodes"][number],
  facts: SchedulingFactSnapshot,
): SchedulingNode {
  let task: TaskSpec | undefined
  try {
    const result = TaskSpecSchema.safeParse(JSON.parse(node.task_body))
    if (result.success) task = result.data
  } catch {
    task = undefined
  }
  const decision: SchedulingDecision = ["queued", "ready"].includes(node.state)
    ? "waiting"
    : "not-applicable"
  const direct = taskPrerequisites(
    node.task_id,
    facts.dependencies.filter((edge) => edge.plan_id === node.plan_id),
  )
  return {
    taskID: node.task_id,
    ...(node.reference ? { reference: node.reference } : {}),
    title: task?.proposal.objective.slice(0, 120) ?? `Task ${node.task_id.slice(0, 8)}`,
    objective: task?.proposal.objective.slice(0, 400) ?? "Task specification is unavailable.",
    ordinal: node.ordinal,
    order: node.ordinal,
    lifecycle: node.state,
    decision,
    reason: task ? null : "Task specification facts are unavailable.",
    prerequisites: direct,
    waitingOn: [],
    reservationTaskIDs: [],
  }
}

function planWorkspaceMode(
  plan: SchedulingFactSnapshot["plans"][number],
  raw: unknown,
): "shared" | "isolated" {
  const attemptPolicy = (() => {
    try {
      const policy: unknown = JSON.parse(plan.last_attempt_policy ?? "null")
      if (typeof policy !== "object" || policy === null || !("workspaceMode" in policy))
        return undefined
      return policy.workspaceMode === "isolated" || policy.workspaceMode === "shared"
        ? policy.workspaceMode
        : undefined
    } catch {
      return undefined
    }
  })()
  const rawMode =
    typeof raw === "object" && raw !== null && "workspaceMode" in raw
      ? raw.workspaceMode
      : undefined
  return rawMode === "isolated" || rawMode === "shared" ? rawMode : (attemptPolicy ?? "shared")
}

/** Whether a running plan may dispatch, given its prerequisite plans and any pause. */
async function runningPlanDecision(
  input: SnapshotBuildInput,
  plan: SchedulingFactSnapshot["plans"][number],
  afterPlans: string[],
  state: SelectionState,
) {
  const { facts, branch, provePlan } = input
  const prerequisite = await planSourceDecision(afterPlans, facts, branch?.head, provePlan)
  state.cacheable &&= prerequisite.cacheable
  let planDecision: SchedulingPlan["decision"] =
    prerequisite.value.decision === "ready" ? "eligible" : prerequisite.value.decision
  let reason = prerequisite.value.reason
  let unknown = prerequisite.value.decision === "unknown"
  let waitingPlanIDs = afterPlans
  if (planDecision === "eligible" && plan.pause_reason !== null) {
    const untilPlans = JSON.parse(plan.pause_until_plans ?? "[]") as string[]
    const resume = await planSourceDecision(untilPlans, facts, branch?.head, provePlan)
    state.cacheable &&= resume.cacheable
    if (resume.value.decision === "unknown") {
      planDecision = "unknown"
      reason = resume.value.reason
      unknown = true
    } else if (!untilPlans.length || resume.value.decision === "waiting") {
      planDecision = "waiting"
      reason = safeReason(plan.pause_reason) ?? "Dispatch is paused."
      waitingPlanIDs = untilPlans
    }
  }
  return { planDecision, reason, unknown, waitingPlanIDs }
}

async function projectPlan(
  input: SnapshotBuildInput,
  plan: SchedulingFactSnapshot["plans"][number],
  planOrder: number,
  sessionPlanIDs: Set<string> | undefined,
  state: SelectionState,
): Promise<ProjectedPlan> {
  const { facts } = input
  let raw: unknown
  try {
    raw = JSON.parse(plan.body) as unknown
  } catch {
    raw = undefined
  }
  const parsed = PlanInput.safeParse(raw)
  const planNodes = facts.nodes.filter((node) => node.plan_id === plan.id)
  const nodes: SchedulingNode[] = planNodes.map((node) => schedulingNodeView(node, facts))
  const workspaceMode = planWorkspaceMode(plan, raw)
  const afterPlans = parsed.success ? (parsed.data.afterPlans ?? []) : []
  let planDecision: SchedulingPlan["decision"] = "waiting"
  let reason = safeReason(plan.reason)
  let unknown = false
  let waitingPlanIDs = afterPlans
  if (!parsed.success) {
    planDecision = "unknown"
    reason = "Plan scheduling facts are unavailable."
    unknown = true
  } else if (plan.state === "running") {
    ;({ planDecision, reason, unknown, waitingPlanIDs } = await runningPlanDecision(
      input,
      plan,
      afterPlans,
      state,
    ))
  } else {
    reason = reason ?? (plan.state === "blocked" ? "Plan is on hold." : null)
  }
  const scopedAfterPlans = afterPlans.filter(
    (planID) => !sessionPlanIDs || sessionPlanIDs.has(planID),
  )
  const schedule: SchedulingPlan = {
    planID: plan.id,
    planVersion: plan.version,
    planOrder,
    priority: parsed.success ? (parsed.data.priority ?? 0) : plan.priority,
    title: parsed.success
      ? (safeReason(parsed.data.title ?? parsed.data.objective.slice(0, 120)) ??
        `Plan ${plan.id.slice(0, 8)}`)
      : `Plan ${plan.id.slice(0, 8)}`,
    lifecycle: plan.state,
    decision: planDecision,
    reason,
    afterPlans: scopedAfterPlans.slice(0, MAX_SCHEDULING_AFTER_PLAN_REFERENCES),
    afterPlansCount: scopedAfterPlans.length,
    afterPlansComplete: scopedAfterPlans.length <= MAX_SCHEDULING_AFTER_PLAN_REFERENCES,
    nodes,
    nodesComplete: plan.node_count === planNodes.length,
  }
  if (!schedule.nodesComplete) unknown = true
  return {
    schedule,
    facts: plan,
    input: parsed.success ? parsed.data : undefined,
    nodes,
    rawNodes: planNodes,
    waitingPlanIDs,
    workspaceMode,
    unknown,
  }
}

function reservationDetails(
  sessionTaskIDs: Set<string> | undefined,
  taskIDs: readonly string[],
  completeFacts: boolean,
) {
  const uniqueTaskIDs = [...new Set(taskIDs)]
  const scopedTaskIDs = sessionTaskIDs
    ? uniqueTaskIDs.filter((taskID) => sessionTaskIDs.has(taskID))
    : uniqueTaskIDs
  return {
    reservationTaskIDs: scopedTaskIDs.slice(0, MAX_SCHEDULING_RESERVATION_REFERENCES),
    reservationTaskCount: scopedTaskIDs.length,
    reservationTaskIDsComplete:
      completeFacts && scopedTaskIDs.length <= MAX_SCHEDULING_RESERVATION_REFERENCES,
    reservationTaskIDsScopeLimited: scopedTaskIDs.length < uniqueTaskIDs.length,
  }
}

/** A plan that is not dispatching explains to its waiting tasks why, and on which plans. */
function holdWaitingPlanNodes(plan: ProjectedPlan, sessionPlanIDs: Set<string> | undefined) {
  for (const node of plan.nodes) {
    if (!["queued", "ready"].includes(node.lifecycle)) continue
    node.reason = plan.schedule.reason
    if (!plan.waitingPlanIDs.length) continue
    const waitingPlanIDs = [...new Set(plan.waitingPlanIDs)].filter(
      (planID) => !sessionPlanIDs || sessionPlanIDs.has(planID),
    )
    if (!waitingPlanIDs.length) continue
    node.waitingOnPlans = waitingPlanIDs.slice(0, MAX_SCHEDULING_PLAN_REFERENCES)
    node.waitingOnPlansCount = waitingPlanIDs.length
    node.waitingOnPlansComplete = waitingPlanIDs.length <= MAX_SCHEDULING_PLAN_REFERENCES
  }
}

/** The plan's node view when its task is a dispatch candidate; undefined when it is not. */
async function candidateNodeView(
  input: SnapshotBuildInput,
  plan: ProjectedPlan,
  node: SchedulingNodeFact,
  planEdges: SchedulingFactSnapshot["dependencies"],
  state: SelectionState,
): Promise<SchedulingNode | undefined> {
  const { facts, branch, proveTask } = input
  const view = plan.nodes.find((candidate) => candidate.taskID === node.task_id)!
  if (view.reason) {
    view.decision = "unknown"
    plan.unknown = true
    markSelectionUnknown(state, view.reason)
    return undefined
  }
  if (!["queued", "ready"].includes(node.state)) return undefined
  const ancestors = taskAncestors(node.task_id, planEdges)
  if (ancestors.length) {
    if (!branch) {
      state.cacheable = false
      view.decision = "unknown"
      view.reason = "Task source ancestry is unavailable."
      plan.unknown = true
      markSelectionUnknown(state, view.reason)
      return undefined
    }
    const integrations = facts.taskIntegrations.filter(
      (row) => row.plan_id === plan.schedule.planID && ancestors.includes(row.task_id),
    )
    const proofResult = await proveTask(branch.branch, ancestors, integrations, branch.head)
    state.cacheable &&= proofResult.cacheable
    const proof = proofResult.value
    if (proof.status !== "ready") {
      view.decision = proof.status === "unknown" ? "unknown" : "waiting"
      view.reason = proof.reason
      view.waitingOn = taskPrerequisites(node.task_id, planEdges)
      if (proof.status === "unknown") {
        plan.unknown = true
        markSelectionUnknown(state, proof.reason)
      }
      return undefined
    }
  }
  view.decision = "eligible"
  view.reason = null
  return view
}

/** Holds the candidates whose scopes are reserved; returns true when a candidate's hold is unknowable. */
function applyReservationHolds(
  candidateNodes: SchedulingNode[],
  selection: ReturnType<typeof selectSchedulingCandidates>,
  plan: ProjectedPlan,
  reservationFactsComplete: boolean,
  knownReservationTaskIDs: Set<string | undefined>,
  sessionTaskIDs: Set<string> | undefined,
  state: SelectionState,
) {
  let reservationUnknown = false
  for (const node of candidateNodes) {
    const hold = selection.holds.get(node.taskID)
    if (reservationFactsComplete) {
      if (!hold) continue
      node.decision = "waiting"
      node.reason = hold.reason
      Object.assign(node, reservationDetails(sessionTaskIDs, hold.reservationTaskIDs, true))
      continue
    }

    const knownBlockers = (hold?.reservationTaskIDs ?? []).filter((taskID) =>
      knownReservationTaskIDs.has(taskID),
    )
    if (knownBlockers.length) {
      node.decision = "waiting"
      node.reason = hold?.reason ?? "A captured active reservation blocks this task."
      Object.assign(node, reservationDetails(sessionTaskIDs, knownBlockers, false))
    } else {
      node.decision = "unknown"
      node.reason =
        "Active reservation coverage is incomplete; task eligibility cannot be established."
      Object.assign(node, reservationDetails(sessionTaskIDs, [], false))
      reservationUnknown = true
      plan.unknown = true
      markSelectionUnknown(state, node.reason)
    }
  }
  return reservationUnknown
}

/** Chooses the plan's dispatchable tasks against active, adoption and earlier-selected reservations. */
async function selectPlanCandidates(
  input: SnapshotBuildInput,
  plan: ProjectedPlan,
  adoptionReservations: SchedulingReservation[],
  sessionTaskIDs: Set<string> | undefined,
  state: SelectionState,
) {
  const { store, facts } = input
  const directory = store.repository.projectDirectory
  const reservationFactsComplete = facts.reservationsComplete && facts.adoptionsComplete
  const planEdges = facts.dependencies.filter((edge) => edge.plan_id === plan.schedule.planID)
  const candidateNodes: SchedulingNode[] = []
  for (const node of plan.rawNodes) {
    const view = await candidateNodeView(input, plan, node, planEdges, state)
    if (view) candidateNodes.push(view)
  }

  const activeReservations = facts.reservations.map((attempt) => ({
    shared: attempt.workspace === directory,
    scopes: store.effectiveReservationScope(attempt.task_id),
    taskID: attempt.task_id,
  }))
  const knownReservationTaskIDs = new Set([
    ...activeReservations.map((reservation) => reservation.taskID),
    ...adoptionReservations.map((reservation) => reservation.taskID),
  ])
  const scopedReservations: SchedulingReservation[] = [
    ...activeReservations,
    ...adoptionReservations,
    ...state.previouslySelectedReservations,
  ]
  const selection = selectSchedulingCandidates(
    plan.workspaceMode,
    candidateNodes.map((node) => ({
      taskID: node.taskID,
      scopes: store.effectiveReservationScope(node.taskID),
    })),
    scopedReservations,
  )
  if (reservationFactsComplete) state.selectedTaskIDs.push(...selection.selectedTaskIDs)
  const reservationUnknown = applyReservationHolds(
    candidateNodes,
    selection,
    plan,
    reservationFactsComplete,
    knownReservationTaskIDs,
    sessionTaskIDs,
    state,
  )
  if (selection.selectedTaskIDs.length && reservationFactsComplete) {
    for (const taskID of selection.selectedTaskIDs)
      state.previouslySelectedReservations.push({
        shared: plan.workspaceMode === "shared",
        scopes: store.effectiveReservationScope(taskID),
        taskID,
      })
    plan.schedule.decision = "eligible"
  } else if ((!candidateNodes.length || reservationUnknown) && plan.unknown) {
    plan.schedule.decision = "unknown"
    plan.schedule.reason = state.firstUnknownReason ?? "Scheduling facts are unavailable."
  } else if (!candidateNodes.length) {
    plan.schedule.decision = "waiting"
    plan.schedule.reason = plan.schedule.reason ?? "No task is currently dispatchable."
  } else {
    plan.schedule.decision = "waiting"
    plan.schedule.reason = "Eligible task scopes are reserved by active work."
  }
  if (!state.firstCandidateKnown && selection.selectedTaskIDs.length && state.prefixKnown)
    state.firstCandidateKnown = true
  if (!plan.schedule.nodesComplete && selection.selectedTaskIDs.length === 0) {
    state.prefixKnown = false
    state.selectionComplete = false
    plan.schedule.decision = "unknown"
    plan.schedule.reason = "Task coverage is incomplete for this higher-priority plan."
    state.firstUnknownReason ??= plan.schedule.reason
  }
}

function nextSchedulingCandidate(
  facts: SchedulingFactSnapshot,
  projected: ProjectedPlan[],
  state: SelectionState,
): SchedulingSnapshot["next"] {
  const { selectedTaskIDs, firstUnknownReason } = state
  const allPlans = projected.map((plan) => plan.schedule)
  const nextCandidateID = selectedTaskIDs[0]
  if (
    nextCandidateID &&
    state.firstCandidateKnown &&
    facts.reservationsComplete &&
    facts.adoptionsComplete
  ) {
    const plan = allPlans.find((candidate) =>
      candidate.nodes.some((node) => node.taskID === nextCandidateID),
    )!
    const node = plan.nodes.find((candidate) => candidate.taskID === nextCandidateID)!
    return {
      status: "known",
      candidate: {
        planID: plan.planID,
        taskID: node.taskID,
        ...(node.reference ? { reference: node.reference } : {}),
        title: node.title,
        priority: plan.priority,
        planOrder: plan.planOrder,
        ordinal: node.ordinal,
        order: selectedTaskIDs.indexOf(node.taskID),
      },
    }
  }
  if (
    selectedTaskIDs.length === 0 &&
    facts.plansComplete &&
    facts.nodesComplete &&
    facts.reservationsComplete &&
    facts.adoptionsComplete &&
    facts.planIntegrationsComplete &&
    state.selectionComplete &&
    !projected.some((plan) => plan.unknown)
  )
    return { status: "none" }
  return {
    status: "unknown",
    reason:
      firstUnknownReason ??
      (facts.plansComplete
        ? "Scheduling facts are incomplete; refresh to establish the next task."
        : "Higher-priority plan coverage is incomplete; refresh to establish the next task."),
  }
}

function coverageReasons(facts: SchedulingFactSnapshot, projected: ProjectedPlan[]) {
  return [
    !facts.plansComplete ? "Plan coverage is bounded." : null,
    !facts.nodesComplete ? "Task coverage is bounded." : null,
    !facts.reservationsComplete ? "Active reservation coverage is incomplete." : null,
    !facts.adoptionsComplete ? "Adoption reservation coverage is incomplete." : null,
    !facts.planIntegrationsComplete ? "Prerequisite integration coverage is bounded." : null,
    projected.some((plan) => plan.schedule.afterPlansComplete === false)
      ? "Prerequisite plan references are bounded."
      : null,
  ].filter((reason): reason is string => reason !== null)
}

async function buildSnapshot(input: SnapshotBuildInput): Promise<BuiltProjection> {
  const { store, facts, scope, observedAt } = input
  const sessionPlanIDs =
    scope.kind === "session" ? new Set(facts.sessionAssociations?.planIDs ?? []) : undefined
  const state: SelectionState = {
    cacheable: true,
    prefixKnown: true,
    firstCandidateKnown: false,
    selectionComplete:
      facts.plansComplete &&
      facts.nodesComplete &&
      facts.reservationsComplete &&
      facts.adoptionsComplete &&
      facts.planIntegrationsComplete,
    firstUnknownReason: undefined,
    selectedTaskIDs: [],
    previouslySelectedReservations: [],
  }
  const projected: ProjectedPlan[] = await Promise.all(
    facts.plans.map((plan, planOrder) =>
      projectPlan(input, plan, planOrder, sessionPlanIDs, state),
    ),
  )

  const adoptionReservations = facts.adoptions.map((adoption) => ({
    shared: false,
    scopes: store.effectiveReservationScope(adoption.task_id),
    taskID: adoption.task_id,
  }))
  const sessionTaskIDs =
    scope.kind === "session" ? new Set(facts.sessionAssociations?.taskIDs ?? []) : undefined

  for (const plan of projected) {
    if (
      !plan.input ||
      plan.schedule.lifecycle !== "running" ||
      plan.schedule.decision === "unknown"
    ) {
      if (plan.schedule.lifecycle === "running" && plan.schedule.decision === "unknown")
        markSelectionUnknown(
          state,
          plan.schedule.reason ?? "Higher-priority scheduling facts are unavailable.",
        )
      continue
    }
    if (plan.schedule.decision === "waiting") {
      holdWaitingPlanNodes(plan, sessionPlanIDs)
      continue
    }
    await selectPlanCandidates(input, plan, adoptionReservations, sessionTaskIDs, state)
  }

  const allPlans = projected.map((plan) => plan.schedule)
  const next = nextSchedulingCandidate(facts, projected, state)
  if (state.selectedTaskIDs.length > 5_000) state.selectionComplete = false
  const reasons = coverageReasons(facts, projected)
  const snapshot = {
    schemaVersion: 1 as const,
    snapshotID: randomUUID(),
    repositoryVersion: facts.repositoryVersion,
    scope,
    observedAt,
    coverage: {
      status: reasons.length ? ("partial" as const) : ("complete" as const),
      planCount: facts.totalPlanCount,
      coveredPlanCount: facts.plans.length,
      nodeCount: facts.totalNodeCount,
      coveredNodeCount: facts.nodes.length,
      activeReservationCount: facts.totalReservationCount + facts.totalAdoptionCount,
      reservationsComplete: facts.reservationsComplete && facts.adoptionsComplete,
      reason: reasons.join(" ") || null,
    },
    next,
    selectedTaskIDs: state.selectedTaskIDs.slice(0, 5_000),
    selectionComplete: state.selectionComplete,
    plans: allPlans,
  }
  const validated = SchedulingSnapshotSchema.parse(snapshot)
  return {
    snapshot: scope.kind === "session" ? scopeSessionSnapshot(validated, facts) : validated,
    cacheable: state.cacheable,
  }
}

function scopeSessionSnapshot(
  snapshot: SchedulingSnapshot,
  facts: SchedulingFactSnapshot,
): SchedulingSnapshot {
  const associations = facts.sessionAssociations
  if (!associations) throw new Error("Session scheduling associations are unavailable")

  const planIDs = new Set(associations.planIDs)
  const taskIDs = new Set(associations.taskIDs)
  const plans = snapshot.plans
    .filter((plan) => planIDs.has(plan.planID))
    .map((plan) => ({
      ...plan,
      afterPlans: plan.afterPlans.filter((planID) => planIDs.has(planID)),
      nodes: plan.nodes.map((node) => {
        const reservationTaskIDs = node.reservationTaskIDs.filter((taskID) => taskIDs.has(taskID))
        const reservationIDsFenced = reservationTaskIDs.length !== node.reservationTaskIDs.length
        return {
          ...node,
          prerequisites: node.prerequisites.filter((taskID) => taskIDs.has(taskID)),
          waitingOn: node.waitingOn.filter((id) => taskIDs.has(id)),
          ...(node.waitingOnPlans
            ? { waitingOnPlans: node.waitingOnPlans.filter((id) => planIDs.has(id)) }
            : {}),
          reservationTaskIDs,
          ...(node.reservationTaskIDsComplete !== undefined || reservationIDsFenced
            ? {
                reservationTaskIDsComplete:
                  (node.reservationTaskIDsComplete ?? true) && !reservationIDsFenced,
              }
            : {}),
          ...(node.reservationTaskIDsScopeLimited !== undefined || reservationIDsFenced
            ? {
                reservationTaskIDsScopeLimited:
                  (node.reservationTaskIDsScopeLimited ?? false) || reservationIDsFenced,
              }
            : {}),
        }
      }),
    }))
  const coveredNodeCount = facts.nodes.filter((node) => planIDs.has(node.plan_id)).length
  const capturedReservationCount =
    facts.reservations.filter((reservation) => planIDs.has(reservation.plan_id)).length +
    facts.adoptions.filter((adoption) => planIDs.has(adoption.plan_id)).length
  const plansComplete = plans.length === associations.planCount
  const nodesComplete = coveredNodeCount === associations.nodeCount
  const reservationsComplete =
    capturedReservationCount === associations.activeReservationCount &&
    facts.reservationsComplete &&
    facts.adoptionsComplete
  const reasons = [
    snapshot.coverage.reason,
    !plansComplete ? "Session plan coverage is incomplete." : null,
    !nodesComplete ? "Session task coverage is incomplete." : null,
    !reservationsComplete ? "Session reservation coverage is incomplete." : null,
  ].filter((reason): reason is string => reason !== null)

  let next = snapshot.next
  if (
    next.status === "known" &&
    (!planIDs.has(next.candidate.planID) || !taskIDs.has(next.candidate.taskID))
  )
    next = {
      status: "unknown",
      reason:
        "The project-wide next task is outside this session scope; a session Next is unavailable.",
    }
  else if (next.status === "unknown")
    next = {
      status: "unknown",
      reason: "Project-wide scheduling coverage is insufficient to establish this session's Next.",
    }

  return SchedulingSnapshotSchema.parse({
    ...snapshot,
    coverage: {
      status: reasons.length ? "partial" : "complete",
      planCount: associations.planCount,
      coveredPlanCount: plans.length,
      nodeCount: associations.nodeCount,
      coveredNodeCount,
      activeReservationCount: associations.activeReservationCount,
      reservationsComplete,
      reason: reasons.join(" ") || null,
    },
    next,
    selectedTaskIDs: snapshot.selectedTaskIDs.filter((taskID) => taskIDs.has(taskID)),
    selectionComplete:
      snapshot.selectionComplete && plansComplete && nodesComplete && reservationsComplete,
    plans,
  })
}

export class TaskSchedulingRead {
  private readonly snapshots = new Map<string, CachedSnapshot>()
  private readonly projections = new Map<string, SchedulingSnapshot>()
  private readonly projectionInFlight = new Map<string, Promise<BuiltProjection>>()
  private readonly planProofs = new Map<string, PlanSourceResult>()
  private readonly taskProofs = new Map<string, IntegrationDecision>()
  private readonly planProofInFlight = new Map<string, Promise<ProofResult<PlanSourceResult>>>()
  private readonly taskProofInFlight = new Map<string, Promise<ProofResult<IntegrationDecision>>>()
  private readonly work = {
    factCaptures: 0,
    projectionBuilds: 0,
    projectionCacheHits: 0,
    proofEvaluations: 0,
    proofCacheHits: 0,
    proofCoalesced: 0,
    projectionCoalesced: 0,
    gitCommands: 0,
  }

  constructor(
    private readonly store: RunnerStore,
    private readonly now: () => number = Date.now,
    private readonly limits: TaskSchedulingReadLimits = {},
    private readonly runGit: SchedulingGitRunner = schedulingGit,
  ) {}

  get workCounts() {
    return { ...this.work }
  }

  private remember<T>(cache: Map<string, T>, key: string, value: T) {
    cache.delete(key)
    cache.set(key, value)
    while (cache.size > MAX_CACHED_PROOFS) {
      const oldest = cache.keys().next().value
      if (!oldest) break
      cache.delete(oldest)
    }
  }

  private async proofGit(directory: string, args: string[]) {
    this.work.gitCommands++
    return this.runGit(directory, args)
  }

  private async planProof(
    prerequisites: readonly string[],
    rows: SchedulingFactSnapshot["planIntegrations"],
    head: string,
  ): Promise<ProofResult<PlanSourceResult>> {
    const directory = this.store.repository.projectDirectory
    const key = proofBasisKey("plan", [directory, prerequisites, rows, head])
    const existing = this.existingProof(this.planProofs, this.planProofInFlight, key)
    if (existing) return existing
    const tracker = this.cacheableProofGit()
    const git = tracker.git
    const promise = evaluatePrerequisiteIntegrationAsync(directory, prerequisites, rows, git, head)
      .then((baseline) => {
        const cacheable = tracker.cacheable
        const value: PlanSourceResult = !cacheable
          ? { decision: "unknown", reason: "Integrated source ancestry is unavailable." }
          : baseline
            ? {
                decision: "ready",
                reason: "Prerequisite plans are integrated in the selected source.",
              }
            : {
                decision: "waiting",
                reason: "Waiting for accepted prerequisite plans to be integrated.",
              }
        if (cacheable) this.remember(this.planProofs, key, value)
        return { value, cacheable }
      })
      .finally(() => this.planProofInFlight.delete(key))
    this.planProofInFlight.set(key, promise)
    return promise
  }

  private existingProof<V>(
    cache: Map<string, V>,
    inFlightProofs: Map<string, Promise<ProofResult<V>>>,
    key: string,
  ): ProofResult<V> | Promise<ProofResult<V>> | undefined {
    if (cache.has(key)) {
      this.work.proofCacheHits++
      return { value: cache.get(key)!, cacheable: true }
    }
    const inFlight = inFlightProofs.get(key)
    if (inFlight) {
      this.work.proofCoalesced++
      return inFlight
    }
    this.work.proofEvaluations++
    return undefined
  }

  private cacheableProofGit() {
    const tracker = {
      cacheable: true,
      git: async (path: string, args: string[]) => {
        try {
          return await this.proofGit(path, args)
        } catch (error) {
          if (!(
            error instanceof SchedulingGitError &&
            args[0] === "merge-base" &&
            error.status === 1
          ))
            tracker.cacheable = false
          throw error
        }
      },
    }
    return tracker
  }

  private async taskProof(
    branch: string,
    prerequisites: readonly string[],
    rows: SchedulingFactSnapshot["taskIntegrations"],
    head: string,
  ): Promise<ProofResult<IntegrationDecision>> {
    const directory = this.store.repository.projectDirectory
    const key = proofBasisKey("task", [directory, branch, prerequisites, rows, head])
    const existing = this.existingProof(this.taskProofs, this.taskProofInFlight, key)
    if (existing) return existing
    const tracker = this.cacheableProofGit()
    const git = tracker.git
    const promise = evaluateTaskPrerequisiteIntegrationAsync(
      directory,
      branch,
      prerequisites,
      rows,
      git,
      head,
    )
      .then((value) => {
        const cacheable = tracker.cacheable
        const decision = cacheable
          ? value
          : { status: "unknown" as const, reason: "Task source ancestry is unavailable." }
        if (cacheable) this.remember(this.taskProofs, key, decision)
        return { value: decision, cacheable }
      })
      .finally(() => this.taskProofInFlight.delete(key))
    this.taskProofInFlight.set(key, promise)
    return promise
  }

  private async captureBranchAndHead() {
    this.work.gitCommands += 2
    return branchAndHead(this.store.repository.projectDirectory, this.runGit)
  }

  private async buildProjection(
    facts: SchedulingFactSnapshot,
    scope: SchedulingScope,
    branch: SchedulingBranch,
  ): Promise<BuiltProjection> {
    this.work.projectionBuilds++
    return buildSnapshot({
      store: this.store,
      facts,
      scope,
      observedAt: this.now(),
      branch,
      provePlan: (prerequisites, rows, head) => this.planProof(prerequisites, rows, head),
      proveTask: (currentBranch, prerequisites, rows, head) =>
        this.taskProof(currentBranch, prerequisites, rows, head),
    })
  }

  private async projectionFor(
    facts: SchedulingFactSnapshot,
    scope: SchedulingScope,
    initialBranch: SchedulingBranch,
  ) {
    let branch = initialBranch
    const semanticBasis = schedulingBasis(facts)
    for (let attempt = 0; attempt < 2; attempt++) {
      const key = JSON.stringify([scopeKey(scope), semanticBasis, branch])
      const cached = this.projections.get(key)
      if (cached) {
        this.work.projectionCacheHits++
        this.projections.delete(key)
        this.projections.set(key, cached)
        return cached
      }
      const pending = this.projectionInFlight.get(key)
      if (pending) {
        this.work.projectionCoalesced++
        const result = await pending
        return result.snapshot
      }
      const proofEvaluations = this.work.proofEvaluations
      const building = this.buildProjection(facts, scope, branch)
      this.projectionInFlight.set(key, building)
      try {
        const built = await building
        if (this.work.proofEvaluations !== proofEvaluations) {
          const currentBranch = await this.captureBranchAndHead()
          if (currentBranch?.branch !== branch?.branch || currentBranch?.head !== branch?.head) {
            branch = currentBranch
            continue
          }
        }
        if (built.cacheable) {
          this.projections.set(key, built.snapshot)
          while (this.projections.size > MAX_CACHED_PROJECTIONS) {
            const oldest = this.projections.keys().next().value
            if (!oldest) break
            this.projections.delete(oldest)
          }
        }
        return built.snapshot
      } finally {
        this.projectionInFlight.delete(key)
      }
    }
    throw new Error("Git source changed during the scheduling read; refresh to retry")
  }

  async read(rawInput: SchedulingInputType): Promise<SchedulingPage> {
    const input = SchedulingInput.parse(rawInput)
    const key = scopeKey(input.scope)
    let cached: CachedSnapshot
    let offset = 0
    if (input.cursor) {
      const cursor = parseCursor(input.cursor)
      const existing = this.snapshots.get(cursor.snapshotID)
      if (
        !existing ||
        existing.expiresAt <= this.now() ||
        existing.scopeKey !== key ||
        cursor.scopeKey !== key
      )
        throw new Error(
          "Scheduling cursor is stale or belongs to another scope; refresh the Tasks view",
        )
      cached = existing
      offset = cursor.offset
      if (offset > cached.snapshot.plans.length)
        throw new Error("Scheduling cursor is invalid; refresh the Tasks view")
    } else {
      const opened = openReadOnlyTrajectoryStore(
        this.store.repository.path,
        this.store.repository.projectDirectory,
      )
      let facts: SchedulingFactSnapshot
      try {
        facts = opened.store.schedulingFacts({
          maxPlans: Math.max(1, Math.min(this.limits.maxPlans ?? MAX_PLANS, MAX_PLANS)),
          maxNodes: Math.max(1, Math.min(this.limits.maxNodes ?? MAX_NODES, MAX_NODES)),
          maxReservations: Math.max(
            1,
            Math.min(this.limits.maxReservations ?? MAX_RESERVATIONS, MAX_RESERVATIONS),
          ),
          ...(input.scope.kind === "session" ? { scopeSessionID: input.scope.sessionID } : {}),
        })
        this.work.factCaptures++
      } finally {
        opened.close()
      }
      const branch = await this.captureBranchAndHead()
      const projection = await this.projectionFor(facts, input.scope, branch)
      const snapshot = materializeSnapshot(projection, facts, this.now())
      const capturedAt = snapshot.observedAt
      cached = { scopeKey: key, expiresAt: capturedAt + SNAPSHOT_TTL_MS, snapshot }
      this.snapshots.set(snapshot.snapshotID, cached)
      while (this.snapshots.size > MAX_CACHED_SNAPSHOTS) {
        const oldest = this.snapshots.keys().next().value
        if (!oldest) break
        this.snapshots.delete(oldest)
      }
    }
    const plans = cached.snapshot.plans.slice(offset, offset + input.limit)
    const nextOffset = offset + plans.length
    const nextCursor =
      nextOffset < cached.snapshot.plans.length
        ? makeCursor(cached.snapshot.snapshotID, nextOffset, key)
        : null
    return SchedulingOutput.parse({ ...cached.snapshot, plans, nextCursor })
  }
}
