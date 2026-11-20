import type { AdoptionSeed } from "./runtime-helpers.ts"
import { isWorkerAgent } from "./worker-agent.ts"

import { fingerprint } from "../identity.ts"
import {
  combineArtifacts,
  gitAsync,
  reviewedScopeBase,
  scopePatternsConflict,
  verificationEnvironmentIdentity,
} from "./artifacts.ts"
import { protectedPaths } from "./scope.ts"
import { FINGERPRINT_V2_PREFIX, isFingerprintV2 } from "./identity-store.ts"
import type { HostSession } from "./host.ts"
import { PlanInput } from "./schema.ts"
import type { CommandInput as PlanCommand } from "./schema.ts"
import type { PlanRow, AttemptRow, AdoptionRow } from "./store.ts"
import type { ArchitectOwnership } from "./architect-ownership.ts"
import type { WorkerObservation } from "./worker-observation.ts"
import type { RuntimeCore } from "./runtime-core.ts"

/** What `AdoptionPreparation` reads from the coordinator and its sibling modules; calls are lazy arrows. */
export type AdoptionPreparationDeps = {
  backgroundBlockReason: WorkerObservation["backgroundBlockReason"]
  validArchitect: ArchitectOwnership["validArchitect"]
}

/**
 * Adoption preparation: the versioned input fingerprint, the reviewed baseline and scope checks for
 * an adopted descendant, worker idleness, and preparing the adoption. Moved out of `TaskRuntime`
 * without rewriting; the private aliases below keep the member bodies identical to what they were.
 */
export class AdoptionPreparation {
  private readonly backgroundBlockReason: AdoptionPreparationDeps["backgroundBlockReason"]
  private readonly validArchitect: AdoptionPreparationDeps["validArchitect"]

  constructor(
    private readonly core: RuntimeCore,
    deps: AdoptionPreparationDeps,
  ) {
    this.backgroundBlockReason = (...args) => deps.backgroundBlockReason(...args)
    this.validArchitect = deps.validArchitect
  }

  private get store() {
    return this.core.store
  }

  private get projectID() {
    return this.core.projectID
  }

  private get host() {
    return this.core.host
  }

  private get directory() {
    return this.core.directory
  }

  /**
   * Versioned. `v1` (no prefix) hashes commit SHAs and stays valid for rows
   * already stored. `v2:` hashes tree OIDs and stable ids, so rewriting history
   * cannot invalidate it. New rows use v2; stored rows keep the version they
   * were written with.
   */
  adoptionInputFingerprint(input: AdoptionFingerprintInput, version: "v1" | "v2" = "v2") {
    const task = this.store.repository.get(input.taskID)
    if (!task) throw new Error("Adoption task is missing")
    const base = {
      projectID: this.projectID,
      planID: input.plan.id,
      planRevision: input.plan.revision,
      planVersion: input.originalPlanVersion,
      taskID: input.taskID,
      taskRevision: input.taskRevision,
      taskProposal: task.proposal,
      attemptID: input.attemptID,
      nodeState: input.nodeState,
      attemptState: input.attemptState,
      targetBranch: input.targetBranch,
      candidateTree: input.candidateTree,
      effectiveWriteScope: this.store.effectiveWriteScope(input.taskID),
      reason: input.reason,
      environmentIdentity: input.environmentIdentity,
    }
    if (version === "v1")
      return fingerprint({
        ...base,
        planBody: input.plan.body,
        oldArtifact: input.oldArtifact,
        descendantCommit: input.descendantCommit,
        landingHead: input.landingHead,
        reviewedBaseline: input.reviewedBaseline,
        combinedArtifact: input.combinedArtifact,
      })
    const ref = (sha: string) => this.store.treeRef(sha)
    return `${FINGERPRINT_V2_PREFIX}${fingerprint({
      ...base,
      planBody: this.store.planBodyIdentity(input.plan.body),
      oldArtifact: ref(input.oldArtifact),
      descendantCommit: ref(input.descendantCommit),
      landingHead: ref(input.landingHead),
      reviewedBaseline: input.reviewedBaseline ? ref(input.reviewedBaseline) : "",
      combinedArtifact: ref(input.combinedArtifact),
    })}`
  }
  currentAdoptionInputFingerprint(plan: PlanRow, adoption: AdoptionRow) {
    // Recompute with the version the row was stored with.
    return this.adoptionInputFingerprint(
      {
        plan,
        originalPlanVersion: adoption.plan_version,
        taskID: adoption.task_id,
        taskRevision: adoption.task_revision,
        attemptID: adoption.attempt_id,
        nodeState: adoption.node_state,
        attemptState: adoption.attempt_state,
        oldArtifact: adoption.old_artifact,
        descendantCommit: adoption.descendant_commit,
        targetBranch: adoption.target_branch,
        landingHead: adoption.landing_head,
        reviewedBaseline: adoption.reviewed_baseline,
        candidateTree: adoption.candidate_tree,
        combinedArtifact: adoption.combined_artifact,
        reason: adoption.reason,
        environmentIdentity: adoption.environment_identity,
      },
      isFingerprintV2(adoption.input_fingerprint) ? "v2" : "v1",
    )
  }
  conflictingActiveAttempt(taskID: string): AttemptRow | undefined {
    const scope = this.store.effectiveReservationScope(taskID)
    return this.store
      .activeProjectAttempts()
      .find(
        (attempt) =>
          ["preparing", "running", "verifying"].includes(attempt.state) &&
          (attempt.workspace === this.directory ||
            scopePatternsConflict(scope, this.store.effectiveReservationScope(attempt.task_id))),
      )
  }
  async reviewedAdoptionBaseline(targetBranch: string, oldArtifact: string, candidate: string) {
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
    const firstParent = (await gitAsync(this.directory, ["rev-list", "--first-parent", candidate]))
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
        await gitAsync(this.directory, ["merge-base", "--is-ancestor", oldArtifact, payload.head])
        await gitAsync(this.directory, [
          "merge-base",
          "--is-ancestor",
          payload.artifact,
          payload.head,
        ])
      } catch {
        continue
      }
      baseline = payload.head
      nearest = position
    }
    return baseline
  }
  async adoptionArtifactScopeViolations(attempt: AttemptRow, artifact: string, branch: string) {
    // Worker scope belongs to its patch. The owner reviews the integrated branch
    // separately, and fresh checks qualify that exact descendant.
    const reviewed = await this.reviewedAdoptionBaseline(branch, attempt.base_commit, artifact)
    const base = await reviewedScopeBase(this.directory, attempt.base_commit, artifact, reviewed)
    const paths = (
      await gitAsync(this.directory, ["diff", "--name-only", "--no-renames", "-z", base, artifact])
    )
      .split("\0")
      .filter(Boolean)
    return protectedPaths(paths, this.store.effectiveScope(attempt.task_id))
  }
  adoptionWorkerIdle(attempt: AttemptRow, worker: HostSession): boolean {
    return (
      worker.busy === false &&
      worker.pendingInput !== true &&
      !worker.observationUnstable &&
      (worker.pendingPermissions ?? 0) === 0 &&
      (worker.pendingForms ?? 0) === 0 &&
      Boolean(worker.outcome) &&
      ["completed", "interrupted"].includes(worker.turn?.state ?? "unknown") &&
      !this.backgroundBlockReason(worker)
    )
  }
  async prepareAdoption(
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
    if (!this.validArchitect(ownerSession))
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
    const scopes = this.store.effectiveReservationScope(command.taskID)
    if (
      this.store
        .activeAdoptions()
        .some((adoption) =>
          scopePatternsConflict(scopes, this.store.effectiveReservationScope(adoption.task_id)),
        )
    )
      throw new Error("An active descendant reservation conflicts with this task scope")

    const worker = await this.host.session(latest.session_id, { messages: true })
    if (
      !worker ||
      worker.id !== latest.session_id ||
      worker.projectID !== this.projectID ||
      worker.directory !== latest.workspace ||
      !isWorkerAgent(worker.agent) ||
      worker.archived ||
      worker.metadata?.lazersAttemptID !== latest.id
    )
      throw new Error("Latest worker session is not the owned attempt")
    if (!this.adoptionWorkerIdle(latest, worker))
      throw new Error("Latest worker activity or control state is not conclusively idle")

    const branch = await gitAsync(this.directory, ["branch", "--show-current"])
    const head = await gitAsync(this.directory, ["rev-parse", "HEAD"])
    if (branch !== command.targetBranch || command.descendantCommit !== head)
      throw new Error("Reviewed descendant must be the exact current HEAD of targetBranch")
    if (
      (await gitAsync(this.directory, ["status", "--porcelain", "--untracked-files=all"])) ||
      (await gitAsync(this.directory, ["ls-files", "-u", "-z"]))
    )
      throw new Error("Dirty or unmerged candidate checkout cannot be adopted")
    const oldArtifact = await gitAsync(this.directory, [
      "rev-parse",
      `${command.artifact}^{commit}`,
    ])
    const descendantCommit = await gitAsync(this.directory, [
      "rev-parse",
      `${command.descendantCommit}^{commit}`,
    ])
    if (oldArtifact !== command.artifact || descendantCommit !== command.descendantCommit)
      throw new Error("Adoption artifacts must be exact full commit identities")
    if (oldArtifact === descendantCommit)
      throw new Error("Reviewed candidate must be a strict descendant of the old artifact")
    await gitAsync(this.directory, ["merge-base", "--is-ancestor", oldArtifact, descendantCommit])
    const reviewedBaseline = await this.reviewedAdoptionBaseline(
      branch,
      oldArtifact,
      descendantCommit,
    )
    const violations = await this.adoptionArtifactScopeViolations(latest, oldArtifact, branch)
    if (violations.length)
      throw new Error(
        `Worker artifact contains changes outside the task's authorized scope: ${violations.slice(0, 20).join(", ")}`,
      )
    const candidateTree = await gitAsync(this.directory, [
      "rev-parse",
      `${descendantCommit}^{tree}`,
    ])
    const branches = input.integrationOrder.map((taskID) => {
      if (taskID === command.taskID) return descendantCommit
      const other = this.store.nodes(plan.id).find((candidate) => candidate.task_id === taskID)
      if (!other?.artifact || !["accepted", "incorporated"].includes(other.state))
        throw new Error("Combined adoption requires every other task's accepted artifact")
      return other.artifact
    })
    const combinedArtifact = await combineArtifacts(this.directory, input.baseCommit, branches)
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
}

type AdoptionFingerprintInput = {
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
}
