import { isWorkerAgent } from "./worker-agent.ts"
import { existsSync, lstatSync } from "node:fs"
import { resolve } from "node:path"
import { SessionMessage } from "@opencode/schema/session-message"
import { fingerprint } from "../identity.ts"
import { git, gitAsync } from "./artifacts.ts"
import type { CheckReceipt } from "./artifacts.ts"
import type { NativeCleanupSettlement, WorktreeLocationRetirement } from "./host.ts"
import { PlanInput } from "./schema.ts"
import type { PlanRow, AttemptRow, EffectRow } from "./store.ts"
import { appendRunnerEffectReceipt } from "./store.ts"

import type { TaskRuntime } from "./runtime.ts"
import { errorText } from "./runtime-helpers.ts"
import { isRecord } from "./runtime-helpers.ts"
import { WORKTREE_CLEANUP_FALLBACK_MS } from "./runtime-helpers.ts"
import { type CleanupRecoveryAuthorization } from "./runtime-helpers.ts"
import type { AdoptionExecution } from "./adoption-execution.ts"
import { verificationCheckWithDefaults } from "./verification-timeout.ts"
import type { VerificationTimeoutDefaults } from "./verification-timeout.ts"

export class WorktreeCleanup {
  constructor(
    private readonly runtime: {
      adoptionCheckReceiptMatches: AdoptionExecution["adoptionCheckReceiptMatches"]
      backgroundBlockReason: TaskRuntime["backgroundBlockReason"]
      directory: TaskRuntime["directory"]
      effect: TaskRuntime["effect"]
      host: TaskRuntime["host"]
      isPriorContinuationBackground: TaskRuntime["isPriorContinuationBackground"]
      matchesWorkerInput: TaskRuntime["matchesWorkerInput"]
      now: TaskRuntime["now"]
      outcome: TaskRuntime["outcome"]
      owner: TaskRuntime["owner"]
      progress: TaskRuntime["progress"]
      projectID: TaskRuntime["projectID"]
      store: TaskRuntime["store"]
      verificationTimeoutDefaults: VerificationTimeoutDefaults
    },
  ) {}

  private assertAdoptionWorkspaceQuiescent(
    plan: PlanRow,
    effect: EffectRow,
    workspace: string,
    allowCancelled = false,
  ) {
    const payload = JSON.parse(effect.payload) as { adoptionID?: unknown }
    if (typeof payload.adoptionID !== "string")
      throw new Error("Adoption worktree ownership is missing; preserve the workspace")
    const adoption = this.runtime.store.adoption(payload.adoptionID)
    const phase = effect.kind === "adoption-task-worktree" ? "task" : "combined"
    const expectedWorkspace =
      phase === "task" ? adoption?.task_workspace : adoption?.combined_workspace
    if (
      !adoption ||
      adoption.plan_id !== plan.id ||
      (adoption.state !== "accepted" && !(allowCancelled && adoption.state === "cancelled")) ||
      expectedWorkspace !== workspace
    )
      throw new Error("Adoption worktree is not owned by an accepted adoption; preserve it")
    const task = this.runtime.store.repository.get(adoption.task_id)
    const checks =
      phase === "task"
        ? task?.proposal.verification
        : PlanInput.parse(JSON.parse(plan.body)).verification
    if (!checks) throw new Error("Adoption check procedure is missing; preserve the workspace")
    const rows = this.runtime.store.adoptionChecks(adoption.id, phase)
    if (rows.length !== checks.length)
      throw new Error("Adoption worktree has no complete receipt for every check; preserve it")
    const artifact = phase === "task" ? adoption.descendant_commit : adoption.combined_artifact
    for (const check of checks) {
      const effectiveCheck = verificationCheckWithDefaults(
        check,
        this.runtime.verificationTimeoutDefaults,
      )
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
        fingerprint(JSON.parse(row.check_json)) !== fingerprint(effectiveCheck) ||
        !receipt ||
        !this.runtime.adoptionCheckReceiptMatches(receipt, row, check)
      )
        throw new Error(
          "Adoption worktree check activity is not conclusively complete; preserve it",
        )
    }
  }

  private assertGraphWorkspaceQuiescent(plan: PlanRow, workspace: string, allowCancelled = false) {
    const source = this.runtime.store.effects(plan.id).find((effect) => {
      if (effect.kind !== "graph-worktree" || effect.state !== "completed") return false
      try {
        return JSON.parse(effect.receipt ?? "{}").workspace === workspace
      } catch {
        return false
      }
    })
    let sourceArtifact: unknown
    try {
      sourceArtifact = JSON.parse(source?.receipt ?? "{}").base
    } catch {
      sourceArtifact = undefined
    }
    const artifact = plan.artifact ?? (allowCancelled ? sourceArtifact : undefined)
    if (typeof artifact !== "string")
      throw new Error("Combined artifact is missing; preserve the workspace")
    const checks = PlanInput.parse(JSON.parse(plan.body)).verification
    const effects = this.runtime.store.effects(plan.id)
    for (const check of checks) {
      const matches = effects.filter((effect) => {
        if (effect.kind !== `graph-verify:${check.id}`) return false
        try {
          const payload = JSON.parse(effect.payload) as { workspace?: unknown; artifact?: unknown }
          return payload.workspace === workspace && payload.artifact === artifact
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
        receipt.artifact !== artifact ||
        receipt.inputIdentity !== artifact
      )
        throw new Error(
          "Combined worktree check activity is not conclusively complete; preserve it",
        )
    }
  }

  private async assertWorktreeQuiescent(
    plan: PlanRow,
    effect: EffectRow,
    workspace: string,
    allowCancelled = false,
    mergedCheckout = false,
  ): Promise<NativeCleanupSettlement | undefined> {
    if (
      this.runtime.store
        .activeProjectAttempts()
        .some((attempt) => resolve(attempt.workspace) === resolve(workspace))
    )
      throw new Error("Owned worktree still has an active runner attempt; preserve it")
    if (effect.kind.startsWith("adoption-")) {
      if (this.runtime.store.attempts(plan.id).some((attempt) => attempt.workspace === workspace))
        throw new Error("Adoption worktree unexpectedly has an attempt owner; preserve it")
      this.assertAdoptionWorkspaceQuiescent(plan, effect, workspace, allowCancelled)
      return undefined
    }
    if (effect.kind === "graph-worktree") {
      if (this.runtime.store.attempts(plan.id).some((attempt) => attempt.workspace === workspace))
        throw new Error("Combined worktree unexpectedly has an attempt owner; preserve it")
      this.assertGraphWorkspaceQuiescent(plan, workspace, allowCancelled)
      return undefined
    }
    const attempts = this.runtime.store
      .attempts(plan.id)
      .filter((attempt) => attempt.workspace === workspace)
    if (!attempts.length)
      throw new Error("Owned worktree has no matching attempt; preserve it for reconciliation")
    let recoverySettlement: NativeCleanupSettlement | undefined
    for (const attempt of attempts) {
      const session = await this.runtime.host.session(attempt.session_id, { messages: true })
      // RunnerHost null is authoritative native not-found. Current session and
      // background uncertainty still fail closed below; a missing historical
      // worker cannot keep its already-merged checkout forever.
      if (!session) {
        if (this.cleanupRecoveryAuthorization(plan, attempt, effect, workspace))
          throw new Error(
            "Native worker session is unavailable for cleanup recovery; preserve the worktree and reconcile the session binding",
          )
        continue
      }
      const backgroundReason = this.runtime.backgroundBlockReason(session, attempt, true)
      let settlement: NativeCleanupSettlement | undefined
      const authorization = this.cleanupRecoveryAuthorization(plan, attempt, effect, workspace)
      if (authorization) {
        if (!this.runtime.host.cleanupSettlement)
          throw new Error(
            "Fresh native cleanup settlement is unsupported by this host; preserve the worktree and wait for a new experimental.idle observation",
          )
        const settlementRequestedAt = Date.now()
        settlement = await this.runtime.host.cleanupSettlement({
          projectID: this.runtime.projectID,
          attemptID: attempt.id,
          sessionID: attempt.session_id,
          workspace: attempt.workspace,
          assignedMessageID: attempt.message_id,
        })
        if (
          settlement.schemaVersion !== 1 ||
          settlement.projectID !== this.runtime.projectID ||
          settlement.attemptID !== attempt.id ||
          settlement.sessionID !== attempt.session_id ||
          settlement.workspace !== attempt.workspace ||
          settlement.assignedMessageID !== attempt.message_id ||
          settlement.inputID !== attempt.message_id ||
          settlement.observedAt < settlementRequestedAt - 1_000 ||
          settlement.observedAt > this.runtime.now() + 1_000 ||
          settlement.inventory.activeSession !== false ||
          settlement.inventory.activeDescendants !== 0 ||
          settlement.inventory.pendingInput !== false ||
          settlement.inventory.pendingPermissions !== 0 ||
          settlement.inventory.pendingForms !== 0 ||
          settlement.inventory.runningShells !== 0 ||
          settlement.idleReport.source !== "experimental.idle" ||
          !Number.isFinite(settlement.idleReport.observedAt) ||
          settlement.idleReport.observedAt > settlement.observedAt ||
          settlement.idleReport.inputID !== attempt.message_id ||
          !Number.isSafeInteger(settlement.idleReport.executionStartSequence) ||
          settlement.idleReport.executionStartSequence < 0 ||
          !Number.isSafeInteger(settlement.idleReport.eventSequence) ||
          settlement.idleReport.eventSequence < settlement.idleReport.executionStartSequence ||
          settlement.idleReport.count !== 0 ||
          settlement.idleReport.kinds.shell !== 0 ||
          settlement.idleReport.kinds.subagent !== 0 ||
          settlement.idleReport.kinds.image !== 0 ||
          !Number.isSafeInteger(settlement.terminal.previousEventSequence) ||
          settlement.terminal.previousEventSequence !== settlement.idleReport.eventSequence ||
          settlement.terminal.sequence <= settlement.idleReport.eventSequence ||
          !Number.isSafeInteger(settlement.terminal.sequence) ||
          settlement.terminal.sequence < 0 ||
          !settlement.terminal.eventID ||
          !settlement.terminal.messageID
        )
          throw new Error(
            "Fresh native cleanup settlement did not match the held worker assignment",
          )
        let terminalMessageID: string | undefined
        try {
          terminalMessageID = SessionMessage.ID.fromEvent(settlement.terminal.eventID)
        } catch {
          terminalMessageID = undefined
        }
        if (terminalMessageID !== settlement.terminal.messageID)
          throw new Error("Fresh native cleanup terminal event/message binding is invalid")
        recoverySettlement = settlement
      }
      const blockers: string[] = []
      if (session.id !== attempt.session_id) blockers.push("session identity changed")
      if (session.projectID !== this.runtime.projectID) blockers.push("project identity changed")
      if (session.directory !== workspace) blockers.push("worker location changed")
      if (!isWorkerAgent(session.agent)) blockers.push("session is no longer an implementor")
      if (session.metadata?.lazersAttemptID !== attempt.id)
        blockers.push("attempt ownership changed")
      if (session.busy !== false) blockers.push("worker execution is active or unknown")
      if (session.pendingInput === true) blockers.push("worker has pending input")
      if (session.observationUnstable) blockers.push("native worker observation is unstable")
      if ((session.pendingPermissions ?? 0) !== 0)
        blockers.push("worker has pending permission requests")
      if ((session.pendingForms ?? 0) !== 0) blockers.push("worker has pending forms")
      if (!session.outcome) blockers.push("worker outcome is unknown")
      if (settlement && session.turn?.inputID && session.turn.inputID !== settlement.inputID)
        blockers.push("native settlement input does not match the current worker turn")
      if (!["completed", "interrupted"].includes(session.turn?.state ?? "unknown"))
        blockers.push("worker turn is not conclusively terminal")
      if (
        !blockers.length &&
        mergedCheckout &&
        !settlement &&
        !allowCancelled &&
        attempt.state === "accepted" &&
        this.runtime.host.retireIntegratedWorker &&
        !(session.background?.state === "observed" && session.background.count > 0) &&
        session.turn?.inputID &&
        this.runtime.matchesWorkerInput(attempt, session.turn.inputID)
      ) {
        await this.runtime.host.retireIntegratedWorker({
          projectID: this.runtime.projectID,
          attemptID: attempt.id,
          sessionID: attempt.session_id,
          workspace,
        })
      } else if (
        backgroundReason &&
        !settlement &&
        !this.runtime.isPriorContinuationBackground(
          attempt,
          session.background,
          session.turn?.inputID,
        )
      )
        blockers.push(backgroundReason)
      if (blockers.length)
        throw new Error(
          `Owned worktree worker is not conclusively idle; preserve it: ${blockers.join("; ")}`,
        )
    }
    return recoverySettlement
  }

  private cleanupRecoveryAuthorization(
    plan: PlanRow,
    attempt: AttemptRow,
    source: EffectRow,
    workspace: string,
  ): CleanupRecoveryAuthorization | undefined {
    const authorization = this.runtime.store.latestTransition<CleanupRecoveryAuthorization>(
      plan.id,
      attempt.task_id,
      "WORKTREE_CLEANUP_RECOVERY_AUTHORIZED",
    )
    if (!authorization) return undefined
    const node = this.runtime.store.nodes(plan.id).find((item) => item.task_id === attempt.task_id)
    const proposal = PlanInput.parse(JSON.parse(plan.body))
    const proposedNode = proposal.nodes.find((item) => item.taskID === attempt.task_id)
    const task = this.runtime.store.repository.get(attempt.task_id)
    const latestAttempt = this.runtime.store
      .attempts(plan.id)
      .filter((candidate) => candidate.task_id === attempt.task_id)
      .at(-1)
    const taskIntegration = this.runtime.store.latestTransition<{
      artifact?: string
      branch?: string
    }>(plan.id, attempt.task_id, "TASK_INTEGRATION_RECORDED")
    const planIntegration = this.runtime.store.latestTransition<{
      artifact?: string
      branch?: string
    }>(plan.id, null, "INTEGRATION_RECORDED")
    const integrationStillRecorded =
      (taskIntegration?.artifact === attempt.artifact &&
        taskIntegration.branch === authorization.targetBranch) ||
      (planIntegration?.artifact === plan.artifact &&
        planIntegration.branch === authorization.targetBranch)
    const valid =
      authorization.schemaVersion === 1 &&
      authorization.projectDirectory === this.runtime.directory &&
      authorization.planID === plan.id &&
      authorization.planRevision === plan.revision &&
      authorization.planArtifact === plan.artifact &&
      authorization.taskID === attempt.task_id &&
      authorization.taskRevision === proposedNode?.revision &&
      authorization.attemptID === attempt.id &&
      authorization.artifact === attempt.artifact &&
      authorization.workspace === workspace &&
      authorization.workspace === attempt.workspace &&
      authorization.sourceEffectID === source.id &&
      authorization.sessionID === attempt.session_id &&
      authorization.assignedMessageID === attempt.message_id &&
      authorization.owner === plan.owner &&
      authorization.ownerEpoch === this.runtime.store.planControlEpoch(plan.id) &&
      authorization.requestID.length > 0 &&
      authorization.reason.trim().length > 0 &&
      ["worktree", "worktree-recovery"].includes(source.kind) &&
      source.state === "completed" &&
      source.attempt_id === attempt.id &&
      node?.state === "accepted" &&
      node.artifact === attempt.artifact &&
      attempt.state === "accepted" &&
      latestAttempt?.id === attempt.id &&
      task?.revision === proposedNode?.revision &&
      task.provenance.projectID === this.runtime.projectID &&
      task.provenance.projectDirectory === this.runtime.directory &&
      integrationStillRecorded &&
      this.runtime.store.repository.taskDisposition(attempt.task_id) === undefined
    if (!valid)
      throw new Error(
        "Cleanup recovery authorization is stale or no longer matches the accepted attempt; preserve the worktree and have the current owner revalidate before retrying recover-cleanup",
      )
    try {
      if (git(this.runtime.directory, ["branch", "--show-current"]) !== authorization.targetBranch)
        throw new Error("current checkout is not the recorded integration branch")
      git(this.runtime.directory, ["merge-base", "--is-ancestor", authorization.artifact, "HEAD"])
    } catch (error) {
      throw new Error(
        `Cleanup recovery integration evidence is no longer valid (${errorText(error)}); preserve the worktree and have the current owner revalidate before retrying recover-cleanup`,
        { cause: error },
      )
    }
    return authorization
  }

  private appendCleanupSettlement(
    effect: EffectRow,
    authorization: CleanupRecoveryAuthorization,
    settlement: NativeCleanupSettlement,
    fence: number,
  ) {
    this.runtime.store.fenced(this.runtime.owner, fence, (db) => {
      const current = db
        .query<{ state: string; receipt: string | null }, [string, string]>(
          "SELECT state,receipt FROM runner_effects WHERE id=? AND plan_id=?",
        )
        .get(effect.id, effect.plan_id)
      if (!current || !["held", "intended", "uncertain"].includes(current.state))
        throw new Error("Native cleanup effect changed before settlement evidence was recorded")
      const receipt = appendRunnerEffectReceipt(current.receipt, {
        schema: "lazers-native-cleanup-settlement/v1",
        authorization: {
          requestID: authorization.requestID,
          owner: authorization.owner,
          ownerEpoch: authorization.ownerEpoch,
          taskID: authorization.taskID,
          attemptID: authorization.attemptID,
          artifact: authorization.artifact,
          workspace: authorization.workspace,
        },
        settlement,
      })
      const changed = db
        .query(
          "UPDATE runner_effects SET receipt=? WHERE id=? AND plan_id=? AND state IN ('held','intended','uncertain')",
        )
        .run(receipt, effect.id, effect.plan_id).changes
      if (changed !== 1)
        throw new Error("Native cleanup settlement evidence lost its durable effect row")
      this.runtime.store.record(
        effect.plan_id,
        effect.task_id,
        "WORKTREE_CLEANUP_SETTLEMENT_OBSERVED",
        {
          effectID: effect.id,
          requestID: authorization.requestID,
          attemptID: authorization.attemptID,
          sessionID: authorization.sessionID,
          workspace: authorization.workspace,
          terminalSequence: settlement.terminal.sequence,
          terminalEventID: settlement.terminal.eventID,
          observedAt: settlement.observedAt,
        },
      )
    })
  }

  private completeWorktreeRemoval(effect: EffectRow, receipt: unknown, fence: number) {
    this.runtime.store.fenced(this.runtime.owner, fence, (db) => {
      const current = db
        .query<{ state: string; receipt: string | null }, [string, string]>(
          "SELECT state,receipt FROM runner_effects WHERE id=? AND plan_id=?",
        )
        .get(effect.id, effect.plan_id)
      if (!current || !["intended", "uncertain"].includes(current.state))
        throw new Error("Native cleanup effect changed before removal completion was recorded")
      const completion = {
        schema: "lazers-worktree-cleanup-completion/v1",
        ...(isRecord(receipt) ? receipt : { result: receipt }),
      }
      const appended = JSON.parse(appendRunnerEffectReceipt(current.receipt, completion)) as Record<
        string,
        unknown
      >
      const next = JSON.stringify({
        ...appended,
        ...(isRecord(receipt) ? receipt : { result: receipt }),
      })
      const changed = db
        .query(
          "UPDATE runner_effects SET state='completed',receipt=? WHERE id=? AND plan_id=? AND state IN ('intended','uncertain')",
        )
        .run(next, effect.id, effect.plan_id).changes
      if (changed !== 1) throw new Error("Native cleanup completion lost its durable effect row")
      this.runtime.store.record(effect.plan_id, effect.task_id, "EFFECT_COMPLETED", {
        effectID: effect.id,
        kind: effect.kind,
      })
    })
  }

  private abandonCleanupEffect(effect: EffectRow, fence: number) {
    this.runtime.store.fenced(this.runtime.owner, fence, (db) => {
      const plan = db
        .query<{ state: string }, [string]>("SELECT state FROM runner_plans WHERE id=?")
        .get(effect.plan_id)
      if (plan?.state === "cleaning") return
      const changed = db
        .query(
          "UPDATE runner_effects SET state=lz_runner_transition('effect',state,'failed'),receipt=? WHERE id=? AND state IN ('intended','uncertain')",
        )
        .run(
          JSON.stringify({ notSent: true, reason: "Cleanup was superseded before removal" }),
          effect.id,
        ).changes
      if (changed)
        this.runtime.store.record(effect.plan_id, null, "EFFECT_NOT_SENT", {
          effectID: effect.id,
          kind: effect.kind,
          reason: "Cleanup was superseded before removal",
        })
    })
  }
  async retireCleanedWorktreeLocation(
    plan: PlanRow,
    workspace: string,
    cleanupCurrent: () => boolean,
  ) {
    const retire = this.runtime.host.retireWorktreeLocation
    if (!retire) return "unsupported"
    const target = resolve(workspace)
    if (target === resolve(this.runtime.directory)) return "shared-checkout"
    if (!cleanupCurrent()) return "superseded"
    if (
      this.runtime.store
        .activeProjectAttempts()
        .some((attempt) => resolve(attempt.workspace) === target)
    )
      return "reserved-by-other-attempt"
    try {
      const native = await this.runtime.host.worktrees()
      if (!cleanupCurrent()) return "superseded"
      if (native.some((directory) => resolve(directory) === target))
        return "native-resource-present"
      const gitWorktrees = git(this.runtime.directory, ["worktree", "list", "--porcelain"])
        .split(/\r?\n/)
        .filter((line) => line.startsWith("worktree "))
        .map((line) => resolve(line.slice("worktree ".length)))
      if (gitWorktrees.includes(target)) return "git-resource-present"
      try {
        lstatSync(target)
        return "filesystem-resource-present"
      } catch (error) {
        if (!isRecord(error) || error.code !== "ENOENT") return "unavailable"
      }
      if (!cleanupCurrent()) return "superseded"
      const result: WorktreeLocationRetirement = await retire.call(this.runtime.host, target)
      return cleanupCurrent() ? result : "superseded"
    } catch {
      return "unavailable"
    }
  }
  pendingOwnedWorktreeCleanup(plan: PlanRow): boolean {
    const creationKinds = new Set([
      "worktree",
      "worktree-recovery",
      "graph-worktree",
      "adoption-task-worktree",
      "adoption-combined-worktree",
    ])
    const effects = this.runtime.store.effects(plan.id)
    return effects.some((effect) => {
      if (!creationKinds.has(effect.kind) || effect.state !== "completed" || !effect.receipt)
        return false
      try {
        const workspace = JSON.parse(effect.receipt).workspace
        return (
          typeof workspace === "string" &&
          !effects.some(
            (candidate) =>
              candidate.kind === "worktree-remove" &&
              JSON.parse(candidate.payload).workspace === workspace &&
              candidate.state === "completed",
          )
        )
      } catch {
        return false
      }
    })
  }

  worktreeCleanupRetryFacts(plan: PlanRow, source: EffectRow, workspace: string): string {
    const target = resolve(workspace)
    const effects = this.runtime.store
      .effects(plan.id)
      .filter((effect) => effect.kind !== "worktree-remove")
    const attempts = this.runtime.store
      .attempts(plan.id)
      .filter((attempt) => resolve(attempt.workspace) === target)
    const sessions = attempts.map((attempt) => ({
      sessionID: attempt.session_id,
      assignment: this.runtime.progress.assignmentForSession(attempt.session_id) ?? null,
    }))
    const idleRevisions = this.runtime.store.atomic((db) => {
      if (!attempts.length) return []
      const sessionIDs = attempts.map((attempt) => attempt.session_id)
      try {
        const rows = db
          .query<{ session_id: string; revision: number }, [string, ...string[]]>(
            `SELECT session_id,revision FROM runner_native_idle
             WHERE project_directory=? AND session_id IN (${sessionIDs.map(() => "?").join(",")})
             ORDER BY session_id`,
          )
          .all(this.runtime.directory, ...sessionIDs)
        const revisions = new Map(rows.map((row) => [row.session_id, row.revision]))
        return sessionIDs.map((sessionID) => [sessionID, revisions.get(sessionID) ?? null])
      } catch {
        // Old databases or unavailable native-idle storage rely on the bounded native fallback.
        return null
      }
    })
    const owners = this.runtime.store.atomic((db) =>
      db
        .query<
          { plan_id: string; id: string; task_id: string; session_id: string; state: string },
          [string, string]
        >(
          `SELECT plan_id,id,task_id,session_id,state FROM runner_attempts
           WHERE project_directory=? AND workspace=? ORDER BY plan_id,id`,
        )
        .all(this.runtime.directory, workspace),
    )
    const cleanupRecoveryAuthorizations = this.runtime.store.atomic((db) => {
      const attemptIDs = new Set(attempts.map((attempt) => attempt.id))
      return db
        .query<{ task_id: string | null; payload: string }, [string]>(
          `SELECT task_id,payload FROM runner_transitions
           WHERE plan_id=? AND event='WORKTREE_CLEANUP_RECOVERY_AUTHORIZED' ORDER BY id`,
        )
        .all(plan.id)
        .filter((row) => {
          try {
            return attemptIDs.has(JSON.parse(row.payload).attemptID)
          } catch {
            return true
          }
        })
    })
    let adoptionFacts: unknown = null
    try {
      const payload = JSON.parse(source.payload) as { adoptionID?: unknown }
      if (typeof payload.adoptionID === "string") {
        const adoption = this.runtime.store.adoption(payload.adoptionID)
        adoptionFacts = {
          id: adoption?.id ?? null,
          state: adoption?.state ?? null,
          taskWorkspace: adoption?.task_workspace ?? null,
          combinedWorkspace: adoption?.combined_workspace ?? null,
          checks: (["task", "combined"] as const).flatMap((phase) =>
            this.runtime.store.adoptionChecks(payload.adoptionID as string, phase).map((check) => ({
              phase,
              checkID: check.check_id,
              state: check.state,
              receipt: check.receipt ? fingerprint(check.receipt) : null,
            })),
          ),
        }
      }
    } catch {
      adoptionFacts = { unavailable: true }
    }

    return fingerprint({
      plan: { id: plan.id, revision: plan.revision, owner: plan.owner, artifact: plan.artifact },
      workspace: target,
      workspaceExists: existsSync(workspace),
      attempts: attempts.map((attempt) => ({
        id: attempt.id,
        taskID: attempt.task_id,
        state: attempt.state,
        messageID: attempt.message_id,
        sessionID: attempt.session_id,
        artifact: attempt.artifact,
      })),
      sessions,
      idleRevisions,
      owners,
      cleanupRecoveryAuthorizations,
      adoptionFacts,
      source: {
        kind: source.kind,
        payload: fingerprint(source.payload),
        receipt: source.receipt ? fingerprint(source.receipt) : null,
      },
      effects: effects.map((effect) => ({
        id: effect.id,
        kind: effect.kind,
        state: effect.state,
        payload: fingerprint(effect.payload),
        receipt: effect.receipt ? fingerprint(effect.receipt) : null,
      })),
    })
  }

  async worktreeCleanupFactsChanged(plan: PlanRow): Promise<boolean> {
    const creationKinds = new Set([
      "worktree",
      "worktree-recovery",
      "graph-worktree",
      "adoption-task-worktree",
      "adoption-combined-worktree",
    ])
    const effects = this.runtime.store.effects(plan.id)
    for (const source of effects) {
      if (!creationKinds.has(source.kind) || source.state !== "completed" || !source.receipt)
        continue
      let workspace: string | undefined
      try {
        workspace = JSON.parse(source.receipt).workspace
      } catch {
        continue
      }
      if (typeof workspace !== "string") continue
      const removal = effects.find(
        (effect) =>
          effect.kind === "worktree-remove" && JSON.parse(effect.payload).workspace === workspace,
      )
      if (!removal) return true
      if (removal.state === "completed") continue
      let previousFacts: unknown
      let previousCheckedAt: unknown
      try {
        const receipt = JSON.parse(removal.receipt ?? "{}") as {
          retryFacts?: unknown
          retryCheckedAt?: unknown
        }
        previousFacts = receipt.retryFacts
        previousCheckedAt = receipt.retryCheckedAt
      } catch {
        previousFacts = undefined
      }
      if (typeof previousCheckedAt !== "number") return true
      let currentFacts: string | undefined
      try {
        currentFacts = this.worktreeCleanupRetryFacts(plan, source, workspace)
      } catch {
        // A local signal read failure never authorizes cleanup; the bounded native fallback retries.
      }
      if (currentFacts !== undefined && currentFacts !== previousFacts) return true
      const elapsed = this.runtime.now() - previousCheckedAt
      if (elapsed < 0 || elapsed >= WORKTREE_CLEANUP_FALLBACK_MS) return true
    }
    return false
  }

  async cleanupWorktrees(
    plan: PlanRow,
    fence: number,
    mode: "integration" | "cancellation" = "integration",
  ) {
    // A fallback probe is not a lifecycle change. Keep an existing hold until
    // its reason changes or native cleanup completes.
    const cleanupCurrent = () => {
      const state = this.runtime.store.plan(plan.id)?.state
      return mode === "integration"
        ? state === "cleaning" || state === "cleanup-blocked"
        : state === "cancelled"
    }
    if (!cleanupCurrent()) return
    const owned = [
      ...new Set(
        this.runtime.store
          .effects(plan.id)
          .filter(
            (effect) =>
              [
                "worktree",
                "worktree-recovery",
                "graph-worktree",
                "adoption-task-worktree",
                "adoption-combined-worktree",
              ].includes(effect.kind) && effect.state === "completed",
          )
          .map((effect) => JSON.parse(effect.receipt!).workspace as string),
      ),
    ]
    for (const workspace of owned) {
      if (workspace === this.runtime.directory)
        throw new Error("Refusing to remove the shared checkout")
      const previous = this.runtime.store
        .effects(plan.id)
        .find(
          (entry) =>
            entry.kind === "worktree-remove" && JSON.parse(entry.payload).workspace === workspace,
        )
      const effect =
        previous ??
        this.runtime.effect(plan.id, null, null, "worktree-remove", { workspace }, fence)
      if (effect.state === "completed") continue
      let removalStarted = false
      const beginCleanup = () => {
        if (!removalStarted && effect.state === "held")
          this.runtime.store.fenced(this.runtime.owner, fence, (db) =>
            db
              .query(
                "UPDATE runner_effects SET state=lz_runner_transition('effect',state,'intended') WHERE id=? AND state='held'",
              )
              .run(effect.id),
          )
        removalStarted = true
      }
      let retryFacts: string | undefined
      let sourceEffectForCleanup: EffectRow | undefined
      try {
        const sourceEffect = this.runtime.store.effects(plan.id).find((entry) => {
          if (
            ![
              "worktree",
              "worktree-recovery",
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
        sourceEffectForCleanup = sourceEffect
        if (!sourceEffect)
          throw new Error("Owned worktree has no completed creation receipt; preserve it")
        try {
          retryFacts = this.worktreeCleanupRetryFacts(plan, sourceEffect, workspace)
        } catch {
          retryFacts = fingerprint({
            planID: plan.id,
            sourceID: sourceEffect.id,
            workspace: resolve(workspace),
            workspaceExists: existsSync(workspace),
            retryFactsUnavailable: true,
          })
        }
        const listed = await this.runtime.host.worktrees()
        if (!cleanupCurrent()) {
          this.abandonCleanupEffect(effect, fence)
          return
        }
        const target = resolve(workspace)
        const listedWorkspace = listed.some((entry) => resolve(entry) === target)
        const gitWorktrees = git(this.runtime.directory, ["worktree", "list", "--porcelain"])
          .split(/\r?\n/)
          .filter((line) => line.startsWith("worktree "))
          .map((line) => resolve(line.slice("worktree ".length)))
        const gitRegistered = gitWorktrees.includes(target)
        if (listedWorkspace && existsSync(workspace)) {
          if (await gitAsync(workspace, ["status", "--porcelain"]))
            throw new Error(`Owned worktree is dirty; preserve ${workspace}`)
          if (!cleanupCurrent()) {
            this.abandonCleanupEffect(effect, fence)
            return
          }
          const head = git(workspace, ["rev-parse", "HEAD"])
          try {
            git(this.runtime.directory, ["merge-base", "--is-ancestor", head, "HEAD"])
          } catch {
            throw new Error(`Owned worktree has unmerged commits; preserve ${workspace}`)
          }
          const initialSettlement = await this.assertWorktreeQuiescent(
            plan,
            sourceEffect,
            workspace,
            mode === "cancellation",
            true,
          )
          if (!cleanupCurrent()) {
            this.abandonCleanupEffect(effect, fence)
            return
          }
          const finalSettlement = await this.assertWorktreeQuiescent(
            plan,
            sourceEffect,
            workspace,
            mode === "cancellation",
            true,
          )
          if (!cleanupCurrent()) {
            this.abandonCleanupEffect(effect, fence)
            return
          }
          if (
            initialSettlement &&
            finalSettlement &&
            fingerprint({ ...initialSettlement, observedAt: 0 }) !==
              fingerprint({ ...finalSettlement, observedAt: 0 })
          )
            throw new Error(
              "Native cleanup settlement changed before removal; preserve the worktree",
            )
          if (await gitAsync(workspace, ["status", "--porcelain"]))
            throw new Error(`Owned worktree became dirty before removal; preserve ${workspace}`)
          const finalHead = git(workspace, ["rev-parse", "HEAD"])
          try {
            git(this.runtime.directory, ["merge-base", "--is-ancestor", finalHead, "HEAD"])
          } catch {
            throw new Error(`Owned worktree has unmerged commits; preserve ${workspace}`)
          }
          const finalNative = await this.runtime.host.worktrees()
          if (!cleanupCurrent()) {
            this.abandonCleanupEffect(effect, fence)
            return
          }
          const finalGitWorktrees = git(this.runtime.directory, ["worktree", "list", "--porcelain"])
            .split(/\r?\n/)
            .filter((line) => line.startsWith("worktree "))
            .map((line) => resolve(line.slice("worktree ".length)))
          if (
            !finalNative.some((entry) => resolve(entry) === target) ||
            !finalGitWorktrees.includes(target)
          )
            throw new Error("Exact owned worktree registration changed before removal; preserve it")
          const settlement = finalSettlement ?? initialSettlement
          if (settlement) {
            const attempt = this.runtime.store
              .attempts(plan.id)
              .find((candidate) => candidate.id === sourceEffect.attempt_id)
            const authorization = attempt
              ? this.cleanupRecoveryAuthorization(plan, attempt, sourceEffect, workspace)
              : undefined
            if (!authorization)
              throw new Error("Cleanup recovery authorization changed before evidence was recorded")
            this.appendCleanupSettlement(effect, authorization, settlement, fence)
          }
          if (!cleanupCurrent()) return
          beginCleanup()
          await this.runtime.host.removeWorktree(workspace)
        } else if (listedWorkspace || gitRegistered) {
          // A disappeared directory can still have a native/Git registration.
          // Ask the recorded native strategy to retire that exact owned path;
          // never substitute filesystem deletion or force removal.
          await this.assertWorktreeQuiescent(plan, sourceEffect, workspace, mode === "cancellation")
          beginCleanup()
          await this.runtime.host.removeWorktree(workspace)
        } else if (existsSync(workspace))
          throw new Error(
            "Owned directory is not registered with OpenCode; preserve it for reconciliation",
          )
        const remainingNative = await this.runtime.host.worktrees()
        const remainingGit = git(this.runtime.directory, ["worktree", "list", "--porcelain"])
          .split(/\r?\n/)
          .filter((line) => line.startsWith("worktree "))
          .map((line) => resolve(line.slice("worktree ".length)))
        if (
          remainingNative.some((entry) => resolve(entry) === target) ||
          remainingGit.includes(target) ||
          existsSync(workspace)
        )
          throw new Error(`Native worktree removal is not confirmed absent: ${workspace}`)
        if (this.runtime.host.retireWorktreeLocation) beginCleanup()
        const cacheRetirement = await this.retireCleanedWorktreeLocation(
          plan,
          workspace,
          cleanupCurrent,
        )
        if (!cleanupCurrent()) return
        if (!(["unsupported", "not-loaded", "evicted"] as string[]).includes(cacheRetirement))
          throw new Error(`Native worktree location retirement is ${cacheRetirement}`)
        this.completeWorktreeRemoval(
          effect,
          { workspace, removed: true, native: true, cacheRetirement },
          fence,
        )
        if (!cleanupCurrent()) return
      } catch (error) {
        const reason = errorText(error)
        if (!retryFacts && sourceEffectForCleanup) {
          try {
            retryFacts = this.worktreeCleanupRetryFacts(plan, sourceEffectForCleanup, workspace)
          } catch {
            retryFacts = fingerprint({
              planID: plan.id,
              sourceID: sourceEffectForCleanup.id,
              workspace: resolve(workspace),
              workspaceExists: existsSync(workspace),
              retryFactsUnavailable: true,
            })
          }
        }
        if (!cleanupCurrent() && !removalStarted) {
          this.abandonCleanupEffect(effect, fence)
          return
        }
        let blocked = false
        this.runtime.store.fenced(this.runtime.owner, fence, (db) => {
          const held = !removalStarted && (!previous || previous.state === "held")
          const current = db
            .query<{ receipt: string | null }, [string]>(
              "SELECT receipt FROM runner_effects WHERE id=? AND state IN ('held','intended','uncertain')",
            )
            .get(effect.id)
          if (!current)
            throw new Error("Native cleanup effect changed before uncertainty was recorded")
          let previousError: string | undefined
          try {
            const previous = JSON.parse(current.receipt ?? "{}") as unknown
            if (isRecord(previous) && typeof previous.error === "string")
              previousError = previous.error
          } catch {
            // Keep malformed legacy receipt bytes in the append-only history below.
          }
          const checkedAt = this.runtime.now()
          const appended = JSON.parse(
            appendRunnerEffectReceipt(current.receipt, {
              schema: "lazers-worktree-cleanup-observation/v1",
              error: reason,
              ...(held ? { notSent: true } : {}),
              ...(retryFacts ? { retryFacts } : {}),
              retryCheckedAt: checkedAt,
            }),
          ) as Record<string, unknown>
          const receipt = JSON.stringify({
            ...appended,
            error: previousError ?? reason,
            ...(held ? { notSent: true } : {}),
            ...(retryFacts ? { retryFacts } : {}),
            retryCheckedAt: checkedAt,
          })
          const recorded = db
            .query(
              "UPDATE runner_effects SET state=lz_runner_transition('effect',state,?),receipt=? WHERE id=? AND state IN ('held','intended','uncertain')",
            )
            .run(held ? "held" : "uncertain", receipt, effect.id).changes
          if (recorded !== 1)
            throw new Error("Native cleanup uncertainty lost its durable effect row")
          blocked =
            db
              .query(
                mode === "integration"
                  ? "UPDATE runner_plans SET state=lz_runner_transition('plan',state,'cleanup-blocked'),reason=?,version=version+1 WHERE id=? AND state IN ('cleaning','cleanup-blocked') AND (state<>'cleanup-blocked' OR reason IS NOT ?)"
                  : "UPDATE runner_plans SET reason=?,version=version+1 WHERE id=? AND state='cancelled' AND (reason IS NULL OR reason<>?)",
              )
              .run(reason, plan.id, reason).changes === 1
          if (blocked)
            this.runtime.store.record(
              plan.id,
              null,
              mode === "integration" ? "CLEANUP_BLOCKED" : "CANCELLATION_CLEANUP_HELD",
              { workspace, reason },
            )
        })
        if (!blocked) return
        if (mode === "integration")
          this.runtime.outcome(
            plan.id,
            {
              status: "cleanup-blocked",
              reason,
              artifact: plan.artifact,
              allowedActions: ["integrated", "recover-cleanup"],
            },
            true,
          )
        return
      }
    }
    if (mode === "cancellation") {
      this.runtime.store.fenced(this.runtime.owner, fence, (db) => {
        db.query(
          "UPDATE runner_plans SET reason=NULL,version=version+1 WHERE id=? AND state='cancelled'",
        ).run(plan.id)
        this.runtime.store.record(plan.id, null, "CANCELLED_WORKTREES_RECONCILED", {
          directories: owned,
        })
      })
      return
    }
    let integrated = false
    this.runtime.store.fenced(this.runtime.owner, fence, (db) => {
      integrated =
        db
          .query(
            "UPDATE runner_plans SET state=lz_runner_transition('plan',state,'integrated'),reason=NULL,version=version+1 WHERE id=? AND state IN ('cleaning','cleanup-blocked')",
          )
          .run(plan.id).changes === 1
      if (integrated)
        this.runtime.store.record(plan.id, null, "WORKTREES_RECONCILED", {
          directories: owned,
          artifact: plan.artifact,
        })
    })
    if (!integrated) return
    this.runtime.outcome(
      plan.id,
      { status: "integrated", artifact: plan.artifact, worktreesRemoved: owned },
      false,
    )
  }
}
