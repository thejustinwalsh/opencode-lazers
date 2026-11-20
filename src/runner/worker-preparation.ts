import { workerAgent } from "./worker-agent.ts"
import { ModelPolicy, WorkerPersona } from "./schema.ts"
import type { PlanRow, AttemptRow } from "./store.ts"
import { workerPersonaLabels, workerPersonaOverlay } from "../personas/index.ts"
import type { ArchitectOwnership } from "./architect-ownership.ts"
import type { Dispatch } from "./dispatch.ts"
import type { RetainedRepairRecords } from "./retained-repair-records.ts"
import type { RuntimeJournal } from "./runtime-journal.ts"
import type { StartupSettlement } from "./startup-settlement.ts"
import type { VerificationReview } from "./verification-review.ts"
import type { WorkerObservation } from "./worker-observation.ts"
import type { RuntimeCore } from "./runtime-core.ts"

/** What `WorkerPreparation` reads from the coordinator and its sibling modules; calls are lazy arrows. */
export type WorkerPreparationDeps = {
  effect: RuntimeJournal["effect"]
  hold: RuntimeJournal["hold"]
  receipt: RuntimeJournal["receipt"]
  uncertain: RuntimeJournal["uncertain"]
  promptAdmissionAllowed: Dispatch["promptAdmissionAllowed"]
  repairFailureBrief: VerificationReview["repairFailureBrief"]
  startAuditorReport: VerificationReview["startAuditorReport"]
  retainedRepairForAttempt: RetainedRepairRecords["retainedRepairForAttempt"]
  retainedRepairPromptCurrent: RetainedRepairRecords["retainedRepairPromptCurrent"]
  sessionTitle: ArchitectOwnership["sessionTitle"]
  startupWorkspaceReady: StartupSettlement["startupWorkspaceReady"]
  workerEvent: WorkerObservation["workerEvent"]
  parseTransitionPayload: RetainedRepairRecords["parseTransitionPayload"]
}

/**
 * Worker preparation: adopting a running worker session and preparing the worker for an attempt
 * (session, workspace, prompt). Moved out of `TaskRuntime` without rewriting; the private aliases below
 * keep the member bodies identical to what they were.
 */
export class WorkerPreparation {
  private readonly effect: WorkerPreparationDeps["effect"]
  private readonly hold: WorkerPreparationDeps["hold"]
  private readonly receipt: WorkerPreparationDeps["receipt"]
  private readonly uncertain: WorkerPreparationDeps["uncertain"]
  private readonly promptAdmissionAllowed: WorkerPreparationDeps["promptAdmissionAllowed"]
  private readonly repairFailureBrief: WorkerPreparationDeps["repairFailureBrief"]
  private readonly startAuditorReport: WorkerPreparationDeps["startAuditorReport"]
  private readonly retainedRepairForAttempt: WorkerPreparationDeps["retainedRepairForAttempt"]
  private readonly retainedRepairPromptCurrent: WorkerPreparationDeps["retainedRepairPromptCurrent"]
  private readonly sessionTitle: WorkerPreparationDeps["sessionTitle"]
  private readonly startupWorkspaceReady: WorkerPreparationDeps["startupWorkspaceReady"]
  private readonly workerEvent: WorkerPreparationDeps["workerEvent"]
  private readonly parseTransitionPayload: WorkerPreparationDeps["parseTransitionPayload"]

  constructor(
    private readonly core: RuntimeCore,
    deps: WorkerPreparationDeps,
  ) {
    this.effect = (...args) => deps.effect(...args)
    this.hold = (...args) => deps.hold(...args)
    this.receipt = (...args) => deps.receipt(...args)
    this.uncertain = (...args) => deps.uncertain(...args)
    this.promptAdmissionAllowed = (...args) => deps.promptAdmissionAllowed(...args)
    this.repairFailureBrief = (...args) => deps.repairFailureBrief(...args)
    this.startAuditorReport = (...args) => deps.startAuditorReport(...args)
    this.retainedRepairForAttempt = (...args) => deps.retainedRepairForAttempt(...args)
    this.retainedRepairPromptCurrent = (...args) => deps.retainedRepairPromptCurrent(...args)
    this.sessionTitle = (...args) => deps.sessionTitle(...args)
    this.startupWorkspaceReady = (...args) => deps.startupWorkspaceReady(...args)
    this.workerEvent = (...args) => deps.workerEvent(...args)
    this.parseTransitionPayload = deps.parseTransitionPayload
  }

  private get store() {
    return this.core.store
  }

  private get owner() {
    return this.core.owner
  }

  private get host() {
    return this.core.host
  }

  /**
   * A resume reserves a fresh input, but the interruption it answers may have been a stale
   * observation: the worker is still inside its previous turn. Prompting it again would queue a
   * second input behind a live turn and the retained-repair fence rightly refuses a busy worker,
   * leaving the attempt in `preparing` while the worker works. When the session is busy on exactly
   * the input the attempt had before the resume, the attempt takes that input back and runs.
   */
  async adoptRunningWorker(plan: PlanRow, attempt: AttemptRow, fence: number) {
    const latest = this.store.activityEvents(plan.id, attempt.task_id, {
      events: ["ATTEMPT_RESUMED"],
      payload: { attemptID: attempt.id },
      newest: true,
      limit: 1,
    })[0]
    const resumed = latest
      ? this.parseTransitionPayload<{
          attemptID?: unknown
          messageID?: unknown
          previousMessageID?: unknown
        }>(latest)
      : undefined
    const previousMessageID = resumed?.previousMessageID
    if (resumed?.messageID !== attempt.message_id || typeof previousMessageID !== "string")
      return false
    const observed = await this.host.session(attempt.session_id, { messages: true })
    if (
      !observed ||
      observed.archived ||
      !observed.busy ||
      observed.directory !== attempt.workspace ||
      observed.turn?.state !== "pending" ||
      observed.turn.inputID !== previousMessageID ||
      observed.messages.some((message) => message.id === attempt.message_id)
    )
      return false
    const adopted = this.store.fenced(this.owner, fence, (db) => {
      if (this.store.plan(plan.id)?.state !== "running") return false
      const changed =
        db
          .query(
            "UPDATE runner_attempts SET state=lz_runner_transition('attempt',state,'running'),message_id=? WHERE id=? AND state='preparing' AND message_id=?",
          )
          .run(previousMessageID, attempt.id, attempt.message_id).changes === 1
      if (changed)
        this.store.record(plan.id, attempt.task_id, "WORKER_RESUME_ADOPTED", {
          attemptID: attempt.id,
          sessionID: attempt.session_id,
          inputID: previousMessageID,
          reservedMessageID: attempt.message_id,
        })
      return changed
    })
    return adopted
  }
  async prepareWorker(plan: PlanRow, attempt: AttemptRow, fence: number) {
    const admissionPlan = this.store.plan(plan.id)
    if (!admissionPlan || admissionPlan.state !== "running") return
    if (!(await this.startupWorkspaceReady(admissionPlan, attempt, fence))) return
    if (!(await this.promptAdmissionAllowed(plan.id, attempt))) return
    const retainedRepair = this.retainedRepairForAttempt(attempt)
    const latestRepair = this.store.latestRetainedRepair<{ attemptID?: unknown }>(
      plan.id,
      attempt.task_id,
    )
    if (latestRepair?.attemptID === attempt.id && !retainedRepair) {
      this.hold(plan, "Retained repair is missing a valid owner/control authorization fence")
      return
    }
    if (retainedRepair && (await this.adoptRunningWorker(plan, attempt, fence))) return
    const existing = this.store.effects(plan.id)
    if (
      retainedRepair &&
      !existing.some(
        (effect) =>
          effect.attempt_id === attempt.id &&
          effect.kind === "session" &&
          effect.state === "completed",
      )
    ) {
      this.hold(plan, "Retained repair lost its original native session receipt")
      return
    }
    if (
      !retainedRepair &&
      !existing.some((e) => e.attempt_id === attempt.id && e.kind === "session")
    ) {
      if (!(await this.promptAdmissionAllowed(plan.id, attempt))) return
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
          agent: workerAgent(JSON.parse(attempt.policy).agent),
          model: ModelPolicy.parse(JSON.parse(attempt.policy).model),
          directory: attempt.workspace,
          title: this.sessionTitle(
            this.store.repository.get(attempt.task_id)!.proposal.objective.slice(0, 100),
          ),
          attemptID: attempt.id,
        })
        this.receipt(effect, { sessionID: attempt.session_id }, fence)
      } catch (error) {
        this.uncertain(effect, error, fence)
        return
      }
    }
    if (!(await this.promptAdmissionAllowed(plan.id, attempt))) return
    this.startAuditorReport(attempt, "baseline")
    const repairPrompt = retainedRepair
      ? existing.find(
          (effect) =>
            effect.attempt_id === attempt.id &&
            effect.kind === "prompt" &&
            (() => {
              try {
                return (
                  (JSON.parse(effect.payload) as { repairID?: unknown }).repairID ===
                    retainedRepair.operationID &&
                  (JSON.parse(effect.payload) as { messageID?: unknown }).messageID ===
                    attempt.message_id
                )
              } catch {
                return false
              }
            })(),
        )
      : undefined
    const conflictingPrompt = retainedRepair
      ? existing.find(
          (effect) =>
            effect.attempt_id === attempt.id &&
            effect.kind === "prompt" &&
            (() => {
              try {
                return (
                  (JSON.parse(effect.payload) as { messageID?: unknown }).messageID ===
                  attempt.message_id
                )
              } catch {
                return false
              }
            })(),
        )
      : undefined
    if (retainedRepair && conflictingPrompt && !repairPrompt) {
      this.hold(plan, "Retained repair prompt receipt is not bound to its operation")
      return
    }
    if (retainedRepair && repairPrompt?.state === "failed") {
      this.hold(
        plan,
        "Retained repair prompt was conclusively rejected; explicit review is required",
      )
      return
    }
    if (retainedRepair && repairPrompt && repairPrompt.state !== "completed") {
      this.hold(plan, "Retained repair prompt effect is unresolved; automatic replay is unsafe")
      return
    }
    if (
      !repairPrompt &&
      !existing.some(
        (e) =>
          e.attempt_id === attempt.id &&
          e.kind === "prompt" &&
          JSON.parse(e.payload).messageID === attempt.message_id,
      )
    ) {
      if (!(await this.promptAdmissionAllowed(plan.id, attempt))) return
      if (
        retainedRepair &&
        !(await this.retainedRepairPromptCurrent(plan, attempt, retainedRepair))
      ) {
        this.hold(plan, "Retained worker ownership or input changed before repair prompt admission")
        return
      }
      const effect = this.effect(
        plan.id,
        attempt.task_id,
        attempt.id,
        "prompt",
        {
          sessionID: attempt.session_id,
          messageID: attempt.message_id,
          workspace: attempt.workspace,
          ...(retainedRepair
            ? {
                repairID: retainedRepair.operationID,
                previousMessageID: retainedRepair.previousMessageID,
                nativeInputID: retainedRepair.nativeInputID,
                nativeAssignmentID: retainedRepair.nativeAssignmentID,
                admissionInputID: retainedRepair.admissionInputID,
                repairMessageID: retainedRepair.repairMessageID,
                ...(retainedRepair.continued
                  ? {
                      continuedFromInputID: retainedRepair.nativeInputID,
                      continuedFromOutcome: retainedRepair.terminalOutcome,
                    }
                  : {}),
                defect: retainedRepair.defect,
              }
            : {}),
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
          attemptID: attempt.id,
          model: ModelPolicy.parse(JSON.parse(attempt.policy).model),
          ...(retainedRepair ? { moveIfNeeded: false } : {}),
          text: retainedRepair
            ? `${retainedRepair.continued ? `Continue the interrupted retained repair task ${attempt.task_id} from its exact prior native input ${retainedRepair.nativeInputID}.` : `Repair task ${attempt.task_id}`} Continue in the same retained workspace ${attempt.workspace}. Fetch the task and source bundle once with lz-get-task before editing. Follow your assigned worker role and task guidance. Preserve all valid prior work, usage, session, workspace and route; do not create or move a worker. Concrete defect to repair: ${retainedRepair.defect}. Commit the repair and report concise results.${personaGuidance}`
            : `Implement task ${attempt.task_id} in ${attempt.workspace}. Fetch the task and source bundle once with lz-get-task before editing. Follow your assigned worker role, use the task's code-grounded guidance, and finish with a commit and concise results. If continuing an earlier attempt, preserve its progress in this assigned workspace.${this.repairFailureBrief(attempt)}${personaGuidance}`,
        })
        this.receipt(
          effect,
          {
            messageID: attempt.message_id,
            taskID: attempt.task_id,
            instructions: "readable; lz-get-task",
            ...(retainedRepair
              ? {
                  repairID: retainedRepair.operationID,
                  repairMessageID: retainedRepair.repairMessageID,
                  ...(retainedRepair.continued
                    ? { continuedFromInputID: retainedRepair.nativeInputID }
                    : {}),
                }
              : {}),
          },
          fence,
        )
      } catch (error) {
        this.uncertain(effect, error, fence)
        return
      }
    }
    if (!(await this.promptAdmissionAllowed(plan.id, attempt))) return
    const started = this.store.fenced(this.owner, fence, (db) => {
      const currentPlan = this.store.plan(plan.id)
      const currentAttempt = this.store.attempts(plan.id).find((item) => item.id === attempt.id)
      const currentNode = this.store.nodes(plan.id).find((item) => item.task_id === attempt.task_id)
      if (
        currentPlan?.state !== "running" ||
        currentAttempt?.state !== "preparing" ||
        currentAttempt.message_id !== attempt.message_id ||
        (retainedRepair
          ? currentNode?.state !== (retainedRepair.continued ? "running" : "ready") ||
            this.retainedRepairForAttempt(currentAttempt)?.operationID !==
              retainedRepair.operationID
          : false)
      )
        return false
      if (retainedRepair && !retainedRepair.continued)
        this.store.move(plan.id, attempt.task_id, "DISPATCH")
      return (
        db
          .query(
            "UPDATE runner_attempts SET state=lz_runner_transition('attempt',state,'running') WHERE id=? AND state='preparing' AND message_id=?",
          )
          .run(attempt.id, attempt.message_id).changes === 1
      )
    })
    if (!started) return
    this.workerEvent(plan, attempt, "WORKER_STARTED", fence)
  }
}
