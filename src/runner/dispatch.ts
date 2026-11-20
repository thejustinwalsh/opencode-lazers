import { messageID, isCommitID, sessionID } from "./runtime-helpers.ts"
import { workerAgent } from "./worker-agent.ts"
import {
  evaluatePrerequisiteIntegration,
  evaluateTaskPrerequisiteIntegration,
  type IntegrationDecision,
  type PrerequisiteIntegrationRow,
  type TaskPrerequisiteIntegrationRow,
} from "./prerequisite-proof.ts"
import { changedPaths, gitAsync, scopePatternsConflict } from "./artifacts.ts"
import { protectedPaths } from "./scope.ts"
import { hasStoredFallowConfig } from "../audit/fallow-gate.ts"
import { storedEvidence } from "./integration-proof.ts"
import type { ArtifactEvidenceLookup } from "./prerequisite-proof.ts"
import type { HostSession } from "./host.ts"
import { ModelPolicy, PlanInput } from "./schema.ts"
import type { PlanRow, NodeRow, AttemptRow } from "./store.ts"
import { resolveDispatchRoute, type DispatchRouteDecision } from "../models/dispatch-resolution.ts"
import { canonicalProjectWorktreePath } from "./workspace-location.ts"

import type { RuntimeCore } from "./runtime-core.ts"
import type { RuntimeJournal } from "./runtime-journal.ts"
import type { JournalDeps } from "./runtime-journal.ts"
import type { DelegatedAgentCapacity } from "./delegated-agent-capacity.ts"
import type { ModelMappingResolver } from "../models/mapping-resolver.ts"
import type { fallowConfigGate } from "../audit/fallow-gate.ts"

/** What dispatch reads from the coordinator and its sibling modules; each call is a lazy arrow. */
export type DispatchDeps = {
  delegatedAgentCapacity: DelegatedAgentCapacity
  modelMappingResolver: ModelMappingResolver
  fallowReviewEnabled: boolean
  fallowGate: () => ReturnType<typeof fallowConfigGate>
  prepareWorker: (plan: PlanRow, attempt: AttemptRow, fence: number) => Promise<void>
  startupRecoveryAuthorization: JournalDeps["startupRecoveryAuthorization"]
  startupRecoveryAuthorityCurrent: JournalDeps["startupRecoveryAuthorityCurrent"]
  journal: {
    hold: RuntimeJournal["hold"]
    effect: RuntimeJournal["effect"]
    receipt: RuntimeJournal["receipt"]
    uncertain: RuntimeJournal["uncertain"]
  }
}

/**
 * Task dispatch: dependency integration proof, the route a task starts on, the capacity and
 * prompt admission checks, and usage observation. Moved out of `TaskRuntime` without rewriting;
 * the private aliases below keep the member bodies identical to what they were.
 */
export class Dispatch {
  private readonly delegatedAgentCapacity: DelegatedAgentCapacity
  private readonly modelMappingResolver: ModelMappingResolver
  private readonly fallowReviewEnabled: boolean
  private readonly fallowGate: DispatchDeps["fallowGate"]
  private readonly prepareWorker: DispatchDeps["prepareWorker"]
  private readonly startupRecoveryAuthorization: DispatchDeps["startupRecoveryAuthorization"]
  private readonly startupRecoveryAuthorityCurrent: DispatchDeps["startupRecoveryAuthorityCurrent"]
  private readonly hold: RuntimeJournal["hold"]
  private readonly effect: RuntimeJournal["effect"]
  private readonly receipt: RuntimeJournal["receipt"]
  private readonly uncertain: RuntimeJournal["uncertain"]

  constructor(
    private readonly core: RuntimeCore,
    deps: DispatchDeps,
  ) {
    this.delegatedAgentCapacity = deps.delegatedAgentCapacity
    this.modelMappingResolver = deps.modelMappingResolver
    this.fallowReviewEnabled = deps.fallowReviewEnabled
    this.fallowGate = () => deps.fallowGate()
    this.prepareWorker = (...args) => deps.prepareWorker(...args)
    this.startupRecoveryAuthorization = (...args) => deps.startupRecoveryAuthorization(...args)
    this.startupRecoveryAuthorityCurrent = (...args) =>
      deps.startupRecoveryAuthorityCurrent(...args)
    this.hold = (...args) => deps.journal.hold(...args)
    this.effect = (...args) => deps.journal.effect(...args)
    this.receipt = (...args) => deps.journal.receipt(...args)
    this.uncertain = (...args) => deps.journal.uncertain(...args)
  }

  private get store() {
    return this.core.store
  }

  private get host() {
    return this.core.host
  }

  private get owner() {
    return this.core.owner
  }

  private get directory() {
    return this.core.directory
  }

  private async dependencySource(plan: PlanRow, input: PlanInput, node: NodeRow): Promise<string> {
    const prerequisites = this.taskDependencyIDs(input, node)
    if (!prerequisites.length) return input.baseCommit
    const proof = await this.taskDependencyIntegration(plan, input, node)
    if (proof.status !== "ready") throw new Error(proof.reason)
    return proof.baseline
  }

  taskDependencyIDs(input: PlanInput, node: NodeRow): string[] {
    const dependencies = new Map<string, string[]>()
    for (const edge of input.dependencies) {
      const prerequisites = dependencies.get(edge.successor) ?? []
      prerequisites.push(edge.prerequisite)
      dependencies.set(edge.successor, prerequisites)
    }
    const ancestors = new Set<string>()
    const visit = (taskID: string) => {
      for (const prerequisite of dependencies.get(taskID) ?? []) {
        if (ancestors.has(prerequisite)) continue
        ancestors.add(prerequisite)
        visit(prerequisite)
      }
    }
    visit(node.task_id)
    const order = new Map(input.integrationOrder.map((taskID, index) => [taskID, index]))
    return [...ancestors].toSorted(
      (left, right) =>
        (order.get(left) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(right) ?? Number.MAX_SAFE_INTEGER),
    )
  }

  /** Stored change identity for an artifact SHA, so proof survives a rewritten history. */
  private artifactEvidence: ArtifactEvidenceLookup = (artifact) =>
    this.store.repository.read((db) => storedEvidence(db, { artifact }))

  async taskDependencyIntegration(
    plan: PlanRow,
    input: PlanInput,
    node: NodeRow,
    candidateBaseline?: string,
    capturedRows?: readonly TaskPrerequisiteIntegrationRow[],
    capturedBranch?: string,
  ): Promise<IntegrationDecision> {
    const prerequisites = this.taskDependencyIDs(input, node)
    if (!prerequisites.length)
      return {
        status: "ready",
        baseline: candidateBaseline ?? input.baseCommit,
      }
    let branch: string
    try {
      branch = capturedBranch ?? (await gitAsync(this.directory, ["branch", "--show-current"]))
    } catch {
      return { status: "unknown", reason: "The integrated source branch could not be read." }
    }
    if (!branch)
      return { status: "waiting", reason: "Task source integration requires the reviewed branch." }
    const rows = capturedRows
      ? capturedRows.filter((row) => row.plan_id === plan.id && prerequisites.includes(row.task_id))
      : this.store.taskPrerequisiteIntegrationRows(plan.id, prerequisites)
    const decision = await evaluateTaskPrerequisiteIntegration(
      this.directory,
      branch,
      prerequisites,
      rows,
      gitAsync,
      candidateBaseline,
      this.artifactEvidence,
    )
    this.observePrerequisites(plan.id, node.task_id, decision)
    return decision
  }

  /** Keep the newest proof where the Tasks list can show it; an unknown proof is not a decision. */
  private observePrerequisites(planID: string, taskID: string, decision: IntegrationDecision) {
    if (decision.status === "unknown") return
    try {
      this.store.recordPrerequisiteObservation(planID, taskID, {
        decision: decision.status,
        reason: decision.status === "waiting" ? decision.reason : null,
      })
    } catch {
      // The proof drives dispatch; the list reads what was recorded and the next tick records again.
    }
  }

  async integratedPrerequisiteBaseline(
    prerequisites: string[],
    candidateBaseline?: string,
  ): Promise<string | undefined> {
    if (!prerequisites.length || new Set(prerequisites).size !== prerequisites.length)
      return undefined

    const rows = this.store.atomic((db) => {
      const result: PrerequisiteIntegrationRow[] = []
      // Bound each query to one hundred plans while reading the latest acceptance
      // and combined-integration transitions from one SQLite snapshot.
      for (let offset = 0; offset < prerequisites.length; offset += 100) {
        const batch = prerequisites.slice(offset, offset + 100)
        const placeholders = batch.map(() => "?").join(",")
        result.push(
          ...db
            .query<PrerequisiteIntegrationRow, string[]>(
              `SELECT p.id AS plan_id,p.project_directory,p.state,p.artifact,
                      accepted.id AS accepted_id,accepted.version AS accepted_version,
                      accepted.payload AS accepted_payload,
                      integration.id AS integration_id,integration.version AS integration_version,
                      integration.payload AS integration_payload,
                      -- Lifecycle labels can be stale; a cancellation invalidates
                      -- older acceptance until a new acceptance/integration pair.
                      (SELECT t.id FROM runner_transitions t
                       WHERE t.plan_id=p.id AND t.task_id IS NULL AND t.event='CANCEL_REQUESTED'
                       ORDER BY t.id DESC LIMIT 1) AS invalidation_id
               FROM runner_plans p
               LEFT JOIN runner_transitions accepted
                 ON accepted.id=(
                   SELECT t.id FROM runner_transitions t
                   WHERE t.plan_id=p.id AND t.task_id IS NULL AND t.event='PLAN_ACCEPTED'
                   ORDER BY t.id DESC LIMIT 1
                 )
               LEFT JOIN runner_transitions integration
                 ON integration.id=(
                   SELECT t.id FROM runner_transitions t
                   WHERE t.plan_id=p.id AND t.task_id IS NULL AND t.event='INTEGRATION_RECORDED'
                   ORDER BY t.id DESC LIMIT 1
                 )
               WHERE p.project_directory=? AND p.id IN (${placeholders})
               ORDER BY p.id`,
            )
            .all(this.directory, ...batch),
        )
      }
      return result
    })
    return evaluatePrerequisiteIntegration(
      this.directory,
      prerequisites,
      rows,
      gitAsync,
      candidateBaseline,
      this.artifactEvidence,
    )
  }

  async dispatch(plan: PlanRow, node: NodeRow, fence: number, admissionRequestID: string) {
    // Work queued before the project had a config (or before this rule) must not dead-end: the
    // plan's Architect gets the same actionable refusal through the hold path, and the tick
    // releases the hold once a config exists.
    const refused =
      !this.fallowReviewEnabled || hasStoredFallowConfig(this.store.repository)
        ? undefined
        : await this.fallowGate()
    if (refused) {
      this.hold(plan, `FALLOW_CONFIG_REQUIRED: ${refused.missing} ${refused.guidance}`)
      return
    }
    const task = this.store.repository.get(node.task_id)!
    const attempts = this.store.attempts(plan.id).filter((a) => a.task_id === task.id)
    const first = attempts[0]
    const audit = this.store.exactContentConflicts([task.id])
    if (audit.findings.length) {
      this.hold(plan, "Overlap audit changed before dispatch")
      return
    }
    const input = PlanInput.parse(JSON.parse(plan.body))
    if (JSON.parse(plan.body).workspaceMode === undefined && attempts.length)
      input.workspaceMode = attempts.at(-1)!.workspace === this.directory ? "shared" : "isolated"
    const persona = input.nodes.find((candidate) => candidate.taskID === task.id)?.persona
    const configuredImplementor = input.workerModel
      ? null
      : persona
        ? ((await this.host.workerModel?.(workerAgent(input.workerAgent))) ?? null)
        : plan.model
          ? ModelPolicy.parse(JSON.parse(plan.model))
          : null
    const routeDecision =
      persona && input.workerAgent !== "auditor"
        ? this.resolveTaskDispatchRoute(input, task.id, persona, configuredImplementor)
        : undefined
    if (routeDecision?.status === "unavailable") {
      this.hold(plan, `No native worker route is available for the ${persona} persona`)
      return
    }
    const model =
      routeDecision?.status === "resolved"
        ? routeDecision.route
        : plan.model
          ? ModelPolicy.parse(JSON.parse(plan.model))
          : null
    if (!model) {
      this.hold(plan, "Select an implementor model in native OpenCode agent configuration")
      return
    }
    const id = crypto.randomUUID()
    // Isolated work inherits its dependency artifacts. A new shared node
    // starts at the actual reviewed checkout, so intervening integrated repairs
    // are input, not attributed to that worker's write scope.
    const retryRequest = this.store.latestTransition<{
      attemptID?: string
      selectedBaseline?: string | null
    }>(plan.id, task.id, "RETRY_REQUESTED")
    const selectedBaseline =
      retryRequest && retryRequest.attemptID === attempts.at(-1)?.id
        ? retryRequest.selectedBaseline
        : null
    const previousBase = selectedBaseline ?? attempts.at(-1)?.artifact ?? undefined
    const taskPrerequisites = this.taskDependencyIDs(input, node)
    const base =
      previousBase ??
      (input.workspaceMode === "shared" && !taskPrerequisites.length
        ? await gitAsync(this.directory, ["rev-parse", "HEAD"])
        : await this.dependencySource(plan, input, node))
    if (taskPrerequisites.length) {
      const proof = await this.taskDependencyIntegration(plan, input, node, base)
      if (proof.status !== "ready") throw new Error(proof.reason)
      if (proof.baseline !== base)
        throw new Error("The prerequisite baseline changed before dispatch")
    }
    const workspace =
      input.workspaceMode === "shared"
        ? this.directory
        : canonicalProjectWorktreePath(this.directory, id)
    const text = JSON.stringify({
      taskID: task.id,
      revision: task.revision,
      specification: task.proposal,
      source: base,
      previousAttempt: first
        ? { id: attempts.at(-1)!.id, evidence: this.store.detail(plan.id).evidence }
        : null,
    })
    const policy = {
      agent: workerAgent(input.workerAgent),
      workspaceMode: input.workspaceMode,
      model,
      ...(routeDecision ? { routeDecision } : {}),
      ...(persona ? { persona } : {}),
      source: base,
      context: text,
      packet: {
        recipe: "task-tool/1",
        taskID: task.id,
        tool: "lz-get-task",
      },
      budget: null,
      repairAttempt: this.store.atomic(
        (db) =>
          db
            .query<{ event: string }, [string, string]>(
              "SELECT event FROM runner_transitions WHERE plan_id=? AND task_id=? ORDER BY id DESC LIMIT 1",
            )
            .get(plan.id, task.id)?.event === "REPAIR",
      ),
      toolPolicy: "inherit host/user/project; delegation forbidden",
      costEstimate: { status: "unavailable", currency: "USD", kind: "equivalent-api" },
    }
    let attempt!: AttemptRow
    const admitted = this.store.fencedAtomic(this.owner, fence, (db) => {
      const current = this.store.plan(plan.id)
      const currentNode = this.store
        .nodes(plan.id)
        .find((candidate) => candidate.task_id === node.task_id)
      if (
        !current ||
        current.state !== "running" ||
        this.store.effectiveDispatchPause(plan.id) !== undefined ||
        current.revision !== plan.revision ||
        current.body !== plan.body ||
        currentNode?.state !== node.state
      )
        return "stale" as const
      if (
        this.store
          .activeAdoptions()
          .some((adoption) =>
            scopePatternsConflict(
              this.store.effectiveReservationScope(task.id),
              this.store.effectiveReservationScope(adoption.task_id),
            ),
          )
      )
        throw new Error("A pending descendant adoption reserves this task's scope")
      if (!this.delegatedAgentCapacity.admitRunnerInTransaction(db, admissionRequestID, id))
        return "waiting" as const
      if (node.state === "queued") this.store.move(plan.id, task.id, "READY")
      this.store.move(plan.id, task.id, "DISPATCH")
      db.query(
        "INSERT INTO runner_attempts(id,plan_id,task_id,number,session_id,message_id,workspace,base_commit,policy,state,started_at) VALUES(?,?,?,?,?,?,?,?,?,'preparing',?)",
      ).run(
        id,
        plan.id,
        task.id,
        attempts.length + 1,
        sessionID(),
        messageID(),
        workspace,
        base,
        JSON.stringify(policy),
        Date.now(),
      )
      attempt = this.store.attempts(plan.id).find((a) => a.id === id)!
      return "admitted" as const
    })
    if (admitted !== "admitted") {
      if (admitted === "stale")
        await this.delegatedAgentCapacity.cancelRunnerRequest(admissionRequestID)
      return
    }
    const admissionPlan = this.store.plan(plan.id)!
    const admissionOwner = admissionPlan.owner
    this.store.record(plan.id, task.id, "CONTEXT_RESOLVED", {
      attemptID: id,
      packet: policy.packet,
      ...(persona ? { persona } : {}),
    })
    if (input.workspaceMode === "shared") {
      const current = this.store.plan(plan.id)
      if (current?.state !== "running" || current.owner !== admissionOwner) return
      await this.prepareWorker(plan, attempt, fence)
      return
    }
    const effect = this.effect(plan.id, task.id, id, "worktree", { workspace, base }, fence)
    try {
      const actual = await this.host.worktree({ directory: workspace, base })
      if ((await gitAsync(actual, ["rev-parse", "HEAD"])) !== base)
        throw new Error("Host worktree did not use the admitted starting revision")
      this.store.fenced(this.owner, fence, (db) =>
        db.query("UPDATE runner_attempts SET workspace=? WHERE id=?").run(actual, id),
      )
      attempt.workspace = actual
      this.receipt(effect, { workspace: actual, base }, fence)
    } catch (error) {
      this.uncertain(effect, error, fence)
      return
    }
    const current = this.store.plan(plan.id)
    if (current?.state !== "running" || current.owner !== admissionOwner) return
    await this.prepareWorker(plan, attempt, fence)
  }
  /** Resumes must obey the same checkout/scope admission as fresh dispatch. */
  preparationAllowed(attempt: AttemptRow) {
    const scope = this.store.effectiveReservationScope(attempt.task_id)
    if (
      this.store
        .activeAdoptions()
        .some(
          (adoption) =>
            attempt.workspace === this.directory ||
            scopePatternsConflict(scope, this.store.effectiveReservationScope(adoption.task_id)),
        )
    )
      return false
    for (const other of this.store.activeProjectAttempts()) {
      if (other.id === attempt.id || !["preparing", "running", "verifying"].includes(other.state))
        continue
      const promptIntended = this.store
        .effects(other.plan_id)
        .some(
          (effect) =>
            effect.attempt_id === other.id &&
            effect.kind === "prompt" &&
            JSON.parse(effect.payload).messageID === other.message_id &&
            effect.state !== "failed",
        )
      // Stable priority prevents two unsent, conflicting reservations waiting
      // on each other. A prompt that may already be admitted always wins.
      if (
        other.state === "preparing" &&
        !promptIntended &&
        (other.started_at > attempt.started_at ||
          (other.started_at === attempt.started_at && other.id > attempt.id))
      )
        continue
      if (
        attempt.workspace === this.directory ||
        other.workspace === this.directory ||
        scopePatternsConflict(scope, this.store.effectiveReservationScope(other.task_id))
      )
        return false
    }
    return true
  }

  async promptAdmissionAllowed(planID: string, attempt: AttemptRow) {
    const plan = this.store.plan(planID)
    const currentAttempt = this.store
      .attempts(planID)
      .find((candidate) => candidate.id === attempt.id)
    if (
      plan?.state !== "running" ||
      currentAttempt?.state !== "preparing" ||
      !this.preparationAllowed(currentAttempt)
    ) {
      if (currentAttempt)
        await this.delegatedAgentCapacity.cancelRunnerAttemptQueue(currentAttempt.id)
      return false
    }
    const recovery = this.startupRecoveryAuthorization(plan, currentAttempt)
    if (recovery && !this.startupRecoveryAuthorityCurrent(plan, currentAttempt, recovery))
      return false

    const input = PlanInput.parse(JSON.parse(plan.body))
    const taskNode = this.store
      .nodes(planID)
      .find((node) => node.task_id === currentAttempt.task_id)
    if (!taskNode) return false
    const taskPrerequisites = this.taskDependencyIDs(input, taskNode)
    if (taskPrerequisites.length) {
      const proof = await this.taskDependencyIntegration(
        plan,
        input,
        taskNode,
        currentAttempt.base_commit,
      )
      if (proof.status !== "ready" || proof.baseline !== currentAttempt.base_commit) return false
      try {
        const treeHead = await gitAsync(currentAttempt.workspace, ["rev-parse", "HEAD"])
        if (!isCommitID(treeHead) || !isCommitID(currentAttempt.base_commit)) return false
        await gitAsync(currentAttempt.workspace, [
          "merge-base",
          "--is-ancestor",
          currentAttempt.base_commit,
          treeHead,
        ])
        const taskChanges = await changedPaths(currentAttempt.workspace, currentAttempt.base_commit)
        const inputLineage = new Set([currentAttempt.message_id])
        let inputID = currentAttempt.message_id
        const resumes = this.store.atomic((db) =>
          db
            .query<{ payload: string }, [string, string]>(
              `SELECT payload FROM runner_transitions
               WHERE plan_id=? AND task_id=? AND event='ATTEMPT_RESUMED' ORDER BY id DESC`,
            )
            .all(planID, currentAttempt.task_id),
        )
        for (const { payload } of resumes) {
          const resume = JSON.parse(payload) as {
            attemptID?: unknown
            messageID?: unknown
            previousMessageID?: unknown
          }
          if (resume.attemptID !== currentAttempt.id || resume.messageID !== inputID) continue
          if (
            typeof resume.previousMessageID !== "string" ||
            inputLineage.has(resume.previousMessageID)
          )
            break
          inputID = resume.previousMessageID
          inputLineage.add(inputID)
        }
        const admittedPrompt = this.store.effects(planID).some((effect) => {
          if (
            effect.attempt_id !== currentAttempt.id ||
            effect.kind !== "prompt" ||
            effect.state !== "completed"
          )
            return false
          const payload = JSON.parse(effect.payload) as {
            sessionID?: unknown
            workspace?: unknown
            messageID?: unknown
          }
          return (
            payload.sessionID === currentAttempt.session_id &&
            payload.workspace === currentAttempt.workspace &&
            typeof payload.messageID === "string" &&
            inputLineage.has(payload.messageID)
          )
        })
        if ((treeHead !== currentAttempt.base_commit || taskChanges.length > 0) && !admittedPrompt)
          return false
        if (
          protectedPaths(taskChanges, this.store.effectiveScope(currentAttempt.task_id)).length >
            0 ||
          (await gitAsync(currentAttempt.workspace, ["ls-files", "-u", "-z"]))
        )
          return false
      } catch {
        return false
      }
    }

    const prerequisites = input.afterPlans ?? []
    if (!prerequisites.length)
      return this.delegatedAgentCapacity.admitRunnerAttempt(
        {
          planID,
          taskID: currentAttempt.task_id,
          attemptNumber: currentAttempt.number,
        },
        currentAttempt.id,
      )

    try {
      // The reservation base is immutable prerequisite proof. A later HEAD is
      // acceptable only as scoped progress from a prompt already admitted to this attempt.
      const baseline = currentAttempt.base_commit
      const head = await gitAsync(currentAttempt.workspace, ["rev-parse", "HEAD"])
      if (!isCommitID(baseline) || !isCommitID(head)) return false
      const retainedPrompt = this.store.effects(planID).some((effect) => {
        if (
          effect.attempt_id !== currentAttempt.id ||
          effect.kind !== "prompt" ||
          effect.state !== "completed"
        )
          return false
        const payload = JSON.parse(effect.payload) as {
          sessionID?: unknown
          workspace?: unknown
          messageID?: unknown
        }
        return (
          payload.sessionID === currentAttempt.session_id &&
          payload.workspace === currentAttempt.workspace &&
          typeof payload.messageID === "string"
        )
      })
      const changed = await changedPaths(currentAttempt.workspace, baseline)
      if ((head !== baseline || changed.length > 0) && !retainedPrompt) return false
      await gitAsync(currentAttempt.workspace, ["merge-base", "--is-ancestor", baseline, head])
      if (await gitAsync(currentAttempt.workspace, ["ls-files", "-u", "-z"])) return false
      if (protectedPaths(changed, this.store.effectiveScope(currentAttempt.task_id)).length)
        return false
      const eligible =
        (await this.integratedPrerequisiteBaseline(prerequisites, baseline)) === baseline
      return (
        eligible &&
        this.delegatedAgentCapacity.admitRunnerAttempt(
          {
            planID,
            taskID: currentAttempt.task_id,
            attemptNumber: currentAttempt.number,
          },
          currentAttempt.id,
        )
      )
    } catch {
      return false
    }
  }

  observeUsage(attempt: AttemptRow, session: HostSession, fence: number) {
    if (session.staleActive)
      this.store.fenced(this.owner, fence, () =>
        this.store.recordOnce(attempt.plan_id, attempt.task_id, "HOST_ACTIVE_STALE", {
          attemptID: attempt.id,
          sessionID: session.id,
          cause: session.staleActive!.cause,
        }),
      )
    this.store.fenced(this.owner, fence, (db) =>
      db
        .query(
          `UPDATE runner_attempts SET
          token_count=CASE WHEN ? IS NULL THEN token_count ELSE MAX(COALESCE(token_count,?),?) END,
          cost=CASE WHEN ? IS NULL THEN cost ELSE MAX(COALESCE(cost,?),?) END,
          tool_count=MAX(tool_count,?) WHERE id=?`,
        )
        .run(
          session.tokens,
          session.tokens,
          session.tokens,
          session.cost,
          session.cost,
          session.cost,
          session.tools,
          attempt.id,
        ),
    )
  }

  resolveTaskDispatchRoute(
    proposal: PlanInput,
    taskID: string,
    persona: NonNullable<PlanInput["nodes"][number]["persona"]>,
    configuredImplementor: NonNullable<PlanInput["workerModel"]> | null,
  ): DispatchRouteDecision {
    return resolveDispatchRoute({
      schemaVersion: 1,
      persona,
      projectDirectory: this.directory,
      taskID,
      explicitOverride: proposal.workerModel
        ? { source: "explicit-plan-selection", route: proposal.workerModel }
        : null,
      mappingResolution: {
        source: "model-mapping-resolver",
        resolution: this.modelMappingResolver.resolve({ persona, taskID }),
      },
      configuredImplementor: {
        source: "native-implementor-selection",
        route: proposal.workerModel ? null : configuredImplementor,
      },
    })
  }
}
