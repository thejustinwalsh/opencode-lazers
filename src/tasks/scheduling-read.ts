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
import { sourceReservationExcluded } from "../runner/source-quarantine.ts"
import { selectSchedulingCandidates } from "../runner/scheduling-selection.ts"
import type { SchedulingReservation } from "../runner/scheduling-selection.ts"
import { openReadOnlyTrajectoryStore } from "../trajectory/store.ts"
import {
  SchedulingInput,
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

async function buildSnapshot(input: {
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
}): Promise<BuiltProjection> {
  const { store, facts, scope, observedAt, branch, provePlan, proveTask } = input
  const directory = store.repository.projectDirectory
  let cacheable = true
  const projected: ProjectedPlan[] = await Promise.all(
    facts.plans.map(async (plan, planOrder) => {
      let raw: unknown
      try {
        raw = JSON.parse(plan.body) as unknown
      } catch {
        raw = undefined
      }
      const parsed = PlanInput.safeParse(raw)
      const planNodes = facts.nodes.filter((node) => node.plan_id === plan.id)
      const nodes: SchedulingNode[] = planNodes.map((node) => {
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
          facts.dependencies.filter((edge) => edge.plan_id === plan.id),
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
      })
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
      const workspaceMode =
        rawMode === "isolated" || rawMode === "shared" ? rawMode : (attemptPolicy ?? "shared")
      let planDecision: SchedulingPlan["decision"] = "waiting"
      let reason = safeReason(plan.reason)
      let unknown = false
      if (!parsed.success) {
        planDecision = "unknown"
        reason = "Plan scheduling facts are unavailable."
        unknown = true
      } else if (plan.state === "running") {
        const prerequisite = await planSourceDecision(
          parsed.data.afterPlans ?? [],
          facts,
          branch?.head,
          provePlan,
        )
        cacheable &&= prerequisite.cacheable
        planDecision =
          prerequisite.value.decision === "ready" ? "eligible" : prerequisite.value.decision
        reason = prerequisite.value.reason
        unknown = prerequisite.value.decision === "unknown"
      } else {
        reason = reason ?? (plan.state === "blocked" ? "Plan is on hold." : null)
      }
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
        afterPlans: parsed.success ? (parsed.data.afterPlans ?? []) : [],
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
        workspaceMode,
        unknown,
      }
    }),
  )

  const adoptionReservations = facts.adoptions.map((adoption) => ({
    shared: false,
    scopes: store.effectiveWriteScope(adoption.task_id),
    taskID: adoption.task_id,
  }))
  const previouslySelectedReservations: SchedulingReservation[] = []
  const selectedTaskIDs: string[] = []
  let prefixKnown = true
  let firstCandidateKnown = false
  let selectionComplete =
    facts.plansComplete &&
    facts.nodesComplete &&
    facts.reservationsComplete &&
    facts.adoptionsComplete &&
    facts.planIntegrationsComplete
  let firstUnknownReason: string | undefined

  for (const plan of projected) {
    if (
      !plan.input ||
      plan.schedule.lifecycle !== "running" ||
      plan.schedule.decision === "unknown"
    ) {
      if (plan.schedule.lifecycle === "running" && plan.schedule.decision === "unknown") {
        prefixKnown = false
        selectionComplete = false
        firstUnknownReason ??=
          plan.schedule.reason ?? "Higher-priority scheduling facts are unavailable."
      }
      continue
    }
    if (plan.schedule.decision === "waiting") {
      for (const node of plan.nodes) {
        if (["queued", "ready"].includes(node.lifecycle)) {
          node.reason = plan.schedule.reason
          node.waitingOn = plan.schedule.afterPlans
        }
      }
      continue
    }
    const planEdges = facts.dependencies.filter((edge) => edge.plan_id === plan.schedule.planID)
    const candidateNodes: SchedulingNode[] = []
    for (const node of plan.rawNodes) {
      const view = plan.nodes.find((candidate) => candidate.taskID === node.task_id)!
      if (view.reason) {
        view.decision = "unknown"
        plan.unknown = true
        prefixKnown = false
        selectionComplete = false
        firstUnknownReason ??= view.reason
        continue
      }
      if (!["queued", "ready"].includes(node.state)) continue
      const ancestors = taskAncestors(node.task_id, planEdges)
      if (ancestors.length) {
        if (!branch) {
          cacheable = false
          view.decision = "unknown"
          view.reason = "Task source ancestry is unavailable."
          plan.unknown = true
          prefixKnown = false
          selectionComplete = false
          firstUnknownReason ??= view.reason
          continue
        }
        const integrations = facts.taskIntegrations.filter(
          (row) => row.plan_id === plan.schedule.planID && ancestors.includes(row.task_id),
        )
        const proofResult = await proveTask(branch.branch, ancestors, integrations, branch.head)
        cacheable &&= proofResult.cacheable
        const proof = proofResult.value
        if (proof.status !== "ready") {
          view.decision = proof.status === "unknown" ? "unknown" : "waiting"
          view.reason = proof.reason
          view.waitingOn = taskPrerequisites(node.task_id, planEdges)
          if (proof.status === "unknown") {
            plan.unknown = true
            prefixKnown = false
            selectionComplete = false
            firstUnknownReason ??= proof.reason
          }
          continue
        }
      }
      view.decision = "eligible"
      view.reason = null
      candidateNodes.push(view)
    }

    const activeReservations = facts.reservations
      .filter((attempt) => !sourceReservationExcluded(store, attempt, { mode: plan.workspaceMode }))
      .map((attempt) => ({
        shared: attempt.workspace === directory,
        scopes: store.effectiveWriteScope(attempt.task_id),
        taskID: attempt.task_id,
      }))
    const scopedReservations: SchedulingReservation[] = [
      ...activeReservations,
      ...adoptionReservations,
      ...previouslySelectedReservations,
    ]
    const selection = selectSchedulingCandidates(
      plan.workspaceMode,
      candidateNodes.map((node) => ({
        taskID: node.taskID,
        scopes: store.effectiveWriteScope(node.taskID),
      })),
      scopedReservations,
    )
    selectedTaskIDs.push(...selection.selectedTaskIDs)
    for (const node of candidateNodes) {
      const hold = selection.holds.get(node.taskID)
      if (hold) {
        node.decision = "waiting"
        node.reason = hold.reason
        node.reservationTaskIDs = hold.reservationTaskIDs
      }
    }
    if (selection.selectedTaskIDs.length) {
      for (const taskID of selection.selectedTaskIDs)
        previouslySelectedReservations.push({
          shared: plan.workspaceMode === "shared",
          scopes: store.effectiveWriteScope(taskID),
          taskID,
        })
      plan.schedule.decision = "eligible"
    } else if (!candidateNodes.length && plan.unknown) {
      plan.schedule.decision = "unknown"
      plan.schedule.reason = firstUnknownReason ?? "Scheduling facts are unavailable."
    } else if (!candidateNodes.length) {
      plan.schedule.decision = "waiting"
      plan.schedule.reason = plan.schedule.reason ?? "No task is currently dispatchable."
    } else {
      plan.schedule.decision = "waiting"
      plan.schedule.reason = "Eligible task scopes are reserved by active work."
    }
    if (!firstCandidateKnown && selection.selectedTaskIDs.length && prefixKnown) {
      firstCandidateKnown = true
    }
    if (!plan.schedule.nodesComplete && selection.selectedTaskIDs.length === 0) {
      prefixKnown = false
      selectionComplete = false
      plan.schedule.decision = "unknown"
      plan.schedule.reason = "Task coverage is incomplete for this higher-priority plan."
      firstUnknownReason ??= plan.schedule.reason
    }
  }

  const allPlans = projected.map((plan) => plan.schedule)
  const nextCandidateID = selectedTaskIDs[0]
  let next: SchedulingSnapshot["next"]
  if (
    nextCandidateID &&
    firstCandidateKnown &&
    facts.reservationsComplete &&
    facts.adoptionsComplete
  ) {
    const plan = allPlans.find((candidate) =>
      candidate.nodes.some((node) => node.taskID === nextCandidateID),
    )!
    const node = plan.nodes.find((candidate) => candidate.taskID === nextCandidateID)!
    next = {
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
  } else if (
    selectedTaskIDs.length === 0 &&
    facts.plansComplete &&
    facts.nodesComplete &&
    facts.reservationsComplete &&
    facts.adoptionsComplete &&
    facts.planIntegrationsComplete &&
    selectionComplete &&
    !projected.some((plan) => plan.unknown)
  ) {
    next = { status: "none" }
  } else {
    next = {
      status: "unknown",
      reason:
        firstUnknownReason ??
        (facts.plansComplete
          ? "Scheduling facts are incomplete; refresh to establish the next task."
          : "Higher-priority plan coverage is incomplete; refresh to establish the next task."),
    }
  }
  const coveredNodeCount = facts.nodes.length
  if (selectedTaskIDs.length > 5_000) selectionComplete = false
  const reasons = [
    !facts.plansComplete ? "Plan coverage is bounded." : null,
    !facts.nodesComplete ? "Task coverage is bounded." : null,
    !facts.reservationsComplete ? "Active reservation coverage is incomplete." : null,
    !facts.adoptionsComplete ? "Adoption reservation coverage is incomplete." : null,
    !facts.planIntegrationsComplete ? "Prerequisite integration coverage is bounded." : null,
  ].filter((reason): reason is string => reason !== null)
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
      coveredNodeCount,
      activeReservationCount: facts.totalReservationCount + facts.totalAdoptionCount,
      reservationsComplete: facts.reservationsComplete && facts.adoptionsComplete,
      reason: reasons.join(" ") || null,
    },
    next,
    selectedTaskIDs: selectedTaskIDs.slice(0, 5_000),
    selectionComplete,
    plans: allPlans,
  }
  return { snapshot: SchedulingSnapshotSchema.parse(snapshot), cacheable }
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
    if (this.planProofs.has(key)) {
      this.work.proofCacheHits++
      return { value: this.planProofs.get(key)!, cacheable: true }
    }
    const inFlight = this.planProofInFlight.get(key)
    if (inFlight) {
      this.work.proofCoalesced++
      return inFlight
    }
    this.work.proofEvaluations++
    let cacheable = true
    const git = async (path: string, args: string[]) => {
      try {
        return await this.proofGit(path, args)
      } catch (error) {
        if (!(
          error instanceof SchedulingGitError &&
          args[0] === "merge-base" &&
          error.status === 1
        ))
          cacheable = false
        throw error
      }
    }
    const promise = evaluatePrerequisiteIntegrationAsync(directory, prerequisites, rows, git, head)
      .then((baseline) => {
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

  private async taskProof(
    branch: string,
    prerequisites: readonly string[],
    rows: SchedulingFactSnapshot["taskIntegrations"],
    head: string,
  ): Promise<ProofResult<IntegrationDecision>> {
    const directory = this.store.repository.projectDirectory
    const key = proofBasisKey("task", [directory, branch, prerequisites, rows, head])
    if (this.taskProofs.has(key)) {
      this.work.proofCacheHits++
      return { value: this.taskProofs.get(key)!, cacheable: true }
    }
    const inFlight = this.taskProofInFlight.get(key)
    if (inFlight) {
      this.work.proofCoalesced++
      return inFlight
    }
    this.work.proofEvaluations++
    let cacheable = true
    const git = async (path: string, args: string[]) => {
      try {
        return await this.proofGit(path, args)
      } catch (error) {
        if (!(
          error instanceof SchedulingGitError &&
          args[0] === "merge-base" &&
          error.status === 1
        ))
          cacheable = false
        throw error
      }
    }
    const promise = evaluateTaskPrerequisiteIntegrationAsync(
      directory,
      branch,
      prerequisites,
      rows,
      git,
      head,
    )
      .then((value) => {
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
        return (await pending).snapshot
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
