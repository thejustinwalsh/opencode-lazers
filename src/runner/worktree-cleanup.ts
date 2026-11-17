import { isWorkerAgent } from "./worker-agent.ts"
import { existsSync, lstatSync } from "node:fs"
import { resolve } from "node:path"
import { fingerprint } from "../identity.ts"
import { gitAsync, worktreeListPorcelain } from "./artifacts.ts"
import type { CheckReceipt } from "./artifacts.ts"
import type { WorktreeLocationRetirement } from "./host.ts"
import { PlanInput } from "./schema.ts"
import { containmentReason, headContained, proofForArtifact } from "./integration-proof.ts"
import type { PlanRow, AttemptRow, EffectRow } from "./store.ts"
import { appendRunnerEffectReceipt } from "./store.ts"

import type { TaskRuntime } from "./runtime.ts"
import { errorText } from "./runtime-helpers.ts"
import { isRecord } from "./runtime-helpers.ts"
import { WORKTREE_CLEANUP_FALLBACK_MS, WORKTREE_CLEANUP_LIVE_RETRY_MS } from "./runtime-helpers.ts"
import type { AdoptionExecution } from "./adoption-execution.ts"
import { sameVerificationCheckIdentity } from "./runtime-helpers.ts"

/** A cleanup blocker that the host can observe directly, so a short poll re-checks it. */
class LiveActivityBlockedError extends Error {}

export class WorktreeCleanup {
  constructor(
    private readonly runtime: {
      adoptionCheckReceiptMatches: AdoptionExecution["adoptionCheckReceiptMatches"]
      adoptionCheckInputMatches: AdoptionExecution["adoptionCheckInputMatches"]
      backgroundBlockReason: TaskRuntime["backgroundBlockReason"]
      directory: TaskRuntime["directory"]
      effect: TaskRuntime["effect"]
      host: TaskRuntime["host"]
      now: TaskRuntime["now"]
      outcome: TaskRuntime["outcome"]
      owner: TaskRuntime["owner"]
      progress: TaskRuntime["progress"]
      projectID: TaskRuntime["projectID"]
      store: TaskRuntime["store"]
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
        !this.runtime.adoptionCheckInputMatches(adoption, phase, check, row, workspace, artifact) ||
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
        !sameVerificationCheckIdentity(payload?.check, check) ||
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
  ): Promise<void> {
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
      return
    }
    if (effect.kind === "graph-worktree") {
      if (this.runtime.store.attempts(plan.id).some((attempt) => attempt.workspace === workspace))
        throw new Error("Combined worktree unexpectedly has an attempt owner; preserve it")
      this.assertGraphWorkspaceQuiescent(plan, workspace, allowCancelled)
      return
    }
    const attempts = this.runtime.store
      .attempts(plan.id)
      .filter((attempt) => attempt.workspace === workspace)
    if (!attempts.length)
      throw new Error("Owned worktree has no matching attempt; preserve it for reconciliation")
    for (const attempt of attempts) {
      const session = await this.runtime.host.session(attempt.session_id, { messages: true })
      // RunnerHost null is authoritative native not-found: a missing worker has
      // nothing running, so it cannot keep its checkout forever.
      if (!session) continue
      // Live idle check, read from the host now: the worker is idle when its
      // session is not busy, has no pending input, permission or form, runs no
      // shell inside the worktree and has no active child session.
      const blockers: string[] = []
      if (session.id !== attempt.session_id) blockers.push("session identity changed")
      if (session.projectID !== this.runtime.projectID) blockers.push("project identity changed")
      if (session.directory !== workspace) blockers.push("worker location changed")
      if (!isWorkerAgent(session.agent)) blockers.push("session is no longer an implementor")
      if (session.metadata?.lazersAttemptID !== attempt.id)
        blockers.push("attempt ownership changed")
      if (session.busy !== false) blockers.push("worker session is busy")
      if (session.pendingInput === true) blockers.push("worker has pending input")
      if (session.observationUnstable) blockers.push("native worker observation is unstable")
      if ((session.pendingPermissions ?? 0) !== 0)
        blockers.push("worker has pending permission requests")
      if ((session.pendingForms ?? 0) !== 0) blockers.push("worker has pending forms")
      const background = this.runtime.backgroundBlockReason(session)
      if (background) blockers.push(background)
      if (
        !blockers.length &&
        mergedCheckout &&
        !allowCancelled &&
        attempt.state === "accepted" &&
        this.runtime.host.retireIntegratedWorker
      )
        await this.runtime.host.retireIntegratedWorker({
          projectID: this.runtime.projectID,
          attemptID: attempt.id,
          sessionID: attempt.session_id,
          workspace,
        })
      if (blockers.length)
        throw new LiveActivityBlockedError(
          `Owned worktree worker is not idle; preserve it: ${blockers.join("; ")}`,
        )
    }
  }

  /**
   * The accepted artifact's change (note, patch-id or tree, not its commit SHA)
   * must be contained in the current checkout before its worktree is removed.
   */
  private async assertArtifactIntegrated(attempt: AttemptRow) {
    if (!attempt.artifact) return
    try {
      const proof = await proofForArtifact(
        (run) => this.runtime.store.repository.read(run),
        this.runtime.directory,
        { artifact: attempt.artifact, attemptID: attempt.id, base: attempt.base_commit },
      )
      if (proof.containment.status !== "contained")
        throw new Error(
          containmentReason(proof.containment, "The accepted artifact", "the integration branch"),
        )
    } catch (error) {
      throw new Error(
        `Accepted artifact is not contained in the checkout (${errorText(error)}); preserve the worktree`,
        { cause: error },
      )
    }
  }

  /**
   * A worktree is safe to remove when its HEAD is an ancestor of the checkout or
   * its change is contained there (rebased, amended, re-signed or squashed).
   * Anything else is preserved; an ambiguous match keeps its reason visible.
   */
  private async assertHeadMerged(workspace: string, head: string) {
    const base = this.runtime.store.repository.read(
      (db) =>
        db
          .query<{ base_commit: string }, [string]>(
            "SELECT base_commit FROM runner_attempts WHERE workspace=? ORDER BY started_at DESC LIMIT 1",
          )
          .get(workspace)?.base_commit,
    )
    const result = await headContained(this.runtime.directory, head, "HEAD", base)
    if (result.status === "contained") return
    throw new Error(
      `Owned worktree has unmerged commits; preserve ${workspace}${
        result.status === "ambiguous"
          ? ` (${containmentReason(result, "Its change", "the checkout")})`
          : ""
      }`,
    )
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
      const gitWorktrees = (await worktreeListPorcelain(this.runtime.directory))
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
      owners,
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
      let liveBlocker = false
      try {
        const receipt = JSON.parse(removal.receipt ?? "{}") as {
          retryFacts?: unknown
          retryCheckedAt?: unknown
          liveBlocker?: unknown
        }
        previousFacts = receipt.retryFacts
        previousCheckedAt = receipt.retryCheckedAt
        liveBlocker = receipt.liveBlocker === true
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
      const interval = liveBlocker ? WORKTREE_CLEANUP_LIVE_RETRY_MS : WORKTREE_CLEANUP_FALLBACK_MS
      if (elapsed < 0 || elapsed >= interval) return true
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
        const gitWorktrees = (await worktreeListPorcelain(this.runtime.directory))
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
          const head = await gitAsync(workspace, ["rev-parse", "HEAD"])
          await this.assertHeadMerged(workspace, head)
          for (const attempt of this.runtime.store
            .attempts(plan.id)
            .filter((candidate) => candidate.workspace === workspace && candidate.artifact))
            if (mode === "integration" && attempt.state === "accepted")
              await this.assertArtifactIntegrated(attempt)
          await this.assertWorktreeQuiescent(
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
          await this.assertWorktreeQuiescent(
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
          if (await gitAsync(workspace, ["status", "--porcelain"]))
            throw new Error(`Owned worktree became dirty before removal; preserve ${workspace}`)
          const finalHead = await gitAsync(workspace, ["rev-parse", "HEAD"])
          await this.assertHeadMerged(workspace, finalHead)
          const finalNative = await this.runtime.host.worktrees()
          if (!cleanupCurrent()) {
            this.abandonCleanupEffect(effect, fence)
            return
          }
          const finalGitWorktrees = (await worktreeListPorcelain(this.runtime.directory))
            .split(/\r?\n/)
            .filter((line) => line.startsWith("worktree "))
            .map((line) => resolve(line.slice("worktree ".length)))
          if (
            !finalNative.some((entry) => resolve(entry) === target) ||
            !finalGitWorktrees.includes(target)
          )
            throw new Error("Exact owned worktree registration changed before removal; preserve it")
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
        const remainingGit = (await worktreeListPorcelain(this.runtime.directory))
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
          const live = error instanceof LiveActivityBlockedError
          let priorReceipt: Record<string, unknown> | undefined
          try {
            const parsed = JSON.parse(current.receipt ?? "null") as unknown
            if (isRecord(parsed)) priorReceipt = parsed
          } catch {
            priorReceipt = undefined
          }
          const last = Array.isArray(priorReceipt?.history)
            ? priorReceipt.history.at(-1)
            : undefined
          // The same blocker observed again is not new history; only the check time moves.
          const unchanged =
            isRecord(last) && last.error === reason && Boolean(last.notSent) === held
          const base =
            unchanged && priorReceipt
              ? priorReceipt
              : (JSON.parse(
                  appendRunnerEffectReceipt(current.receipt, {
                    schema: "lazers-worktree-cleanup-observation/v1",
                    error: reason,
                    ...(held ? { notSent: true } : {}),
                    ...(retryFacts ? { retryFacts } : {}),
                    retryCheckedAt: checkedAt,
                  }),
                ) as Record<string, unknown>)
          const receipt = JSON.stringify({
            ...base,
            error: previousError ?? reason,
            ...(held ? { notSent: true } : {}),
            ...(retryFacts ? { retryFacts } : {}),
            retryCheckedAt: checkedAt,
            liveBlocker: live,
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
              allowedActions: ["integrated", "cancel"],
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
