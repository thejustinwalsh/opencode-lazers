import { existsSync, readFileSync, realpathSync } from "node:fs"
import { dirname, join } from "node:path"
import { fingerprint } from "../identity.ts"
import type { TaskProposal } from "../task.ts"
import {
  artifactExists,
  ArtifactScopeViolation,
  artifactUnchanged,
  changedPaths,
  combineArtifacts,
  commitArtifact,
  git,
  reviewedScopeBase,
  runCheck,
  scopeViolations,
  scopePatternsConflict,
  verificationEnvironmentIdentity,
} from "./artifacts.ts"
import type { CheckReceipt } from "./artifacts.ts"
import type { HostSession, RunnerHost, WorkerInstruction } from "./host.ts"
import {
  ArchitectContinuityInput,
  CommandInput,
  ModelPolicy,
  PlanInput,
  WorkerPersona,
} from "./schema.ts"
import type { CommandInput as PlanCommand } from "./schema.ts"
import type {
  PlanRow,
  NodeRow,
  AttemptRow,
  EffectRow,
  OutboxRow,
  AdoptionRow,
  AdoptionCheckRow,
  ArchitectRenewalRow,
} from "./store.ts"
import { appendOutboxReceipt, RunnerStore } from "./store.ts"
import { outcomeText } from "./outcome.ts"
import { isOwnedOutcomeTranscript, isOwnedQueuedOutcome, parseOutcomeOwnership } from "./inbox.ts"
import type { OutcomeOwnership } from "./inbox.ts"
import type { StartTaskInput, StartTaskResult } from "../tasks/contract.ts"
import { workerPersonaLabels, workerPersonaOverlay } from "../personas/index.ts"
import { ProgressRecorder } from "../progress/recorder.ts"

const terminal = new Set([
  "accepted",
  "failed",
  "cancelled",
  "exhausted",
  "incorporated",
  "integrated",
  "cleanup-blocked",
])
const messageID = () => `msg_${crypto.randomUUID().replaceAll("-", "")}`
const sessionID = () => `ses_${crypto.randomUUID().replaceAll("-", "")}`
const taskStartRequestID = (taskID: string) => `task-start:${taskID}:1`
const isCommitID = (value: unknown): value is string =>
  typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const errorText = (error: unknown) =>
  error instanceof Error ? error.message || String(error) : String(error)
export const DEFAULT_ARCHITECT_IDLE_WINDOW_MS = 30 * 60 * 1000

type PrerequisiteIntegrationRow = {
  plan_id: string
  project_directory: string
  state: string
  artifact: string | null
  accepted_id: number | null
  accepted_version: number | null
  accepted_payload: string | null
  integration_id: number | null
  integration_version: number | null
  integration_payload: string | null
  invalidation_id: number | null
}

export type TaskRuntimeOptions = {
  architectIdleWindowMs?: number
  now?: () => number
  architectPromptHook?: boolean
}

type AdoptionSeed = {
  taskID: string
  taskRevision: number
  attemptID: string
  nodeState: string
  attemptState: string
  oldArtifact: string
  descendantCommit: string
  targetBranch: string
  landingHead: string
  reviewedBaseline: string
  candidateTree: string
  environmentIdentity: string
  inputFingerprint: string
  reason: string
  combinedArtifact: string
}

export function architectIdleWindowMs(value: unknown): number {
  if (value === undefined) return DEFAULT_ARCHITECT_IDLE_WINDOW_MS
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error("architectIdleWindowMs must be a positive integer number of milliseconds")
  return value
}

export class TaskRuntime {
  readonly owner = crypto.randomUUID()
  readonly progress: ProgressRecorder
  private running = false
  private stopped = false
  private readonly idleWaiters: (() => void)[] = []
  private readonly renewalLocks = new Map<string, Promise<void>>()
  private readonly now: () => number
  private readonly architectIdleWindowMs: number
  private readonly architectPromptHook: boolean
  constructor(
    readonly store: RunnerStore,
    readonly host: RunnerHost,
    readonly projectID: string,
    progress?: ProgressRecorder,
    options: TaskRuntimeOptions = {},
  ) {
    this.progress = progress ?? new ProgressRecorder(store, projectID)
    this.now = options.now ?? Date.now
    this.architectIdleWindowMs = architectIdleWindowMs(options.architectIdleWindowMs)
    this.architectPromptHook = options.architectPromptHook ?? false
  }
  get directory() {
    return this.store.repository.projectDirectory
  }
  get dataDirectory() {
    return join(dirname(this.store.repository.path), "runner")
  }

  private adoptionInputFingerprint(input: {
    plan: PlanRow
    originalPlanVersion: number
    taskID: string
    taskRevision: number
    attemptID: string
    nodeState: string
    attemptState: string
    oldArtifact: string
    descendantCommit: string
    targetBranch: string
    landingHead: string
    reviewedBaseline: string
    candidateTree: string
    combinedArtifact: string
    reason: string
    environmentIdentity: string
  }) {
    const task = this.store.repository.get(input.taskID)
    if (!task) throw new Error("Adoption task is missing")
    return fingerprint({
      projectID: this.projectID,
      planID: input.plan.id,
      planRevision: input.plan.revision,
      planVersion: input.originalPlanVersion,
      planBody: input.plan.body,
      owner: input.plan.owner,
      taskID: input.taskID,
      taskRevision: input.taskRevision,
      taskProposal: task.proposal,
      attemptID: input.attemptID,
      nodeState: input.nodeState,
      attemptState: input.attemptState,
      oldArtifact: input.oldArtifact,
      descendantCommit: input.descendantCommit,
      targetBranch: input.targetBranch,
      landingHead: input.landingHead,
      reviewedBaseline: input.reviewedBaseline,
      candidateTree: input.candidateTree,
      combinedArtifact: input.combinedArtifact,
      effectiveWriteScope: this.store.effectiveWriteScope(input.taskID),
      reason: input.reason,
      environmentIdentity: input.environmentIdentity,
    })
  }

  private conflictingActiveAttempt(taskID: string): AttemptRow | undefined {
    const scope = this.store.effectiveWriteScope(taskID)
    return this.store
      .plans()
      .flatMap((candidate) => this.store.attempts(candidate.id))
      .find(
        (attempt) =>
          ["preparing", "running", "verifying"].includes(attempt.state) &&
          (attempt.workspace === this.directory ||
            scopePatternsConflict(scope, this.store.effectiveWriteScope(attempt.task_id))),
      )
  }

  private reviewedAdoptionBaseline(targetBranch: string, oldArtifact: string, candidate: string) {
    const rows = this.store.atomic((db) =>
      db
        .query<{ event: string; payload: string }, [string]>(
          `SELECT t.event,t.payload FROM runner_transitions t
           JOIN runner_plans p ON p.id=t.plan_id
           WHERE p.project_directory=? AND t.event IN ('INTEGRATION_RECORDED','TASK_INTEGRATION_RECORDED')
           ORDER BY t.id`,
        )
        .all(this.directory),
    )
    const firstParent = git(this.directory, ["rev-list", "--first-parent", candidate])
      .split(/\s+/)
      .filter(Boolean)
    const firstParentIndex = new Map(firstParent.map((commit, index) => [commit, index]))
    let baseline = oldArtifact
    let nearest = Number.POSITIVE_INFINITY
    for (const row of rows) {
      let payload: { artifact?: unknown; branch?: unknown; head?: unknown }
      try {
        payload = JSON.parse(row.payload) as typeof payload
      } catch {
        continue
      }
      if (
        payload.branch !== targetBranch ||
        typeof payload.artifact !== "string" ||
        typeof payload.head !== "string" ||
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(payload.artifact) ||
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(payload.head) ||
        payload.head === candidate
      )
        continue
      const position = firstParentIndex.get(payload.head)
      if (position === undefined || position >= nearest) continue
      try {
        git(this.directory, ["merge-base", "--is-ancestor", oldArtifact, payload.head])
        git(this.directory, ["merge-base", "--is-ancestor", payload.artifact, payload.head])
      } catch {
        continue
      }
      baseline = payload.head
      nearest = position
    }
    return baseline
  }

  private adoptionWorkerIdle(attempt: AttemptRow, worker: HostSession): boolean {
    return (
      worker.busy === false &&
      worker.pendingInput !== true &&
      !worker.observationUnstable &&
      (worker.pendingPermissions ?? 0) === 0 &&
      (worker.pendingForms ?? 0) === 0 &&
      Boolean(worker.outcome) &&
      ["completed", "interrupted"].includes(worker.turn?.state ?? "unknown") &&
      !this.backgroundBlockReason(worker, attempt, true)
    )
  }

  private async prepareAdoption(
    plan: PlanRow,
    command: PlanCommand,
    caller: string,
    ownerSession: HostSession | null | undefined,
  ): Promise<AdoptionSeed> {
    if (
      !command.taskID ||
      !command.attemptID ||
      !command.artifact ||
      !command.descendantCommit ||
      !command.targetBranch ||
      !command.reason
    )
      throw new Error(
        "Descendant adoption requires taskID, attemptID, exact old artifact, descendantCommit, targetBranch and reason",
      )
    if (
      caller !== plan.owner ||
      !this.validArchitect(ownerSession) ||
      ownerSession.id !== plan.owner
    )
      throw new Error("Descendant adoption requires the current same-project Architect owner")
    if (plan.state !== "blocked")
      throw new Error("Descendant adoption is only available for a blocked, non-finalized plan")
    if (this.store.activeAdoptions(plan.id).length)
      throw new Error("A descendant adoption is already pending for this plan")
    if (
      this.store.effects(plan.id).some((effect) => ["intended", "uncertain"].includes(effect.state))
    )
      throw new Error("Uncertain effects must be resolved before descendant adoption")

    const input = PlanInput.parse(JSON.parse(plan.body))
    const node = this.store.nodes(plan.id).find((item) => item.task_id === command.taskID)
    const task = this.store.repository.get(command.taskID)
    const attempts = this.store
      .attempts(plan.id)
      .filter((attempt) => attempt.task_id === command.taskID)
    const latest = attempts.at(-1)
    if (!node || !task || !latest || latest.id !== command.attemptID)
      throw new Error("Descendant adoption must name the exact latest task attempt")
    if (
      task.revision !== 1 ||
      task.revision !== input.nodes.find((entry) => entry.taskID === task.id)?.revision
    )
      throw new Error("Task revision changed since plan admission")
    if (
      !["ready", "failed", "accepted"].includes(node.state) ||
      (node.state === "accepted" && latest.state !== "accepted") ||
      (node.state !== "accepted" && latest.state !== "failed")
    )
      throw new Error("Adoption requires the latest failed attempt or its accepted task result")
    if (
      !latest.artifact ||
      node.artifact !== latest.artifact ||
      command.artifact !== latest.artifact
    )
      throw new Error("Old artifact does not match the exact latest attempt and task result")
    if (
      this.store
        .nodes(plan.id)
        .some(
          (candidate) =>
            candidate.task_id !== command.taskID &&
            !["accepted", "incorporated"].includes(candidate.state),
        )
    )
      throw new Error("All other plan tasks must be accepted before adopting a descendant")

    if (this.conflictingActiveAttempt(command.taskID))
      throw new Error("A conflicting worker prevents descendant adoption")
    const scopes = this.store.effectiveWriteScope(command.taskID)
    if (
      this.store
        .activeAdoptions()
        .some((adoption) =>
          scopePatternsConflict(scopes, this.store.effectiveWriteScope(adoption.task_id)),
        )
    )
      throw new Error("An active descendant reservation conflicts with this task scope")

    const worker = await this.host.session(latest.session_id, { messages: true })
    if (
      !worker ||
      worker.id !== latest.session_id ||
      worker.projectID !== this.projectID ||
      worker.directory !== latest.workspace ||
      worker.agent !== "lazers-implementor" ||
      worker.archived ||
      worker.metadata?.lazersAttemptID !== latest.id
    )
      throw new Error("Latest worker session is not the owned attempt")
    if (!this.adoptionWorkerIdle(latest, worker))
      throw new Error("Latest worker activity or control state is not conclusively idle")

    const branch = git(this.directory, ["branch", "--show-current"])
    const head = git(this.directory, ["rev-parse", "HEAD"])
    if (branch !== command.targetBranch || command.descendantCommit !== head)
      throw new Error("Reviewed descendant must be the exact current HEAD of targetBranch")
    if (
      git(this.directory, ["status", "--porcelain", "--untracked-files=all"]) ||
      git(this.directory, ["ls-files", "-u", "-z"])
    )
      throw new Error("Dirty or unmerged candidate checkout cannot be adopted")
    const oldArtifact = git(this.directory, ["rev-parse", `${command.artifact}^{commit}`])
    const descendantCommit = git(this.directory, [
      "rev-parse",
      `${command.descendantCommit}^{commit}`,
    ])
    if (oldArtifact !== command.artifact || descendantCommit !== command.descendantCommit)
      throw new Error("Adoption artifacts must be exact full commit identities")
    if (oldArtifact === descendantCommit)
      throw new Error("Reviewed candidate must be a strict descendant of the old artifact")
    git(this.directory, ["merge-base", "--is-ancestor", oldArtifact, descendantCommit])
    const reviewedBaseline = this.reviewedAdoptionBaseline(branch, oldArtifact, descendantCommit)
    const scopeBase = reviewedScopeBase(
      this.directory,
      oldArtifact,
      descendantCommit,
      reviewedBaseline,
    )
    const violations = scopeViolations(changedPaths(this.directory, scopeBase), scopes)
    if (violations.length)
      throw new Error(
        `Descendant contains changes outside the task's authorized scope: ${violations.slice(0, 20).join(", ")}`,
      )
    const candidateTree = git(this.directory, ["rev-parse", `${descendantCommit}^{tree}`])
    const branches = input.integrationOrder.map((taskID) => {
      if (taskID === command.taskID) return descendantCommit
      const other = this.store.nodes(plan.id).find((candidate) => candidate.task_id === taskID)
      if (!other?.artifact || !["accepted", "incorporated"].includes(other.state))
        throw new Error("Combined adoption requires every other task's accepted artifact")
      return other.artifact
    })
    const combinedArtifact = combineArtifacts(this.directory, input.baseCommit, branches)
    const seed = {
      taskID: task.id,
      taskRevision: task.revision,
      attemptID: latest.id,
      nodeState: node.state,
      attemptState: latest.state,
      oldArtifact,
      descendantCommit,
      targetBranch: branch,
      landingHead: head,
      reviewedBaseline,
      candidateTree,
      combinedArtifact,
      reason: command.reason,
    }
    const environmentIdentity = verificationEnvironmentIdentity()
    return {
      ...seed,
      environmentIdentity,
      inputFingerprint: this.adoptionInputFingerprint({
        plan,
        originalPlanVersion: plan.version,
        ...seed,
        environmentIdentity,
      }),
    }
  }

  async command(input: unknown, caller: string): Promise<unknown> {
    const command = CommandInput.parse(input)
    const prior = this.store.priorCommand<unknown>(command.requestID, { command, caller })
    if (prior !== undefined) return prior
    // Resolve host facts before the transaction, then recheck durable versions within it.
    const old = this.store.plan(command.planID)
    if (!old) throw new Error("Plan not found")
    // Reject stale/foreign requests before any asynchronous owner recovery effect.
    // Receipts above remain bound to the ORIGINAL command and caller, even when
    // a valid owner is durably continued to a different native session.
    if (old.version !== command.expectedVersion)
      throw new Error(`Stale plan version; current ${old.version}`)
    if (caller !== old.owner && !["audit", "reassign"].includes(command.action))
      throw new Error("Only the plan owner may change execution")
    let continuedOwner: string | undefined
    const configuredWorker =
      command.action === "run" && !JSON.parse(old.body).workerModel
        ? await this.host.workerModel?.()
        : undefined
    const target = command.action === "reassign" ? command.targetSessionID : old.owner
    let ownerSession: HostSession | null | undefined
    if (
      ["run", "reassign", "reconcile", "resume", "retry", "adopt-descendant"].includes(
        command.action,
      )
    ) {
      if (!target) throw new Error("Target session required")
      ownerSession = await this.host.session(target)
    }
    if (command.action === "run" && !this.validArchitect(ownerSession)) {
      ownerSession = await this.ensureArchitectOwner(old, ownerSession, false)
      continuedOwner = ownerSession.id
    }
    const adoptionSeed =
      command.action === "adopt-descendant"
        ? await this.prepareAdoption(old, command, caller, ownerSession)
        : undefined
    const result = this.store.command(command.requestID, { command, caller }, (db) => {
      const plan = this.store.plan(command.planID)!
      if (plan.version !== command.expectedVersion)
        throw new Error(`Stale plan version; current ${plan.version}`)
      if (caller !== plan.owner && !["audit", "reassign"].includes(command.action))
        throw new Error("Only the plan owner may change execution")
      // Commit owner adoption with the original request receipt. If native
      // creation succeeds but this command fails, exact replay can recover it
      // without granting an old owner authority over a reassigned plan.
      if (continuedOwner) this.store.updatePlanOwner(plan.id, plan.owner, continuedOwner)
      const activeAdoptions = this.store.activeAdoptions(plan.id)
      if (
        activeAdoptions.length &&
        !["adopt-descendant", "human-evidence", "cancel", "audit"].includes(command.action)
      )
        throw new Error(
          "A descendant adoption is pending; only its evidence or cancellation is allowed",
        )
      if (command.action === "amend-scope") {
        if (!command.taskID || !command.scopeAdditions?.length || !command.reason)
          throw new Error("Scope amendment requires task, added paths and reason")
        const node = this.store.nodes(plan.id).find((item) => item.task_id === command.taskID)
        if (!node || terminal.has(plan.state) || ["accepted", "incorporated"].includes(node.state))
          throw new Error("Scope amendment requires unfinished work in this plan")
        const previous = this.store.effectiveWriteScope(node.task_id)
        const writeScope = [...new Set([...previous, ...command.scopeAdditions])]
        if (writeScope.length > 100) throw new Error("Effective write scope exceeds 100 paths")
        const additions = writeScope.filter((path) => !previous.includes(path))
        if (!additions.length) return { status: "scope-unchanged", version: plan.version }
        const active = ["preparing", "running", "verifying"]
        if (
          this.store
            .attempts(plan.id)
            .some((a) => a.task_id === node.task_id && active.includes(a.state))
        ) {
          for (const otherPlan of this.store.plans())
            for (const other of this.store.attempts(otherPlan.id))
              if (
                other.task_id !== node.task_id &&
                active.includes(other.state) &&
                scopePatternsConflict(writeScope, this.store.effectiveWriteScope(other.task_id))
              )
                throw new Error(`Scope amendment conflicts with active task ${other.task_id}`)
        }
        this.store.record(plan.id, node.task_id, "SCOPE_AMENDED", {
          additions,
          writeScope,
          reason: command.reason,
          caller,
          taskRevision: this.store.repository.get(node.task_id)!.revision,
        })
        const instructionUpdates: string[] = []
        for (const attempt of this.store
          .attempts(plan.id)
          .filter(
            (item) =>
              item.task_id === node.task_id &&
              (["running", "verifying"].includes(item.state) ||
                (item.state === "preparing" &&
                  this.store
                    .effects(plan.id)
                    .some(
                      (effect) =>
                        effect.attempt_id === item.id &&
                        effect.kind === "prompt" &&
                        effect.state !== "failed",
                    ))),
          )) {
          const payload: WorkerInstruction = {
            sessionID: attempt.session_id,
            attemptID: attempt.id,
            projectID: this.projectID,
            directory: attempt.workspace,
            key: `lazers-scope-${attempt.id}-${fingerprint(writeScope)}`,
            text: `Architect-authorized additive execution scope for task ${node.task_id}, revision 1, attempt ${attempt.id}. The immutable specification is unchanged.\nAdded paths: ${JSON.stringify(additions)}\nAuthorized cumulative write scope: ${JSON.stringify(writeScope)}\nReason: ${command.reason}\nContinue in this same assigned workspace; preserve legitimate dependency/test changes. All original acceptance and verification requirements still apply. This is authorization, not evidence of acceptance.`,
          }
          const kind = "scope-instruction"
          const id = fingerprint({
            planID: plan.id,
            taskID: node.task_id,
            attemptID: attempt.id,
            kind,
            payload,
          })
          // Command authorization and native-update intent commit atomically.
          // The fenced runtime owns delivery and recovery, including lost replies.
          db.query("INSERT INTO runner_effects VALUES(?,?,?,?,?,'intended',?,NULL,0)").run(
            id,
            plan.id,
            node.task_id,
            attempt.id,
            kind,
            JSON.stringify(payload),
          )
          this.store.record(plan.id, node.task_id, "EFFECT_INTENDED", {
            effectID: id,
            kind,
            attemptID: attempt.id,
          })
          instructionUpdates.push(id)
        }
        db.query("UPDATE runner_plans SET version=version+1 WHERE id=?").run(plan.id)
        return {
          status: "scope-amended",
          version: plan.version + 1,
          writeScope,
          instructionUpdates,
        }
      }
      if (command.action === "adopt-descendant") {
        if (!adoptionSeed || !ownerSession || !this.validArchitect(ownerSession))
          throw new Error("Descendant adoption requires the current same-project Architect owner")
        if (ownerSession.id !== plan.owner || caller !== plan.owner)
          throw new Error("Descendant adoption owner changed")
        const adoptionID = crypto.randomUUID()
        const adoption = this.store.createAdoption({
          id: adoptionID,
          planID: plan.id,
          taskID: adoptionSeed.taskID,
          writeScope: this.store.effectiveWriteScope(adoptionSeed.taskID),
          requestID: command.requestID,
          owner: plan.owner,
          expectedVersion: plan.version,
          taskRevision: adoptionSeed.taskRevision,
          attemptID: adoptionSeed.attemptID,
          nodeState: adoptionSeed.nodeState,
          attemptState: adoptionSeed.attemptState,
          oldArtifact: adoptionSeed.oldArtifact,
          descendantCommit: adoptionSeed.descendantCommit,
          targetBranch: adoptionSeed.targetBranch,
          landingHead: adoptionSeed.landingHead,
          reviewedBaseline: adoptionSeed.reviewedBaseline,
          candidateTree: adoptionSeed.candidateTree,
          inputFingerprint: adoptionSeed.inputFingerprint,
          environmentIdentity: adoptionSeed.environmentIdentity,
          reason: adoptionSeed.reason,
          combinedArtifact: adoptionSeed.combinedArtifact,
        })
        return {
          status: "descendant-adoption-requested",
          adoptionID: adoption.id,
          taskID: adoption.task_id,
          artifact: adoption.descendant_commit,
          combinedArtifact: adoption.combined_artifact,
          version: plan.version + 1,
        }
      }
      if (command.action === "integrated") {
        if (command.taskID) {
          const node = this.store.nodes(plan.id).find((item) => item.task_id === command.taskID)
          if (node?.state !== "accepted" || !node.artifact)
            throw new Error("Only an accepted task result can be recorded as integrated")
          if (command.artifact !== node.artifact || !command.targetBranch || !command.reason)
            throw new Error("Record the accepted task artifact, reviewed targetBranch and reason")
          if (git(this.directory, ["branch", "--show-current"]) !== command.targetBranch)
            throw new Error("The current checkout is not the reviewed target branch")
          git(this.directory, ["merge-base", "--is-ancestor", node.artifact, "HEAD"])
          const head = git(this.directory, ["rev-parse", "HEAD"])
          this.store.record(plan.id, node.task_id, "TASK_INTEGRATION_RECORDED", {
            artifact: node.artifact,
            branch: command.targetBranch,
            head,
            reason: command.reason,
          })
          db.query("UPDATE runner_plans SET version=version+1 WHERE id=?").run(plan.id)
          // A task source landing is not combined acceptance. Keep its artifact
          // and workspace available to dependencies until normal plan cleanup.
          return { status: "task-integration-recorded", version: plan.version + 1, head }
        }
        if (!["accepted", "cleanup-blocked"].includes(plan.state) || !plan.artifact)
          throw new Error("Only an accepted result can be integrated")
        if (command.artifact !== plan.artifact || !command.targetBranch || !command.reason)
          throw new Error("Record the accepted artifact, reviewed targetBranch and reason")
        if (git(this.directory, ["branch", "--show-current"]) !== command.targetBranch)
          throw new Error("The current checkout is not the reviewed target branch")
        git(this.directory, ["merge-base", "--is-ancestor", plan.artifact, "HEAD"])
        this.store.record(plan.id, null, "INTEGRATION_RECORDED", {
          artifact: plan.artifact,
          branch: command.targetBranch,
          head: git(this.directory, ["rev-parse", "HEAD"]),
          reason: command.reason,
        })
        db.query(
          "UPDATE runner_plans SET state='cleaning',reason=NULL,version=version+1 WHERE id=?",
        ).run(plan.id)
        return { status: "cleanup-requested", version: this.store.plan(plan.id)!.version }
      }
      if (command.action === "schedule") {
        if (terminal.has(plan.state) || plan.state === "cancelling" || plan.state === "cleaning")
          throw new Error("Plan has ended")
        if (!command.reason) throw new Error("Scheduling changes require a reason")
        const attempts = this.store.attempts(plan.id)
        if (
          attempts.length &&
          (command.afterPlans !== undefined ||
            command.baseCommit !== undefined ||
            command.workspaceMode !== undefined)
        )
          throw new Error("Only priority may change after execution has started")
        const updated = PlanInput.parse({
          ...JSON.parse(plan.body),
          ...(command.priority !== undefined ? { priority: command.priority } : {}),
          ...(command.afterPlans !== undefined ? { afterPlans: command.afterPlans } : {}),
          ...(command.baseCommit !== undefined ? { baseCommit: command.baseCommit } : {}),
          ...(command.workspaceMode !== undefined ? { workspaceMode: command.workspaceMode } : {}),
        })
        this.store.validatePlanDependencies(updated.afterPlans ?? [], plan.id)
        if (command.baseCommit)
          git(this.directory, ["merge-base", "--is-ancestor", command.baseCommit, "HEAD"])
        this.store.revisePlan(plan, updated, "SCHEDULE_UPDATED", {
          caller,
          reason: command.reason,
          priority: updated.priority ?? 0,
          afterPlans: updated.afterPlans ?? [],
          baseCommit: updated.baseCommit,
        })
        return { status: "scheduled", version: this.store.plan(plan.id)!.version }
      }
      if (command.action === "audit")
        return { status: "audited", ...this.store.audit(), version: plan.version }
      if (command.action === "reassign") {
        if (!ownerSession || ownerSession.archived || ownerSession.projectID !== this.projectID)
          throw new Error("Reassignment needs an unarchived same-project owner")
        const retiredSource = db
          .query<{ present: number }, [string, string, string]>(
            `SELECT 1 AS present FROM runner_architect_renewals r
             JOIN runner_architect_renewal_plans rp ON rp.renewal_id=r.id
             WHERE r.previous_session_id=? AND rp.plan_id=? AND rp.transferred=1
               AND EXISTS(SELECT 1 FROM runner_plans current WHERE current.id=rp.plan_id AND current.owner<>?)
             LIMIT 1`,
          )
          .get(caller, plan.id, caller)
        if (caller !== plan.owner && retiredSource)
          throw new Error("A retired Architect predecessor cannot reassign a transferred plan")
        db.query("UPDATE runner_plans SET owner=?,version=version+1 WHERE id=?").run(
          ownerSession.id,
          plan.id,
        )
        this.store.record(plan.id, null, "OWNER_REASSIGNED", {
          from: plan.owner,
          to: ownerSession.id,
          reason: command.reason,
        })
        return { status: "reassigned", version: plan.version + 1 }
      }
      if (command.action === "cancel") {
        if (terminal.has(plan.state)) throw new Error("Plan has ended")
        this.store.cancelAdoptions(plan.id, "Cancellation requested")
        // Stop admission now. In-flight work remains running until interruption is proven.
        db.query(
          "UPDATE runner_plans SET state='cancelling',reason='Cancellation requested',version=version+1 WHERE id=?",
        ).run(plan.id)
        for (const node of this.store.nodes(plan.id))
          if (!terminal.has(node.state) && node.state !== "running" && node.state !== "verifying")
            this.store.move(plan.id, node.task_id, "CANCEL")
        this.store.record(plan.id, null, "CANCEL_REQUESTED", { caller })
        return { status: "cancelling", version: this.store.plan(plan.id)!.version }
      }
      if (command.action === "human-evidence") {
        if (!command.assertionID || !command.artifact || !command.reason)
          throw new Error("Human evidence requires assertion, exact artifact and decision")
        if (command.adoptionID) {
          const adoption = this.store.adoption(command.adoptionID)
          if (
            !adoption ||
            adoption.plan_id !== plan.id ||
            adoption.owner !== caller ||
            !["pending", "task-checks", "combined-checks", "waiting-human"].includes(adoption.state)
          )
            throw new Error("Human evidence must name a current pending descendant adoption")
          const taskEvidence = command.taskID === adoption.task_id
          if (command.taskID && !taskEvidence)
            throw new Error("Adoption task evidence must name its exact task")
          const assertions = taskEvidence
            ? (this.store.repository.get(adoption.task_id)?.proposal.acceptance ?? [])
            : PlanInput.parse(JSON.parse(plan.body)).acceptance
          const artifact = taskEvidence ? adoption.descendant_commit : adoption.combined_artifact
          const assertion = assertions.find((item) => item.id === command.assertionID)
          if (command.artifact !== artifact || !assertion?.evidence.some((e) => e.kind === "human"))
            throw new Error("Human evidence does not bind to the adoption assertion/artifact")
          this.store.recordAdoptionEvidence({
            id: crypto.randomUUID(),
            adoptionID: adoption.id,
            taskID: taskEvidence ? adoption.task_id : null,
            phase: taskEvidence ? "task" : "combined",
            assertionID: assertion.id,
            artifact,
            body: { decision: command.reason, caller },
          })
          this.store.record(plan.id, command.taskID ?? null, "DESCENDANT_ADOPTION_HUMAN_EVIDENCE", {
            adoptionID: adoption.id,
            assertionID: assertion.id,
            artifact,
          })
          return { status: "recorded", version: this.store.plan(plan.id)!.version }
        }
        const nodes = this.store.nodes(plan.id)
        let assertions: TaskProposal["acceptance"]
        let artifact: string | null
        if (command.taskID) {
          artifact = nodes.find((node) => node.task_id === command.taskID)?.artifact ?? null
          assertions = this.store.repository.get(command.taskID)?.proposal.acceptance ?? []
        } else {
          const input = PlanInput.parse(JSON.parse(plan.body))
          const ordered = input.integrationOrder.map((id) =>
            nodes.find((node) => node.task_id === id),
          )
          if (ordered.some((node) => node?.state !== "accepted" || !node.artifact))
            throw new Error("Plan evidence requires all accepted task artifacts")
          artifact = combineArtifacts(
            this.directory,
            input.baseCommit,
            ordered.map((node) => node!.artifact!),
          )
          assertions = input.acceptance
        }
        const assertion = assertions.find((item) => item.id === command.assertionID)
        if (artifact !== command.artifact || !assertion?.evidence.some((e) => e.kind === "human"))
          throw new Error("Human evidence does not bind to the current assertion/artifact")
        db.query("INSERT INTO runner_evidence VALUES(?,?,?,?,?,'human',?,?,?)").run(
          crypto.randomUUID(),
          plan.id,
          command.taskID ?? null,
          null,
          assertion.id,
          command.artifact,
          JSON.stringify({ decision: command.reason, caller }),
          Date.now(),
        )
        this.store.record(plan.id, command.taskID ?? null, "HUMAN_EVIDENCE", {
          assertionID: assertion.id,
          artifact: command.artifact,
        })
        return { status: "recorded", version: this.store.plan(plan.id)!.version }
      }
      if (command.action === "resume" || command.action === "retry") {
        const retry = command.action === "retry"
        if (!ownerSession || ownerSession.archived) throw new Error("Owner unavailable")
        if (!command.taskID || !command.reason) throw new Error("Resume requires taskID and reason")
        const node = this.store.nodes(plan.id).find((n) => n.task_id === command.taskID)
        const attempt = this.store
          .attempts(plan.id)
          .filter((a) => a.task_id === command.taskID)
          .at(-1)
        if (retry && node?.state === "cancelled" && !attempt) {
          if (
            !["blocked", "cancelled", "failed", "running"].includes(plan.state) ||
            !plan.model ||
            plan.artifact !== null
          )
            throw new Error("Only an admitted, nonintegrated plan can requeue an unstarted task")
          if (ownerSession.id !== plan.owner || ownerSession.projectID !== this.projectID)
            throw new Error("Foreign owner session")
          if (
            this.store
              .effects(plan.id)
              .some((effect) => ["intended", "uncertain"].includes(effect.state))
          )
            throw new Error("Reconcile uncertain effects first")

          this.store.move(plan.id, node.task_id, "RETRY", command.reason)
          if (plan.state !== "running")
            db.query(
              "UPDATE runner_plans SET state='running',reason=NULL,version=version+1 WHERE id=?",
            ).run(plan.id)
          this.store.record(plan.id, node.task_id, "UNSTARTED_TASK_REQUEUED", {
            caller,
            reason: command.reason,
          })
          return { status: "requeued", version: this.store.plan(plan.id)!.version }
        }
        if (
          !["blocked", "cancelled", "failed"].includes(plan.state) ||
          !node ||
          !["exhausted", "cancelled", "running", "failed", "blocked"].includes(node.state) ||
          !attempt ||
          !["exhausted", "cancelled", "preparing", "failed"].includes(attempt.state)
        )
          throw new Error("Only an exhausted or cancelled, stopped attempt can resume")
        if (
          this.store
            .effects(plan.id)
            .some((effect) => ["intended", "uncertain"].includes(effect.state))
        )
          throw new Error("Reconcile uncertain effects first")
        if (retry) this.store.move(plan.id, node.task_id, "RETRY", command.reason)
        else if (node.state !== "running")
          this.store.move(plan.id, node.task_id, "RESUME", command.reason)
        const planInput = PlanInput.parse(JSON.parse(plan.body))
        const sharedMode =
          command.workspaceMode === "shared" ||
          (command.workspaceMode === undefined && planInput.workspaceMode === "shared")
        let selectedBaseline: string | null = null
        if (
          command.workspaceMode === "shared" ||
          (retry && sharedMode && command.baseCommit !== undefined)
        ) {
          const source = command.baseCommit ?? git(this.directory, ["rev-parse", "HEAD"])
          git(this.directory, ["merge-base", "--is-ancestor", source, "HEAD"])
          if (!retry)
            db.query("UPDATE runner_attempts SET workspace=?,base_commit=? WHERE id=?").run(
              this.directory,
              source,
              attempt.id,
            )
          const revised = PlanInput.parse({
            ...JSON.parse(plan.body),
            workspaceMode: "shared",
            baseCommit: source,
          })
          db.query("UPDATE runner_plans SET body=?,revision=revision+1 WHERE id=?").run(
            JSON.stringify(revised),
            plan.id,
          )
          db.query("INSERT INTO runner_plan_revisions VALUES(?,?,?,?,?)").run(
            plan.id,
            plan.revision + 1,
            JSON.stringify(revised),
            plan.owner,
            Date.now(),
          )
          this.store.record(plan.id, node.task_id, "WORKSPACE_SELECTED", {
            attemptID: attempt.id,
            from: attempt.workspace,
            directory: this.directory,
            source,
            explicitBaseline: retry && command.baseCommit !== undefined,
            mode: "shared",
            reason: command.reason,
          })
          if (retry && command.baseCommit !== undefined) selectedBaseline = source
        }
        if (retry)
          db.query(
            "UPDATE runner_attempts SET state='cancelled' WHERE id=? AND state='preparing'",
          ).run(attempt.id)
        else
          db.query("UPDATE runner_attempts SET state='preparing',message_id=? WHERE id=?").run(
            messageID(),
            attempt.id,
          )
        db.query(
          "UPDATE runner_plans SET state='running',reason=NULL,version=version+1 WHERE id=?",
        ).run(plan.id)
        this.store.record(plan.id, node.task_id, retry ? "RETRY_REQUESTED" : "ATTEMPT_RESUMED", {
          attemptID: attempt.id,
          reason: command.reason,
          usageRetained: true,
          budget: null,
          ...(retry ? { selectedBaseline } : {}),
        })
        return {
          status: retry ? "retrying" : "resuming",
          version: this.store.plan(plan.id)!.version,
        }
      }
      if (command.action === "reconcile") {
        if (!ownerSession || ownerSession.archived) throw new Error("Owner unavailable")
        if (this.store.effects(plan.id).some((e) => ["intended", "uncertain"].includes(e.state)))
          return {
            status: "blocked",
            reason: "Uncertain effects require conclusive host/artifact evidence",
            version: plan.version,
          }
        if (plan.state === "blocked") {
          db.query(
            "UPDATE runner_plans SET state='running',reason=NULL,version=version+1 WHERE id=?",
          ).run(plan.id)
          for (const node of this.store.nodes(plan.id))
            if (
              node.state === "blocked" &&
              !this.store.attempts(plan.id).some((a) => a.task_id === node.task_id)
            )
              this.store.move(plan.id, node.task_id, "RECONCILE")
        }
        this.store.record(plan.id, null, "RECONCILE_REQUESTED", {
          caller,
          verificationEpoch: this.store.plan(plan.id)!.version,
        })
        return { status: "reconciling", version: this.store.plan(plan.id)!.version }
      }
      if (plan.state !== "draft" && plan.state !== "blocked")
        throw new Error("Execution already requested or ended")
      if (this.store.attempts(plan.id).length)
        throw new Error(
          "Existing execution must be reconciled; admission cannot replace its policy",
        )
      if (!ownerSession || ownerSession.archived)
        return this.hold(plan, "Owner is missing or archived")
      if (ownerSession.projectID !== this.projectID) throw new Error("Foreign owner session")
      if (command.action === "run" && ownerSession.agent !== "architect")
        throw new Error("Only an Architect session can own execution")
      const proposal = PlanInput.parse(JSON.parse(plan.body))
      const selectedModel = proposal.workerModel ?? configuredWorker
      if (!selectedModel)
        return this.hold(plan, "Select an implementor model in native OpenCode agent configuration")
      const model = ModelPolicy.parse(selectedModel)
      try {
        if (
          git(this.directory, ["rev-parse", `${proposal.baseCommit}^{commit}`]) !==
          proposal.baseCommit
        )
          throw new Error("Base mismatch")
      } catch (error) {
        return this.hold(plan, `Unavailable committed source baseline: ${errorText(error)}`)
      }
      const audit = this.store.audit()
      const ids = new Set(proposal.nodes.map((n) => n.taskID))
      const conflicts = audit.findings.filter(
        (f) => f.code === "exact-content" && f.taskIDs.some((id) => ids.has(id)),
      )
      if (conflicts.length)
        return this.hold(
          plan,
          `Unresolved overlap findings: ${conflicts.map((f) => f.id).join(", ")}`,
        )
      db.query(
        "UPDATE runner_plans SET state='running',model=?,reason=NULL,version=version+1 WHERE id=?",
      ).run(JSON.stringify(model), plan.id)
      this.store.record(plan.id, null, "ADMITTED", {
        model,
        modelSource: proposal.workerModel ? "explicit-plan-selection" : "native-agent-selection",
        auditWatermark: audit.watermark,
        source: proposal.baseCommit,
        enforcement: {
          budget: "unconfigured; historical proposed limits are not execution policy",
          tokens: "measured usage only",
          cost: "API-equivalent price unavailable until resolved; never treated as zero",
          tools: "measured usage only",
          repairs: "one bounded verification repair by default",
        },
      })
      return { status: "running", planID: plan.id, version: this.store.plan(plan.id)!.version }
    })
    return result
  }

  async startTask(input: StartTaskInput): Promise<StartTaskResult> {
    const actor = await this.host.session(input.sessionID)
    if (!actor || actor.archived || actor.projectID !== this.projectID)
      throw new Error("Start requires a live session in this project")

    const task = this.store.repository.get(input.taskID)
    if (
      !task ||
      task.provenance.projectDirectory !== this.directory ||
      task.provenance.projectID !== this.projectID
    )
      throw new Error("Task is not available in this project")
    if (task.revision !== input.revision) throw new Error("Stale task revision")
    if (this.store.repository.taskDisposition(task.id))
      throw new Error("Task has been retired; inspect its disposition")

    let existing = this.store.execution(task.id)
    // Read the native implementor selection, not the Architect's model. A plan
    // already carrying an explicit route keeps that route unchanged.
    let workerModel: ModelPolicy | undefined
    if (!existing) {
      workerModel = await this.host.workerModel?.()
      existing = this.store.execution(task.id)
      if (!existing && !workerModel)
        throw new Error("Select an implementor model in native OpenCode agent configuration")
    }
    let plan: PlanRow
    let created = false
    if (existing) {
      plan = this.store.plan(existing.planID)!
      if (plan.state !== "draft" || !["queued", "ready"].includes(existing.state)) {
        if (plan.state === "running" && ["queued", "ready"].includes(existing.state))
          await this.tick()
        return { status: "existing", planID: plan.id, state: this.store.execution(task.id)!.state }
      }
    } else {
      if (task.status !== "submitted") throw new Error("Task cannot be started")
      if (task.provenance.startingRevision.kind !== "git")
        throw new Error("Task has no committed starting revision")
      const proposal = task.proposal
      const receipt = this.store.submit(
        {
          requestID: taskStartRequestID(task.id),
          objective: proposal.objective,
          baseCommit: task.provenance.startingRevision.commit,
          workspaceMode: "shared",
          workerModel,
          nodes: [{ taskID: task.id, revision: task.revision }],
          dependencies: [],
          integrationOrder: [task.id],
          verification: proposal.verification,
          acceptance: proposal.acceptance,
          dispositions: [],
        },
        task.provenance.sessionID,
      )
      plan = this.store.plan(receipt.planID)!
      created = true
    }

    if (plan.state === "draft")
      await this.command(
        {
          requestID: `task-start-run:${task.id}:1`,
          planID: plan.id,
          expectedVersion: plan.version,
          action: "run",
        },
        plan.owner,
      )
    await this.tick()
    const execution = this.store.execution(task.id)
    if (!execution) throw new Error("Runtime did not record task execution")
    return {
      status: created ? "started" : "existing",
      planID: execution.planID,
      state: execution.state,
    }
  }

  private taskStartID(plan: PlanRow): string | undefined {
    try {
      const body = PlanInput.parse(JSON.parse(plan.body))
      const taskID = body.nodes.length === 1 ? body.nodes[0]?.taskID : undefined
      return taskID && body.requestID === taskStartRequestID(taskID) ? taskID : undefined
    } catch {
      return undefined
    }
  }

  private validArchitect(session: HostSession | null | undefined): session is HostSession {
    return Boolean(
      session &&
      !session.archived &&
      session.agent === "architect" &&
      session.projectID === this.projectID,
    )
  }

  private async ensureArchitectOwner(
    plan: PlanRow,
    previous: HostSession | null | undefined,
    adopt = true,
  ): Promise<HostSession> {
    const current = await this.host.session(plan.owner)
    if (this.validArchitect(current)) return current

    let continuation = this.store.continuation(plan.id)
    let priorContinuation: HostSession | null = null
    if (continuation) {
      priorContinuation = await this.host.session(continuation.session_id)
      if (
        this.validArchitect(priorContinuation) &&
        this.matchesContinuation(priorContinuation, plan.id)
      ) {
        if (adopt) this.store.updatePlanOwner(plan.id, plan.owner, priorContinuation.id)
        return priorContinuation
      }
    }

    let next:
      | { session_id: string; parent_id: string | null; directory: string; model: string | null }
      | undefined
    if (!continuation || priorContinuation) {
      const source = previous?.projectID === this.projectID ? previous : current
      const parentID =
        source?.projectID === this.projectID && source.directory === this.directory
          ? source.id
          : null
      const model = source?.projectID === this.projectID ? source.model : undefined
      next = {
        session_id: sessionID(),
        parent_id: parentID,
        directory: this.directory,
        model: model ? JSON.stringify(model) : (continuation?.model ?? null),
      }
      continuation = continuation
        ? this.store.replaceContinuation(plan.id, continuation.session_id, next)
        : this.store.ensureContinuation(plan.id, next)
    }

    // A concurrent scheduler may already have selected a different stable ID.
    if (next && continuation.session_id !== next.session_id && continuation.generation > 1) {
      const adopted = await this.host.session(continuation.session_id)
      if (this.validArchitect(adopted) && this.matchesContinuation(adopted, plan.id)) {
        if (adopt) this.store.updatePlanOwner(plan.id, plan.owner, adopted.id)
        return adopted
      }
    }

    let session = await this.host.session(continuation.session_id)
    if (session && !this.matchesContinuation(session, plan.id))
      throw new Error("Native Architect continuation ID belongs to another session")
    if (!session) {
      try {
        await this.host.createArchitect({
          id: continuation.session_id,
          ...(continuation.parent_id ? { parentID: continuation.parent_id } : {}),
          directory: continuation.directory,
          ...(continuation.model ? { model: JSON.parse(continuation.model) } : {}),
          title: `LAZERS · continue ${plan.id.slice(0, 8)}`,
          planID: plan.id,
          sourceSessionID: plan.owner,
        })
      } catch (error) {
        const recovered = await this.host.session(continuation.session_id)
        if (!this.matchesContinuation(recovered, plan.id)) throw error
        session = recovered
      }
      session ??= await this.host.session(continuation.session_id)
    }
    if (!this.validArchitect(session) || !this.matchesContinuation(session, plan.id))
      throw new Error("Native Architect continuation is unavailable or foreign")
    this.store.record(plan.id, null, "ARCHITECT_CONTINUATION_READY", {
      sessionID: session.id,
      parentID: continuation.parent_id,
      generation: continuation.generation,
    })
    if (adopt) this.store.updatePlanOwner(plan.id, plan.owner, session.id)
    return session
  }

  private matchesContinuation(session: HostSession | null | undefined, planID: string) {
    const continuation = this.store.continuation(planID)
    const listedPlans = session?.metadata?.lazersPlanIDs
    return (
      Boolean(continuation) &&
      session?.agent === "architect" &&
      session.projectID === this.projectID &&
      session.directory === this.directory &&
      session.parentID === (continuation?.parent_id ?? undefined) &&
      session.metadata?.lazersContinuation === true &&
      (session.metadata.lazersPlanID === planID ||
        (Array.isArray(listedPlans) && listedPlans.includes(planID)))
    )
  }

  /** Called by the native prompt hook before OpenCode admits the input to its inbox. */
  async observeArchitectPrompt(sessionID: string, nativeMessageID: string) {
    this.store.observeArchitectInput(sessionID, nativeMessageID, this.now(), {
      type: "user",
      disposition: "prompt",
      userPrompt: true,
    })
  }

  async recordArchitectContinuity(sessionID: string, input: unknown) {
    const continuity = ArchitectContinuityInput.parse(input)
    const session = await this.host.session(sessionID)
    if (!this.validArchitect(session))
      throw new Error("Architect continuity can only be recorded by the current active Architect")
    if (!this.host.architectInputPage)
      throw new Error("Architect continuity requires public input/history coverage")
    const coverageInputs: Array<{ id: string; type: string; metadata?: Record<string, unknown> }> =
      []
    const seenCursors = new Set<string>()
    let cursor: string | undefined
    for (;;) {
      const page = await this.host.architectInputPage(sessionID, cursor)
      coverageInputs.push(...page.inbox, ...page.messages)
      if (!page.nextCursor) break
      if (seenCursors.has(page.nextCursor))
        throw new Error("Architect continuity history pagination did not advance")
      seenCursors.add(page.nextCursor)
      cursor = page.nextCursor
    }
    const saved = this.store.saveArchitectContinuity({
      sessionID,
      decisions: continuity.decisions,
      unresolvedQuestions: continuity.unresolvedQuestions,
      coverageInputs,
      now: this.now(),
    })
    return {
      status: "recorded",
      sessionID,
      revision: saved.revision,
      decisionCount: continuity.decisions.length,
      unresolvedQuestionCount: continuity.unresolvedQuestions.length,
    }
  }

  private async inspectArchitectSourcePage(renewal: ArchitectRenewalRow, fence: number) {
    if (!this.host.architectInputPage)
      throw new Error("Native Architect input/history observation is unavailable")
    const source = this.store.architectSource(renewal.previous_session_id)
    if (!source) throw new Error("Durable Architect predecessor source is unavailable")
    const page = await this.host.architectInputPage(
      renewal.previous_session_id,
      source.scan_cursor ?? undefined,
    )
    const result = this.store.recordArchitectSourcePage({
      schedulerOwner: this.owner,
      fence,
      sessionID: renewal.previous_session_id,
      cursor: source.scan_cursor,
      nextCursor: page.nextCursor,
      inbox: page.inbox,
      messages: page.messages,
      now: this.now(),
      projectID: this.projectID,
    })
    if (!result) throw new Error("Architect predecessor source changed during reconciliation")
    if (result.changedInputs.length)
      this.renewalEvent(
        renewal,
        "ARCHITECT_RENEWAL_NATIVE_INPUT_OBSERVED",
        {
          renewalID: renewal.id,
          sourceRevision: result.revision,
          inputs: result.changedInputs,
          nextCursor: result.nextCursor,
        },
        fence,
      )
    if (result.changedResults.length)
      this.renewalEvent(
        renewal,
        "ARCHITECT_RENEWAL_SOURCE_RESULT_OBSERVED",
        {
          renewalID: renewal.id,
          sourceRevision: result.revision,
          results: result.changedResults,
          nextCursor: result.nextCursor,
        },
        fence,
      )
    return result
  }

  private async inspectArchitectSourceSweep(renewal: ArchitectRenewalRow, fence: number) {
    const requestedCursors = new Set<string>()
    for (;;) {
      const source = this.store.architectSource(renewal.previous_session_id)
      if (!source) throw new Error("Durable Architect predecessor source is unavailable")
      const cursor = source.scan_cursor
      if (cursor !== null) {
        if (requestedCursors.has(cursor))
          throw new Error("Native Architect input/history pagination did not advance")
        requestedCursors.add(cursor)
      }
      try {
        const result = await this.inspectArchitectSourcePage(renewal, fence)
        if (result.nextCursor === null) return
        if (result.nextCursor === cursor || requestedCursors.has(result.nextCursor))
          throw new Error("Native Architect input/history pagination did not advance")
      } catch (error) {
        // A prompt hook can defer preparation between the page read and its journal
        // write. That expected state change ends the sweep without masking read errors.
        if (this.store.architectRenewal(renewal.id)?.state !== "creating") return
        throw error
      }
    }
  }

  private async reconcileArchitectSources(fence: number) {
    if (!this.host.architectInputPage) return
    for (const source of this.store.architectSources()) {
      const renewal = this.store.architectRenewal(source.renewal_id)
      if (!renewal) continue
      try {
        await this.inspectArchitectSourcePage(renewal, fence)
      } catch (error) {
        this.renewalEvent(
          renewal,
          "ARCHITECT_SOURCE_SCAN_FAILED",
          { renewalID: renewal.id, sourceSessionID: source.session_id, error: errorText(error) },
          fence,
        )
      }
    }
  }

  private async withRenewalLock<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = this.renewalLocks.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => (release = resolve))
    this.renewalLocks.set(key, current)
    await previous
    try {
      return await run()
    } finally {
      release()
      if (this.renewalLocks.get(key) === current) this.renewalLocks.delete(key)
    }
  }

  private async restorePredecessorForInput(renewal: ArchitectRenewalRow, fence?: number) {
    if (!this.host.updateSession)
      throw new Error(
        "Cannot preserve input during Architect renewal: native session update is unavailable",
      )
    const predecessor = await this.host.session(renewal.previous_session_id)
    if (!predecessor)
      throw new Error(
        "Cannot preserve input during Architect renewal: predecessor session is unavailable",
      )
    if (predecessor.archived) {
      await this.host.updateSession({ sessionID: predecessor.id, archived: false })
      const restored = await this.host.session(predecessor.id)
      if (!restored || restored.archived)
        throw new Error(
          "Cannot preserve input during Architect renewal: predecessor did not unarchive",
        )
    }
    if (fence !== undefined) {
      const changed = this.store.rollbackArchitectRenewal(
        this.owner,
        fence,
        renewal.id,
        "deferred",
        null,
      )
      if (!changed) {
        const current = this.store.architectRenewal(renewal.id)
        if (current && ["archiving", "recovering-input", "rolling-back"].includes(current.state))
          throw new Error(
            "Cannot preserve input during Architect renewal: ownership rollback was not recorded",
          )
      }
    }
  }

  private renewalSuccessorMatches(
    session: HostSession | null,
    renewal: ArchitectRenewalRow,
    allowArchived = false,
  ) {
    const model = JSON.parse(renewal.model) as NonNullable<HostSession["model"]>
    const planIDs = this.store.architectRenewalPlans(renewal.id).map((item) => item.plan_id)
    const metadataPlanIDs = session?.metadata?.lazersPlanIDs
    // Metadata is the identity snapshot taken when native creation began. Later
    // plans may be admitted to the predecessor while creation is in flight; the
    // durable transfer attaches those plans without changing successor identity.
    const anchorIdentity =
      session?.metadata?.lazersPlanID === renewal.anchor_plan_id &&
      (!Array.isArray(metadataPlanIDs) ||
        (metadataPlanIDs.includes(renewal.anchor_plan_id) &&
          metadataPlanIDs.every((id) => planIDs.includes(String(id)))))
    return Boolean(
      session &&
      (allowArchived || !session.archived) &&
      session.agent === "architect" &&
      session.id === renewal.successor_session_id &&
      session.projectID === this.projectID &&
      session.directory === renewal.directory &&
      session.parentID === renewal.previous_session_id &&
      session.model?.id === model.id &&
      session.model.providerID === model.providerID &&
      session.model.variant === model.variant &&
      session.metadata?.lazersContinuation === true &&
      session.metadata.lazersSourceSessionID === renewal.previous_session_id &&
      anchorIdentity,
    )
  }

  private renewalLabel(renewal: ArchitectRenewalRow) {
    const plan = this.store.plan(renewal.anchor_plan_id)
    if (!plan) return `Continue LAZERS plan ${renewal.anchor_plan_id.slice(0, 8)}`
    const input = PlanInput.parse(JSON.parse(plan.body))
    return input.title ?? input.objective.slice(0, 120)
  }

  private renewalContinuity(renewal: ArchitectRenewalRow) {
    if (!renewal.continuity_json)
      throw new Error("Architect renewal has no explicit continuity checkpoint")
    const parsed = JSON.parse(renewal.continuity_json) as { revision?: unknown }
    const content = ArchitectContinuityInput.parse({
      decisions: (parsed as Record<string, unknown>).decisions,
      unresolvedQuestions: (parsed as Record<string, unknown>).unresolvedQuestions,
    })
    if (typeof parsed.revision !== "number" || !Number.isSafeInteger(parsed.revision))
      throw new Error("Architect continuity checkpoint revision is invalid")
    return { revision: parsed.revision, ...content }
  }

  private renewalContinuityCoverage(renewal: ArchitectRenewalRow) {
    const coverage = this.store.architectRenewalCoverageEvidence(renewal.id)
    if (!coverage) throw new Error("Architect renewal continuity coverage is unavailable")
    return {
      revision: coverage.revision,
      inputCount: coverage.inputCount,
      inputFingerprint: coverage.inputFingerprint,
    }
  }

  private renewalWakeContext(renewal: ArchitectRenewalRow, payload: unknown) {
    const text = outcomeText(JSON.stringify(payload))
    return {
      bytes: new TextEncoder().encode(text).byteLength,
      tokens: null,
      tokenProvenance:
        "unknown: OpenCode exposes session-cumulative token counts, not a message-level count for this wake",
      cache: {
        uncachedInput: null,
        read: null,
        write: null,
        provenance:
          "unknown until the native successor reports a public session usage snapshot; no cache hit or savings are inferred",
      },
      sessionID: renewal.successor_session_id,
      sessionUsageProvenance: "OpenCode 2.2.5 session.get cumulative snapshot, not wake-attributed",
    }
  }

  private renewalEvent(
    renewal: ArchitectRenewalRow,
    event: string,
    payload: unknown,
    fence: number,
  ) {
    this.store.fenced(this.owner, fence, () =>
      this.store.record(renewal.anchor_plan_id, null, event, payload),
    )
  }

  private renewalIssue(
    renewal: ArchitectRenewalRow,
    event: string,
    error: string,
    payload: Record<string, unknown>,
    fence: number,
  ) {
    this.store.setArchitectRenewalState(
      this.owner,
      fence,
      renewal.id,
      [renewal.state],
      renewal.state,
      error,
    )
    this.renewalEvent(renewal, event, { renewalID: renewal.id, error, ...payload }, fence)
  }

  private async considerArchitectRenewal(plan: PlanRow, owner: HostSession, fence: number) {
    if (
      !this.architectPromptHook ||
      !this.host.updateSession ||
      !this.host.architectInputPage ||
      owner.idleAt === undefined ||
      owner.busy ||
      !owner.model ||
      this.now() - owner.idleAt < this.architectIdleWindowMs
    )
      return false
    if (!this.store.architectContinuity(owner.id)) return false
    const labelPlan = PlanInput.parse(JSON.parse(plan.body))
    const label = labelPlan.title ?? labelPlan.objective.slice(0, 120)
    const renewal = this.store.beginArchitectRenewal({
      schedulerOwner: this.owner,
      fence,
      anchorPlanID: plan.id,
      previousSessionID: owner.id,
      directory: owner.directory,
      model: JSON.stringify(owner.model),
      idleAt: owner.idleAt,
      now: this.now(),
      handoffMessageID: messageID(),
    })
    if (!renewal) return false
    await this.continueArchitectRenewal(renewal, fence, label)
    return true
  }

  private async continueArchitectRenewal(
    initial: ArchitectRenewalRow,
    fence: number,
    knownLabel?: string,
  ) {
    try {
      return await this.withRenewalLock(initial.id, async () => {
        let renewal = this.store.architectRenewal(initial.id)
        if (!renewal) return
        if (
          !this.architectPromptHook ||
          !this.host.updateSession ||
          !this.host.architectInputPage
        ) {
          const reason = "Native Architect source reconciliation or archival is unavailable"
          if (renewal.state === "creating") {
            this.store.setArchitectRenewalState(
              this.owner,
              fence,
              renewal.id,
              ["creating"],
              "deferred",
              reason,
            )
            this.renewalEvent(
              renewal,
              "ARCHITECT_RENEWAL_DEFERRED",
              { renewalID: renewal.id, reason },
              fence,
            )
            return
          }
          if (renewal.state === "archiving") {
            this.renewalIssue(renewal, "ARCHITECT_RENEWAL_ARCHIVE_UNCERTAIN", reason, {}, fence)
            return
          }
        }
        if (["recovering-input", "rolling-back"].includes(renewal.state)) {
          await this.restorePredecessorForInput(renewal, fence)
          return
        }
        if (renewal.state === "committed" || renewal.state === "deferred") return
        if (!renewal.continuity_json) {
          if (renewal.state === "creating") {
            this.store.setArchitectRenewalState(
              this.owner,
              fence,
              renewal.id,
              ["creating"],
              "deferred",
              "No explicit Architect decisions/questions checkpoint was recorded",
            )
            this.renewalEvent(
              renewal,
              "ARCHITECT_RENEWAL_DEFERRED",
              {
                renewalID: renewal.id,
                reason: "No explicit Architect decisions/questions checkpoint was recorded",
              },
              fence,
            )
            return
          }
          if (renewal.state === "archiving") {
            this.renewalIssue(
              renewal,
              "ARCHITECT_RENEWAL_ARCHIVE_UNCERTAIN",
              "No explicit Architect decisions/questions checkpoint was recorded",
              {},
              fence,
            )
            return
          }
        }
        if (renewal.state === "creating") {
          // A checkpoint is only safe to transfer after its complete current history
          // sweep has been journaled and checked for uncovered user input.
          await this.inspectArchitectSourceSweep(renewal, fence)
          renewal = this.store.architectRenewal(renewal.id)!
          if (renewal.state !== "creating") return
          let successor = await this.host.session(renewal.successor_session_id)
          if (successor && !this.renewalSuccessorMatches(successor, renewal))
            throw new Error("Native Architect renewal ID belongs to another session or route")
          if (!successor) {
            const planIDs = this.store.architectRenewalPlans(renewal.id).map((item) => item.plan_id)
            await this.host
              .createArchitect({
                id: renewal.successor_session_id,
                parentID: renewal.previous_session_id,
                directory: renewal.directory,
                model: JSON.parse(renewal.model),
                title: `LAZERS · ${knownLabel ?? this.renewalLabel(renewal)}`.slice(0, 120),
                planID: renewal.anchor_plan_id,
                planIDs,
                sourceSessionID: renewal.previous_session_id,
              })
              .catch(async (error) => {
                const recovered = await this.host.session(renewal!.successor_session_id)
                if (!this.renewalSuccessorMatches(recovered, renewal!)) throw error
                successor = recovered
              })
            successor ??= await this.host.session(renewal.successor_session_id)
          }
          if (!this.renewalSuccessorMatches(successor, renewal))
            throw new Error("Native Architect renewal is unavailable or foreign")
          renewal = this.store.architectRenewal(renewal.id)!
          if (renewal.state !== "creating") return
          // Repeat the complete sweep after successor creation to include inputs
          // observed while the native create call was in flight, before transfer.
          await this.inspectArchitectSourceSweep(renewal, fence)
          renewal = this.store.architectRenewal(renewal.id)!
          if (renewal.state !== "creating") return

          const predecessor = await this.host.session(renewal.previous_session_id)
          const tooRecent =
            predecessor?.idleAt === undefined ||
            this.now() - predecessor.idleAt < this.architectIdleWindowMs
          if (!this.validArchitect(predecessor) || predecessor.busy || tooRecent) {
            this.store.setArchitectRenewalState(
              this.owner,
              fence,
              renewal.id,
              ["creating"],
              "deferred",
            )
            this.renewalEvent(
              renewal,
              "ARCHITECT_RENEWAL_DEFERRED",
              {
                renewalID: renewal.id,
                busy: predecessor?.busy ?? null,
              },
              fence,
            )
            return
          }

          const planIDs = this.store.architectRenewalPlans(renewal.id).map((item) => item.plan_id)
          const label = knownLabel ?? this.renewalLabel(renewal)
          const continuity = this.renewalContinuity(renewal)
          const anchor = this.store.plan(renewal.anchor_plan_id)
          if (!anchor) throw new Error("Architect renewal plan disappeared")
          const source = this.store.architectSource(renewal.previous_session_id)
          if (!source) throw new Error("Architect predecessor source disappeared before handoff")
          const payload = {
            status: "architect-handoff",
            planID: renewal.anchor_plan_id,
            version: anchor.version + 1,
            planIDs,
            label,
            continuity,
            continuityCoverage: this.renewalContinuityCoverage(renewal),
            predecessorSessionID: renewal.previous_session_id,
            successorSessionID: renewal.successor_session_id,
            sourceRevision: source?.revision ?? 0,
            sourceCoverage: {
              sourceSessionID: renewal.previous_session_id,
              cursor: source?.scan_cursor ?? null,
              complete: (source?.scan_sweep ?? 0) > 0 && source?.scan_cursor === null,
            },
          }
          const outboxID = fingerprint({
            kind: "architect-handoff",
            renewalID: renewal.id,
            messageID: renewal.handoff_message_id,
          })
          const metadata: OutcomeOwnership = {
            lazersKind: "runner-outcome",
            lazersProjectID: this.projectID,
            lazersProjectDirectory: this.directory,
            lazersPlanID: renewal.anchor_plan_id,
            lazersOutboxID: outboxID,
            lazersMessageID: renewal.handoff_message_id,
            lazersSessionID: renewal.successor_session_id,
            lazersStatus: "architect-handoff",
            lazersVersion: anchor.version + 1,
          }
          if (
            !this.store.transferArchitectRenewal({
              schedulerOwner: this.owner,
              fence,
              renewalID: renewal.id,
              outboxID,
              payload: JSON.stringify(payload),
              metadata: JSON.stringify(metadata),
            })
          ) {
            renewal = this.store.architectRenewal(renewal.id)
            if (renewal?.state === "deferred") return
            throw new Error("Architect ownership transfer lost its durable compare-and-swap")
          }
          renewal = this.store.architectRenewal(renewal.id)!
        }

        if (renewal.state !== "archiving") return
        await this.inspectArchitectSourcePage(renewal, fence)
        renewal = this.store.architectRenewal(renewal.id)!
        if (renewal.state !== "archiving") return
        let successor: HostSession | null
        try {
          successor = await this.host.session(renewal.successor_session_id)
        } catch (error) {
          this.renewalIssue(
            renewal,
            "ARCHITECT_RENEWAL_SUCCESSOR_UNAVAILABLE",
            errorText(error),
            { successorSessionID: renewal.successor_session_id },
            fence,
          )
          return
        }
        if (!successor || !this.renewalSuccessorMatches(successor, renewal, true)) {
          this.renewalIssue(
            renewal,
            "ARCHITECT_RENEWAL_SUCCESSOR_UNAVAILABLE",
            "Durable Architect successor is missing or has a conflicting identity",
            { successorSessionID: renewal.successor_session_id },
            fence,
          )
          return
        }
        if (successor.archived) {
          this.renewalIssue(
            renewal,
            "ARCHITECT_RENEWAL_SUCCESSOR_UNAVAILABLE",
            "Durable Architect successor was archived before renewal recovery",
            { successorSessionID: renewal.successor_session_id },
            fence,
          )
          return
        }
        const predecessorBeforeArchive = await this.host.session(renewal.previous_session_id)
        if (!predecessorBeforeArchive) {
          this.renewalIssue(
            renewal,
            "ARCHITECT_RENEWAL_ARCHIVE_UNCERTAIN",
            "Predecessor session is unavailable before archival",
            {},
            fence,
          )
          return
        }
        if (
          predecessorBeforeArchive.agent !== "architect" ||
          predecessorBeforeArchive.projectID !== this.projectID ||
          predecessorBeforeArchive.directory !== renewal.directory
        ) {
          this.renewalIssue(
            renewal,
            "ARCHITECT_RENEWAL_ARCHIVE_UNCERTAIN",
            "Predecessor identity changed before archival",
            {},
            fence,
          )
          return
        }
        if (
          predecessorBeforeArchive.busy ||
          predecessorBeforeArchive.idleAt === undefined ||
          this.now() - predecessorBeforeArchive.idleAt < this.architectIdleWindowMs
        ) {
          this.renewalIssue(
            renewal,
            "ARCHITECT_RENEWAL_ARCHIVE_DEFERRED",
            "Predecessor became busy or recent before archival",
            { busy: predecessorBeforeArchive.busy, idleAt: predecessorBeforeArchive.idleAt },
            fence,
          )
          return
        }
        let archiveError: string | null = null
        if (!predecessorBeforeArchive.archived) {
          try {
            await this.host.updateSession!({
              sessionID: renewal.previous_session_id,
              archived: true,
            })
          } catch (error) {
            archiveError = errorText(error)
          }
        }

        let predecessor: HostSession | null
        try {
          predecessor = await this.host.session(renewal.previous_session_id)
        } catch (error) {
          this.renewalIssue(
            renewal,
            "ARCHITECT_RENEWAL_ARCHIVE_UNCERTAIN",
            errorText(error),
            { archiveError },
            fence,
          )
          return
        }
        if (!predecessor) {
          this.renewalIssue(
            renewal,
            "ARCHITECT_RENEWAL_ARCHIVE_UNCERTAIN",
            "Predecessor session is unavailable",
            { archiveError },
            fence,
          )
          return
        }
        if (!predecessor.archived) {
          this.renewalIssue(
            renewal,
            "ARCHITECT_RENEWAL_ARCHIVE_UNCERTAIN",
            archiveError ?? "Native archive was not observed",
            { predecessorSessionID: renewal.previous_session_id },
            fence,
          )
          return
        }
        if (archiveError) {
          this.renewalEvent(
            renewal,
            "ARCHITECT_RENEWAL_ARCHIVE_RECONCILED",
            { renewalID: renewal.id, error: archiveError, archived: true },
            fence,
          )
        }
        try {
          await this.inspectArchitectSourcePage(renewal, fence)
        } catch (error) {
          this.renewalIssue(
            renewal,
            "ARCHITECT_SOURCE_SCAN_FAILED",
            `Native inbox could not be verified after archival: ${errorText(error)}`,
            { sourceSessionID: renewal.previous_session_id },
            fence,
          )
          return
        }
        const source = this.store.architectSource(renewal.previous_session_id)
        if (!source) throw new Error("Architect predecessor source disappeared before commit")
        const payload = {
          status: "architect-handoff",
          planID: renewal.anchor_plan_id,
          planIDs: this.store.architectRenewalPlans(renewal.id).map((item) => item.plan_id),
          label: knownLabel ?? this.renewalLabel(renewal),
          continuity: this.renewalContinuity(renewal),
          continuityCoverage: this.renewalContinuityCoverage(renewal),
          predecessorSessionID: renewal.previous_session_id,
          successorSessionID: renewal.successor_session_id,
          sourceRevision: source?.revision ?? 0,
          sourceCoverage: {
            sourceSessionID: renewal.previous_session_id,
            cursor: source?.scan_cursor ?? null,
            complete: source.scan_sweep > 0 && source.scan_cursor === null,
          },
        }
        const committed = this.store.finishArchitectRenewal(
          this.owner,
          fence,
          renewal.id,
          this.renewalWakeContext(renewal, payload),
        )
        if (!committed) {
          this.renewalIssue(
            renewal,
            "ARCHITECT_RENEWAL_COMMIT_UNCERTAIN",
            "Durable renewal commit was not confirmed after native archival",
            { predecessorSessionID: renewal.previous_session_id },
            fence,
          )
        }
      })
    } catch (error) {
      const current = this.store.architectRenewal(initial.id)
      if (
        current &&
        ["creating", "archiving", "recovering-input", "rolling-back"].includes(current.state)
      ) {
        this.store.setArchitectRenewalState(
          this.owner,
          fence,
          current.id,
          [current.state],
          current.state,
          errorText(error),
        )
        this.renewalEvent(
          current,
          "ARCHITECT_RENEWAL_RECOVERY_FAILED",
          { renewalID: current.id, state: current.state, error: errorText(error) },
          fence,
        )
      }
      throw error
    }
  }

  private async rollbackArchitectRenewal(
    renewal: ArchitectRenewalRow,
    state: "deferred" | "archive-failed",
    error: string | null,
    fence: number,
  ) {
    if (!this.host.updateSession)
      throw new Error("Cannot recover Architect renewal without native session update")
    await this.host.updateSession({ sessionID: renewal.previous_session_id, archived: false })
    const restored = await this.host.session(renewal.previous_session_id)
    if (!restored || restored.archived)
      throw new Error("Architect renewal rollback did not restore the predecessor")
    this.store.rollbackArchitectRenewal(this.owner, fence, renewal.id, state, error)
  }

  private hold(plan: PlanRow, reason: string, allowedActions = ["audit", "reconcile", "cancel"]) {
    this.store.atomic((db) => {
      const changed = db
        .query(
          "UPDATE runner_plans SET state='blocked',reason=?,version=version+1 WHERE id=? AND (state!='blocked' OR reason IS NOT ?)",
        )
        .run(reason, plan.id, reason).changes
      if (!changed) return
      this.store.record(plan.id, null, "BLOCKED", { reason })
      this.outcome(plan.id, { status: "blocked", reason, allowedActions }, true)
    })
    return {
      status: "blocked",
      reason,
      planID: plan.id,
      version: this.store.plan(plan.id)!.version,
    }
  }
  private outcome(planID: string, payload: unknown, resume: boolean) {
    const plan = this.store.plan(planID)!
    const full = {
      planID,
      planRevision: plan.revision,
      version: plan.version,
      ...(payload as object),
      currentPlan: { state: plan.state, reason: plan.reason },
      reviewableTasks: this.store
        .nodes(planID)
        .filter((node) => node.state === "accepted" && node.artifact)
        .map((node) => {
          const attempt = this.store
            .attempts(planID)
            .findLast(
              (candidate) =>
                candidate.task_id === node.task_id &&
                candidate.state === "accepted" &&
                candidate.artifact === node.artifact,
            )
          const adoption = this.store
            .adoptions(planID)
            .find(
              (candidate) =>
                candidate.state === "accepted" &&
                candidate.task_id === node.task_id &&
                candidate.descendant_commit === node.artifact,
            )
          return {
            taskID: node.task_id,
            artifact: node.artifact,
            attemptID: attempt?.id ?? null,
            ...(adoption ? { adoptionID: adoption.id } : {}),
            evidence: this.store.repository
              .get(node.task_id)!
              .proposal.verification.map((check) => check.id),
          }
        }),
    }
    const id = fingerprint(full)
    const nativeMessageID = messageID()
    const metadata: OutcomeOwnership = {
      lazersKind: "runner-outcome",
      lazersProjectID: this.projectID,
      lazersProjectDirectory: this.directory,
      lazersPlanID: planID,
      lazersOutboxID: id,
      lazersMessageID: nativeMessageID,
      lazersSessionID: plan.owner,
      lazersStatus:
        typeof payload === "object" &&
        payload !== null &&
        "status" in payload &&
        typeof payload.status === "string"
          ? payload.status
          : "update",
      lazersVersion: plan.version,
    }
    this.store.atomic((db) => {
      db.query(
        "INSERT OR IGNORE INTO runner_outbox(id,plan_id,session_id,message_id,payload,state,resume,metadata,receipt) VALUES(?,?,?,?,?,'pending',?,?,NULL)",
      ).run(
        id,
        planID,
        plan.owner,
        nativeMessageID,
        JSON.stringify(full),
        Number(resume),
        JSON.stringify(metadata),
      )
      this.store.repository.changed()
    })
  }
  private effect(
    planID: string,
    taskID: string | null,
    attemptID: string | null,
    kind: string,
    payload: unknown,
    fence: number,
  ): EffectRow {
    const id = fingerprint({ planID, taskID, attemptID, kind, payload })
    return this.store.fenced(this.owner, fence, (db) => {
      const existing = db
        .query<EffectRow, [string]>("SELECT * FROM runner_effects WHERE id=?")
        .get(id)
      if (existing) throw new Error(`Existing ${kind} effect must be reconciled, never replayed`)
      db.query("INSERT INTO runner_effects VALUES(?,?,?,?,?,'intended',?,NULL,?)").run(
        id,
        planID,
        taskID,
        attemptID,
        kind,
        JSON.stringify(payload),
        fence,
      )
      this.store.record(planID, taskID, "EFFECT_INTENDED", { effectID: id, kind, attemptID })
      return db.query<EffectRow, [string]>("SELECT * FROM runner_effects WHERE id=?").get(id)!
    })
  }
  private receipt(effect: EffectRow, receipt: unknown, fence: number) {
    this.store.fenced(this.owner, fence, (db) => {
      db.query(
        "UPDATE runner_effects SET state='completed',receipt=? WHERE id=? AND state IN ('intended','uncertain')",
      ).run(JSON.stringify(receipt), effect.id)
      this.store.record(effect.plan_id, effect.task_id, "EFFECT_COMPLETED", {
        effectID: effect.id,
        kind: effect.kind,
      })
    })
  }
  private uncertain(effect: EffectRow, error: unknown, fence: number) {
    this.store.fenced(this.owner, fence, (db) =>
      db
        .query("UPDATE runner_effects SET state='uncertain',receipt=? WHERE id=?")
        .run(JSON.stringify({ error: errorText(error) }), effect.id),
    )
    const plan = this.store.plan(effect.plan_id)!
    if (plan.state !== "cancelling") {
      const reason = `Recovery uncertain for ${effect.kind} ${effect.id}: ${errorText(error)}`
      const payload = JSON.parse(effect.payload) as { adoptionID?: unknown }
      if (effect.kind.startsWith("adoption-") && typeof payload.adoptionID === "string")
        this.holdAdoption(plan, payload.adoptionID, reason, "pending", fence)
      else this.hold(plan, reason)
    }
  }

  async tick() {
    if (this.running || this.stopped) return
    this.running = true
    const fence = this.store.claim(this.owner)
    if (fence === null) {
      this.running = false
      return
    }
    const heartbeat = setInterval(() => {
      this.store.renew(this.owner, fence)
    }, 10000)
    try {
      // A lease only selects a reconciler; it never proves an old side effect stopped.
      for (const renewal of this.store.architectRenewalsNeedingRecovery()) {
        try {
          await this.continueArchitectRenewal(renewal, fence)
        } catch (error) {
          // The renewal has durably recorded its failed recovery phase. Do not let
          // a retained-history read failure starve cancellation of transferred work.
          const cancellationWasRequested = this.store
            .plans()
            .some(
              (plan) =>
                ["cancelling", "cancelled"].includes(plan.state) &&
                this.store.architectRenewalForPlan(plan.id)?.id === renewal.id,
            )
          const recordedFailure = this.store.architectRenewal(renewal.id)
          if (
            !cancellationWasRequested ||
            recordedFailure?.state !== renewal.state ||
            recordedFailure.error !== errorText(error)
          )
            throw error
        }
      }
      await this.reconcileArchitectSources(fence)
      for (let plan of this.store
        .plans()
        .filter((p) => !terminal.has(p.state) && (p.state !== "draft" || this.taskStartID(p)))
        .sort((a, b) => Number(b.state === "cancelling") - Number(a.state === "cancelling"))) {
        if (plan.state === "draft") {
          const taskID = this.taskStartID(plan)!
          await this.command(
            {
              requestID: `task-start-run:${taskID}:1`,
              planID: plan.id,
              expectedVersion: plan.version,
              action: "run",
            },
            plan.owner,
          )
          plan = this.store.plan(plan.id)!
        }
        await this.step(plan, fence)
      }
      await this.deliver(fence)
    } finally {
      clearInterval(heartbeat)
      this.running = false
      for (const resolve of this.idleWaiters.splice(0)) resolve()
    }
  }
  async stop() {
    this.stopped = true
    if (this.running) await new Promise<void>((resolve) => this.idleWaiters.push(resolve))
  }

  private async step(initialPlan: PlanRow, fence: number) {
    let plan = this.store.plan(initialPlan.id)
    if (!plan) return
    if (plan.state === "cancelling") {
      await this.cancelWorkers(plan, fence)
      const pending = this.store
        .effects(plan.id)
        .find((e) => ["intended", "uncertain"].includes(e.state))
      if (pending) await this.reconcileEffect(pending, fence)
      return
    }
    const planRenewal = this.store.architectRenewalForPlan(plan.id)
    if (
      planRenewal &&
      ["creating", "archiving", "recovering-input", "rolling-back"].includes(planRenewal.state)
    ) {
      await this.continueArchitectRenewal(planRenewal, fence)
      return
    }
    if (plan.state === "cleaning") {
      await this.cleanupWorktrees(plan, fence)
      return
    }
    const adoption = this.store.activeAdoptions(plan.id)[0]
    if (adoption) {
      await this.advanceAdoption(plan, adoption, fence)
      return
    }
    const owner = await this.host.session(plan.owner)
    if (this.validArchitect(owner)) {
      const renewal = this.store.architectRenewalForSource(owner.id)
      if (
        renewal &&
        ["creating", "archiving", "recovering-input", "rolling-back"].includes(renewal.state)
      ) {
        await this.continueArchitectRenewal(renewal, fence)
        return
      }
      if (await this.considerArchitectRenewal(plan, owner, fence)) return
    }
    if (!this.validArchitect(owner)) {
      await this.ensureArchitectOwner(plan, owner)
      plan = this.store.plan(plan.id)!
    }
    // An owner read can overlap an authorized resume, cancellation, or reassignment.
    if (this.store.plan(plan.id)?.version !== plan.version) return
    const pending = this.store
      .effects(plan.id)
      .find((e) => ["intended", "uncertain"].includes(e.state))
    if (pending) {
      await this.reconcileEffect(pending, fence)
      return
    }
    const active = this.store
      .attempts(plan.id)
      .filter((a) => ["preparing", "running", "verifying"].includes(a.state))
    if (active.length) {
      await Promise.all(
        active.map((attempt) => {
          const promptCompleted = this.store
            .effects(plan!.id)
            .some(
              (effect) =>
                effect.attempt_id === attempt.id &&
                effect.kind === "prompt" &&
                JSON.parse(effect.payload).messageID === attempt.message_id &&
                effect.state === "completed",
            )
          if (plan!.state === "blocked" && attempt.state === "preparing" && !promptCompleted)
            return this.cancelReservedAttempt(plan!, attempt, fence)
          const scopeWait = this.store.latestTransition<{ attemptID: string; reason: string }>(
            plan!.id,
            attempt.task_id,
            "SCOPE_DECISION_REQUIRED",
          )
          if (
            plan!.state === "blocked" &&
            scopeWait?.attemptID === attempt.id &&
            scopeWait.reason === plan!.reason
          )
            return
          return this.advanceAttempt(this.store.plan(plan!.id)!, attempt, fence)
        }),
      )
      plan = this.store.plan(plan.id)!
      if (plan.state === "cancelling") {
        await this.cancelWorkers(plan, fence)
        return
      }
    }
    if (plan.state === "blocked") return

    let rawInput = JSON.parse(plan.body)
    let input = PlanInput.parse(rawInput)
    const prerequisites = input.afterPlans ?? []
    const prerequisiteBaseline = prerequisites.length
      ? this.integratedPrerequisiteBaseline(prerequisites)
      : undefined
    if (prerequisites.length && !prerequisiteBaseline) return
    if (prerequisites.length && !this.store.attempts(plan.id).length) {
      // Dependents inherit the selected checkout after every prerequisite's
      // current combined integration proof is present in its Git history.
      const baseCommit = prerequisiteBaseline!
      if (input.baseCommit !== baseCommit) {
        input = PlanInput.parse({ ...rawInput, baseCommit })
        this.store.revisePlan(plan, input, "DEPENDENCIES_INTEGRATED", { prerequisites, baseCommit })
        plan = this.store.plan(plan.id)!
        rawInput = JSON.parse(plan.body)
      }
    }
    if (rawInput.workspaceMode === undefined) {
      const attempts = this.store.attempts(plan.id)
      if (attempts.length)
        input.workspaceMode = attempts.at(-1)!.workspace === this.directory ? "shared" : "isolated"
    }
    const nodes = this.store.nodes(plan.id)
    const activeProject = this.store.plans().flatMap((candidate) =>
      this.store
        .attempts(candidate.id)
        .filter((attempt) => ["preparing", "running", "verifying"].includes(attempt.state))
        .map((attempt) => ({ attempt, plan: candidate })),
    )
    const occupied = activeProject.map(({ attempt }) => ({
      shared: attempt.workspace === this.directory,
      scopes: this.store.effectiveWriteScope(attempt.task_id),
    }))
    occupied.push(
      ...this.store.activeAdoptions().map((adoption) => ({
        shared: false,
        scopes: this.store.effectiveWriteScope(adoption.task_id),
      })),
    )
    const ready = nodes.filter(
      (node) =>
        ["queued", "ready"].includes(node.state) &&
        this.store.execution(node.task_id)!.waitingOn.length === 0,
    )
    const selected: NodeRow[] = []
    if (input.workspaceMode === "shared") {
      // A shared checkout is a single-writer resource, including across plans.
      if (occupied.length === 0 && ready[0]) selected.push(ready[0])
    } else if (!occupied.some((entry) => entry.shared)) {
      for (const node of ready) {
        const scope = this.store.effectiveWriteScope(node.task_id)
        if (occupied.some((entry) => scopePatternsConflict(entry.scopes, scope))) continue
        selected.push(node)
        occupied.push({ shared: false, scopes: scope })
      }
    }
    if (selected.length) {
      await Promise.all(
        selected.map(async (node) => {
          try {
            await this.dispatch(plan!, node, fence)
          } catch (error) {
            const current = this.store.plan(plan!.id)
            if (current && current.state !== "blocked")
              this.hold(current, `Dispatch failed for ${node.task_id}: ${errorText(error)}`)
          }
        }),
      )
      return
    }
    if (
      this.store
        .attempts(plan.id)
        .some((attempt) => ["preparing", "running", "verifying"].includes(attempt.state))
    )
      return
    const failed = nodes.find((n) =>
      ["failed", "cancelled", "exhausted", "blocked"].includes(n.state),
    )
    if (failed) {
      this.hold(plan, `Task ${failed.task_id}: ${failed.reason ?? failed.state}`)
      return
    }
    if (nodes.every((n) => n.state === "accepted" || n.state === "incorporated"))
      await this.finish(plan, fence)
  }

  private async cancelWorkers(plan: PlanRow, fence: number) {
    const active = this.store
      .attempts(plan.id)
      .filter((attempt) => ["preparing", "running", "verifying"].includes(attempt.state))
    let waiting = false
    for (const attempt of active) {
      let session = await this.host.session(attempt.session_id)
      if (!session) {
        waiting = true
        continue
      }
      const promptCompleted = this.store
        .effects(plan.id)
        .some(
          (effect) =>
            effect.attempt_id === attempt.id &&
            effect.kind === "prompt" &&
            JSON.parse(effect.payload).messageID === attempt.message_id &&
            effect.state === "completed",
        )
      this.observeUsage(attempt, session, fence)
      const backgroundReason = this.backgroundBlockReason(session, attempt)
      const knownBackgroundWork =
        session.background?.state === "observed" && session.background.count > 0
      if ((session.pendingPermissions ?? 0) > 0 || (session.pendingForms ?? 0) > 0)
        this.approvalWait(plan, attempt, session, fence)
      if (session.busy) {
        await this.host.interrupt(attempt.session_id)
        if (backgroundReason)
          this.backgroundWait(
            plan,
            attempt,
            session,
            backgroundReason,
            fence,
            knownBackgroundWork ? "WORKER_BACKGROUND_WAIT" : "WORKER_BACKGROUND_UNKNOWN",
          )
        waiting = true
        continue
      }
      if (
        session.pendingInput ||
        session.observationUnstable ||
        (session.pendingPermissions ?? 0) > 0 ||
        (session.pendingForms ?? 0) > 0
      ) {
        waiting = true
        continue
      }
      if (knownBackgroundWork) {
        this.backgroundWait(plan, attempt, session, backgroundReason!, fence)
        waiting = true
        continue
      }
      if (backgroundReason)
        this.backgroundWait(
          plan,
          attempt,
          session,
          backgroundReason,
          fence,
          "WORKER_BACKGROUND_UNKNOWN",
        )
      session = await this.host.session(attempt.session_id, { messages: true })
      if (!session) {
        waiting = true
        continue
      }
      this.observeUsage(attempt, session, fence)
      if ((session.pendingPermissions ?? 0) > 0 || (session.pendingForms ?? 0) > 0)
        this.approvalWait(plan, attempt, session, fence)
      if (
        session.busy ||
        session.pendingInput ||
        session.observationUnstable ||
        (session.pendingPermissions ?? 0) > 0 ||
        (session.pendingForms ?? 0) > 0
      ) {
        if (session.busy) await this.host.interrupt(attempt.session_id)
        waiting = true
        continue
      }
      const detailedBackgroundReason = this.backgroundBlockReason(session, attempt, true)
      const detailedKnownBackgroundWork =
        session.background?.state === "observed" && session.background.count > 0
      if (detailedKnownBackgroundWork) {
        this.backgroundWait(plan, attempt, session, detailedBackgroundReason!, fence)
        waiting = true
        continue
      }
      if (detailedBackgroundReason)
        this.backgroundWait(
          plan,
          attempt,
          session,
          detailedBackgroundReason,
          fence,
          "WORKER_BACKGROUND_UNKNOWN",
        )
      if (
        promptCompleted &&
        (!session.turn ||
          !this.matchesWorkerInput(attempt, session.turn.inputID) ||
          (session.turn.state !== "completed" && session.turn.state !== "interrupted"))
      ) {
        waiting = true
        continue
      }
      if (promptCompleted) {
        this.workerEvent(plan, attempt, "WORKER_STARTED", fence)
        this.workerEvent(plan, attempt, "WORKER_STOPPED", fence, session.outcome ?? "cancelled")
      }
      if (
        this.store
          .effects(plan.id)
          .some(
            (effect) =>
              effect.attempt_id === attempt.id && ["intended", "uncertain"].includes(effect.state),
          )
      ) {
        waiting = true
        continue
      }
      this.store.fenced(this.owner, fence, (db) =>
        db.query("UPDATE runner_attempts SET state='cancelled' WHERE id=?").run(attempt.id),
      )
      const node = this.store
        .nodes(plan.id)
        .find((candidate) => candidate.task_id === attempt.task_id)!
      if (!terminal.has(node.state)) this.store.move(plan.id, node.task_id, "CANCEL")
    }
    if (
      waiting ||
      this.store.effects(plan.id).some((effect) => ["intended", "uncertain"].includes(effect.state))
    )
      return
    this.store.fenced(this.owner, fence, (db) =>
      db
        .query("UPDATE runner_plans SET state='cancelled',version=version+1 WHERE id=?")
        .run(plan.id),
    )
    this.outcome(plan.id, { status: "cancelled" }, true)
  }

  private cancelReservedAttempt(plan: PlanRow, attempt: AttemptRow, fence: number) {
    this.store.fenced(this.owner, fence, (db) =>
      db.query("UPDATE runner_attempts SET state='cancelled' WHERE id=?").run(attempt.id),
    )
    const node = this.store
      .nodes(plan.id)
      .find((candidate) => candidate.task_id === attempt.task_id)!
    if (!terminal.has(node.state)) this.store.move(plan.id, node.task_id, "CANCEL")
  }

  private workerEvent(
    plan: PlanRow,
    attempt: AttemptRow,
    event: "WORKER_STARTED" | "WORKER_STOPPED",
    fence: number,
    outcome?: HostSession["outcome"] | "cancelled",
  ) {
    const previous = this.store.latestTransition<{ attemptID?: string }>(
      plan.id,
      attempt.task_id,
      event,
    )
    if (previous?.attemptID === attempt.id) return
    this.store.fenced(this.owner, fence, () =>
      this.store.record(plan.id, attempt.task_id, event, {
        attemptID: attempt.id,
        sessionID: attempt.session_id,
        workspace: attempt.workspace,
        observedAt: Date.now(),
        ...(outcome ? { outcome } : {}),
      }),
    )
  }

  private matchesWorkerInput(attempt: AttemptRow, inputID: string | null | undefined): boolean {
    return this.progress.matchesAssignedInput(
      attempt.id,
      attempt.session_id,
      attempt.message_id,
      inputID,
    )
  }

  private backgroundBlockReason(
    session: HostSession,
    attempt: AttemptRow,
    requireTurnLineage = false,
  ): string | undefined {
    const background = session.background
    if (!background) return "Native idle background observation is unknown"
    if (background.state === "unknown")
      return `Native idle background observation is unknown: ${background.reason}`
    if (
      !this.matchesWorkerInput(attempt, background.inputID) ||
      (requireTurnLineage && session.turn?.inputID !== background.inputID)
    )
      return "Native idle background observation does not match the current worker input lineage"
    if (background.count > 0) {
      const kinds = Object.entries(background.kinds)
        .filter(([, count]) => count > 0)
        .map(([kind, count]) => `${count} ${kind}`)
        .join(", ")
      return `Worker has ${background.count} known background job(s) in the last experimental.idle report${kinds ? ` (${kinds})` : ""}`
    }
    return undefined
  }

  private approvalWait(plan: PlanRow, attempt: AttemptRow, session: HostSession, fence: number) {
    const pendingPermissions = session.pendingPermissions ?? 0
    const pendingForms = session.pendingForms ?? 0
    const previous = this.store.latestTransition<{
      attemptID?: string
      pendingPermissions?: number
      pendingForms?: number
    }>(plan.id, attempt.task_id, "WORKER_APPROVAL_WAIT")
    if (
      previous?.attemptID === attempt.id &&
      previous.pendingPermissions === pendingPermissions &&
      previous.pendingForms === pendingForms
    )
      return
    this.store.fenced(this.owner, fence, () =>
      this.store.record(plan.id, attempt.task_id, "WORKER_APPROVAL_WAIT", {
        attemptID: attempt.id,
        sessionID: attempt.session_id,
        workspace: attempt.workspace,
        directory: session.directory,
        pendingPermissions,
        pendingForms,
        observedAt: Date.now(),
      }),
    )
  }

  private resumeTransientObservationWait(plan: PlanRow, fence: number) {
    const current = this.store.plan(plan.id)
    const reason = current?.reason
    const backgroundWait =
      reason?.startsWith("Native idle background observation is unknown") ||
      reason?.includes(" known background job(s)")
    const approvalWait =
      reason?.startsWith("Worker at ") &&
      reason.includes("pending permission request(s)") &&
      reason.includes("pending form(s)")
    if (current?.state !== "blocked" || !reason || (!backgroundWait && !approvalWait)) return
    this.store.fenced(this.owner, fence, (db) => {
      const changed =
        db
          .query(
            "UPDATE runner_plans SET state='running',reason=NULL,version=version+1 WHERE id=? AND state='blocked' AND reason=?",
          )
          .run(plan.id, reason).changes === 1
      if (changed)
        this.store.record(plan.id, null, "WORKER_OBSERVATION_SETTLED", {
          previousReason: reason,
          observation: approvalWait ? "worker-approvals" : "experimental.idle-background",
        })
    })
  }

  private backgroundWait(
    plan: PlanRow,
    attempt: AttemptRow,
    session: HostSession,
    reason: string,
    fence: number,
    event: "WORKER_BACKGROUND_WAIT" | "WORKER_BACKGROUND_UNKNOWN" = "WORKER_BACKGROUND_WAIT",
  ) {
    const background = session.background ?? {
      state: "unknown" as const,
      source: "experimental.idle" as const,
      reason: "Native idle background observation is unavailable",
    }
    const previous = this.store.latestTransition<{
      attemptID?: string
      background?: HostSession["background"]
    }>(plan.id, attempt.task_id, event)
    if (
      previous?.attemptID === attempt.id &&
      JSON.stringify(previous.background) === JSON.stringify(background)
    )
      return
    this.store.fenced(this.owner, fence, () =>
      this.store.record(plan.id, attempt.task_id, event, {
        attemptID: attempt.id,
        sessionID: attempt.session_id,
        workspace: attempt.workspace,
        reason,
        background,
      }),
    )
  }

  private dependencySource(plan: PlanRow, input: PlanInput, node: NodeRow): string {
    const dependencies = new Map<string, string[]>()
    for (const edge of input.dependencies) {
      const predecessors = dependencies.get(edge.successor) ?? []
      predecessors.push(edge.prerequisite)
      dependencies.set(edge.successor, predecessors)
    }
    const ancestors = new Set<string>()
    const visit = (taskID: string) => {
      for (const prerequisite of dependencies.get(taskID) ?? [])
        if (!ancestors.has(prerequisite)) {
          ancestors.add(prerequisite)
          visit(prerequisite)
        }
    }
    visit(node.task_id)
    if (!ancestors.size) return input.baseCommit
    const byTask = new Map(
      this.store.nodes(plan.id).map((candidate) => [candidate.task_id, candidate]),
    )
    const attempts = this.store.attempts(plan.id)
    const order = new Map(input.integrationOrder.map((taskID, index) => [taskID, index]))
    const artifacts = [...ancestors]
      .map((taskID) => ({ taskID, node: byTask.get(taskID) }))
      .filter((entry) => entry.node?.state === "accepted")
      .sort((a, b) => order.get(a.taskID)! - order.get(b.taskID)!)
      .map(
        ({ taskID, node: predecessor }) =>
          attempts
            .filter((attempt) => attempt.task_id === taskID && attempt.state === "accepted")
            .at(-1)?.artifact ?? predecessor!.artifact,
      )
    if (artifacts.length !== ancestors.size || artifacts.some((artifact) => !artifact))
      throw new Error("Accepted dependency artifact is missing")
    return combineArtifacts(this.directory, input.baseCommit, artifacts as string[])
  }

  private integratedPrerequisiteBaseline(
    prerequisites: string[],
    candidateBaseline?: string,
  ): string | undefined {
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
    if (rows.length !== prerequisites.length) return undefined

    let baseline: string
    try {
      baseline = candidateBaseline ?? git(this.directory, ["rev-parse", "HEAD"])
      if (git(this.directory, ["rev-parse", `${baseline}^{commit}`]) !== baseline) return undefined
    } catch {
      return undefined
    }
    if (!isCommitID(baseline)) return undefined

    for (const row of rows) {
      if (
        !prerequisites.includes(row.plan_id) ||
        row.project_directory !== this.directory ||
        !["cleaning", "cleanup-blocked", "integrated"].includes(row.state) ||
        !isCommitID(row.artifact) ||
        !Number.isSafeInteger(row.accepted_id) ||
        !Number.isSafeInteger(row.accepted_version) ||
        !Number.isSafeInteger(row.integration_id) ||
        !Number.isSafeInteger(row.integration_version) ||
        row.accepted_id === null ||
        row.accepted_version === null ||
        row.integration_id === null ||
        row.integration_version === null ||
        row.accepted_id >= row.integration_id ||
        row.integration_version < row.accepted_version ||
        (row.invalidation_id !== null &&
          (!Number.isSafeInteger(row.invalidation_id) || row.accepted_id <= row.invalidation_id))
      )
        return undefined

      let accepted: unknown
      let integration: unknown
      try {
        accepted = JSON.parse(row.accepted_payload ?? "") as unknown
        integration = JSON.parse(row.integration_payload ?? "") as unknown
      } catch {
        return undefined
      }
      if (!isRecord(accepted) || !isRecord(integration)) return undefined
      if (
        accepted.artifact !== row.artifact ||
        integration.artifact !== row.artifact ||
        typeof integration.branch !== "string" ||
        !integration.branch.trim() ||
        typeof integration.reason !== "string" ||
        !integration.reason.trim() ||
        !isCommitID(integration.head)
      )
        return undefined

      try {
        git(this.directory, ["merge-base", "--is-ancestor", row.artifact, integration.head])
        git(this.directory, ["merge-base", "--is-ancestor", integration.head, baseline])
        git(this.directory, ["merge-base", "--is-ancestor", row.artifact, baseline])
      } catch {
        return undefined
      }
    }
    return baseline
  }

  private async dispatch(plan: PlanRow, node: NodeRow, fence: number) {
    const task = this.store.repository.get(node.task_id)!
    const attempts = this.store.attempts(plan.id).filter((a) => a.task_id === task.id)
    const first = attempts[0]
    const audit = this.store.audit()
    if (audit.findings.some((f) => f.code === "exact-content" && f.taskIDs.includes(task.id))) {
      this.hold(plan, "Overlap audit changed before dispatch")
      return
    }
    const input = PlanInput.parse(JSON.parse(plan.body))
    if (JSON.parse(plan.body).workspaceMode === undefined && attempts.length)
      input.workspaceMode = attempts.at(-1)!.workspace === this.directory ? "shared" : "isolated"
    const persona = input.nodes.find((candidate) => candidate.taskID === task.id)?.persona
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
    const base =
      selectedBaseline ??
      attempts.at(-1)?.artifact ??
      (input.workspaceMode === "shared"
        ? git(this.directory, ["rev-parse", "HEAD"])
        : this.dependencySource(plan, input, node))
    const workspace =
      input.workspaceMode === "shared" ? this.directory : join(this.dataDirectory, "worktrees", id)
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
      agent: "lazers-implementor",
      workspaceMode: input.workspaceMode,
      model: ModelPolicy.parse(JSON.parse(plan.model!)),
      ...(persona ? { persona } : {}),
      source: base,
      context: text,
      packet: {
        recipe: "task-tool/1",
        taskID: task.id,
        tool: "lz-get-task-instructions",
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
    this.store.fenced(this.owner, fence, (db) => {
      if (
        this.store
          .activeAdoptions()
          .some((adoption) =>
            scopePatternsConflict(
              this.store.effectiveWriteScope(task.id),
              this.store.effectiveWriteScope(adoption.task_id),
            ),
          )
      )
        throw new Error("A pending descendant adoption reserves this task's scope")
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
    })
    this.store.record(plan.id, task.id, "CONTEXT_RESOLVED", {
      attemptID: id,
      packet: policy.packet,
      ...(persona ? { persona } : {}),
    })
    if (input.workspaceMode === "shared") {
      if (this.store.plan(plan.id)?.state !== "running") return
      await this.prepareWorker(plan, attempt, fence)
      return
    }
    const effect = this.effect(plan.id, task.id, id, "worktree", { workspace, base }, fence)
    try {
      const actual = await this.host.worktree({ directory: workspace, base })
      if (git(actual, ["rev-parse", "HEAD"]) !== base)
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
    if (this.store.plan(plan.id)?.state !== "running") return
    await this.prepareWorker(plan, attempt, fence)
  }
  /** Resumes must obey the same checkout/scope admission as fresh dispatch. */
  private preparationAllowed(attempt: AttemptRow) {
    const scope = this.store.effectiveWriteScope(attempt.task_id)
    if (
      this.store
        .activeAdoptions()
        .some(
          (adoption) =>
            attempt.workspace === this.directory ||
            scopePatternsConflict(scope, this.store.effectiveWriteScope(adoption.task_id)),
        )
    )
      return false
    for (const plan of this.store.plans()) {
      for (const other of this.store.attempts(plan.id)) {
        if (other.id === attempt.id || !["preparing", "running", "verifying"].includes(other.state))
          continue
        const promptIntended = this.store
          .effects(plan.id)
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
          scopePatternsConflict(scope, this.store.effectiveWriteScope(other.task_id))
        )
          return false
      }
    }
    return true
  }

  private promptAdmissionAllowed(planID: string, attempt: AttemptRow) {
    const plan = this.store.plan(planID)
    const currentAttempt = this.store
      .attempts(planID)
      .find((candidate) => candidate.id === attempt.id)
    if (
      plan?.state !== "running" ||
      currentAttempt?.state !== "preparing" ||
      !this.preparationAllowed(currentAttempt)
    )
      return false

    const prerequisites = PlanInput.parse(JSON.parse(plan.body)).afterPlans ?? []
    if (!prerequisites.length) return true

    try {
      // The reservation base is immutable prerequisite proof. A later HEAD is
      // acceptable only as scoped progress from a prompt already admitted to this attempt.
      const baseline = currentAttempt.base_commit
      const head = git(currentAttempt.workspace, ["rev-parse", "HEAD"])
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
      const changed = changedPaths(currentAttempt.workspace, baseline)
      if ((head !== baseline || changed.length > 0) && !retainedPrompt) return false
      git(currentAttempt.workspace, ["merge-base", "--is-ancestor", baseline, head])
      if (git(currentAttempt.workspace, ["ls-files", "-u", "-z"])) return false
      if (scopeViolations(changed, this.store.effectiveWriteScope(currentAttempt.task_id)).length)
        return false
      return this.integratedPrerequisiteBaseline(prerequisites, baseline) === baseline
    } catch {
      return false
    }
  }

  private observeUsage(attempt: AttemptRow, session: HostSession, fence: number) {
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

  private async prepareWorker(plan: PlanRow, attempt: AttemptRow, fence: number) {
    if (!this.promptAdmissionAllowed(plan.id, attempt)) return
    const existing = this.store.effects(plan.id)
    if (!existing.some((e) => e.attempt_id === attempt.id && e.kind === "session")) {
      if (!this.promptAdmissionAllowed(plan.id, attempt)) return
      const effect = this.effect(
        plan.id,
        attempt.task_id,
        attempt.id,
        "session",
        { sessionID: attempt.session_id },
        fence,
      )
      try {
        await this.host.create({
          id: attempt.session_id,
          parentID: plan.owner,
          agent: "lazers-implementor",
          model: ModelPolicy.parse(JSON.parse(attempt.policy).model),
          directory: attempt.workspace,
          title: `LAZERS · ${this.store.repository.get(attempt.task_id)!.proposal.objective.slice(0, 100)}`,
          attemptID: attempt.id,
        })
        this.receipt(effect, { sessionID: attempt.session_id }, fence)
      } catch (error) {
        this.uncertain(effect, error, fence)
        return
      }
    }
    if (
      !existing.some(
        (e) =>
          e.attempt_id === attempt.id &&
          e.kind === "prompt" &&
          JSON.parse(e.payload).messageID === attempt.message_id,
      )
    ) {
      if (!this.promptAdmissionAllowed(plan.id, attempt)) return
      const effect = this.effect(
        plan.id,
        attempt.task_id,
        attempt.id,
        "prompt",
        {
          sessionID: attempt.session_id,
          messageID: attempt.message_id,
          workspace: attempt.workspace,
        },
        fence,
      )
      try {
        const selectedPersona = WorkerPersona.safeParse(JSON.parse(attempt.policy).persona)
        const personaGuidance = selectedPersona.success
          ? `\n\nSelected ${workerPersonaLabels[selectedPersona.data]} persona (advisory, independent of model/provider):\n${workerPersonaOverlay(selectedPersona.data)}`
          : ""
        await this.host.prompt({
          sessionID: attempt.session_id,
          id: attempt.message_id,
          directory: attempt.workspace,
          text: `Implement task ${attempt.task_id} in ${attempt.workspace}. Fetch readable revision 1 instructions with lz-get-task-instructions before editing. Use lz-get-task only when structured task data is needed. Follow the implementor role, use the task's code-grounded guidance, and finish with a commit and concise results. If continuing an earlier attempt, preserve its progress in this assigned workspace.${personaGuidance}`,
        })
        this.receipt(
          effect,
          {
            messageID: attempt.message_id,
            taskID: attempt.task_id,
            instructions: "readable; lz-get-task-instructions",
          },
          fence,
        )
      } catch (error) {
        this.uncertain(effect, error, fence)
        return
      }
    }
    this.store.fenced(this.owner, fence, (db) =>
      db.query("UPDATE runner_attempts SET state='running' WHERE id=?").run(attempt.id),
    )
    this.workerEvent(plan, attempt, "WORKER_STARTED", fence)
  }

  private async advanceAttempt(plan: PlanRow, attempt: AttemptRow, fence: number) {
    if (attempt.state === "preparing") {
      await this.prepareWorker(plan, attempt, fence)
      return
    }
    let session = await this.host.session(attempt.session_id)
    if (!["running", "blocked"].includes(this.store.plan(plan.id)!.state)) {
      if (session) this.observeUsage(attempt, session, fence)
      return
    }
    if (!session) {
      this.hold(plan, "Owned worker session definitively missing")
      return
    }
    const task = this.store.repository.get(attempt.task_id)!
    this.observeUsage(attempt, session, fence)
    if (!["running", "blocked"].includes(this.store.plan(plan.id)!.state)) return
    const backgroundReason = this.backgroundBlockReason(session, attempt)
    if ((session.pendingPermissions ?? 0) > 0 || (session.pendingForms ?? 0) > 0) {
      this.approvalWait(plan, attempt, session, fence)
      this.hold(
        plan,
        `Worker at ${session.directory} has ${session.pendingPermissions ?? 0} pending permission request(s) and ${session.pendingForms ?? 0} pending form(s)`,
        ["audit", "reconcile", "cancel"],
      )
      return
    }
    if (
      !session.busy &&
      !session.pendingInput &&
      !session.observationUnstable &&
      backgroundReason &&
      !session.outcome
    ) {
      this.hold(plan, backgroundReason, ["audit", "reconcile", "cancel"])
      this.backgroundWait(plan, attempt, session, backgroundReason, fence)
      return
    }
    if (!session.busy && !session.pendingInput && !session.observationUnstable && session.outcome) {
      const detailed = await this.host.session(attempt.session_id, { messages: true })
      if (!["running", "blocked"].includes(this.store.plan(plan.id)!.state)) {
        if (detailed) this.observeUsage(attempt, detailed, fence)
        return
      }
      if (!detailed) {
        this.hold(plan, "Owned worker session disappeared during terminal observation")
        return
      }
      session = detailed
      this.observeUsage(attempt, session, fence)
      if (session.pendingInput || session.observationUnstable) return
      const detailedBackgroundReason = this.backgroundBlockReason(session, attempt, true)
      if ((session.pendingPermissions ?? 0) > 0 || (session.pendingForms ?? 0) > 0) {
        this.approvalWait(plan, attempt, session, fence)
        this.hold(
          plan,
          `Worker at ${session.directory} has ${session.pendingPermissions ?? 0} pending permission request(s) and ${session.pendingForms ?? 0} pending form(s)`,
          ["audit", "reconcile", "cancel"],
        )
        return
      }
      if (session.outcome === "interrupted") {
        this.workerEvent(plan, attempt, "WORKER_STOPPED", fence, "interrupted")
        const reason = detailedBackgroundReason
          ? `Worker execution was interrupted; ${detailedBackgroundReason}`
          : "Worker execution was interrupted; explicit reconciliation or cancellation is required"
        if (detailedBackgroundReason)
          this.backgroundWait(plan, attempt, session, detailedBackgroundReason, fence)
        this.hold(plan, reason, ["audit", "reconcile", "cancel"])
        return
      }
      if (detailedBackgroundReason) {
        this.hold(plan, detailedBackgroundReason, ["audit", "reconcile", "cancel"])
        this.backgroundWait(plan, attempt, session, detailedBackgroundReason, fence)
        return
      }
    }
    if (session.busy || session.pendingInput || session.observationUnstable || !session.outcome)
      return
    this.resumeTransientObservationWait(plan, fence)
    if (
      session.outcome === "succeeded" &&
      (!session.turn ||
        !this.matchesWorkerInput(attempt, session.turn.inputID) ||
        session.turn.state !== "completed")
    ) {
      if (
        session.turn &&
        this.matchesWorkerInput(attempt, session.turn.inputID) &&
        session.turn.state === "pending"
      )
        return
      this.hold(
        plan,
        "Native worker success does not match a completed response to the current assigned input",
        ["audit", "reconcile", "cancel"],
      )
      return
    }
    this.workerEvent(plan, attempt, "WORKER_STOPPED", fence, session.outcome)
    if (session.outcome !== "succeeded") {
      if (session.outcome === "interrupted") {
        this.hold(
          plan,
          "Worker execution was interrupted; explicit reconciliation or cancellation is required",
          ["audit", "reconcile", "cancel"],
        )
        return
      }
      this.failAttempt(plan, attempt, `Worker ${session.outcome}`)
      return
    }
    if (attempt.state === "running") {
      this.store.move(plan.id, task.id, "VERIFY")
      this.store.atomic((db) =>
        db.query("UPDATE runner_attempts SET state='verifying' WHERE id=?").run(attempt.id),
      )
    }
    await this.verify(plan, attempt, task.proposal, fence)
  }

  private async verify(plan: PlanRow, attempt: AttemptRow, proposal: TaskProposal, fence: number) {
    let artifact
    try {
      artifact = commitArtifact(
        attempt.workspace,
        attempt.base_commit,
        this.store.effectiveWriteScope(attempt.task_id),
        attempt.workspace !== this.directory,
        attempt.workspace !== this.directory
          ? git(this.directory, ["rev-parse", "HEAD"])
          : undefined,
      )
    } catch (error) {
      try {
        this.progress.recordAttemptOutcome(
          attempt.id,
          error instanceof ArtifactScopeViolation ? "artifact-scope-violation" : "artifact-error",
          errorText(error),
        )
      } catch {
        // The task state machine remains authoritative if annotation storage is unavailable.
      }
      if (error instanceof ArtifactScopeViolation) {
        this.store.fenced(this.owner, fence, () => {
          this.store.record(plan.id, attempt.task_id, "SCOPE_DECISION_REQUIRED", {
            attemptID: attempt.id,
            workspace: attempt.workspace,
            baseCommit: attempt.base_commit,
            paths: error.paths,
            reason: error.message,
          })
          this.hold(plan, error.message, ["amend-scope", "audit", "reconcile", "cancel"])
        })
        return
      }
      this.failAttempt(plan, attempt, errorText(error))
      return
    }
    this.store.fenced(this.owner, fence, (db) => {
      db.query("UPDATE runner_attempts SET artifact=? WHERE id=?").run(artifact.commit, attempt.id)
      db.query("UPDATE runner_nodes SET artifact=? WHERE plan_id=? AND task_id=?").run(
        artifact.commit,
        plan.id,
        attempt.task_id,
      )
    })
    try {
      this.progress.recordArtifact(attempt.id, artifact.commit)
    } catch {
      // Artifact acceptance and its runner receipt remain independent of commentary.
    }
    const receipts: CheckReceipt[] = []
    for (const check of proposal.verification) {
      if (!["running", "blocked"].includes(this.store.plan(plan.id)!.state)) return
      const known = this.store.effects(plan.id).find((e) => {
        if (e.attempt_id !== attempt.id || e.kind !== `verify:${check.id}`) return false
        const payload = JSON.parse(e.payload)
        return (
          payload.artifact === artifact.commit &&
          payload.identity === artifact.identity &&
          payload.workspace === attempt.workspace &&
          fingerprint(payload.check) === fingerprint(check)
        )
      })
      if (known?.state === "completed") {
        receipts.push(JSON.parse(known.receipt!).check)
        continue
      }
      const receiptPath = join(
        this.dataDirectory,
        "receipts",
        attempt.id,
        `${check.id}-${artifact.commit}.json`,
      )
      const effect = this.effect(
        plan.id,
        attempt.task_id,
        attempt.id,
        `verify:${check.id}`,
        {
          check,
          workspace: attempt.workspace,
          artifact: artifact.commit,
          identity: artifact.identity,
          receiptPath,
        },
        fence,
      )
      try {
        const result = await runCheck(attempt.workspace, artifact.commit, check, receiptPath)
        try {
          this.progress.recordVerification(attempt.id, effect.id, result)
        } catch {
          // The runner receipt below is the authoritative verification record.
        }
        this.receipt(effect, { check: result }, fence)
        this.store.atomic((db) =>
          db
            .query("INSERT INTO runner_evidence VALUES(?,?,?,?,NULL,'verification',?,?,?)")
            .run(
              effect.id,
              plan.id,
              attempt.task_id,
              attempt.id,
              artifact.commit,
              JSON.stringify(result),
              Date.now(),
            ),
        )
        receipts.push(result)
        if (!["running", "blocked"].includes(this.store.plan(plan.id)!.state)) return
      } catch (error) {
        try {
          this.progress.recordVerificationError(attempt.id, effect.id, check.id, error)
        } catch {
          // The runner effect remains authoritative if annotation storage fails.
        }
        this.uncertain(effect, error, fence)
        return
      }
    }
    const failure = receipts.find(
      (r) =>
        r.exitCode !== 0 || r.timedOut || !r.unchanged || r.inputIdentity !== artifact.identity,
    )
    if (failure) {
      this.failAttempt(plan, attempt, `Verification ${failure.id} failed or changed its inputs`)
      return
    }
    const missing = this.missingEvidence(
      plan.id,
      attempt.task_id,
      artifact.commit,
      attempt.workspace,
      proposal.acceptance,
      receipts,
    )
    if (missing.length) {
      this.hold(plan, `Required evidence missing: ${missing.join(", ")}`)
      return
    }
    if (!artifactUnchanged(attempt.workspace, artifact.commit)) {
      this.failAttempt(plan, attempt, "Artifact changed after verification")
      return
    }
    this.store.fenced(this.owner, fence, (db) => {
      if (!["running", "blocked"].includes(this.store.plan(plan.id)!.state)) return
      db.query("UPDATE runner_attempts SET state='accepted' WHERE id=?").run(attempt.id)
      this.store.move(plan.id, attempt.task_id, "ACCEPT")
      this.store.record(plan.id, attempt.task_id, "ARTIFACT_ACCEPTED", artifact)
      this.outcome(
        plan.id,
        {
          status: "task-accepted",
          taskID: attempt.task_id,
          attemptID: attempt.id,
          artifact: artifact.commit,
          evidence: receipts.map((r) => r.id),
        },
        true,
      )
    })
    try {
      this.progress.recordAttemptOutcome(attempt.id, "accepted")
    } catch {
      // Progress facts never grant or revoke acceptance.
    }
  }
  private missingEvidence(
    planID: string,
    taskID: string | null,
    artifact: string,
    workspace: string,
    assertions: TaskProposal["acceptance"],
    receipts: CheckReceipt[],
    adoptionID?: string,
  ) {
    const missing: string[] = []
    for (const assertion of assertions)
      for (const evidence of assertion.evidence) {
        if (
          evidence.kind === "verification" &&
          !receipts.some(
            (r) =>
              r.id === evidence.verificationID && r.exitCode === 0 && !r.timedOut && r.unchanged,
          )
        )
          missing.push(assertion.id)
        if (evidence.kind === "artifact" && !artifactExists(workspace, evidence.reference))
          missing.push(`${assertion.id}:${evidence.reference}`)
        if (evidence.kind === "human") {
          const found = adoptionID
            ? this.store.hasAdoptionEvidence(
                adoptionID,
                taskID === null ? "combined" : "task",
                taskID,
                assertion.id,
                artifact,
              )
            : this.store.atomic((db) =>
                db
                  .query(
                    "SELECT id FROM runner_evidence WHERE plan_id=? AND task_id IS ? AND kind='human' AND assertion_id=? AND artifact=?",
                  )
                  .get(planID, taskID, assertion.id, artifact),
              )
          if (!found) missing.push(`${assertion.id}:human`)
        }
      }
    return missing
  }

  private adoptionIsLive(adoptionID: string): boolean {
    const adoption = this.store.adoption(adoptionID)
    const plan = adoption ? this.store.plan(adoption.plan_id) : undefined
    return Boolean(
      adoption &&
      plan?.state === "blocked" &&
      ["pending", "task-checks", "combined-checks", "waiting-human"].includes(adoption.state),
    )
  }

  private holdAdoption(
    plan: PlanRow,
    adoptionID: string,
    reason: string,
    state: "pending" | "waiting-human" | "held" = "held",
    fence: number,
  ) {
    this.store.fenced(this.owner, fence, () => {
      const current = this.store.adoption(adoptionID)
      const currentPlan = this.store.plan(plan.id)
      if (
        !current ||
        !currentPlan ||
        currentPlan.state === "cancelling" ||
        currentPlan.state === "cancelled" ||
        !["pending", "task-checks", "combined-checks", "waiting-human"].includes(current.state)
      )
        return
      if (
        current.state === state &&
        current.hold_reason === reason &&
        currentPlan.reason === reason
      )
        return
      if (
        !this.store.setAdoptionState(current.id, state, reason, { owner: this.owner, value: fence })
      )
        return
      const changed = this.store.atomic(
        (db) =>
          db
            .query(
              "UPDATE runner_plans SET state='blocked',reason=?,version=version+1 WHERE id=? AND state='blocked' AND reason IS NOT ?",
            )
            .run(reason, plan.id, reason).changes,
      )
      this.store.record(
        plan.id,
        current.task_id,
        state === "waiting-human"
          ? "DESCENDANT_ADOPTION_WAITING_HUMAN"
          : "DESCENDANT_ADOPTION_HELD",
        { adoptionID, reason, state, planVersionChanged: changed === 1 },
      )
    })
  }

  private async validateAdoption(planID: string, adoption: AdoptionRow) {
    const plan = this.store.plan(planID)
    if (!plan || plan.state !== "blocked") throw new Error("Adoption plan is no longer blocked")
    if (plan.owner !== adoption.owner) throw new Error("Descendant adoption owner changed")
    const owner = await this.host.session(plan.owner)
    if (!this.validArchitect(owner) || owner.id !== adoption.owner)
      throw new Error("Descendant adoption owner is missing, stale, or foreign")
    const input = PlanInput.parse(JSON.parse(plan.body))
    const task = this.store.repository.get(adoption.task_id)
    const node = this.store
      .nodes(plan.id)
      .find((candidate) => candidate.task_id === adoption.task_id)
    const attempt = this.store
      .attempts(plan.id)
      .filter((candidate) => candidate.task_id === adoption.task_id)
      .at(-1)
    if (
      !task ||
      !node ||
      !attempt ||
      task.revision !== adoption.task_revision ||
      node.state !== adoption.node_state ||
      node.artifact !== adoption.old_artifact ||
      attempt.id !== adoption.attempt_id ||
      attempt.state !== adoption.attempt_state ||
      attempt.artifact !== adoption.old_artifact
    )
      throw new Error("Task revision, latest attempt, or old artifact changed during adoption")
    if (
      this.store
        .nodes(plan.id)
        .some(
          (candidate) =>
            candidate.task_id !== adoption.task_id &&
            !["accepted", "incorporated"].includes(candidate.state),
        )
    )
      throw new Error("Combined adoption inputs are no longer fully accepted")
    if (this.conflictingActiveAttempt(adoption.task_id))
      throw new Error("A conflicting worker prevents descendant adoption")
    if (
      this.store
        .effects(plan.id)
        .some(
          (effect) =>
            !effect.kind.startsWith("adoption-") &&
            ["intended", "uncertain"].includes(effect.state),
        )
    )
      throw new Error("An uncertain prior effect prevents descendant adoption")
    const competing = this.store.activeAdoptions().filter((item) => item.id !== adoption.id)
    if (
      competing.some((item) =>
        scopePatternsConflict(
          this.store.effectiveWriteScope(adoption.task_id),
          this.store.effectiveWriteScope(item.task_id),
        ),
      )
    )
      throw new Error("A conflicting descendant reservation became active")
    const worker = await this.host.session(attempt.session_id, { messages: true })
    if (
      !worker ||
      worker.id !== attempt.session_id ||
      worker.projectID !== this.projectID ||
      worker.directory !== attempt.workspace ||
      worker.agent !== "lazers-implementor" ||
      worker.archived ||
      worker.metadata?.lazersAttemptID !== attempt.id ||
      !this.adoptionWorkerIdle(attempt, worker)
    )
      throw new Error("Latest worker activity or control state is not conclusively idle")
    const branch = git(this.directory, ["branch", "--show-current"])
    const head = git(this.directory, ["rev-parse", "HEAD"])
    if (branch !== adoption.target_branch || head !== adoption.landing_head)
      throw new Error("Reviewed landing branch or HEAD changed during adoption")
    if (
      git(this.directory, ["status", "--porcelain", "--untracked-files=all"]) ||
      git(this.directory, ["ls-files", "-u", "-z"])
    )
      throw new Error("Dirty or unmerged candidate checkout cannot publish adoption")
    const candidate = git(this.directory, ["rev-parse", `${adoption.descendant_commit}^{commit}`])
    const oldArtifact = git(this.directory, ["rev-parse", `${adoption.old_artifact}^{commit}`])
    if (
      candidate !== adoption.descendant_commit ||
      oldArtifact !== adoption.old_artifact ||
      git(this.directory, ["rev-parse", `${candidate}^{tree}`]) !== adoption.candidate_tree ||
      git(this.directory, ["write-tree"]) !== adoption.candidate_tree
    )
      throw new Error("Candidate or index no longer matches the reviewed adoption inputs")
    git(this.directory, ["merge-base", "--is-ancestor", oldArtifact, candidate])
    const reviewedBaseline = this.reviewedAdoptionBaseline(
      adoption.target_branch,
      oldArtifact,
      candidate,
    )
    if (reviewedBaseline !== adoption.reviewed_baseline)
      throw new Error("Reviewed adoption baseline changed during adoption")
    const scopeBase = reviewedScopeBase(this.directory, oldArtifact, candidate, reviewedBaseline)
    const violations = scopeViolations(
      changedPaths(this.directory, scopeBase),
      this.store.effectiveWriteScope(adoption.task_id),
    )
    if (violations.length)
      throw new Error(
        `Candidate contains out-of-scope changes: ${violations.slice(0, 20).join(", ")}`,
      )
    const branches = input.integrationOrder.map((taskID) => {
      if (taskID === adoption.task_id) return candidate
      const other = this.store.nodes(plan.id).find((item) => item.task_id === taskID)
      if (!other?.artifact || !["accepted", "incorporated"].includes(other.state))
        throw new Error("Combined adoption requires every other accepted artifact")
      return other.artifact
    })
    const combinedArtifact = combineArtifacts(this.directory, input.baseCommit, branches)
    if (combinedArtifact !== adoption.combined_artifact)
      throw new Error("Combined artifact inputs changed during adoption")
    const environmentIdentity = verificationEnvironmentIdentity()
    if (environmentIdentity !== adoption.environment_identity)
      throw new Error("Check environment changed during adoption")
    const currentFingerprint = this.adoptionInputFingerprint({
      plan,
      originalPlanVersion: adoption.plan_version,
      taskID: task.id,
      taskRevision: task.revision,
      attemptID: attempt.id,
      nodeState: node.state,
      attemptState: attempt.state,
      oldArtifact: adoption.old_artifact,
      descendantCommit: candidate,
      targetBranch: branch,
      landingHead: head,
      reviewedBaseline,
      candidateTree: adoption.candidate_tree,
      combinedArtifact,
      reason: adoption.reason,
      environmentIdentity,
    })
    if (currentFingerprint !== adoption.input_fingerprint)
      throw new Error(
        "Adoption input vector changed; this operation's evidence is no longer reusable",
      )
    return { plan, input, task, node, attempt }
  }

  private async ensureAdoptionWorkspace(
    plan: PlanRow,
    adoption: AdoptionRow,
    phase: "task" | "combined",
    base: string,
    fence: number,
  ): Promise<string | undefined> {
    const kind = phase === "task" ? "adoption-task-worktree" : "adoption-combined-worktree"
    const workspaceField = phase === "task" ? adoption.task_workspace : adoption.combined_workspace
    const existing = this.store.effects(plan.id).find((effect) => {
      if (effect.kind !== kind) return false
      try {
        return JSON.parse(effect.payload).adoptionID === adoption.id
      } catch {
        return false
      }
    })
    if (existing) {
      if (existing.state !== "completed") {
        await this.reconcileEffect(existing, fence)
        return undefined
      }
      const workspace = workspaceField ?? JSON.parse(existing.receipt!).workspace
      if (
        !existsSync(workspace) ||
        git(workspace, ["rev-parse", "HEAD"]) !== base ||
        git(workspace, ["status", "--porcelain", "--untracked-files=all"]) ||
        git(workspace, ["ls-files", "-u", "-z"])
      )
        throw new Error(`Owned adoption worktree changed; preserve ${workspace}`)
      return workspace
    }
    if (!this.adoptionIsLive(adoption.id)) return undefined
    const workspace = join(
      realpathSync(dirname(this.dataDirectory)),
      "runner",
      "worktrees",
      `adoption-${adoption.id}-${phase}`,
    )
    const effect = this.effect(
      plan.id,
      phase === "task" ? adoption.task_id : null,
      null,
      kind,
      { adoptionID: adoption.id, workspace, base },
      fence,
    )
    if (!this.adoptionIsLive(adoption.id)) {
      this.store.fenced(this.owner, fence, (db) =>
        db
          .query(
            "UPDATE runner_effects SET state='failed',receipt=? WHERE id=? AND state='intended'",
          )
          .run(
            JSON.stringify({
              notSent: true,
              reason: "Adoption was cancelled before worktree creation",
            }),
            effect.id,
          ),
      )
      return undefined
    }
    try {
      const actual = await this.host.worktree({ directory: workspace, base })
      if (
        actual === this.directory ||
        git(actual, ["rev-parse", "HEAD"]) !== base ||
        git(actual, ["status", "--porcelain", "--untracked-files=all"]) ||
        git(actual, ["ls-files", "-u", "-z"])
      )
        throw new Error("Adoption worktree is not a clean exact-candidate checkout")
      this.receipt(effect, { workspace: actual, base }, fence)
      this.store.setAdoptionWorkspace(adoption.id, phase, actual, {
        owner: this.owner,
        value: fence,
      })
      return this.adoptionIsLive(adoption.id) ? actual : undefined
    } catch (error) {
      this.store.fenced(this.owner, fence, (db) =>
        db
          .query("UPDATE runner_effects SET state='uncertain',receipt=? WHERE id=?")
          .run(JSON.stringify({ error: errorText(error) }), effect.id),
      )
      this.holdAdoption(
        plan,
        adoption.id,
        `Recovery uncertain for ${kind} ${effect.id}: ${errorText(error)}`,
        "pending",
        fence,
      )
      return undefined
    }
  }

  private adoptionCheckReceiptMatches(
    receipt: CheckReceipt,
    row: AdoptionCheckRow,
    check: TaskProposal["verification"][number],
  ): boolean {
    return (
      receipt.id === check.id &&
      receipt.command === check.command &&
      receipt.cwd === row.workspace &&
      receipt.artifact === row.artifact &&
      receipt.inputIdentity === row.artifact &&
      receipt.environmentIdentity === row.environment_identity
    )
  }

  private async runAdoptionChecks(
    plan: PlanRow,
    adoption: AdoptionRow,
    phase: "task" | "combined",
    checks: TaskProposal["verification"],
    workspace: string,
    artifact: string,
    fence: number,
  ): Promise<CheckReceipt[] | undefined> {
    const receipts: CheckReceipt[] = []
    for (const check of checks) {
      if (!this.adoptionIsLive(adoption.id)) return undefined
      const environmentIdentity = verificationEnvironmentIdentity()
      const inputFingerprint = fingerprint({
        adoptionID: adoption.id,
        adoptionInputFingerprint: adoption.input_fingerprint,
        phase,
        check,
        workspace,
        artifact,
        environmentIdentity,
      })
      const receiptPath = join(
        this.dataDirectory,
        "receipts",
        "adoptions",
        adoption.id,
        `${phase}-${check.id}.json`,
      )
      const row = this.store
        .adoptionChecks(adoption.id, phase)
        .find((item) => item.check_id === check.id)
      if (row) {
        if (
          row.input_fingerprint !== inputFingerprint ||
          row.environment_identity !== environmentIdentity ||
          row.workspace !== workspace ||
          row.artifact !== artifact ||
          fingerprint(JSON.parse(row.check_json)) !== fingerprint(check) ||
          row.receipt_path !== receiptPath
        ) {
          this.holdAdoption(
            plan,
            adoption.id,
            `Adoption verification inputs changed for ${phase}:${check.id}`,
            "held",
            fence,
          )
          return undefined
        }
        let previous: CheckReceipt | undefined
        try {
          if (row.state === "completed" && row.receipt)
            previous = JSON.parse(row.receipt) as CheckReceipt
          else if (existsSync(row.receipt_path))
            previous = JSON.parse(readFileSync(row.receipt_path, "utf8")) as CheckReceipt
        } catch {
          previous = undefined
        }
        if (previous && this.adoptionCheckReceiptMatches(previous, row, check)) {
          if (row.state !== "completed") {
            this.store.completeAdoptionCheck(adoption.id, phase, check.id, previous, {
              owner: this.owner,
              value: fence,
            })
          }
          receipts.push(previous)
          if (!this.adoptionIsLive(adoption.id)) return undefined
          continue
        }
        if (row.state !== "completed")
          this.store.markAdoptionCheckUncertain(
            adoption.id,
            phase,
            check.id,
            "No conclusive operation-bound check receipt; check was not repeated",
            { owner: this.owner, value: fence },
          )
        this.holdAdoption(
          plan,
          adoption.id,
          `Uncertain adoption check ${phase}:${check.id}; evidence was not replayed`,
          "pending",
          fence,
        )
        return undefined
      }
      const candidateClean =
        existsSync(workspace) &&
        git(workspace, ["rev-parse", "HEAD"]) === artifact &&
        !git(workspace, ["status", "--porcelain", "--untracked-files=all"]) &&
        !git(workspace, ["ls-files", "-u", "-z"])
      if (!candidateClean) {
        this.holdAdoption(
          plan,
          adoption.id,
          `Adoption verification workspace is dirty or not the exact ${phase} artifact`,
          "held",
          fence,
        )
        return undefined
      }
      this.store.beginAdoptionCheck({
        adoptionID: adoption.id,
        phase,
        checkID: check.id,
        check,
        workspace,
        artifact,
        inputFingerprint,
        environmentIdentity,
        receiptPath,
        fence: { owner: this.owner, value: fence },
      })
      if (!this.adoptionIsLive(adoption.id)) return undefined
      try {
        const receipt = await runCheck(workspace, artifact, check, receiptPath)
        this.store.completeAdoptionCheck(adoption.id, phase, check.id, receipt, {
          owner: this.owner,
          value: fence,
        })
        receipts.push(receipt)
        if (
          verificationEnvironmentIdentity() !== environmentIdentity ||
          !this.adoptionIsLive(adoption.id)
        )
          return undefined
      } catch (error) {
        this.store.markAdoptionCheckUncertain(adoption.id, phase, check.id, errorText(error), {
          owner: this.owner,
          value: fence,
        })
        this.holdAdoption(
          plan,
          adoption.id,
          `Uncertain adoption check ${phase}:${check.id}: ${errorText(error)}`,
          "pending",
          fence,
        )
        return undefined
      }
    }
    return receipts
  }

  private async advanceAdoption(plan: PlanRow, initial: AdoptionRow, fence: number) {
    let adoption = this.store.adoption(initial.id)
    if (!adoption || !this.adoptionIsLive(adoption.id)) return
    let context: Awaited<ReturnType<TaskRuntime["validateAdoption"]>>
    try {
      context = await this.validateAdoption(plan.id, adoption)
    } catch (error) {
      this.holdAdoption(plan, adoption.id, errorText(error), "held", fence)
      return
    }
    if (!this.adoptionIsLive(adoption.id)) return
    const taskWorkspace = await this.ensureAdoptionWorkspace(
      plan,
      adoption,
      "task",
      adoption.descendant_commit,
      fence,
    )
    if (!taskWorkspace || !this.adoptionIsLive(adoption.id)) return
    this.store.setAdoptionState(adoption.id, "task-checks", null, {
      owner: this.owner,
      value: fence,
    })
    adoption = this.store.adoption(adoption.id)!
    const taskReceipts = await this.runAdoptionChecks(
      plan,
      adoption,
      "task",
      context.task.proposal.verification,
      taskWorkspace,
      adoption.descendant_commit,
      fence,
    )
    if (!taskReceipts || !this.adoptionIsLive(adoption.id)) return
    if (
      taskReceipts.some(
        (receipt) =>
          receipt.exitCode !== 0 ||
          receipt.timedOut ||
          !receipt.unchanged ||
          receipt.inputIdentity !== adoption!.descendant_commit ||
          receipt.environmentIdentity !== verificationEnvironmentIdentity(),
      )
    ) {
      this.holdAdoption(
        plan,
        adoption.id,
        "Fresh task verification failed or changed its inputs",
        "held",
        fence,
      )
      return
    }
    try {
      context = await this.validateAdoption(plan.id, adoption)
    } catch (error) {
      this.holdAdoption(plan, adoption.id, errorText(error), "held", fence)
      return
    }
    const combinedWorkspace = await this.ensureAdoptionWorkspace(
      plan,
      adoption,
      "combined",
      adoption.combined_artifact,
      fence,
    )
    if (!combinedWorkspace || !this.adoptionIsLive(adoption.id)) return
    this.store.setAdoptionState(adoption.id, "combined-checks", null, {
      owner: this.owner,
      value: fence,
    })
    adoption = this.store.adoption(adoption.id)!
    const combinedReceipts = await this.runAdoptionChecks(
      plan,
      adoption,
      "combined",
      context.input.verification,
      combinedWorkspace,
      adoption.combined_artifact,
      fence,
    )
    if (!combinedReceipts || !this.adoptionIsLive(adoption.id)) return
    if (
      combinedReceipts.some(
        (receipt) =>
          receipt.exitCode !== 0 ||
          receipt.timedOut ||
          !receipt.unchanged ||
          receipt.inputIdentity !== adoption!.combined_artifact ||
          receipt.environmentIdentity !== verificationEnvironmentIdentity(),
      )
    ) {
      this.holdAdoption(
        plan,
        adoption.id,
        "Fresh combined artifact verification failed or changed its inputs",
        "held",
        fence,
      )
      return
    }
    try {
      context = await this.validateAdoption(plan.id, adoption)
    } catch (error) {
      this.holdAdoption(plan, adoption.id, errorText(error), "held", fence)
      return
    }
    const taskMissing = this.missingEvidence(
      plan.id,
      adoption.task_id,
      adoption.descendant_commit,
      taskWorkspace,
      context.task.proposal.acceptance,
      taskReceipts,
      adoption.id,
    )
    const combinedMissing = this.missingEvidence(
      plan.id,
      null,
      adoption.combined_artifact,
      combinedWorkspace,
      context.input.acceptance,
      combinedReceipts,
      adoption.id,
    )
    const missing = [
      ...taskMissing.map((item) => `task:${item}`),
      ...combinedMissing.map((item) => `combined:${item}`),
    ]
    if (missing.length) {
      const humanOnly = [...taskMissing, ...combinedMissing].every((item) =>
        item.endsWith(":human"),
      )
      this.holdAdoption(
        plan,
        adoption.id,
        `Required adoption evidence missing: ${missing.join(", ")}`,
        humanOnly ? "waiting-human" : "held",
        fence,
      )
      return
    }
    if (
      !artifactUnchanged(taskWorkspace, adoption.descendant_commit) ||
      !artifactUnchanged(combinedWorkspace, adoption.combined_artifact)
    ) {
      this.holdAdoption(
        plan,
        adoption.id,
        "Adoption artifact changed after fresh verification",
        "held",
        fence,
      )
      return
    }
    try {
      context = await this.validateAdoption(plan.id, adoption)
    } catch (error) {
      this.holdAdoption(plan, adoption.id, errorText(error), "held", fence)
      return
    }
    this.store.fenced(this.owner, fence, (db) => {
      const current = this.store.adoption(adoption!.id)
      const currentPlan = this.store.plan(plan.id)
      const currentNode = this.store
        .nodes(plan.id)
        .find((node) => node.task_id === adoption!.task_id)
      if (
        !current ||
        !currentPlan ||
        currentPlan.state !== "blocked" ||
        !["pending", "task-checks", "combined-checks", "waiting-human"].includes(current.state) ||
        !currentNode ||
        currentNode.state !== adoption!.node_state ||
        currentNode.artifact !== adoption!.old_artifact
      )
        return
      if (
        git(this.directory, ["branch", "--show-current"]) !== adoption!.target_branch ||
        git(this.directory, ["rev-parse", "HEAD"]) !== adoption!.landing_head ||
        git(this.directory, ["status", "--porcelain", "--untracked-files=all"]) ||
        verificationEnvironmentIdentity() !== adoption!.environment_identity
      )
        return
      const activeWorker = this.conflictingActiveAttempt(adoption!.task_id)
      if (activeWorker) {
        const reason = "A conflicting worker prevents descendant adoption publication"
        const held = db
          .query(
            `UPDATE runner_adoptions SET state='held',hold_reason=?,updated_at=?
             WHERE id=? AND state IN ('pending','task-checks','combined-checks','waiting-human')`,
          )
          .run(reason, Date.now(), adoption!.id).changes
        if (!held) return
        db.query(
          "UPDATE runner_plans SET state='blocked',reason=?,version=version+1 WHERE id=? AND state='blocked'",
        ).run(reason, plan.id)
        this.store.record(plan.id, adoption!.task_id, "DESCENDANT_ADOPTION_HELD", {
          adoptionID: adoption!.id,
          reason,
          activeAttemptID: activeWorker.id,
        })
        return
      }
      if (currentNode.state === "accepted") {
        db.query(
          "UPDATE runner_nodes SET artifact=?,version=version+1 WHERE plan_id=? AND task_id=? AND state='accepted' AND artifact=?",
        ).run(adoption!.descendant_commit, plan.id, adoption!.task_id, adoption!.old_artifact)
      } else {
        db.query(
          "UPDATE runner_nodes SET artifact=? WHERE plan_id=? AND task_id=? AND state=? AND artifact=?",
        ).run(
          adoption!.descendant_commit,
          plan.id,
          adoption!.task_id,
          adoption!.node_state,
          adoption!.old_artifact,
        )
        this.store.move(plan.id, adoption!.task_id, "ADOPT_ACCEPT")
      }
      this.store.record(plan.id, adoption!.task_id, "DESCENDANT_ADOPTED", {
        adoptionID: adoption!.id,
        attemptID: adoption!.attempt_id,
        oldArtifact: adoption!.old_artifact,
        descendantCommit: adoption!.descendant_commit,
        targetBranch: adoption!.target_branch,
        landingHead: adoption!.landing_head,
        reason: adoption!.reason,
        taskChecks: taskReceipts,
        combinedChecks: combinedReceipts,
      })
      const changed = db
        .query(
          `UPDATE runner_adoptions SET state='accepted',hold_reason=NULL,updated_at=?
           WHERE id=? AND state IN ('pending','task-checks','combined-checks','waiting-human')`,
        )
        .run(Date.now(), adoption!.id).changes
      if (!changed) return
      db.query(
        "UPDATE runner_plans SET state='accepted',reason=NULL,artifact=?,version=version+1 WHERE id=? AND state='blocked'",
      ).run(adoption!.combined_artifact, plan.id)
      this.store.record(plan.id, null, "PLAN_ACCEPTED", {
        artifact: adoption!.combined_artifact,
        checks: combinedReceipts,
        adoptionID: adoption!.id,
        taskArtifact: adoption!.descendant_commit,
      })
      this.outcome(
        plan.id,
        {
          status: "accepted",
          artifact: adoption!.combined_artifact,
          evidence: combinedReceipts,
          taskIDs: context.input.integrationOrder,
          adoptionID: adoption!.id,
        },
        true,
      )
    })
  }

  private failAttempt(plan: PlanRow, attempt: AttemptRow, reason: string) {
    const task = this.store.repository.get(attempt.task_id)!
    const node = this.store.nodes(plan.id).find((n) => n.task_id === task.id)!
    this.store.atomic((db) => {
      db.query("UPDATE runner_attempts SET state='failed' WHERE id=?").run(attempt.id)
      if (
        node.state === "verifying" &&
        (task.proposal.limits?.maxRepairAttempts ?? 1) > 0 &&
        !JSON.parse(attempt.policy).repairAttempt
      )
        this.store.move(plan.id, task.id, "REPAIR", reason)
      else this.store.move(plan.id, task.id, "FAIL", reason)
    })
    try {
      this.progress.recordAttemptOutcome(attempt.id, "failed", reason)
    } catch {
      // Runtime transitions remain authoritative if annotation storage is unavailable.
    }
    if (this.store.execution(task.id)?.state === "failed") this.hold(plan, reason)
  }
  private async finish(plan: PlanRow, fence: number) {
    if (this.store.plan(plan.id)?.state !== "running") return
    const input = PlanInput.parse(JSON.parse(plan.body))
    const nodes = this.store.nodes(plan.id)
    const branches = input.integrationOrder.flatMap((taskID) => {
      const node = nodes.find((candidate) => candidate.task_id === taskID)
      return node?.artifact ? [node.artifact] : []
    })
    if (branches.length !== input.integrationOrder.length) {
      this.hold(plan, "An accepted task artifact is missing from the integration order")
      return
    }
    let artifact: string
    try {
      artifact = combineArtifacts(this.directory, input.baseCommit, branches)
    } catch (error) {
      this.hold(plan, `Combined artifact conflict: ${errorText(error)}`)
      return
    }
    const attempts = this.store.attempts(plan.id)
    const shared =
      JSON.parse(plan.body).workspaceMode === undefined
        ? attempts.at(-1)?.workspace === this.directory
        : input.workspaceMode === "shared"
    let workspace = this.directory
    if (!shared || !artifactUnchanged(this.directory, artifact)) {
      const existing = this.store
        .effects(plan.id)
        .find(
          (effect) =>
            effect.kind === "graph-worktree" &&
            effect.state === "completed" &&
            JSON.parse(effect.payload).base === artifact,
        )
      const matchingAttempt = attempts.find(
        (attempt) => attempt.state === "accepted" && attempt.artifact === artifact,
      )
      if (existing) workspace = JSON.parse(existing.receipt!).workspace
      else if (
        matchingAttempt &&
        existsSync(matchingAttempt.workspace) &&
        artifactUnchanged(matchingAttempt.workspace, artifact)
      )
        workspace = matchingAttempt.workspace
      else {
        const proposed = join(this.dataDirectory, "worktrees", crypto.randomUUID())
        const effect = this.effect(
          plan.id,
          null,
          null,
          "graph-worktree",
          { workspace: proposed, base: artifact },
          fence,
        )
        try {
          const actual = await this.host.worktree({ directory: proposed, base: artifact })
          if (git(actual, ["rev-parse", "HEAD"]) !== artifact)
            throw new Error("Combined worktree did not use the accepted artifact")
          this.receipt(effect, { workspace: actual, base: artifact }, fence)
          workspace = actual
        } catch (error) {
          this.uncertain(effect, error, fence)
          return
        }
      }
    }
    // Explicit reconciliation may follow a conclusive verifier/environment
    // failure. Keep prior effects and give the requested check run its own ID;
    // never replay uncertain effects or silently retry on ordinary ticks.
    const verificationEpoch =
      this.store.latestTransition<{ verificationEpoch?: number }>(
        plan.id,
        null,
        "RECONCILE_REQUESTED",
      )?.verificationEpoch ?? 0
    const receipts: CheckReceipt[] = []
    for (const check of input.verification) {
      if (this.store.plan(plan.id)?.state !== "running") return
      const existing = this.store
        .effects(plan.id)
        .find(
          (e) =>
            e.kind === `graph-verify:${check.id}` &&
            JSON.parse(e.payload).artifact === artifact &&
            JSON.parse(e.payload).workspace === workspace &&
            (JSON.parse(e.payload).verificationEpoch ?? 0) === verificationEpoch &&
            fingerprint(JSON.parse(e.payload).check) === fingerprint(check),
        )
      if (existing?.state === "completed") {
        receipts.push(JSON.parse(existing.receipt!).check)
        continue
      }
      const receiptPath = join(
        this.dataDirectory,
        "receipts",
        plan.id,
        `${check.id}-${artifact}${verificationEpoch ? `-${verificationEpoch}` : ""}.json`,
      )
      const effect = this.effect(
        plan.id,
        null,
        null,
        `graph-verify:${check.id}`,
        {
          workspace,
          artifact,
          identity: artifact,
          check,
          receiptPath,
          ...(verificationEpoch ? { verificationEpoch } : {}),
        },
        fence,
      )
      try {
        const result = await runCheck(workspace, artifact, check, receiptPath)
        this.receipt(effect, { check: result }, fence)
        receipts.push(result)
        if (this.store.plan(plan.id)?.state !== "running") return
      } catch (error) {
        this.uncertain(effect, error, fence)
        return
      }
    }
    if (receipts.some((r) => r.exitCode !== 0 || r.timedOut || !r.unchanged)) {
      this.hold(plan, "Combined artifact verification failed")
      return
    }
    const missing = this.missingEvidence(
      plan.id,
      null,
      artifact,
      workspace,
      input.acceptance,
      receipts,
    )
    if (missing.length) {
      this.hold(plan, `Combined artifact evidence missing: ${missing.join(", ")}`)
      return
    }
    this.store.fenced(this.owner, fence, (db) => {
      if (this.store.plan(plan.id)?.state !== "running") return
      db.query(
        "UPDATE runner_plans SET state='accepted',artifact=?,version=version+1 WHERE id=?",
      ).run(artifact, plan.id)
      this.store.record(plan.id, null, "PLAN_ACCEPTED", { artifact, checks: receipts })
      this.outcome(
        plan.id,
        { status: "accepted", artifact, evidence: receipts, taskIDs: input.integrationOrder },
        true,
      )
    })
  }
  private assertAdoptionWorkspaceQuiescent(plan: PlanRow, effect: EffectRow, workspace: string) {
    const payload = JSON.parse(effect.payload) as { adoptionID?: unknown }
    if (typeof payload.adoptionID !== "string")
      throw new Error("Adoption worktree ownership is missing; preserve the workspace")
    const adoption = this.store.adoption(payload.adoptionID)
    const phase = effect.kind === "adoption-task-worktree" ? "task" : "combined"
    const expectedWorkspace =
      phase === "task" ? adoption?.task_workspace : adoption?.combined_workspace
    if (
      !adoption ||
      adoption.plan_id !== plan.id ||
      adoption.state !== "accepted" ||
      expectedWorkspace !== workspace
    )
      throw new Error("Adoption worktree is not owned by an accepted adoption; preserve it")
    const task = this.store.repository.get(adoption.task_id)
    const checks =
      phase === "task"
        ? task?.proposal.verification
        : PlanInput.parse(JSON.parse(plan.body)).verification
    if (!checks) throw new Error("Adoption check procedure is missing; preserve the workspace")
    const rows = this.store.adoptionChecks(adoption.id, phase)
    if (rows.length !== checks.length)
      throw new Error("Adoption worktree has no complete receipt for every check; preserve it")
    const artifact = phase === "task" ? adoption.descendant_commit : adoption.combined_artifact
    for (const check of checks) {
      const row = rows.find((item) => item.check_id === check.id)
      let receipt: CheckReceipt | undefined
      try {
        if (row?.receipt) receipt = JSON.parse(row.receipt) as CheckReceipt
      } catch {
        receipt = undefined
      }
      if (
        !row ||
        row.state !== "completed" ||
        row.workspace !== workspace ||
        row.artifact !== artifact ||
        row.environment_identity !== adoption.environment_identity ||
        fingerprint(JSON.parse(row.check_json)) !== fingerprint(check) ||
        !receipt ||
        !this.adoptionCheckReceiptMatches(receipt, row, check) ||
        receipt.exitCode !== 0 ||
        receipt.timedOut ||
        !receipt.unchanged
      )
        throw new Error(
          "Adoption worktree check activity is not conclusively complete; preserve it",
        )
    }
  }

  private assertGraphWorkspaceQuiescent(plan: PlanRow, workspace: string) {
    if (!plan.artifact) throw new Error("Combined artifact is missing; preserve the workspace")
    const checks = PlanInput.parse(JSON.parse(plan.body)).verification
    const effects = this.store.effects(plan.id)
    for (const check of checks) {
      const matches = effects.filter((effect) => {
        if (effect.kind !== `graph-verify:${check.id}`) return false
        try {
          const payload = JSON.parse(effect.payload) as { workspace?: unknown; artifact?: unknown }
          return payload.workspace === workspace && payload.artifact === plan.artifact
        } catch {
          return false
        }
      })
      const effect = matches.at(-1)
      let receipt: CheckReceipt | undefined
      let payload: { check?: unknown } | undefined
      try {
        if (effect) {
          payload = JSON.parse(effect.payload) as typeof payload
          const body = JSON.parse(effect.receipt ?? "{}") as { check?: CheckReceipt }
          receipt = body.check
        }
      } catch {
        receipt = undefined
      }
      if (
        !effect ||
        effect.state !== "completed" ||
        fingerprint(payload?.check) !== fingerprint(check) ||
        !receipt ||
        receipt.id !== check.id ||
        receipt.command !== check.command ||
        receipt.cwd !== workspace ||
        receipt.artifact !== plan.artifact ||
        receipt.inputIdentity !== plan.artifact ||
        receipt.exitCode !== 0 ||
        receipt.timedOut ||
        !receipt.unchanged
      )
        throw new Error(
          "Combined worktree check activity is not conclusively complete; preserve it",
        )
    }
  }

  private async assertWorktreeQuiescent(plan: PlanRow, effect: EffectRow, workspace: string) {
    if (effect.kind.startsWith("adoption-")) {
      if (this.store.attempts(plan.id).some((attempt) => attempt.workspace === workspace))
        throw new Error("Adoption worktree unexpectedly has an attempt owner; preserve it")
      this.assertAdoptionWorkspaceQuiescent(plan, effect, workspace)
      return
    }
    if (effect.kind === "graph-worktree") {
      if (this.store.attempts(plan.id).some((attempt) => attempt.workspace === workspace))
        throw new Error("Combined worktree unexpectedly has an attempt owner; preserve it")
      this.assertGraphWorkspaceQuiescent(plan, workspace)
      return
    }
    const attempts = this.store
      .attempts(plan.id)
      .filter((attempt) => attempt.workspace === workspace)
    if (!attempts.length)
      throw new Error("Owned worktree has no matching attempt; preserve it for reconciliation")
    for (const attempt of attempts) {
      const session = await this.host.session(attempt.session_id, { messages: true })
      if (
        !session ||
        session.id !== attempt.session_id ||
        session.projectID !== this.projectID ||
        session.directory !== workspace ||
        session.agent !== "lazers-implementor" ||
        session.metadata?.lazersAttemptID !== attempt.id ||
        session.busy !== false ||
        session.pendingInput === true ||
        session.observationUnstable ||
        (session.pendingPermissions ?? 0) !== 0 ||
        (session.pendingForms ?? 0) !== 0 ||
        !session.outcome ||
        !["completed", "interrupted"].includes(session.turn?.state ?? "unknown") ||
        this.backgroundBlockReason(session, attempt, true)
      )
        throw new Error("Owned worktree worker activity is not conclusively idle; preserve it")
    }
  }

  private abandonCleanupEffect(effect: EffectRow, fence: number) {
    this.store.fenced(this.owner, fence, (db) => {
      const plan = db
        .query<{ state: string }, [string]>("SELECT state FROM runner_plans WHERE id=?")
        .get(effect.plan_id)
      if (plan?.state === "cleaning") return
      const changed = db
        .query(
          "UPDATE runner_effects SET state='failed',receipt=? WHERE id=? AND state IN ('intended','uncertain')",
        )
        .run(
          JSON.stringify({ notSent: true, reason: "Cleanup was superseded before removal" }),
          effect.id,
        ).changes
      if (changed)
        this.store.record(effect.plan_id, null, "EFFECT_NOT_SENT", {
          effectID: effect.id,
          kind: effect.kind,
          reason: "Cleanup was superseded before removal",
        })
    })
  }
  private async cleanupWorktrees(plan: PlanRow, fence: number) {
    const cleanupCurrent = () => this.store.plan(plan.id)?.state === "cleaning"
    if (!cleanupCurrent()) return
    const owned = [
      ...new Set(
        this.store
          .effects(plan.id)
          .filter(
            (effect) =>
              [
                "worktree",
                "graph-worktree",
                "adoption-task-worktree",
                "adoption-combined-worktree",
              ].includes(effect.kind) && effect.state === "completed",
          )
          .map((effect) => JSON.parse(effect.receipt!).workspace as string),
      ),
    ]
    for (const workspace of owned) {
      if (workspace === this.directory) throw new Error("Refusing to remove the shared checkout")
      const effect =
        this.store
          .effects(plan.id)
          .find(
            (entry) =>
              entry.kind === "worktree-remove" && JSON.parse(entry.payload).workspace === workspace,
          ) ?? this.effect(plan.id, null, null, "worktree-remove", { workspace }, fence)
      if (effect.state === "completed") continue
      let removalStarted = false
      try {
        const listed = await this.host.worktrees()
        if (!cleanupCurrent()) {
          this.abandonCleanupEffect(effect, fence)
          return
        }
        if (listed.includes(workspace)) {
          const sourceEffect = this.store.effects(plan.id).find((entry) => {
            if (
              ![
                "worktree",
                "graph-worktree",
                "adoption-task-worktree",
                "adoption-combined-worktree",
              ].includes(entry.kind) ||
              entry.state !== "completed"
            )
              return false
            try {
              return JSON.parse(entry.receipt ?? "{}").workspace === workspace
            } catch {
              return false
            }
          })
          if (!sourceEffect)
            throw new Error("Owned worktree has no completed creation receipt; preserve it")
          await this.assertWorktreeQuiescent(plan, sourceEffect, workspace)
          if (!cleanupCurrent()) {
            this.abandonCleanupEffect(effect, fence)
            return
          }
          if (git(workspace, ["status", "--porcelain"]))
            throw new Error(`Owned worktree is dirty; preserve ${workspace}`)
          const head = git(workspace, ["rev-parse", "HEAD"])
          try {
            git(this.directory, ["merge-base", "--is-ancestor", head, "HEAD"])
          } catch {
            throw new Error(`Owned worktree has unmerged commits; preserve ${workspace}`)
          }
          removalStarted = true
          await this.host.removeWorktree(workspace)
        } else if (existsSync(workspace))
          throw new Error(
            "Owned directory is not registered with OpenCode; preserve it for reconciliation",
          )
        this.receipt(effect, { workspace, removed: true, native: true }, fence)
        if (!cleanupCurrent()) return
      } catch (error) {
        const reason = errorText(error)
        if (!cleanupCurrent() && !removalStarted) {
          this.abandonCleanupEffect(effect, fence)
          return
        }
        let blocked = false
        this.store.fenced(this.owner, fence, (db) => {
          db.query("UPDATE runner_effects SET state='uncertain',receipt=? WHERE id=?").run(
            JSON.stringify({ error: reason }),
            effect.id,
          )
          blocked =
            db
              .query(
                "UPDATE runner_plans SET state='cleanup-blocked',reason=?,version=version+1 WHERE id=? AND state='cleaning'",
              )
              .run(reason, plan.id).changes === 1
          if (blocked) this.store.record(plan.id, null, "CLEANUP_BLOCKED", { workspace, reason })
        })
        if (!blocked) return
        this.outcome(
          plan.id,
          {
            status: "cleanup-blocked",
            reason,
            artifact: plan.artifact,
            allowedActions: ["integrated"],
          },
          true,
        )
        return
      }
    }
    let integrated = false
    this.store.fenced(this.owner, fence, (db) => {
      integrated =
        db
          .query(
            "UPDATE runner_plans SET state='integrated',reason=NULL,version=version+1 WHERE id=? AND state='cleaning'",
          )
          .run(plan.id).changes === 1
      if (integrated)
        this.store.record(plan.id, null, "WORKTREES_RECONCILED", {
          directories: owned,
          artifact: plan.artifact,
        })
    })
    if (!integrated) return
    this.outcome(
      plan.id,
      { status: "integrated", artifact: plan.artifact, worktreesRemoved: owned },
      false,
    )
  }
  private async reconcileEffect(effect: EffectRow, fence: number) {
    const payload = JSON.parse(effect.payload)
    try {
      if (effect.kind === "scope-instruction") {
        const update = payload as WorkerInstruction
        const attempt = this.store
          .attempts(effect.plan_id)
          .find((item) => item.id === effect.attempt_id)
        const plan = this.store.plan(effect.plan_id)!
        if (
          !attempt ||
          attempt.task_id !== effect.task_id ||
          update.attemptID !== attempt.id ||
          update.sessionID !== attempt.session_id ||
          update.directory !== attempt.workspace ||
          update.projectID !== this.projectID
        )
          throw new Error("Scope instruction no longer matches its owned attempt")
        if (
          plan.state === "cancelling" ||
          terminal.has(plan.state) ||
          !["preparing", "running", "verifying"].includes(attempt.state)
        ) {
          this.receipt(
            effect,
            {
              skipped: true,
              reason: "Attempt no longer executing",
              sessionID: update.sessionID,
              key: update.key,
            },
            fence,
          )
          return
        }
        await this.host.updateInstruction(update)
        this.receipt(
          effect,
          {
            sessionID: update.sessionID,
            key: update.key,
            nativeEntryConfirmed: true,
            modelConsumption: "unknown",
          },
          fence,
        )
        return
      } else if (effect.kind === "session") {
        const session = await this.host.session(payload.sessionID)
        if (session) {
          this.receipt(effect, { sessionID: session.id, reconciled: true }, fence)
          return
        }
      } else if (effect.kind === "prompt") {
        const session = await this.host.session(payload.sessionID, { messages: true })
        if (session?.messages.some((m) => m.id === payload.messageID)) {
          this.receipt(
            effect,
            {
              messageID: payload.messageID,
              reconciled: true,
            },
            fence,
          )
          return
        }
        // This guard throws before ctx.session.prompt. A queued native move may
        // finish after the call returns; no model work was admitted by this effect.
        if (
          !session?.messages.some((m) => m.id === payload.messageID) &&
          JSON.parse(effect.receipt ?? "{}").error ===
            "Worker session is not in its assigned worktree"
        ) {
          this.store.fenced(this.owner, fence, (db) => {
            db.query("UPDATE runner_effects SET state='failed',receipt=? WHERE id=?").run(
              JSON.stringify({
                notSent: true,
                reason: "Native move queued; prompt guard prevented dispatch",
              }),
              effect.id,
            )
            db.query("UPDATE runner_attempts SET message_id=? WHERE id=?").run(
              messageID(),
              effect.attempt_id!,
            )
            this.store.record(effect.plan_id, effect.task_id, "PROMPT_NOT_DISPATCHED", {
              effectID: effect.id,
              continuation: "new durable message after native move wait",
            })
          })
          return
        }
      } else if (
        [
          "worktree",
          "graph-worktree",
          "adoption-task-worktree",
          "adoption-combined-worktree",
        ].includes(effect.kind)
      ) {
        const startupRecoveryReason = (() => {
          if (effect.kind !== "worktree" || effect.state !== "uncertain" || !effect.receipt)
            return undefined
          try {
            const receipt = JSON.parse(effect.receipt) as { error?: unknown }
            return typeof receipt.error === "string"
              ? `Recovery uncertain for worktree ${effect.id}: ${receipt.error}`
              : undefined
          } catch {
            return undefined
          }
        })()
        const candidates = (await this.host.worktrees())
          .filter(
            (directory) =>
              directory === payload.workspace ||
              (/^-[2-9]$|^-10$/.test(directory.slice(payload.workspace.length)) &&
                directory.startsWith(payload.workspace)),
          )
          .filter(
            (directory) =>
              existsSync(directory) && git(directory, ["rev-parse", "HEAD"]) === payload.base,
          )
          .filter(
            (directory) =>
              !effect.kind.startsWith("adoption-") ||
              !git(directory, ["status", "--porcelain", "--untracked-files=all"]),
          )
        if (candidates.length === 1) {
          const workspace = candidates[0]!
          if (effect.attempt_id)
            this.store.fenced(this.owner, fence, (db) =>
              db
                .query("UPDATE runner_attempts SET workspace=? WHERE id=?")
                .run(workspace, effect.attempt_id!),
            )
          this.receipt(effect, { workspace, base: payload.base, reconciled: true }, fence)
          if (effect.kind.startsWith("adoption-") && typeof payload.adoptionID === "string")
            this.store.setAdoptionWorkspace(
              payload.adoptionID,
              effect.kind === "adoption-task-worktree" ? "task" : "combined",
              workspace,
              { owner: this.owner, value: fence },
            )
          if (startupRecoveryReason && effect.attempt_id) {
            const plan = this.store.plan(effect.plan_id)
            const attempt = plan
              ? this.store.attempts(plan.id).find((item) => item.id === effect.attempt_id)
              : undefined
            if (plan?.state === "blocked" && attempt?.state === "preparing") {
              this.store.fenced(this.owner, fence, (db) => {
                const changed =
                  db
                    .query(
                      "UPDATE runner_plans SET state='running',reason=NULL,version=version+1 WHERE id=? AND state='blocked' AND reason=?",
                    )
                    .run(plan.id, startupRecoveryReason).changes === 1
                if (!changed) return
                this.store.record(plan.id, null, "WORKTREE_RECOVERY_RESUMED", {
                  effectID: effect.id,
                  attemptID: effect.attempt_id,
                  workspace,
                })
              })
            }
          }
          return
        }
      } else if (effect.kind.startsWith("verify:") || effect.kind.startsWith("graph-verify:")) {
        if (existsSync(payload.receiptPath)) {
          const check = JSON.parse(readFileSync(payload.receiptPath, "utf8")) as CheckReceipt
          if (
            check.artifact === payload.artifact &&
            check.command === payload.check.command &&
            check.inputIdentity === payload.identity &&
            artifactUnchanged(payload.workspace, payload.artifact)
          ) {
            this.receipt(effect, { check, reconciled: true }, fence)
            return
          }
        }
      }
      if (effect.state !== "uncertain")
        this.uncertain(
          effect,
          "No conclusive host/artifact receipt; effect was not repeated",
          fence,
        )
    } catch (error) {
      if (effect.state !== "uncertain") this.uncertain(effect, error, fence)
    }
  }
  private ownership(message: OutboxRow): OutcomeOwnership | undefined {
    const ownership = parseOutcomeOwnership(message.metadata ? JSON.parse(message.metadata) : null)
    if (
      !ownership ||
      ownership.lazersOutboxID !== message.id ||
      ownership.lazersPlanID !== message.plan_id ||
      ownership.lazersMessageID !== message.message_id ||
      ownership.lazersSessionID !== message.session_id
    )
      return undefined
    return ownership
  }

  private createOwnership(message: OutboxRow, sessionID: string): OutcomeOwnership {
    const payload = JSON.parse(message.payload) as { status?: unknown; version?: unknown }
    return {
      lazersKind: "runner-outcome",
      lazersProjectID: this.projectID,
      lazersProjectDirectory: this.directory,
      lazersPlanID: message.plan_id,
      lazersOutboxID: message.id,
      lazersMessageID: message.message_id,
      lazersSessionID: sessionID,
      lazersStatus: typeof payload.status === "string" ? payload.status : "update",
      lazersVersion: typeof payload.version === "number" ? payload.version : 0,
    }
  }

  private outcomeState(
    message: OutboxRow,
    expected: string[],
    state: string,
    receipt: unknown,
    event: string,
    fence: number,
  ) {
    return this.store.fenced(this.owner, fence, (db) => {
      const placeholders = expected.map(() => "?").join(",")
      const current = db
        .query<{ state: string; receipt: string | null }, [string]>(
          "SELECT state,receipt FROM runner_outbox WHERE id=?",
        )
        .get(message.id)
      if (!current || !expected.includes(current.state)) return false
      const nextReceipt = appendOutboxReceipt(current.receipt, receipt)
      const changed = db
        .query(
          `UPDATE runner_outbox SET state=?,receipt=? WHERE id=? AND state=? AND state IN (${placeholders})`,
        )
        .run(state, nextReceipt, message.id, current.state, ...expected).changes
      if (changed) {
        this.store.record(message.plan_id, null, event, {
          outboxID: message.id,
          messageID: message.message_id,
          from: current.state,
          to: state,
          receipt,
        })
        this.store.repository.changed()
      }
      return changed === 1
    })
  }

  private async outcomeObservation(
    message: OutboxRow,
    sessionID: string,
    ownership?: OutcomeOwnership,
  ): Promise<"queued" | "consumed" | "missing" | "unowned"> {
    // Older injected hosts used by recovery fixtures do not have the pinned
    // inbox API. They can still prove an exact transcript ID, but cannot prove
    // that an absent message was cancelled or consumed.
    if (!this.host.outcomeInbox) {
      const target = await this.host.session(sessionID, { messages: true })
      const transcript = target?.messages.find((item) => item.id === message.message_id)
      if (!transcript) return "missing"
      if (ownership) return isOwnedOutcomeTranscript(transcript, ownership) ? "consumed" : "unowned"
      return transcript.type === "synthetic" ? "consumed" : "unowned"
    }
    const inbox = await this.host.outcomeInbox(sessionID)
    const entry = inbox.find((item) => item.id === message.message_id)
    if (entry) {
      if (ownership && isOwnedQueuedOutcome(entry, ownership)) return "queued"
      return "unowned"
    }
    const target = await this.host.session(sessionID, { messages: true })
    const transcript = target?.messages.find((item) => item.id === message.message_id)
    if (!transcript) return "missing"
    if (ownership) return isOwnedOutcomeTranscript(transcript, ownership) ? "consumed" : "unowned"
    return transcript.type === "synthetic" ? "consumed" : "unowned"
  }

  private async supersedeOutcome(
    message: OutboxRow,
    latest: OutboxRow,
    plan: PlanRow,
    fence: number,
  ) {
    if (message.state === "unknown") return true
    if (message.state === "pending") {
      this.outcomeState(
        message,
        ["pending"],
        "superseded",
        { kind: "superseded-before-native-admission", byOutboxID: latest.id },
        "OUTCOME_SUPERSEDED",
        fence,
      )
      return true
    }
    if (!["sending", "uncertain", "admitted", "unknown", "delivered"].includes(message.state))
      return true

    const ownership = this.ownership(message)
    if (
      !ownership ||
      message.session_id !== latest.session_id ||
      message.session_id !== plan.owner
    ) {
      this.outcomeState(
        message,
        [message.state],
        "unknown",
        { kind: "supersession-ownership-unavailable", byOutboxID: latest.id },
        "OUTCOME_CONSUMPTION_UNKNOWN",
        fence,
      )
      return true
    }

    const target = await this.host.session(message.session_id)
    if (!this.validArchitect(target) || target.id !== plan.owner) return true
    let observation: "queued" | "consumed" | "missing" | "unowned"
    try {
      observation = await this.outcomeObservation(message, target.id, ownership)
    } catch (error) {
      this.outcomeState(
        message,
        [message.state],
        message.state,
        {
          kind: "supersession-observation-unavailable",
          byOutboxID: latest.id,
          error: errorText(error),
        },
        "OUTCOME_SUPERSESSION_UNCERTAIN",
        fence,
      )
      return false
    }
    if (observation === "consumed") {
      this.outcomeState(
        message,
        [message.state],
        "consumed",
        { kind: "transcript-observed", byOutboxID: latest.id },
        "OUTCOME_CONSUMED",
        fence,
      )
      return true
    }
    if (observation === "unowned") {
      this.outcomeState(
        message,
        [message.state],
        "unknown",
        { kind: "supersession-input-identity-conflict", byOutboxID: latest.id },
        "OUTCOME_CONSUMPTION_UNKNOWN",
        fence,
      )
      return true
    }
    if (observation === "missing") {
      this.outcomeState(
        message,
        [message.state],
        "unknown",
        { kind: "unknown-consumption", byOutboxID: latest.id },
        "OUTCOME_CONSUMPTION_UNKNOWN",
        fence,
      )
      return true
    }

    if (!this.host.cancelOutcome) {
      this.outcomeState(
        message,
        [message.state],
        message.state,
        { kind: "native-cancellation-unavailable", byOutboxID: latest.id },
        "OUTCOME_CANCEL_UNCERTAIN",
        fence,
      )
      return false
    }

    try {
      await this.host.cancelOutcome({
        sessionID: target.id,
        inboxID: message.message_id,
        ownership,
      })
    } catch (error) {
      let afterFailure: "queued" | "consumed" | "missing" | "unowned"
      try {
        afterFailure = await this.outcomeObservation(message, target.id, ownership)
      } catch (observationError) {
        this.outcomeState(
          message,
          [message.state],
          message.state,
          {
            kind: "cancellation-outcome-unobservable",
            byOutboxID: latest.id,
            error: errorText(error),
            observationError: errorText(observationError),
          },
          "OUTCOME_CANCEL_UNCERTAIN",
          fence,
        )
        return false
      }
      if (afterFailure === "consumed") {
        this.outcomeState(
          message,
          [message.state],
          "consumed",
          { kind: "cancel-raced-with-consumption", byOutboxID: latest.id, error: errorText(error) },
          "OUTCOME_CANCEL_RACED_WITH_CONSUMPTION",
          fence,
        )
        return true
      }
      if (afterFailure === "queued") {
        this.outcomeState(
          message,
          [message.state],
          message.state,
          {
            kind: "cancellation-failed-still-queued",
            byOutboxID: latest.id,
            error: errorText(error),
          },
          "OUTCOME_CANCEL_UNCERTAIN",
          fence,
        )
        return false
      }
      if (afterFailure === "missing")
        this.outcomeState(
          message,
          [message.state],
          "unknown",
          {
            kind: "cancel-race-consumption-unknown",
            byOutboxID: latest.id,
            error: errorText(error),
          },
          "OUTCOME_CONSUMPTION_UNKNOWN",
          fence,
        )
      if (afterFailure === "unowned") {
        this.outcomeState(
          message,
          [message.state],
          message.state,
          { kind: "cancellation-not-confirmed-unowned-input", byOutboxID: latest.id },
          "OUTCOME_CANCEL_UNCERTAIN",
          fence,
        )
        return false
      }
      return true
    }

    let afterCancellation: "queued" | "consumed" | "missing" | "unowned"
    try {
      afterCancellation = await this.outcomeObservation(message, target.id, ownership)
    } catch (error) {
      this.outcomeState(
        message,
        [message.state],
        message.state,
        {
          kind: "cancellation-confirmation-unavailable",
          byOutboxID: latest.id,
          error: errorText(error),
        },
        "OUTCOME_CANCEL_UNCERTAIN",
        fence,
      )
      return false
    }
    if (afterCancellation === "consumed") {
      this.outcomeState(
        message,
        [message.state],
        "consumed",
        { kind: "consumption-observed-after-cancel", byOutboxID: latest.id },
        "OUTCOME_CANCEL_RACED_WITH_CONSUMPTION",
        fence,
      )
      return true
    }
    if (afterCancellation === "queued") {
      this.outcomeState(
        message,
        [message.state],
        message.state,
        { kind: "cancel-returned-but-outcome-still-queued", byOutboxID: latest.id },
        "OUTCOME_CANCEL_UNCERTAIN",
        fence,
      )
      return false
    }
    if (afterCancellation === "unowned") {
      this.outcomeState(
        message,
        [message.state],
        "unknown",
        { kind: "cancel-returned-with-identity-conflict", byOutboxID: latest.id },
        "OUTCOME_CONSUMPTION_UNKNOWN",
        fence,
      )
      return true
    }

    this.outcomeState(
      message,
      [message.state],
      "superseded",
      { kind: "native-cancellation-confirmed", inboxID: message.message_id, byOutboxID: latest.id },
      "OUTCOME_SUPERSEDED",
      fence,
    )
    return true
  }

  private async deliverCurrent(message: OutboxRow, fence: number) {
    if (["consumed", "superseded", "unknown"].includes(message.state)) return
    const plan = this.store.plan(message.plan_id)
    if (!plan) return
    let target = await this.host.session(message.session_id)
    if (!this.validArchitect(target) || target.id !== plan.owner) {
      // Admitted is not consumed. Prove consumption in the original session
      // before transferring an otherwise-current notice to its replacement.
      const priorOwnership = this.ownership(message)
      let priorObservation: string
      try {
        priorObservation = await this.outcomeObservation(
          message,
          message.session_id,
          priorOwnership,
        )
      } catch (error) {
        priorObservation = `unavailable: ${errorText(error)}`
      }
      if (priorObservation === "consumed") {
        this.outcomeState(
          message,
          [message.state],
          "consumed",
          { kind: "transcript-observed-before-owner-transfer" },
          "OUTCOME_CONSUMED",
          fence,
        )
        return
      }
      let safeToRetarget = message.state === "pending"
      if (!safeToRetarget && priorObservation === "queued" && this.host.cancelOutcome) {
        try {
          const originalOwnership =
            priorOwnership ?? this.createOwnership(message, message.session_id)
          await this.host.cancelOutcome({
            sessionID: message.session_id,
            inboxID: message.message_id,
            ownership: originalOwnership,
          })
          const afterCancellation = await this.outcomeObservation(
            message,
            message.session_id,
            originalOwnership,
          )
          if (afterCancellation === "consumed") {
            this.outcomeState(
              message,
              [message.state],
              "consumed",
              { kind: "cancellation-raced-with-consumption" },
              "OUTCOME_CANCEL_RACED_WITH_CONSUMPTION",
              fence,
            )
            return
          }
          safeToRetarget = afterCancellation === "missing"
          if (safeToRetarget) priorObservation = "cancelled-confirmed-by-inbox-and-history-readback"
        } catch (error) {
          priorObservation = `cancellation-unconfirmed: ${errorText(error)}`
        }
      }
      if (!safeToRetarget) {
        this.outcomeState(
          message,
          [message.state],
          priorObservation === "missing" || priorObservation === "unowned"
            ? "unknown"
            : message.state,
          {
            kind: "owner-changed-with-original-delivery-unresolved",
            priorSessionID: message.session_id,
            priorMessageID: message.message_id,
            priorObservation,
          },
          "OUTCOME_OWNER_TRANSFER_UNCERTAIN",
          fence,
        )
        return
      }
      const owner = await this.ensureArchitectOwner(plan, target)
      // Native message IDs are global. Never reuse an admitted/uncertain ID in
      // another session; persist the replacement identity before host admission.
      const replacementID = messageID()
      const nextOwnership = {
        ...(priorOwnership ?? this.createOwnership(message, message.session_id)),
        lazersSessionID: owner.id,
        lazersMessageID: replacementID,
      }
      if (
        !this.store.retargetOutbox({
          id: message.id,
          expectedState: message.state,
          sessionID: owner.id,
          messageID: replacementID,
          metadata: JSON.stringify(nextOwnership),
          receipt: {
            kind: "owner-retargeted-current-outcome",
            fromSessionID: message.session_id,
            toSessionID: owner.id,
            previousMessageID: message.message_id,
            replacementMessageID: replacementID,
            priorOwnership: priorOwnership ?? null,
            priorObservation,
            priorDeliveryState: message.state,
          },
        })
      )
        return
      message = {
        ...message,
        state: "pending",
        session_id: owner.id,
        message_id: replacementID,
        metadata: JSON.stringify(nextOwnership),
      }
      target = owner
    }
    if (!this.validArchitect(target)) return
    if (message.state === "admitted") return

    const ownership = this.ownership(message)
    let observation: "queued" | "consumed" | "missing" | "unowned"
    try {
      observation = await this.outcomeObservation(message, target.id, ownership)
    } catch (error) {
      this.outcomeState(
        message,
        [message.state],
        message.state,
        { kind: "native-observation-unavailable", error: errorText(error) },
        "OUTCOME_OBSERVATION_UNAVAILABLE",
        fence,
      )
      return
    }
    if (observation === "queued") {
      this.outcomeState(
        message,
        [message.state],
        "admitted",
        { kind: "native-inbox-observed", consumption: "unknown" },
        "OUTCOME_HOST_ADMITTED",
        fence,
      )
      return
    }
    if (observation === "consumed") {
      this.outcomeState(
        message,
        [message.state],
        "consumed",
        { kind: "transcript-observed" },
        "OUTCOME_CONSUMED",
        fence,
      )
      return
    }
    if (observation === "unowned") {
      this.outcomeState(
        message,
        [message.state],
        "unknown",
        { kind: "native-input-identity-conflict" },
        "OUTCOME_CONSUMPTION_UNKNOWN",
        fence,
      )
      return
    }
    if (
      !this.outcomeState(
        message,
        ["pending", "sending", "uncertain", "delivered"],
        "sending",
        { kind: "native-admission-in-progress" },
        "OUTCOME_SEND_STARTED",
        fence,
      )
    )
      return
    try {
      await this.host.notify({
        sessionID: target.id,
        id: message.message_id,
        text: outcomeText(message.payload),
        resume: Boolean(message.resume),
        ...(ownership ? { metadata: ownership } : {}),
      })
      this.outcomeState(
        message,
        ["sending"],
        "admitted",
        { kind: "host-admitted", consumption: "unknown", sessionID: target.id },
        "OUTCOME_HOST_ADMITTED",
        fence,
      )
    } catch (error) {
      this.outcomeState(
        message,
        ["pending", "sending", "uncertain", "delivered"],
        "uncertain",
        { kind: "native-delivery-uncertain", error: errorText(error) },
        "OUTCOME_DELIVERY_UNCERTAIN",
        fence,
      )
    }
  }

  private async deliver(fence: number) {
    const messages = this.store.outboxForDelivery(this.directory)
    const groups = new Map<string, OutboxRow[]>()
    for (const message of messages) {
      const group = groups.get(message.plan_id) ?? []
      group.push(message)
      groups.set(message.plan_id, group)
    }
    for (const group of groups.values()) {
      const ordered = group.toSorted((a, b) => a.version - b.version || a.sequence - b.sequence)
      if (this.store.architectRenewalBlocksDelivery(ordered[0]!.plan_id)) continue
      const plan = this.store.plan(ordered[0]!.plan_id)
      if (!plan) continue
      const ready = new Map<string, boolean>()
      const current = new Map<string, OutboxRow>()
      for (const [index, message] of ordered.entries()) {
        const older = JSON.parse(message.payload)
        const replacement = ordered.slice(index + 1).findLast((candidate) => {
          const next = JSON.parse(candidate.payload)
          if (
            older.status === "architect-handoff" ||
            older.status === "architect-source-reference" ||
            next.status === "architect-handoff" ||
            next.status === "architect-source-reference"
          )
            return false
          // Current outcomes include the whole accepted-artifact review set.
          // Legacy partial notices cannot suppress a different actionable result.
          if (older.status === "task-accepted")
            return (
              (Array.isArray(next.reviewableTasks) &&
                next.reviewableTasks.some(
                  (task: { taskID?: string; artifact?: string }) =>
                    task.taskID === older.taskID && task.artifact === older.artifact,
                )) ||
              (next.status === "task-accepted" &&
                next.taskID === older.taskID &&
                next.artifact === older.artifact) ||
              (["accepted", "integrated"].includes(next.status) &&
                typeof next.artifact === "string")
            )
          return next.status !== "task-accepted" || Boolean(next.currentPlan)
        })
        if (replacement) {
          const ok = await this.supersedeOutcome(message, replacement, plan, fence)
          ready.set(replacement.id, (ready.get(replacement.id) ?? true) && ok)
        } else current.set(message.id, message)
      }
      for (const message of current.values())
        if (ready.get(message.id) !== false) await this.deliverCurrent(message, fence)
    }
  }
}
