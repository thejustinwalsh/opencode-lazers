import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fingerprint } from "../identity.ts"
import type { TaskProposal } from "../task.ts"
import {
  artifactExists,
  ArtifactScopeViolation,
  artifactUnchanged,
  combineArtifacts,
  commitArtifact,
  git,
  runCheck,
  scopePatternsConflict,
} from "./artifacts.ts"
import type { CheckReceipt } from "./artifacts.ts"
import type { HostSession, RunnerHost, WorkerInstruction } from "./host.ts"
import { CommandInput, ModelPolicy, PlanInput, WorkerPersona } from "./schema.ts"
import type { PlanRow, NodeRow, AttemptRow, EffectRow, OutboxRow } from "./store.ts"
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
const errorText = (error: unknown) =>
  error instanceof Error ? error.message || String(error) : String(error)

export class TaskRuntime {
  readonly owner = crypto.randomUUID()
  readonly progress: ProgressRecorder
  private running = false
  private stopped = false
  private readonly idleWaiters: (() => void)[] = []
  constructor(
    readonly store: RunnerStore,
    readonly host: RunnerHost,
    readonly projectID: string,
    progress?: ProgressRecorder,
  ) {
    this.progress = progress ?? new ProgressRecorder(store, projectID)
  }
  get directory() {
    return this.store.repository.projectDirectory
  }
  get dataDirectory() {
    return join(dirname(this.store.repository.path), "runner")
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
    if (["run", "reassign", "reconcile", "resume", "retry"].includes(command.action)) {
      if (!target) throw new Error("Target session required")
      ownerSession = await this.host.session(target)
    }
    if (command.action === "run" && !this.validArchitect(ownerSession)) {
      ownerSession = await this.ensureArchitectOwner(old, ownerSession, false)
      continuedOwner = ownerSession.id
    }
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
    return (
      Boolean(continuation) &&
      session?.agent === "architect" &&
      session.projectID === this.projectID &&
      session.directory === this.directory &&
      session.parentID === (continuation?.parent_id ?? undefined) &&
      session.metadata?.lazersContinuation === true &&
      session.metadata.lazersPlanID === planID
    )
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
        .map((node) => ({
          taskID: node.task_id,
          artifact: node.artifact,
          attemptID:
            this.store
              .attempts(planID)
              .findLast(
                (attempt) => attempt.task_id === node.task_id && attempt.state === "accepted",
              )?.id ?? null,
          evidence: this.store.repository
            .get(node.task_id)!
            .proposal.verification.map((check) => check.id),
        })),
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
    if (plan.state !== "cancelling")
      this.hold(plan, `Recovery uncertain for ${effect.kind} ${effect.id}: ${errorText(error)}`)
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
      for (let plan of this.store
        .plans()
        .filter((p) => !terminal.has(p.state) && (p.state !== "draft" || this.taskStartID(p)))) {
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
    if (plan.state === "cleaning") {
      await this.cleanupWorktrees(plan, fence)
      return
    }
    const owner = await this.host.session(plan.owner)
    if (!this.validArchitect(owner)) {
      await this.ensureArchitectOwner(plan, owner)
      plan = this.store.plan(plan.id)!
    }
    if (plan.state === "cancelling") {
      await this.cancelWorkers(plan, fence)
      const pending = this.store
        .effects(plan.id)
        .find((e) => ["intended", "uncertain"].includes(e.state))
      if (pending) await this.reconcileEffect(pending, fence)
      return
    }
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
    if (prerequisites.some((id) => this.store.plan(id)?.state !== "integrated")) return
    if (prerequisites.length && !this.store.attempts(plan.id).length) {
      // A cross-plan prerequisite includes integration, so dependent workers see its code.
      for (const id of prerequisites) {
        const artifact = this.store.plan(id)!.artifact
        if (artifact) git(this.directory, ["merge-base", "--is-ancestor", artifact, "HEAD"])
      }
      const baseCommit = git(this.directory, ["rev-parse", "HEAD"])
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
      if (session && !session.busy && session.outcome) {
        session = (await this.host.session(attempt.session_id, { messages: true })) ?? session
      }
      if (session) this.observeUsage(attempt, session, fence)
      const promptCompleted = this.store
        .effects(plan.id)
        .some(
          (effect) =>
            effect.attempt_id === attempt.id &&
            effect.kind === "prompt" &&
            JSON.parse(effect.payload).messageID === attempt.message_id &&
            effect.state === "completed",
        )
      if (promptCompleted) {
        this.workerEvent(plan, attempt, "WORKER_STARTED", fence)
        if (!session?.busy)
          this.workerEvent(plan, attempt, "WORKER_STOPPED", fence, session?.outcome ?? "cancelled")
      }
      if (session?.busy) {
        await this.host.interrupt(attempt.session_id)
        waiting = true
        continue
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
        tool: "lazers_get_task_instructions",
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
    if (!this.preparationAllowed(attempt)) return
    const existing = this.store.effects(plan.id)
    if (!existing.some((e) => e.attempt_id === attempt.id && e.kind === "session")) {
      if (this.store.plan(plan.id)?.state !== "running") return
      if (!this.preparationAllowed(attempt)) return
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
      if (this.store.plan(plan.id)?.state !== "running") return
      if (!this.preparationAllowed(attempt)) return
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
          text: `Implement task ${attempt.task_id} in ${attempt.workspace}. Fetch readable revision 1 instructions with lazers_get_task_instructions before editing. Use lazers_get_task only when structured task data is needed. Follow the implementor role, use the task's code-grounded guidance, and finish with a commit and concise results. If continuing an earlier attempt, preserve its progress in this assigned workspace.${personaGuidance}`,
        })
        this.receipt(
          effect,
          {
            messageID: attempt.message_id,
            taskID: attempt.task_id,
            instructions: "readable; lazers_get_task_instructions",
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
    if (!session.busy && session.outcome) {
      session = (await this.host.session(attempt.session_id, { messages: true })) ?? session
      this.observeUsage(attempt, session, fence)
      if (!session.busy && session.outcome)
        this.workerEvent(plan, attempt, "WORKER_STOPPED", fence, session.outcome)
    }
    if (session.busy || !session.outcome) return
    if (session.outcome !== "succeeded") {
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
          const found = this.store.atomic((db) =>
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
  private async cleanupWorktrees(plan: PlanRow, fence: number) {
    const owned = [
      ...new Set(
        this.store
          .effects(plan.id)
          .filter(
            (effect) =>
              ["worktree", "graph-worktree"].includes(effect.kind) && effect.state === "completed",
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
      try {
        const active = await Promise.all(
          this.store
            .attempts(plan.id)
            .filter((attempt) => attempt.workspace === workspace)
            .map((attempt) => this.host.session(attempt.session_id)),
        )
        if (active.some((session) => session?.busy)) throw new Error("Worker is still active")
        const listed = await this.host.worktrees()
        if (listed.includes(workspace)) {
          if (git(workspace, ["status", "--porcelain"]))
            throw new Error(`Owned worktree is dirty; preserve ${workspace}`)
          const head = git(workspace, ["rev-parse", "HEAD"])
          try {
            git(this.directory, ["merge-base", "--is-ancestor", head, "HEAD"])
          } catch {
            throw new Error(`Owned worktree has unmerged commits; preserve ${workspace}`)
          }
          await this.host.removeWorktree(workspace)
        } else if (existsSync(workspace))
          throw new Error(
            "Owned directory is not registered with OpenCode; preserve it for reconciliation",
          )
        this.receipt(effect, { workspace, removed: true, native: true }, fence)
      } catch (error) {
        const reason = errorText(error)
        this.store.fenced(this.owner, fence, (db) => {
          db.query("UPDATE runner_effects SET state='uncertain',receipt=? WHERE id=?").run(
            JSON.stringify({ error: reason }),
            effect.id,
          )
          db.query(
            "UPDATE runner_plans SET state='cleanup-blocked',reason=?,version=version+1 WHERE id=?",
          ).run(reason, plan.id)
          this.store.record(plan.id, null, "CLEANUP_BLOCKED", { workspace, reason })
        })
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
    this.store.fenced(this.owner, fence, (db) => {
      db.query(
        "UPDATE runner_plans SET state='integrated',reason=NULL,version=version+1 WHERE id=?",
      ).run(plan.id)
      this.store.record(plan.id, null, "WORKTREES_RECONCILED", {
        directories: owned,
        artifact: plan.artifact,
      })
    })
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
      } else if (effect.kind === "worktree" || effect.kind === "graph-worktree") {
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
        if (candidates.length === 1) {
          const workspace = candidates[0]!
          if (effect.attempt_id)
            this.store.fenced(this.owner, fence, (db) =>
              db
                .query("UPDATE runner_attempts SET workspace=? WHERE id=?")
                .run(workspace, effect.attempt_id!),
            )
          this.receipt(effect, { workspace, base: payload.base, reconciled: true }, fence)
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
      const plan = this.store.plan(ordered[0]!.plan_id)
      if (!plan) continue
      const ready = new Map<string, boolean>()
      const current = new Map<string, OutboxRow>()
      for (const [index, message] of ordered.entries()) {
        const older = JSON.parse(message.payload)
        const replacement = ordered.slice(index + 1).findLast((candidate) => {
          const next = JSON.parse(candidate.payload)
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
