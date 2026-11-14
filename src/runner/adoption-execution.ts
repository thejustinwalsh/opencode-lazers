import { isWorkerAgent } from "./worker-agent.ts"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fingerprint } from "../identity.ts"
import type { TaskProposal } from "../task.ts"
import {
  artifactUnchanged,
  checkResourcesSettled,
  combineArtifacts,
  git,
  gitAsync,
  runDeclaredCheck,
  scopePatternsConflict,
  verificationEnvironmentIdentity,
} from "./artifacts.ts"
import type { CheckReceipt } from "./artifacts.ts"
import { checkSucceeded } from "./checks.ts"
import { verificationCheckWithDefaults } from "./verification-timeout.ts"
import type { VerificationTimeoutDefaults } from "./verification-timeout.ts"
import { PlanInput } from "./schema.ts"
import type { PlanRow, AttemptRow, AdoptionRow, AdoptionCheckRow } from "./store.ts"
import { canonicalProjectWorktreePath } from "./workspace-location.ts"
import { forgetVerificationActivity, verificationActivityKey } from "./verification-activities.ts"

import type { TaskRuntime } from "./runtime.ts"
import { errorText } from "./runtime-helpers.ts"

export class AdoptionExecution {
  constructor(
    private readonly runtime: {
      adoptionArtifactScopeViolations: TaskRuntime["adoptionArtifactScopeViolations"]
      adoptionWorkerIdle: TaskRuntime["adoptionWorkerIdle"]
      checkActivity: TaskRuntime["checkActivity"]
      conflictingActiveAttempt: TaskRuntime["conflictingActiveAttempt"]
      currentAdoptionInputFingerprint: TaskRuntime["currentAdoptionInputFingerprint"]
      dataDirectory: TaskRuntime["dataDirectory"]
      directory: TaskRuntime["directory"]
      effect: TaskRuntime["effect"]
      host: TaskRuntime["host"]
      missingEvidence: TaskRuntime["missingEvidence"]
      outcome: TaskRuntime["outcome"]
      owner: TaskRuntime["owner"]
      projectID: TaskRuntime["projectID"]
      receipt: TaskRuntime["receipt"]
      reconcileEffect: TaskRuntime["reconcileEffect"]
      reviewedAdoptionBaseline: TaskRuntime["reviewedAdoptionBaseline"]
      startCheckActivity: TaskRuntime["startCheckActivity"]
      store: TaskRuntime["store"]
      validArchitect: TaskRuntime["validArchitect"]
      verificationTimeoutDefaults: VerificationTimeoutDefaults
    },
  ) {}

  private adoptionIsLive(adoptionID: string): boolean {
    const adoption = this.runtime.store.adoption(adoptionID)
    const plan = adoption ? this.runtime.store.plan(adoption.plan_id) : undefined
    return Boolean(
      adoption &&
      plan?.state === "blocked" &&
      ["pending", "task-checks", "combined-checks", "waiting-human"].includes(adoption.state),
    )
  }

  holdAdoption(
    plan: PlanRow,
    adoptionID: string,
    reason: string,
    state: "pending" | "waiting-human" | "held" = "held",
    fence: number,
  ) {
    this.runtime.store.fenced(this.runtime.owner, fence, () => {
      const current = this.runtime.store.adoption(adoptionID)
      const currentPlan = this.runtime.store.plan(plan.id)
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
        !this.runtime.store.setAdoptionState(current.id, state, reason, {
          owner: this.runtime.owner,
          value: fence,
        })
      )
        return
      const changed = this.runtime.store.atomic(
        (db) =>
          db
            .query(
              "UPDATE runner_plans SET state=lz_runner_transition('plan',state,'blocked'),reason=?,version=version+1 WHERE id=? AND state='blocked' AND reason IS NOT ?",
            )
            .run(reason, plan.id, reason).changes,
      )
      this.runtime.store.record(
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
    const plan = this.runtime.store.plan(planID)
    if (!plan || plan.state !== "blocked") throw new Error("Adoption plan is no longer blocked")
    if (plan.owner !== adoption.owner) throw new Error("Descendant adoption owner changed")
    const owner = await this.runtime.host.session(plan.owner)
    if (!this.runtime.validArchitect(owner) || owner.id !== adoption.owner)
      throw new Error("Descendant adoption owner is missing, stale, or foreign")
    const input = PlanInput.parse(JSON.parse(plan.body))
    const task = this.runtime.store.repository.get(adoption.task_id)
    const node = this.runtime.store
      .nodes(plan.id)
      .find((candidate) => candidate.task_id === adoption.task_id)
    const attempt = this.runtime.store
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
      this.runtime.store
        .nodes(plan.id)
        .some(
          (candidate) =>
            candidate.task_id !== adoption.task_id &&
            !["accepted", "incorporated"].includes(candidate.state),
        )
    )
      throw new Error("Combined adoption inputs are no longer fully accepted")
    if (this.runtime.conflictingActiveAttempt(adoption.task_id))
      throw new Error("A conflicting worker prevents descendant adoption")
    if (
      this.runtime.store
        .effects(plan.id)
        .some(
          (effect) =>
            !effect.kind.startsWith("adoption-") &&
            ["intended", "uncertain"].includes(effect.state),
        )
    )
      throw new Error("An uncertain prior effect prevents descendant adoption")
    const competing = this.runtime.store.activeAdoptions().filter((item) => item.id !== adoption.id)
    if (
      competing.some((item) =>
        scopePatternsConflict(
          this.runtime.store.effectiveWriteScope(adoption.task_id),
          this.runtime.store.effectiveWriteScope(item.task_id),
        ),
      )
    )
      throw new Error("A conflicting descendant reservation became active")
    const worker = await this.runtime.host.session(attempt.session_id, { messages: true })
    if (
      !worker ||
      worker.id !== attempt.session_id ||
      worker.projectID !== this.runtime.projectID ||
      worker.directory !== attempt.workspace ||
      !isWorkerAgent(worker.agent) ||
      worker.archived ||
      worker.metadata?.lazersAttemptID !== attempt.id ||
      !this.runtime.adoptionWorkerIdle(attempt, worker)
    )
      throw new Error("Latest worker activity or control state is not conclusively idle")
    const currentAttempt = this.runtime.store
      .attempts(plan.id)
      .filter((candidate) => candidate.task_id === adoption.task_id)
      .at(-1)
    const currentPlan = this.runtime.store.plan(plan.id)
    if (
      !currentAttempt ||
      currentAttempt.id !== attempt.id ||
      currentAttempt.state !== adoption.attempt_state ||
      currentAttempt.artifact !== adoption.old_artifact ||
      currentAttempt.session_id !== attempt.session_id ||
      currentAttempt.workspace !== attempt.workspace
    )
      throw new Error("Latest task attempt changed during adoption verification")
    if (
      !currentPlan ||
      this.runtime.currentAdoptionInputFingerprint(currentPlan, adoption) !==
        adoption.input_fingerprint
    )
      throw new Error("Task, plan, or authorized scope changed during adoption verification")
    const branch = git(this.runtime.directory, ["branch", "--show-current"])
    const head = git(this.runtime.directory, ["rev-parse", "HEAD"])
    if (branch !== adoption.target_branch || head !== adoption.landing_head)
      throw new Error("Reviewed landing branch or HEAD changed during adoption")
    if (
      (await gitAsync(this.runtime.directory, [
        "status",
        "--porcelain",
        "--untracked-files=all",
      ])) ||
      git(this.runtime.directory, ["ls-files", "-u", "-z"])
    )
      throw new Error("Dirty or unmerged candidate checkout cannot publish adoption")
    const candidate = git(this.runtime.directory, [
      "rev-parse",
      `${adoption.descendant_commit}^{commit}`,
    ])
    const oldArtifact = git(this.runtime.directory, [
      "rev-parse",
      `${adoption.old_artifact}^{commit}`,
    ])
    if (
      candidate !== adoption.descendant_commit ||
      oldArtifact !== adoption.old_artifact ||
      git(this.runtime.directory, ["rev-parse", `${candidate}^{tree}`]) !==
        adoption.candidate_tree ||
      git(this.runtime.directory, ["write-tree"]) !== adoption.candidate_tree
    )
      throw new Error("Candidate or index no longer matches the reviewed adoption inputs")
    git(this.runtime.directory, ["merge-base", "--is-ancestor", oldArtifact, candidate])
    const reviewedBaseline = this.runtime.reviewedAdoptionBaseline(
      adoption.target_branch,
      oldArtifact,
      candidate,
    )
    if (reviewedBaseline !== adoption.reviewed_baseline)
      throw new Error("Reviewed adoption baseline changed during adoption")
    const violations = await this.runtime.adoptionArtifactScopeViolations(
      attempt,
      oldArtifact,
      adoption.target_branch,
    )
    if (violations.length)
      throw new Error(
        `Candidate contains out-of-scope changes: ${violations.slice(0, 20).join(", ")}`,
      )
    const branches = input.integrationOrder.map((taskID) => {
      if (taskID === adoption.task_id) return candidate
      const other = this.runtime.store.nodes(plan.id).find((item) => item.task_id === taskID)
      if (!other?.artifact || !["accepted", "incorporated"].includes(other.state))
        throw new Error("Combined adoption requires every other accepted artifact")
      return other.artifact
    })
    const combinedArtifact = await combineArtifacts(
      this.runtime.directory,
      input.baseCommit,
      branches,
    )
    if (combinedArtifact !== adoption.combined_artifact)
      throw new Error("Combined artifact inputs changed during adoption")
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
    const existing = this.runtime.store.effects(plan.id).find((effect) => {
      if (effect.kind !== kind) return false
      try {
        return JSON.parse(effect.payload).adoptionID === adoption.id
      } catch {
        return false
      }
    })
    if (existing) {
      if (existing.state !== "completed") {
        await this.runtime.reconcileEffect(existing, fence)
        return undefined
      }
      const workspace = workspaceField ?? JSON.parse(existing.receipt!).workspace
      if (!existsSync(workspace) || git(workspace, ["rev-parse", "HEAD"]) !== base)
        throw new Error(`Owned adoption worktree changed; preserve ${workspace}`)
      if (git(workspace, ["ls-files", "-u", "-z"]))
        throw new Error(`Owned adoption worktree has unmerged paths; preserve ${workspace}`)
      if (await gitAsync(workspace, ["status", "--porcelain", "--untracked-files=all"])) {
        const declaredChecks =
          phase === "task"
            ? this.runtime.store.repository.get(adoption.task_id)?.proposal.verification
            : PlanInput.parse(JSON.parse(plan.body)).verification
        const rows = this.runtime.store.adoptionChecks(adoption.id, phase)
        const exactReceiptExists = (check: TaskProposal["verification"][number]) => {
          const row = rows.find((candidate) => candidate.check_id === check.id)
          if (!row) return false
          const receiptPath = join(
            this.runtime.dataDirectory,
            "receipts",
            "adoptions",
            adoption.id,
            `${phase}-${check.id}.json`,
          )
          const effectiveCheck = verificationCheckWithDefaults(
            check,
            this.runtime.verificationTimeoutDefaults,
          )
          const expectedInputFingerprint = fingerprint({
            adoptionID: adoption.id,
            adoptionInputFingerprint: adoption.input_fingerprint,
            phase,
            authoredCheck: check,
            check: effectiveCheck,
            workspace,
            artifact: base,
            environmentIdentity: row.environment_identity,
          })
          if (
            row.workspace !== workspace ||
            row.artifact !== base ||
            row.receipt_path !== receiptPath ||
            row.input_fingerprint !== expectedInputFingerprint
          )
            return false
          try {
            if (fingerprint(JSON.parse(row.check_json)) !== fingerprint(effectiveCheck))
              return false
            const receipt =
              row.state === "completed" && row.receipt
                ? (JSON.parse(row.receipt) as CheckReceipt)
                : existsSync(row.receipt_path)
                  ? (JSON.parse(readFileSync(row.receipt_path, "utf8")) as CheckReceipt)
                  : undefined
            return Boolean(receipt && this.adoptionCheckReceiptMatches(receipt, row, check))
          } catch {
            return false
          }
        }
        const allChecksHaveReceipts = Boolean(
          declaredChecks?.length &&
          declaredChecks.length === rows.length &&
          declaredChecks.every(exactReceiptExists),
        )
        const checkIsRunning = rows.some((row) => {
          const check = declaredChecks?.find((candidate) => candidate.id === row.check_id)
          if (!check) return false
          const activityIdentity = {
            adoptionID: adoption.id,
            phase,
            checkID: check.id,
            inputFingerprint: row.input_fingerprint,
            workspace: row.workspace,
            artifact: row.artifact,
            receiptPath: row.receipt_path,
          }
          return (
            this.runtime.checkActivity(
              `adoption:${adoption.id}:${phase}:${check.id}`,
              activityIdentity,
            )?.state === "running"
          )
        })
        if (checkIsRunning && !allChecksHaveReceipts) return undefined
        if (!allChecksHaveReceipts)
          throw new Error(`Owned adoption worktree changed; preserve ${workspace}`)
      }
      return workspace
    }
    if (!this.adoptionIsLive(adoption.id)) return undefined
    const workspace = canonicalProjectWorktreePath(
      this.runtime.directory,
      `adoption-${adoption.id}-${phase}`,
    )
    const effect = this.runtime.effect(
      plan.id,
      phase === "task" ? adoption.task_id : null,
      null,
      kind,
      { adoptionID: adoption.id, workspace, base },
      fence,
    )
    if (!this.adoptionIsLive(adoption.id)) {
      this.runtime.store.fenced(this.runtime.owner, fence, (db) =>
        db
          .query(
            "UPDATE runner_effects SET state=lz_runner_transition('effect',state,'failed'),receipt=? WHERE id=? AND state='intended'",
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
      const actual = await this.runtime.host.worktree({ directory: workspace, base })
      if (
        actual === this.runtime.directory ||
        git(actual, ["rev-parse", "HEAD"]) !== base ||
        (await gitAsync(actual, ["status", "--porcelain", "--untracked-files=all"])) ||
        git(actual, ["ls-files", "-u", "-z"])
      )
        throw new Error("Adoption worktree is not a clean exact-candidate checkout")
      this.runtime.receipt(effect, { workspace: actual, base }, fence)
      this.runtime.store.setAdoptionWorkspace(adoption.id, phase, actual, {
        owner: this.runtime.owner,
        value: fence,
      })
      return this.adoptionIsLive(adoption.id) ? actual : undefined
    } catch (error) {
      this.runtime.store.fenced(this.runtime.owner, fence, (db) =>
        db
          .query(
            "UPDATE runner_effects SET state=lz_runner_transition('effect',state,'uncertain'),receipt=? WHERE id=?",
          )
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

  adoptionCheckReceiptMatches(
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
      const effectiveCheck = verificationCheckWithDefaults(
        check,
        this.runtime.verificationTimeoutDefaults,
      )
      const row = this.runtime.store
        .adoptionChecks(adoption.id, phase)
        .find((item) => item.check_id === check.id)
      const environmentIdentity = row?.environment_identity ?? verificationEnvironmentIdentity()
      const inputFingerprint = fingerprint({
        adoptionID: adoption.id,
        adoptionInputFingerprint: adoption.input_fingerprint,
        phase,
        authoredCheck: check,
        check: effectiveCheck,
        workspace,
        artifact,
        environmentIdentity,
      })
      const receiptPath = join(
        this.runtime.dataDirectory,
        "receipts",
        "adoptions",
        adoption.id,
        `${phase}-${check.id}.json`,
      )
      const activityID = `adoption:${adoption.id}:${phase}:${check.id}`
      if (row) {
        const activityIdentity = {
          adoptionID: adoption.id,
          phase,
          checkID: check.id,
          inputFingerprint: row.input_fingerprint,
          workspace: row.workspace,
          artifact: row.artifact,
          receiptPath: row.receipt_path,
        }
        if (
          row.workspace !== workspace ||
          row.artifact !== artifact ||
          fingerprint(JSON.parse(row.check_json)) !== fingerprint(effectiveCheck) ||
          row.receipt_path !== receiptPath
        ) {
          this.holdAdoption(
            plan,
            adoption.id,
            `Adoption check ${phase}:${check.id} no longer matches its recorded command or workspace`,
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
        if (previous && this.adoptionCheckReceiptMatches(previous, row, effectiveCheck)) {
          if (row.state !== "completed") {
            this.runtime.store.completeAdoptionCheck(adoption.id, phase, check.id, previous, {
              owner: this.runtime.owner,
              value: fence,
            })
          }
          forgetVerificationActivity(
            verificationActivityKey(this.runtime.store.repository.path, activityID),
            fingerprint(activityIdentity),
          )
          receipts.push(previous)
          if (!checkResourcesSettled(previous)) {
            this.holdAdoption(
              plan,
              adoption.id,
              `Adoption verification ${phase}:${check.id} completed with exit ${previous.exitCode ?? "unknown"} and timedOut=${previous.timedOut}, but subprocess cleanup is uncertain: ${previous.processCleanup?.detail ?? "termination was not confirmed"}`,
              "held",
              fence,
            )
            return undefined
          }
          if (!this.adoptionIsLive(adoption.id)) return undefined
          continue
        }
        const activity = this.runtime.checkActivity(activityID, activityIdentity)
        if (activity?.state === "running") return undefined
        if (row.state !== "completed")
          this.runtime.store.markAdoptionCheckUncertain(
            adoption.id,
            phase,
            check.id,
            activity?.state === "failed"
              ? `Verification subprocess did not settle conclusively: ${errorText(activity.error)}`
              : "No conclusive operation-bound check receipt; check was not repeated",
            { owner: this.runtime.owner, value: fence },
          )
        this.holdAdoption(
          plan,
          adoption.id,
          `Uncertain adoption check ${phase}:${check.id}; evidence was not replayed`,
          "pending",
          fence,
        )
        forgetVerificationActivity(
          verificationActivityKey(this.runtime.store.repository.path, activityID),
          fingerprint(activityIdentity),
        )
        return undefined
      }
      const candidateClean =
        existsSync(workspace) &&
        git(workspace, ["rev-parse", "HEAD"]) === artifact &&
        !(await gitAsync(workspace, ["status", "--porcelain", "--untracked-files=all"])) &&
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
      const checkRow = this.runtime.store.beginAdoptionCheck({
        adoptionID: adoption.id,
        phase,
        checkID: check.id,
        check: effectiveCheck,
        workspace,
        artifact,
        inputFingerprint,
        environmentIdentity,
        receiptPath,
        fence: { owner: this.runtime.owner, value: fence },
      })
      if (!this.adoptionIsLive(adoption.id)) return undefined
      try {
        const activityIdentity = {
          adoptionID: adoption.id,
          phase,
          checkID: check.id,
          inputFingerprint: checkRow.input_fingerprint,
          workspace: checkRow.workspace,
          artifact: checkRow.artifact,
          receiptPath: checkRow.receipt_path,
        }
        this.runtime.startCheckActivity({
          id: activityID,
          identity: activityIdentity,
          metadata: {
            kind: "adoption",
            projectDirectory: this.runtime.directory,
            planID: plan.id,
            activityID,
            adoptionID: adoption.id,
            phase,
            checkID: check.id,
          },
          run: (signal) =>
            runDeclaredCheck(workspace, artifact, effectiveCheck, receiptPath, { signal }),
        })
        return undefined
      } catch (error) {
        this.runtime.store.markAdoptionCheckUncertain(
          adoption.id,
          phase,
          check.id,
          errorText(error),
          {
            owner: this.runtime.owner,
            value: fence,
          },
        )
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

  async advanceAdoption(plan: PlanRow, initial: AdoptionRow, fence: number) {
    let adoption = this.runtime.store.adoption(initial.id)
    if (!adoption || !this.adoptionIsLive(adoption.id)) return
    let context: Awaited<ReturnType<AdoptionExecution["validateAdoption"]>>
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
    this.runtime.store.setAdoptionState(adoption.id, "task-checks", null, {
      owner: this.runtime.owner,
      value: fence,
    })
    adoption = this.runtime.store.adoption(adoption.id)!
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
    if (!artifactUnchanged(taskWorkspace, adoption.descendant_commit)) {
      this.holdAdoption(
        plan,
        adoption.id,
        "Adopted task candidate changed after its checks; authorize retained repair before capturing fixes",
        "held",
        fence,
      )
      return
    }
    if (
      taskReceipts.some(
        (receipt) =>
          !checkSucceeded(receipt) || receipt.inputIdentity !== adoption!.descendant_commit,
      )
    ) {
      this.holdAdoption(plan, adoption.id, "Task verification command failed", "held", fence)
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
    this.runtime.store.setAdoptionState(adoption.id, "combined-checks", null, {
      owner: this.runtime.owner,
      value: fence,
    })
    adoption = this.runtime.store.adoption(adoption.id)!
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
    if (!artifactUnchanged(combinedWorkspace, adoption.combined_artifact)) {
      this.holdAdoption(
        plan,
        adoption.id,
        "Adopted combined candidate changed after its checks; authorize retained repair before capturing fixes",
        "held",
        fence,
      )
      return
    }
    if (
      combinedReceipts.some(
        (receipt) =>
          !checkSucceeded(receipt) || receipt.inputIdentity !== adoption!.combined_artifact,
      )
    ) {
      this.holdAdoption(plan, adoption.id, "Combined verification command failed", "held", fence)
      return
    }
    try {
      context = await this.validateAdoption(plan.id, adoption)
    } catch (error) {
      this.holdAdoption(plan, adoption.id, errorText(error), "held", fence)
      return
    }
    const taskMissing = this.runtime.missingEvidence(
      plan.id,
      adoption.task_id,
      adoption.descendant_commit,
      taskWorkspace,
      context.task.proposal.acceptance,
      taskReceipts,
      adoption.id,
    )
    const combinedMissing = this.runtime.missingEvidence(
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
    try {
      context = await this.validateAdoption(plan.id, adoption)
    } catch (error) {
      this.holdAdoption(plan, adoption.id, errorText(error), "held", fence)
      return
    }
    const publicationStatus = await gitAsync(this.runtime.directory, [
      "status",
      "--porcelain",
      "--untracked-files=all",
    ])
    this.runtime.store.fenced(this.runtime.owner, fence, (db) => {
      const current = this.runtime.store.adoption(adoption!.id)
      const currentPlan = this.runtime.store.plan(plan.id)
      const currentNode = this.runtime.store
        .nodes(plan.id)
        .find((node) => node.task_id === adoption!.task_id)
      const currentAttempt = db
        .query<
          Pick<AttemptRow, "id" | "state" | "artifact" | "session_id" | "workspace">,
          [string, string]
        >(
          `SELECT id,state,artifact,session_id,workspace FROM runner_attempts
           WHERE plan_id=? AND task_id=? ORDER BY number DESC LIMIT 1`,
        )
        .get(plan.id, adoption!.task_id)
      if (
        !current ||
        !currentPlan ||
        currentPlan.state !== "blocked" ||
        currentPlan.version !== context.plan.version ||
        currentPlan.owner !== context.plan.owner ||
        !["pending", "task-checks", "combined-checks", "waiting-human"].includes(current.state) ||
        !currentNode ||
        currentNode.state !== adoption!.node_state ||
        currentNode.artifact !== adoption!.old_artifact
      )
        return
      if (
        !currentAttempt ||
        currentAttempt.id !== adoption!.attempt_id ||
        currentAttempt.state !== adoption!.attempt_state ||
        currentAttempt.artifact !== adoption!.old_artifact ||
        currentAttempt.session_id !== context.attempt.session_id ||
        currentAttempt.workspace !== context.attempt.workspace
      ) {
        const reason = "Latest task attempt changed during adoption publication"
        const held = db
          .query(
            `UPDATE runner_adoptions SET state=lz_runner_transition('adoption',state,'held'),hold_reason=?,updated_at=?
             WHERE id=? AND state IN ('pending','task-checks','combined-checks','waiting-human')`,
          )
          .run(reason, Date.now(), adoption!.id).changes
        if (!held) return
        db.query(
          "UPDATE runner_plans SET state=lz_runner_transition('plan',state,'blocked'),reason=?,version=version+1 WHERE id=? AND state='blocked'",
        ).run(reason, plan.id)
        this.runtime.store.record(plan.id, adoption!.task_id, "DESCENDANT_ADOPTION_HELD", {
          adoptionID: adoption!.id,
          reason,
          attemptID: currentAttempt?.id ?? null,
          attemptState: currentAttempt?.state ?? null,
        })
        return
      }
      if (
        git(this.runtime.directory, ["branch", "--show-current"]) !== adoption!.target_branch ||
        git(this.runtime.directory, ["rev-parse", "HEAD"]) !== adoption!.landing_head ||
        publicationStatus
      )
        return
      const activeWorker = this.runtime.conflictingActiveAttempt(adoption!.task_id)
      if (activeWorker) {
        const reason = "A conflicting worker prevents descendant adoption publication"
        const held = db
          .query(
            `UPDATE runner_adoptions SET state=lz_runner_transition('adoption',state,'held'),hold_reason=?,updated_at=?
             WHERE id=? AND state IN ('pending','task-checks','combined-checks','waiting-human')`,
          )
          .run(reason, Date.now(), adoption!.id).changes
        if (!held) return
        db.query(
          "UPDATE runner_plans SET state=lz_runner_transition('plan',state,'blocked'),reason=?,version=version+1 WHERE id=? AND state='blocked'",
        ).run(reason, plan.id)
        this.runtime.store.record(plan.id, adoption!.task_id, "DESCENDANT_ADOPTION_HELD", {
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
        this.runtime.store.move(plan.id, adoption!.task_id, "ADOPT_ACCEPT")
      }
      this.runtime.store.record(plan.id, adoption!.task_id, "DESCENDANT_ADOPTED", {
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
          `UPDATE runner_adoptions SET state=lz_runner_transition('adoption',state,'accepted'),hold_reason=NULL,updated_at=?
           WHERE id=? AND state IN ('pending','task-checks','combined-checks','waiting-human')`,
        )
        .run(Date.now(), adoption!.id).changes
      if (!changed) return
      db.query(
        "UPDATE runner_plans SET state=lz_runner_transition('plan',state,'accepted'),reason=NULL,artifact=?,version=version+1 WHERE id=? AND state='blocked'",
      ).run(adoption!.combined_artifact, plan.id)
      this.runtime.store.record(plan.id, null, "PLAN_ACCEPTED", {
        artifact: adoption!.combined_artifact,
        checks: combinedReceipts,
        adoptionID: adoption!.id,
        taskArtifact: adoption!.descendant_commit,
      })
      this.runtime.outcome(
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
}
