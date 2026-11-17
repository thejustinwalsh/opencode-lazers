import { sameProject } from "../project-key.ts"
import { privacyStats, safeText } from "../trajectory/privacy.ts"
import type { Database } from "bun:sqlite"
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"
import { fingerprint } from "../identity.ts"
import { FINGERPRINT_V2_PREFIX } from "./identity-store.ts"
import {
  effectiveVerificationCheck,
  verificationCommandFingerprint,
  verificationReceiptDeadline,
} from "./verification-timeout.ts"
import type { VerificationTimeoutTarget } from "./verification-timeout.ts"
import type { TaskProposal } from "../task.ts"
import {
  artifactExists,
  checkResourcesSettled,
  combineArtifacts,
  combinedArtifactsMatch,
  gitAsync,
  worktreeListPorcelain,
} from "./artifacts.ts"
import type { CheckReceipt } from "./artifacts.ts"
import { checkSucceeded, checkFailureReason, isConclusiveNonTimeoutInterruption } from "./checks.ts"
import type { HostSession } from "./host.ts"
import { PlanInput } from "./schema.ts"
import type { PlanRow } from "./store.ts"
import {
  samePhysicalWorkspace,
  sourceQuarantineVerificationBindingMatches,
} from "./source-quarantine.ts"
import { startupWorktreeCandidates } from "./startup-recovery.ts"
import {
  activateRetainedVerificationResources,
  beginRetainedVerificationCheck,
  completeRetainedVerificationCheck,
  markRetainedVerificationCheckUncertain,
  registerRetainedVerificationResources,
  retainedVerification,
  retainedVerificationChecks,
  retainedVerificationsForProject,
  saveRetainedVerification,
  setRetainedVerificationCheckCleanup,
  setRetainedVerificationWorkspace,
  settleRetainedVerificationResources,
  updateRetainedVerificationResourceIdentity,
} from "./retained-verification/store.ts"
import {
  forgetVerificationActivity,
  verificationActivitiesForDatabase,
  verificationActivityKey,
} from "./verification-activities.ts"
import type { RetainedVerification } from "./retained-verification/schema.ts"
import {
  createRetainedCheckContext,
  observeRetainedCheckContext,
  observeRetainedCheckIsolationWitness,
  removeRetainedCheckContext,
  removeRetainedCheckContextFromWitness,
  removeRetainedCheckSetupResources,
  retainedCheckIsolationWitness,
  retainedTemporaryDirectoryAliasPath,
  RetainedSetupProcessTreeUncertainError,
} from "./retained-verification/isolation.ts"
import type {
  RetainedCheckSetupLink,
  RetainedCheckSetupResource,
} from "./retained-verification/isolation.ts"
import { ProbeRepository } from "../verification/probe/store.ts"
import { ResourceRepository } from "../verification/resources/store.ts"
import { retainedVerificationProbeBasis } from "./retained-verification/probe.ts"
import {
  retainedProcedurePlan,
  retainedProjectIdentity,
} from "./retained-verification/procedure.ts"

import type { TaskRuntime } from "./runtime.ts"
import { errorText } from "./runtime-helpers.ts"
import { isRecord } from "./runtime-helpers.ts"
import { sameVerificationCheckIdentity } from "./runtime-helpers.ts"
import { WORKTREE_CLEANUP_FALLBACK_MS } from "./runtime-helpers.ts"
import { pathEntryExists } from "./runtime-helpers.ts"

function isCurrentRetainedVerification(
  current: RetainedVerification | undefined,
  initial: RetainedVerification,
): current is RetainedVerification {
  return (
    current !== undefined &&
    current.generation === initial.generation &&
    ["pending", "task-checks", "combined-checks"].includes(current.state)
  )
}

function retainedRetryResourcesMatch(
  current: Array<{ name: string; pathFingerprint: string; state: string }>,
  prior: unknown,
  allowLegacyRows: boolean,
): boolean {
  if (fingerprint(current) === fingerprint(prior)) return true
  if (!allowLegacyRows || !Array.isArray(prior)) return false
  const legacyBindings: Array<{ name: string; pathFingerprint: string; state: string }> = []
  for (const resource of prior) {
    if (
      !isRecord(resource) ||
      Object.keys(resource).sort().join(",") !== "canonical_path,resource_name,state" ||
      typeof resource.resource_name !== "string" ||
      typeof resource.canonical_path !== "string" ||
      typeof resource.state !== "string"
    )
      return false
    legacyBindings.push({
      name: resource.resource_name,
      pathFingerprint: fingerprint(resource.canonical_path),
      state: resource.state,
    })
  }
  const byName = (left: { name: string }, right: { name: string }) =>
    left.name.localeCompare(right.name)
  return fingerprint([...current].sort(byName)) === fingerprint(legacyBindings.sort(byName))
}

export class RetainedVerificationExecution {
  constructor(
    private readonly runtime: {
      checkActivity: TaskRuntime["checkActivity"]
      dataDirectory: TaskRuntime["dataDirectory"]
      directory: TaskRuntime["directory"]
      host: TaskRuntime["host"]
      now: TaskRuntime["now"]
      observeRetainedRepairCandidate: TaskRuntime["observeRetainedRepairCandidate"]
      outcome: TaskRuntime["outcome"]
      owner: TaskRuntime["owner"]
      projectID: TaskRuntime["projectID"]
      beforeRetainedCheckBegin: TaskRuntime["beforeRetainedCheckBegin"]
      recoverCancelledRetainedChecks: TaskRuntime["recoverCancelledRetainedChecks"]
      retainedDependencyInstaller: TaskRuntime["retainedDependencyInstaller"]
      retainedRepairCandidateCurrent: TaskRuntime["retainedRepairCandidateCurrent"]
      retainedVerificationAborts: TaskRuntime["retainedVerificationAborts"]
      retainedVerificationWorkspacePath: TaskRuntime["retainedVerificationWorkspacePath"]
      runVerificationCheck: TaskRuntime["runVerificationCheck"]
      startCheckActivity: TaskRuntime["startCheckActivity"]
      store: TaskRuntime["store"]
      terminalRetainedVerificationCleanupChecks: TaskRuntime["terminalRetainedVerificationCleanupChecks"]
      validArchitect: TaskRuntime["validArchitect"]
      verificationDeadline: TaskRuntime["verificationDeadline"]
      verificationTarget: TaskRuntime["verificationTarget"]
    },
  ) {}

  sourceQuarantinePlanVersionCurrent(
    operation: RetainedVerification,
    plan: PlanRow,
    database?: Database,
  ): boolean {
    if (!operation.sourceQuarantine) return false
    if (plan.version === operation.planVersion)
      return ["running", "blocked", "accepted", "cleanup-blocked"].includes(plan.state)
    if (plan.state !== "blocked" || plan.version !== operation.planVersion + 1) return false

    const supportedBlock = (db: Database) => {
      const requests = db
        .query<{ id: number; payload: string }, [string, string]>(
          `SELECT id,payload FROM runner_transitions
           WHERE plan_id=? AND task_id=? AND event='RETAINED_VERIFICATION_REQUESTED'
           ORDER BY id DESC`,
        )
        .all(plan.id, operation.taskID)
      const request = requests.find((row) => {
        try {
          const payload = JSON.parse(row.payload) as { operationID?: unknown; generation?: unknown }
          return payload.operationID === operation.id && payload.generation === operation.generation
        } catch {
          return false
        }
      })
      if (!request) return false

      const blocked = db
        .query<{ id: number; version: number; payload: string }, [string]>(
          `SELECT id,version,payload FROM runner_transitions
           WHERE plan_id=? AND task_id IS NULL AND event='BLOCKED' ORDER BY id DESC LIMIT 1`,
        )
        .get(plan.id)
      if (!blocked || blocked.id <= request.id || blocked.version !== plan.version) return false
      try {
        return (JSON.parse(blocked.payload) as { reason?: unknown }).reason === plan.reason
      } catch {
        return false
      }
    }

    return database ? supportedBlock(database) : this.runtime.store.atomic(supportedBlock)
  }

  retainedVerificationLive(operationID: string, generation: number): boolean {
    try {
      const current = this.runtime.store.atomic((db) => retainedVerification(db, operationID))
      if (
        !current ||
        current.generation !== generation ||
        !["pending", "task-checks", "combined-checks", "task-accepted"].includes(current.state)
      )
        return false
      const plan = this.runtime.store.plan(current.planID)
      const task = this.runtime.store.repository.get(current.taskID)
      const latestAttempt = this.runtime.store
        .attempts(current.planID)
        .filter((attempt) => attempt.task_id === current.taskID)
        .at(-1)
      const combinedPhase = current.state === "combined-checks"
      const deferredTaskPhase = current.state === "task-accepted"
      const sourceQuarantineCurrent = Boolean(
        current.sourceQuarantine &&
        ["running", "blocked", "accepted", "cleanup-blocked"].includes(plan?.state ?? "") &&
        latestAttempt?.state === "verifying" &&
        latestAttempt.artifact === current.artifact &&
        sourceQuarantineVerificationBindingMatches(this.runtime.store, {
          planID: current.planID,
          owner: current.owner,
          attempt: latestAttempt,
          artifact: current.artifact,
          expected: current.sourceQuarantine,
        }),
      )
      const planIsCurrent = current.sourceQuarantine
        ? Boolean(
            sourceQuarantineCurrent &&
            plan &&
            (deferredTaskPhase || this.sourceQuarantinePlanVersionCurrent(current, plan)),
          )
        : Boolean(
            ["blocked", "accepted", "cleanup-blocked"].includes(plan?.state ?? "") ||
            ((combinedPhase || deferredTaskPhase) && plan?.state === "running") ||
            (deferredTaskPhase && plan?.state === "blocked"),
          )
      const planVersionCurrent = Boolean(
        plan &&
        (deferredTaskPhase ||
          (current.sourceQuarantine
            ? this.sourceQuarantinePlanVersionCurrent(current, plan)
            : plan.version === current.planVersion)),
      )
      return Boolean(
        plan &&
        planIsCurrent &&
        plan.revision === current.planRevision &&
        planVersionCurrent &&
        task &&
        task.revision === current.taskRevision &&
        sameProject(task.provenance.projectID, this.runtime.projectID) &&
        task.provenance.projectDirectory === this.runtime.directory &&
        !this.runtime.store.repository.taskDisposition(current.taskID) &&
        latestAttempt?.id === current.attemptID &&
        latestAttempt.session_id === current.originalSessionID &&
        latestAttempt.message_id === current.originalMessageID &&
        (!current.repair ||
          (this.runtime.retainedRepairCandidateCurrent(plan, latestAttempt, current.repair) &&
            (latestAttempt.artifact === current.repair.previousArtifact ||
              latestAttempt.artifact === current.artifact))) &&
        realpathSync(latestAttempt.workspace) === current.originalWorkspace,
      )
    } catch {
      return false
    }
  }

  retainedTaskCandidateAccepted(operation: RetainedVerification): boolean {
    const accepted = this.runtime.store.latestTransition<{
      operationID?: string
      generation?: number
      artifact?: string
    }>(operation.planID, operation.taskID, "RETAINED_TASK_CANDIDATE_ACCEPTED")
    return Boolean(
      accepted?.operationID === operation.id &&
      accepted.generation === operation.generation &&
      accepted.artifact === operation.artifact,
    )
  }

  retainedCombinedGatePending(operation: RetainedVerification): boolean {
    return Boolean(
      ["task-accepted", "combined-checks"].includes(operation.state) ||
      (operation.state === "held" && this.retainedTaskCandidateAccepted(operation)),
    )
  }

  /**
   * An authorization recorded accepted artifacts by SHA. They still match when
   * every other field is equal and each artifact is the same SHA or carries the
   * same recorded tree OID, so a rewritten commit does not revoke it.
   */
  private acceptedArtifactsMatch(recorded: unknown, current: unknown): boolean {
    if (!Array.isArray(recorded) || !Array.isArray(current) || recorded.length !== current.length)
      return fingerprint(recorded) === fingerprint(current)
    return recorded.every((left: unknown, index) => {
      const right: unknown = current[index]
      if (typeof left !== "object" || left === null || typeof right !== "object" || right === null)
        return fingerprint(left) === fingerprint(right)
      const { artifact: leftArtifact, ...leftRest } = left as Record<string, unknown>
      const { artifact: rightArtifact, ...rightRest } = right as Record<string, unknown>
      return (
        fingerprint(leftRest) === fingerprint(rightRest) &&
        (leftArtifact === rightArtifact ||
          (typeof leftArtifact === "string" &&
            typeof rightArtifact === "string" &&
            this.runtime.store.sameArtifact(leftArtifact, rightArtifact)))
      )
    })
  }

  private retainedVerificationInputFingerprint(
    operation: RetainedVerification,
    phase: "task" | "combined",
  ): string {
    return phase === "task"
      ? operation.inputFingerprint
      : (operation.combinedInputFingerprint ?? operation.inputFingerprint)
  }

  private async retainedWorkspaceUnchanged(
    workspace: string,
    artifact: string,
    ownedDependencyLink?: { path: string; target: string } | null,
  ): Promise<boolean> {
    try {
      const workspaceRoot = realpathSync(workspace)
      let status = await gitAsync(workspace, ["status", "--porcelain", "--untracked-files=all"])
      if (ownedDependencyLink) {
        if (
          ownedDependencyLink.path !== join(workspaceRoot, "node_modules") ||
          !lstatSync(ownedDependencyLink.path).isSymbolicLink() ||
          realpathSync(ownedDependencyLink.path) !== ownedDependencyLink.target
        )
          return false
        status = status
          .split("\n")
          .filter((line) => line !== "?? node_modules")
          .join("\n")
      }
      return (
        realpathSync(await gitAsync(workspace, ["rev-parse", "--show-toplevel"])) ===
          workspaceRoot &&
        (await gitAsync(workspace, ["rev-parse", "HEAD"])) === artifact &&
        !status &&
        !(await gitAsync(workspace, ["ls-files", "-u", "-z"]))
      )
    } catch {
      return false
    }
  }

  private retainedProbeResourcesAreIsolated(
    operation: RetainedVerification,
    workspace: string,
    resources: ReturnType<ResourceRepository["resourcesForRun"]>,
  ): boolean {
    if (resources.length === 0) return false
    const canonicalPath = (value: string) => {
      const absolute = resolve(value)
      try {
        return (existsSync(absolute) ? realpathSync(absolute) : absolute).toLocaleLowerCase()
      } catch {
        return absolute.toLocaleLowerCase()
      }
    }
    const workspaces = [
      operation.originalWorkspace,
      workspace,
      this.runtime.store.repository.path,
      process.env.HOME,
      process.env.XDG_CONFIG_HOME,
      process.env.XDG_DATA_HOME,
      process.env.XDG_CACHE_HOME,
      process.env.XDG_STATE_HOME,
      process.env.LAZERS_VERIFICATION_SQLITE,
    ]
      .filter((path): path is string => Boolean(path))
      .map(canonicalPath)
    const overlaps = (left: string, right: string) => {
      const path = canonicalPath(left)
      const parent = canonicalPath(right)
      const rel = relative(parent, path)
      return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep))
    }
    const currentRunID = resources[0]!.runID
    if (resources.some((resource) => resource.runID !== currentRunID)) return false
    const priorOwnedResources = this.runtime.store.atomic((db) => {
      const table = db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='owned_resources'",
        )
        .get()
      if (!table) return []
      return db
        .query<{ payload: string }, [string]>(
          "SELECT payload FROM owned_resources WHERE project_directory=?",
        )
        .all(operation.projectDirectory)
        .flatMap(({ payload }) => {
          try {
            const resource = JSON.parse(payload) as {
              runID?: unknown
              resourceKey?: unknown
              state?: unknown
            }
            if (resource.runID === currentRunID || resource.state === "removed") return []
            if (
              typeof resource.resourceKey !== "string" ||
              !resource.resourceKey.startsWith("filesystem:")
            )
              return [null]
            const path = resource.resourceKey.slice("filesystem:".length)
            return path.startsWith("/") ? [path] : [null]
          } catch {
            return [null]
          }
        })
    })
    if (priorOwnedResources.some((path) => path === null)) return false
    const retainedCheckPaths = this.runtime.store.atomic((db) =>
      db
        .query<{ canonical_path: string }, [string, string, number]>(
          `SELECT canonical_path FROM runner_retained_verification_resources
           WHERE project_directory=? AND operation_id=? AND generation=?`,
        )
        .all(operation.projectDirectory, operation.id, operation.generation)
        .map((row) => row.canonical_path),
    )
    const currentPaths = resources.map((resource) => {
      if (!resource.resourceKey.startsWith("filesystem:")) return false
      const resourcePath = resource.resourceKey.slice("filesystem:".length)
      if (!resourcePath.startsWith("/")) return false
      return canonicalPath(resourcePath)
    })
    if (currentPaths.some((path) => path === false)) return false
    const allCurrentPaths = currentPaths as string[]
    const distinct = allCurrentPaths.every((path, index) =>
      allCurrentPaths
        .slice(index + 1)
        .every((other) => !overlaps(path, other) && !overlaps(other, path)),
    )
    const externalPaths = [...priorOwnedResources, ...retainedCheckPaths].filter(
      (path): path is string => path !== null,
    )
    return (
      distinct &&
      allCurrentPaths.every((path) =>
        [...workspaces, ...externalPaths].every(
          (blocked) => !overlaps(path, blocked) && !overlaps(blocked, path),
        ),
      )
    )
  }

  retainedVerificationIsolatedWorkspace(
    operation: RetainedVerification,
    phase: "task" | "combined",
  ): string | undefined {
    return phase === "task"
      ? (operation.taskWorkspace ?? undefined)
      : (operation.combinedWorkspace ?? undefined)
  }

  notifyHeldRetainedVerification(operationID: string, fence: number) {
    this.runtime.store.fenced(this.runtime.owner, fence, (db) => {
      const operation = retainedVerification(db, operationID)
      if (operation?.state !== "held") return
      const plan = this.runtime.store.plan(operation.planID)
      if (!plan || ["cancelling", "cancelled", "integrated"].includes(plan.state)) return
      const alreadyNotified = db
        .query<{ id: string }, [string, string, string]>(
          `SELECT id FROM runner_outbox WHERE plan_id=?
           AND (session_id=? OR state IN ('pending','sending','uncertain','admitted','delivered'))
           AND json_extract(payload,'$.status')='retained-verification-held'
           AND json_extract(payload,'$.operationID')=?
           AND state NOT IN ('unknown','superseded') LIMIT 1`,
        )
        .get(plan.id, plan.owner, operation.id)
      if (alreadyNotified) return
      this.runtime.outcome(
        plan.id,
        {
          status: "retained-verification-held",
          operationID: operation.id,
          generation: operation.generation,
          taskID: operation.taskID,
          attemptID: operation.attemptID,
          artifact: operation.artifact,
          reason: safeText(
            operation.holdReason ?? "Retained verification requires review",
            privacyStats(),
          ),
        },
        true,
      )
    })
  }

  async holdRetainedVerification(
    initial: RetainedVerification,
    reason: string,
    fence: number,
  ): Promise<void> {
    this.runtime.store.fenced(this.runtime.owner, fence, (db) => {
      const current = retainedVerification(db, initial.id)
      if (
        !current ||
        current.generation !== initial.generation ||
        !["pending", "task-checks", "combined-checks", "task-accepted"].includes(current.state)
      )
        return
      if (current.state === "held" && current.holdReason === reason) return
      const updated: RetainedVerification = {
        ...current,
        state: "held",
        holdReason: reason,
        updatedAt: this.runtime.now(),
      }
      saveRetainedVerification(db, updated)
      this.runtime.store.record(current.planID, current.taskID, "RETAINED_VERIFICATION_HELD", {
        operationID: current.id,
        generation: current.generation,
        reason,
        originalAttemptPreserved: true,
      })
    })
  }

  private async setRetainedVerificationState(
    initial: RetainedVerification,
    state: RetainedVerification["state"],
    reason: string | null,
    fence: number,
  ): Promise<RetainedVerification | undefined> {
    return this.runtime.store.fenced(this.runtime.owner, fence, (db) => {
      const current = retainedVerification(db, initial.id)
      if (!isCurrentRetainedVerification(current, initial)) return undefined
      if (current.state === state && current.holdReason === reason) return current
      const updated: RetainedVerification = {
        ...current,
        state,
        holdReason: reason,
        updatedAt: this.runtime.now(),
      }
      saveRetainedVerification(db, updated)
      return updated
    })
  }

  private async ensureRetainedVerificationWorkspace(
    initial: RetainedVerification,
    phase: "task" | "combined",
    artifact: string,
    fence: number,
  ): Promise<string | undefined> {
    if (!this.retainedVerificationLive(initial.id, initial.generation)) return undefined
    const field = phase === "task" ? initial.taskWorkspace : initial.combinedWorkspace
    const fieldState =
      phase === "task" ? initial.taskWorkspaceState : initial.combinedWorkspaceState
    const proposed = this.runtime.retainedVerificationWorkspacePath(initial.id, phase)
    const workspace = field ?? proposed
    const native = await this.runtime.host.worktrees()
    const candidates =
      fieldState === "reserved" || fieldState === "uncertain"
        ? startupWorktreeCandidates(workspace)
        : [workspace]
    const present = native.find((item) =>
      candidates.some((candidate) => samePhysicalWorkspace(item, candidate)),
    )
    if (present) {
      let mismatches: string[]
      try {
        const actual = realpathSync(present)
        const topLevel = realpathSync(await gitAsync(actual, ["rev-parse", "--show-toplevel"]))
        const head = await gitAsync(actual, ["rev-parse", "HEAD"])
        const status = await gitAsync(actual, ["status", "--porcelain", "--untracked-files=all"])
        const conflicts = await gitAsync(actual, ["ls-files", "-u", "-z"])
        const pendingCheck = this.runtime.store.atomic((db) =>
          retainedVerificationChecks(db, initial.id, phase).find(
            (check) => check.workspace === actual && check.artifact === artifact,
          ),
        )
        const pendingActivity = pendingCheck
          ? this.runtime.checkActivity(
              `retained:${initial.id}:${initial.generation}:${phase}:${pendingCheck.checkID}`,
              {
                operationID: initial.id,
                generation: initial.generation,
                phase,
                checkID: pendingCheck.checkID,
                inputFingerprint: pendingCheck.inputFingerprint,
                workspace: pendingCheck.workspace,
                artifact: pendingCheck.artifact,
                contextPath: pendingCheck.contextPath,
              },
            )
          : undefined
        const checkOwnsCheckoutChanges = Boolean(
          pendingCheck &&
          (pendingActivity || pendingCheck.receipt || existsSync(pendingCheck.receiptPath)),
        )
        mismatches = [
          ...(actual !== realpathSync(present) ? ["noncanonical-path"] : []),
          ...(realpathSync(dirname(actual)) !== realpathSync(dirname(workspace))
            ? ["unexpected-parent"]
            : []),
          ...(samePhysicalWorkspace(actual, initial.originalWorkspace)
            ? ["original-workspace"]
            : []),
          ...(samePhysicalWorkspace(actual, this.runtime.directory) ? ["project-workspace"] : []),
          ...(topLevel !== actual ? ["repository-root"] : []),
          ...(head !== artifact ? ["candidate-identity"] : []),
          ...(status && !checkOwnsCheckoutChanges ? ["dirty-checkout"] : []),
          ...(conflicts ? ["unmerged-files"] : []),
        ]
        if (mismatches.length === 0) {
          const updated = this.runtime.store.fenced(this.runtime.owner, fence, (db) => {
            const current = retainedVerification(db, initial.id)
            if (!isCurrentRetainedVerification(current, initial)) return undefined
            const saved = setRetainedVerificationWorkspace(db, current, phase, actual, "owned")
            this.runtime.store.record(
              current.planID,
              current.taskID,
              "RETAINED_VERIFICATION_WORKSPACE_OWNED",
              {
                operationID: current.id,
                generation: current.generation,
                phase,
                workspace: actual,
                artifact,
                recovered: fieldState === "reserved" || fieldState === "uncertain",
              },
            )
            return saved
          })
          return updated ? actual : undefined
        }
      } catch (error) {
        await this.holdRetainedVerification(
          initial,
          `Retained ${phase} verification checkout ownership or candidate is uncertain: ${errorText(error)}`,
          fence,
        )
        return undefined
      }
      await this.holdRetainedVerification(
        initial,
        `Retained ${phase} verification checkout exists but its canonical owner or candidate identity is not proven${mismatches.length ? ` (${mismatches.join(", ")})` : ""}`,
        fence,
      )
      return undefined
    }
    const unregisteredPath = candidates.find((candidate) => existsSync(candidate))
    if (unregisteredPath) {
      await this.holdRetainedVerification(
        initial,
        `Retained ${phase} verification checkout path exists without native worktree ownership; preserve ${unregisteredPath}`,
        fence,
      )
      return undefined
    }
    if (fieldState !== null) {
      await this.holdRetainedVerification(
        initial,
        `Retained ${phase} verification checkout creation outcome is uncertain; it will not be replayed`,
        fence,
      )
      return undefined
    }
    const reserved = this.runtime.store.fenced(this.runtime.owner, fence, (db) => {
      const current = retainedVerification(db, initial.id)
      if (!isCurrentRetainedVerification(current, initial)) return undefined
      const saved = setRetainedVerificationWorkspace(db, current, phase, workspace, "reserved")
      this.runtime.store.record(
        current.planID,
        current.taskID,
        "RETAINED_VERIFICATION_WORKSPACE_RESERVED",
        {
          operationID: current.id,
          generation: current.generation,
          phase,
          workspace,
          artifact,
        },
      )
      return saved
    })
    if (!reserved || !this.retainedVerificationLive(initial.id, initial.generation))
      return undefined
    let returnedWorkspace: string | undefined
    try {
      mkdirSync(dirname(workspace), { recursive: true, mode: 0o700 })
      returnedWorkspace = await this.runtime.host.worktree({ directory: workspace, base: artifact })
      const actual = realpathSync(returnedWorkspace)
      const canonical = realpathSync(actual)
      const currentNative = await this.runtime.host.worktrees()
      if (
        !currentNative.some((item) => samePhysicalWorkspace(item, canonical)) ||
        realpathSync(dirname(canonical)) !== realpathSync(dirname(workspace)) ||
        samePhysicalWorkspace(canonical, initial.originalWorkspace) ||
        samePhysicalWorkspace(canonical, this.runtime.directory) ||
        realpathSync(await gitAsync(canonical, ["rev-parse", "--show-toplevel"])) !== canonical ||
        (await gitAsync(canonical, ["rev-parse", "HEAD"])) !== artifact ||
        (await gitAsync(canonical, ["status", "--porcelain", "--untracked-files=all"])) ||
        (await gitAsync(canonical, ["ls-files", "-u", "-z"]))
      )
        throw new Error(
          "Native worktree is not a distinct clean canonical checkout of the exact candidate",
        )
      if (!this.retainedVerificationLive(initial.id, initial.generation)) {
        await this.holdRetainedVerification(
          initial,
          "Retained verification authority changed during checkout creation",
          fence,
        )
        return undefined
      }
      this.runtime.store.fenced(this.runtime.owner, fence, (db) => {
        const current = retainedVerification(db, initial.id)
        if (!isCurrentRetainedVerification(current, initial)) return
        setRetainedVerificationWorkspace(db, current, phase, canonical, "owned")
        this.runtime.store.record(
          current.planID,
          current.taskID,
          "RETAINED_VERIFICATION_WORKSPACE_OWNED",
          {
            operationID: current.id,
            generation: current.generation,
            phase,
            workspace: canonical,
            artifact,
            recovered: false,
          },
        )
      })
      return this.retainedVerificationLive(initial.id, initial.generation) ? canonical : undefined
    } catch (error) {
      this.runtime.store.fenced(this.runtime.owner, fence, (db) => {
        const current = retainedVerification(db, initial.id)
        if (!current || current.generation !== initial.generation) return
        setRetainedVerificationWorkspace(
          db,
          current,
          phase,
          returnedWorkspace ?? workspace,
          "uncertain",
        )
      })
      await this.holdRetainedVerification(
        initial,
        `Retained ${phase} verification checkout creation is uncertain: ${errorText(error)}`,
        fence,
      )
      return undefined
    }
  }

  retainedVerificationCheckReceipt(
    raw: unknown,
    operation: RetainedVerification,
    phase: "task" | "combined",
    check: TaskProposal["verification"][number],
    workspace: string,
    artifact: string,
    _environmentIdentity: string,
  ): CheckReceipt | undefined {
    if (!isRecord(raw) || !isRecord(raw.isolation)) return undefined
    const receipt = raw as unknown as CheckReceipt
    const witness = raw.isolation
    if (
      receipt.id !== check.id ||
      receipt.command !== check.command ||
      receipt.cwd !== workspace ||
      receipt.artifact !== artifact ||
      receipt.inputIdentity !== artifact ||
      witness.schemaVersion !== 1 ||
      witness.operationID !== operation.id ||
      witness.generation !== operation.generation ||
      witness.phase !== phase ||
      witness.checkID !== check.id ||
      witness.originalWorkspace !== operation.originalWorkspace ||
      witness.candidateWorkspace !== workspace ||
      witness.taskDatabase !== realpathSync(this.runtime.store.repository.path)
    )
      return undefined
    return receipt
  }

  completeRetainedCheck(
    operation: RetainedVerification,
    phase: "task" | "combined",
    checkID: string,
    receipt: CheckReceipt,
  ): boolean {
    return this.runtime.store.atomic((db) => {
      if (!completeRetainedVerificationCheck(db, operation.id, phase, checkID, receipt))
        return false
      // Persist the result and event together. Receipt recovery, normal ticks,
      // stop and cancellation may all observe the same final subprocess result.
      this.runtime.store.record(
        operation.planID,
        operation.taskID,
        "RETAINED_VERIFICATION_CHECK_COMPLETED",
        {
          operationID: operation.id,
          generation: operation.generation,
          phase,
          checkID,
          artifact: receipt.artifact,
          workspace: receipt.cwd,
          environmentIdentity: receipt.environmentIdentity,
          exitCode: receipt.exitCode,
          timedOut: receipt.timedOut,
          passed: checkSucceeded(receipt),
          processCleanup: receipt.processCleanup,
          cancelled: operation.state === "cancelled",
        },
      )
      return true
    })
  }

  private async runRetainedVerificationChecks(
    initial: RetainedVerification,
    phase: "task" | "combined",
    checks: TaskProposal["verification"],
    workspace: string,
    artifact: string,
    fence: number,
    parentSignal?: AbortSignal,
  ): Promise<CheckReceipt[] | undefined> {
    const results: CheckReceipt[] = []
    for (const check of checks) {
      if (parentSignal?.aborted || !this.retainedVerificationLive(initial.id, initial.generation))
        return undefined
      const plan = this.runtime.store.plan(initial.planID)
      if (!plan || plan.revision !== initial.planRevision)
        throw new Error("Retained verification plan revision changed")
      const input = PlanInput.parse(JSON.parse(plan.body))
      const target: VerificationTimeoutTarget = {
        ...this.runtime.verificationTarget(
          plan,
          phase,
          check,
          artifact,
          phase === "task" ? initial.taskID : null,
          phase === "task" ? initial.taskRevision : null,
          phase === "task" ? initial.attemptID : null,
        ),
        retainedVerificationID: initial.id,
        retainedGeneration: initial.generation,
        retainedTaskID: initial.taskID,
        retainedTaskRevision: initial.taskRevision,
        retainedAttemptID: initial.attemptID,
      }
      const deadline = this.runtime.verificationDeadline(target)
      const effectiveCheck = effectiveVerificationCheck(check, deadline)
      const procedure = retainedProcedurePlan(check.command)
      if (procedure.status !== "supported") {
        await this.holdRetainedVerification(
          initial,
          `Verification ${check.id} ${procedure.reason}; required resources are not bound to the retained context`,
          fence,
        )
        return undefined
      }
      const existing = this.runtime.store.atomic((db) =>
        retainedVerificationChecks(db, initial.id, phase).find((row) => row.checkID === check.id),
      )
      const activityID = `retained:${initial.id}:${initial.generation}:${phase}:${check.id}`
      let retryAuthorization:
        | {
            requestID?: unknown
            continuationKind?: unknown
            continuationID?: unknown
            owner?: unknown
            planRevision?: unknown
            planVersion?: unknown
            operationID?: unknown
            generation?: unknown
            taskID?: unknown
            taskRevision?: unknown
            attemptID?: unknown
            phase?: unknown
            checkID?: unknown
            candidateArtifact?: unknown
            commandFingerprint?: unknown
            amendmentID?: unknown
            environmentIdentity?: unknown
            planBodyFingerprint?: unknown
            combinedInputFingerprint?: unknown
            acceptedArtifacts?: unknown
            sourceQuarantineFingerprint?: unknown
            priorReceipt?: unknown
            priorReceiptFingerprint?: unknown
            priorCheckFingerprint?: unknown
            priorReceiptPath?: unknown
            priorResources?: unknown
            reason?: unknown
          }
        | undefined
      if (existing?.state === "retry-authorized") {
        let previousCheck: unknown
        let previousReceipt: unknown
        try {
          previousCheck = JSON.parse(existing.checkJSON) as unknown
          previousReceipt = existing.receipt ? (JSON.parse(existing.receipt) as unknown) : undefined
        } catch {
          previousCheck = undefined
          previousReceipt = undefined
        }
        const authorization = this.runtime.store.latestTransition<
          NonNullable<typeof retryAuthorization>
        >(initial.planID, initial.taskID, "RETAINED_VERIFICATION_CHECK_RETRY_AUTHORIZED")
        retryAuthorization = authorization
        const retryResources = this.runtime.store.atomic((db) =>
          db
            .query<
              { resource_name: string; canonical_path: string; state: string },
              [string, string, string]
            >(
              `SELECT resource_name,canonical_path,state FROM runner_retained_verification_resources
               WHERE operation_id=? AND phase=? AND check_id=? ORDER BY resource_name`,
            )
            .all(initial.id, phase, check.id),
        )
        const retryResourceBindings = retryResources.map((resource) => ({
          name: resource.resource_name,
          pathFingerprint: fingerprint(resource.canonical_path),
          state: resource.state,
        }))
        const previousBoundReceipt =
          isRecord(previousCheck) && previousReceipt
            ? this.retainedVerificationCheckReceipt(
                previousReceipt,
                initial,
                phase,
                previousCheck as TaskProposal["verification"][number],
                workspace,
                artifact,
                existing.environmentIdentity,
              )
            : undefined
        const interruptedContinuation = authorization?.continuationKind === "interrupted-check"
        const legacyTimeoutAuthorization = Boolean(
          authorization !== undefined &&
          !interruptedContinuation &&
          authorization.continuationKind === undefined &&
          authorization.environmentIdentity === undefined &&
          authorization.planVersion === undefined,
        )
        const retryResourcesMatch = retainedRetryResourcesMatch(
          retryResourceBindings,
          authorization?.priorResources,
          legacyTimeoutAuthorization,
        )
        const planNodes = this.runtime.store.nodes(initial.planID)
        const planAttempts = this.runtime.store.attempts(initial.planID)
        let acceptedArtifactsCurrent = true
        const acceptedArtifacts = input.integrationOrder.map((taskID) => {
          const authored = input.nodes.find((candidate) => candidate.taskID === taskID)
          const planNode = planNodes.find((candidate) => candidate.task_id === taskID)
          const task = this.runtime.store.repository.get(taskID)
          const attempt = planAttempts.filter((candidate) => candidate.task_id === taskID).at(-1)
          const retainedCandidate = Boolean(
            initial.sourceQuarantine &&
            taskID === initial.taskID &&
            task?.revision === initial.taskRevision &&
            attempt?.id === initial.attemptID &&
            attempt.state === "verifying" &&
            attempt.artifact === initial.artifact &&
            this.retainedTaskCandidateAccepted(initial),
          )
          const artifact = planNode?.artifact ?? null
          if (
            !authored ||
            !planNode ||
            (!retainedCandidate && !["accepted", "incorporated"].includes(planNode.state)) ||
            !artifact ||
            !task ||
            task.revision !== authored.revision ||
            !sameProject(task.provenance.projectID, this.runtime.projectID) ||
            task.provenance.projectDirectory !== this.runtime.directory ||
            this.runtime.store.repository.taskDisposition(taskID) !== undefined ||
            !attempt ||
            (!retainedCandidate && (attempt.state !== "accepted" || attempt.artifact !== artifact))
          )
            acceptedArtifactsCurrent = false
          return { taskID, taskRevision: task?.revision ?? null, artifact }
        })
        const unresolvedEffects = this.runtime.store.effects(initial.planID).filter((effect) => {
          if (!["intended", "uncertain"].includes(effect.state)) return false
          if (
            !initial.sourceQuarantine ||
            effect.task_id !== initial.taskID ||
            effect.attempt_id !== initial.attemptID ||
            !effect.kind.startsWith("verify:")
          )
            return true
          const sourceCheckID = effect.kind.slice("verify:".length)
          const sourceCheck = this.runtime.store.repository
            .get(initial.taskID)
            ?.proposal.verification.find((candidate) => candidate.id === sourceCheckID)
          if (!sourceCheck) return true
          try {
            const payload: unknown = JSON.parse(effect.payload)
            return !(
              isRecord(payload) &&
              payload.artifact === initial.artifact &&
              payload.workspace === initial.originalWorkspace &&
              isRecord(payload.check) &&
              payload.check.id === sourceCheck.id &&
              payload.check.command === sourceCheck.command
            )
          } catch {
            return true
          }
        })
        const unrelatedActivity = verificationActivitiesForDatabase(
          this.runtime.store.repository.path,
        ).some(
          (activity) =>
            activity.metadata.planID === initial.planID &&
            activity.state === "running" &&
            !(
              activity.metadata.kind === "retained-advance" &&
              activity.metadata.operationID === initial.id &&
              activity.metadata.generation === initial.generation
            ),
        )
        const currentCombinedArtifact =
          interruptedContinuation && acceptedArtifactsCurrent
            ? await combineArtifacts(
                this.runtime.directory,
                input.baseCommit,
                acceptedArtifacts.flatMap((item) => (item.artifact ? [item.artifact] : [])),
              ).catch(() => undefined)
            : undefined
        const retryKindMatches = interruptedContinuation
          ? authorization?.continuationID !== undefined &&
            phase === "combined" &&
            acceptedArtifactsCurrent &&
            !unresolvedEffects.length &&
            !unrelatedActivity &&
            (currentCombinedArtifact === undefined
              ? false
              : initial.combinedArtifact
                ? await combinedArtifactsMatch(
                    this.runtime.directory,
                    currentCombinedArtifact,
                    initial.combinedArtifact,
                  )
                : false) &&
            previousBoundReceipt !== undefined &&
            isConclusiveNonTimeoutInterruption(previousBoundReceipt) &&
            authorization.planVersion === initial.planVersion &&
            plan.version === initial.planVersion &&
            authorization.planBodyFingerprint === fingerprint(plan.body) &&
            authorization.combinedInputFingerprint === initial.combinedInputFingerprint &&
            this.acceptedArtifactsMatch(authorization.acceptedArtifacts, acceptedArtifacts) &&
            authorization.sourceQuarantineFingerprint ===
              fingerprint(initial.sourceQuarantine ?? null) &&
            fingerprint(previousCheck) === fingerprint(effectiveCheck)
          : Boolean(
              deadline.amendmentID &&
              previousBoundReceipt?.timedOut &&
              authorization?.amendmentID === deadline.amendmentID,
            )
        if (
          existing.cleanupState !== "complete" ||
          existing.artifact !== artifact ||
          existing.workspace !== workspace ||
          !isRecord(previousCheck) ||
          previousCheck.id !== check.id ||
          previousCheck.command !== check.command ||
          !retryKindMatches ||
          !previousBoundReceipt ||
          !checkResourcesSettled(previousBoundReceipt) ||
          previousBoundReceipt.environmentIdentity !== existing.environmentIdentity ||
          !authorization ||
          authorization.planRevision !== initial.planRevision ||
          authorization.operationID !== initial.id ||
          authorization.generation !== initial.generation ||
          authorization.taskID !== initial.taskID ||
          authorization.taskRevision !== initial.taskRevision ||
          authorization.attemptID !== initial.attemptID ||
          authorization.phase !== phase ||
          authorization.checkID !== check.id ||
          authorization.candidateArtifact !== artifact ||
          authorization.commandFingerprint !== verificationCommandFingerprint(check.command) ||
          (authorization.environmentIdentity !== undefined &&
            authorization.environmentIdentity !== existing.environmentIdentity) ||
          authorization.priorReceiptFingerprint !== fingerprint(existing.receipt) ||
          authorization.priorCheckFingerprint !== fingerprint(existing.checkJSON) ||
          authorization.priorReceiptPath !== existing.receiptPath ||
          fingerprint(authorization.priorReceipt) !== fingerprint(previousReceipt) ||
          !retryResourcesMatch ||
          retryResources.length === 0 ||
          retryResources.some((resource) => resource.state !== "removed")
        ) {
          await this.holdRetainedVerification(
            initial,
            `Explicit retained check continuation ${phase}:${check.id} lost its settled retry binding`,
            fence,
          )
          return undefined
        }
      }
      if (existing && existing.state !== "retry-authorized") {
        const activityIdentity = {
          operationID: initial.id,
          generation: initial.generation,
          phase,
          checkID: check.id,
          inputFingerprint: existing.inputFingerprint,
          workspace: existing.workspace,
          artifact: existing.artifact,
          contextPath: existing.contextPath,
        }
        let savedReceipt: unknown
        try {
          if (existing.receipt) savedReceipt = JSON.parse(existing.receipt) as unknown
          else if (existsSync(existing.receiptPath))
            savedReceipt = JSON.parse(readFileSync(existing.receiptPath, "utf8")) as unknown
        } catch {
          savedReceipt = undefined
        }
        if (
          existing.artifact !== artifact ||
          existing.workspace !== workspace ||
          !sameVerificationCheckIdentity(JSON.parse(existing.checkJSON), effectiveCheck)
        ) {
          await this.holdRetainedVerification(
            initial,
            `Retained check ${phase}:${check.id} no longer matches its recorded command or workspace`,
            fence,
          )
          return undefined
        }
        if (existing.state === "completed" && existing.receipt) {
          const receipt = this.retainedVerificationCheckReceipt(
            JSON.parse(existing.receipt),
            initial,
            phase,
            effectiveCheck,
            workspace,
            artifact,
            existing.environmentIdentity,
          )
          if (receipt) {
            results.push(receipt)
            forgetVerificationActivity(
              verificationActivityKey(this.runtime.store.repository.path, activityID),
              fingerprint(activityIdentity),
            )
            this.runtime.retainedVerificationAborts.delete(initial.id)
            if (!checkResourcesSettled(receipt)) {
              this.runtime.store.atomic((db) =>
                settleRetainedVerificationResources(
                  db,
                  initial.id,
                  phase,
                  check.id,
                  "uncertain",
                  this.runtime.now(),
                ),
              )
              await this.holdRetainedVerification(
                initial,
                `Retained verification ${phase}:${check.id} completed with exit ${receipt.exitCode ?? "unknown"} and timedOut=${receipt.timedOut}, but subprocess cleanup is uncertain: ${receipt.processCleanup?.detail ?? "termination was not confirmed"}`,
                fence,
              )
              return undefined
            }
            if (existing.cleanupState !== "complete")
              await this.cleanupRetainedCheckResources(
                initial,
                phase,
                check.id,
                existing.contextPath,
                receipt.isolation,
                fence,
              )
            continue
          }
          await this.holdRetainedVerification(
            initial,
            `Retained verification receipt ${phase}:${check.id} is not operation-bound`,
            fence,
          )
          return undefined
        }
        if (existing.state === "intended" && existsSync(existing.receiptPath)) {
          let recovered: CheckReceipt | undefined
          try {
            const onDisk = savedReceipt
            if (
              await observeRetainedCheckIsolationWitness(
                existing.contextPath,
                isRecord(onDisk) ? onDisk.isolation : undefined,
                {
                  operationID: initial.id,
                  generation: initial.generation,
                  phase,
                  checkID: check.id,
                  originalWorkspace: initial.originalWorkspace,
                  candidateWorkspace: workspace,
                  taskDatabase: this.runtime.store.repository.path,
                  projectDirectory: this.runtime.directory,
                  candidateArtifact: artifact,
                  projectIdentity: retainedProjectIdentity(
                    this.runtime.directory,
                    workspace,
                    artifact,
                  ),
                  procedurePlan: procedure.plan,
                },
              )
            )
              recovered = this.retainedVerificationCheckReceipt(
                onDisk,
                initial,
                phase,
                effectiveCheck,
                workspace,
                artifact,
                existing.environmentIdentity,
              )
          } catch {
            recovered = undefined
          }
          if (recovered) {
            const saved = this.runtime.store.atomic((db) => {
              const current = retainedVerification(db, initial.id)
              if (!isCurrentRetainedVerification(current, initial)) return false
              return this.completeRetainedCheck(current, phase, check.id, recovered)
            })
            if (!saved) return undefined
            results.push(recovered)
            forgetVerificationActivity(
              verificationActivityKey(this.runtime.store.repository.path, activityID),
              fingerprint(activityIdentity),
            )
            this.runtime.retainedVerificationAborts.delete(initial.id)
            if (!checkResourcesSettled(recovered)) {
              this.runtime.store.atomic((db) =>
                settleRetainedVerificationResources(
                  db,
                  initial.id,
                  phase,
                  check.id,
                  "uncertain",
                  this.runtime.now(),
                ),
              )
              await this.holdRetainedVerification(
                initial,
                `Retained verification ${phase}:${check.id} completed with exit ${recovered.exitCode ?? "unknown"} and timedOut=${recovered.timedOut}, but subprocess cleanup is uncertain: ${recovered.processCleanup?.detail ?? "termination was not confirmed"}`,
                fence,
              )
              return undefined
            }
            await this.cleanupRetainedCheckResources(
              initial,
              phase,
              check.id,
              existing.contextPath,
              recovered.isolation,
              fence,
            )
            continue
          }
        }
        const activity = this.runtime.checkActivity(activityID, activityIdentity)
        if (activity?.state === "running") return undefined
        this.runtime.store.atomic((db) =>
          markRetainedVerificationCheckUncertain(
            db,
            initial.id,
            phase,
            check.id,
            "A retained check intent has no conclusive isolated receipt; it will not be replayed",
          ),
        )
        await this.holdRetainedVerification(
          initial,
          activity?.state === "failed"
            ? `Retained verification check ${phase}:${check.id} is uncertain: ${errorText(activity.error)}`
            : `Retained verification check ${phase}:${check.id} is uncertain and was not replayed`,
          fence,
        )
        forgetVerificationActivity(
          verificationActivityKey(this.runtime.store.repository.path, activityID),
          fingerprint(activityIdentity),
        )
        return undefined
      }

      if (
        await this.reconcileInterruptedRetainedCheckSetup(initial, phase, check, workspace, fence)
      )
        return undefined

      const prior = this.runtime.store.atomic((db) => {
        const active = db
          .query<{ canonical_path: string }, [string]>(
            `SELECT canonical_path FROM runner_retained_verification_resources
             WHERE project_directory=? AND state IN ('creating','active','uncertain')`,
          )
          .all(this.runtime.directory)
        const legacy = db
          .query<{ name: string }, []>(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='owned_resources'",
          )
          .get()
        if (legacy) {
          const outstanding = db
            .query<{ count: number }, [string]>(
              "SELECT COUNT(*) AS count FROM owned_resources WHERE project_directory=? AND json_extract(payload,'$.state') NOT IN ('removed')",
            )
            .get(this.runtime.directory)?.count
          if (outstanding)
            throw new Error(
              "An existing owned external resource has no canonical path witness; retained verification cannot prove non-overlap",
            )
        }
        return active.map((row) => row.canonical_path)
      })
      const controller = new AbortController()
      const runSignal = parentSignal
        ? AbortSignal.any([controller.signal, parentSignal])
        : controller.signal
      this.runtime.retainedVerificationAborts.set(initial.id, controller)
      const rootDirectory = join(this.runtime.dataDirectory, "retained-verification-resources")
      let setupResource: RetainedCheckSetupResource | undefined
      let setupDependencyLink: RetainedCheckSetupLink | undefined
      let setupTemporaryDirectoryLink: RetainedCheckSetupLink | undefined
      let context: Awaited<ReturnType<typeof createRetainedCheckContext>>
      try {
        mkdirSync(rootDirectory, { recursive: true, mode: 0o700 })
        context = await createRetainedCheckContext({
          rootDirectory,
          operationID: initial.id,
          generation: initial.generation,
          phase,
          checkID: check.id,
          originalWorkspace: initial.originalWorkspace,
          candidateWorkspace: workspace,
          taskDatabase: this.runtime.store.repository.path,
          projectDirectory: this.runtime.directory,
          candidateArtifact: artifact,
          priorResourcePaths: prior,
          procedurePlan: procedure.plan,
          signal: runSignal,
          dependencyInstaller: this.runtime.retainedDependencyInstaller,
          onSetupPathReserved: (path) => {
            setupResource = { path, realPath: path, device: -1, inode: -1 }
            this.runtime.store.atomic((db) =>
              registerRetainedVerificationResources(db, this.runtime.directory, {
                operationID: initial.id,
                generation: initial.generation,
                phase,
                checkID: check.id,
                resources: [{ name: "setup-root", realPath: path, device: -1, inode: -1 }],
                state: "creating",
                now: this.runtime.now(),
              }),
            )
          },
          onSetupPathCreated: (resource) => {
            setupResource = resource
            const updated = this.runtime.store.atomic((db) =>
              updateRetainedVerificationResourceIdentity(db, {
                operationID: initial.id,
                phase,
                checkID: check.id,
                resourceName: "setup-root",
                realPath: resource.realPath,
                device: resource.device,
                inode: resource.inode,
                now: this.runtime.now(),
              }),
            )
            if (!updated)
              throw new Error("Retained verification setup-root ownership reservation changed")
          },
          onResourcesCreated: (resources) =>
            this.runtime.store.atomic((db) =>
              registerRetainedVerificationResources(db, this.runtime.directory, {
                operationID: initial.id,
                generation: initial.generation,
                phase,
                checkID: check.id,
                resources,
                state: "creating",
                now: this.runtime.now(),
              }),
            ),
          onDependencyLinkReserved: (link) => {
            setupDependencyLink = link
            this.runtime.store.atomic((db) =>
              registerRetainedVerificationResources(db, this.runtime.directory, {
                operationID: initial.id,
                generation: initial.generation,
                phase,
                checkID: check.id,
                resources: [
                  { name: "dependency-link", realPath: link.path, device: -1, inode: -1 },
                ],
                state: "creating",
                now: this.runtime.now(),
              }),
            )
          },
          onDependencyLink: (link) => {
            setupDependencyLink = link
            const updated = this.runtime.store.atomic((db) =>
              updateRetainedVerificationResourceIdentity(db, {
                operationID: initial.id,
                phase,
                checkID: check.id,
                resourceName: "dependency-link",
                realPath: link.path,
                device: link.device,
                inode: link.inode,
                now: this.runtime.now(),
              }),
            )
            if (!updated)
              throw new Error("Retained verification dependency-link ownership reservation changed")
          },
          onTemporaryDirectoryLinkReserved: (link) => {
            setupTemporaryDirectoryLink = link
            this.runtime.store.atomic((db) =>
              registerRetainedVerificationResources(db, this.runtime.directory, {
                operationID: initial.id,
                generation: initial.generation,
                phase,
                checkID: check.id,
                resources: [
                  {
                    name: "tmp-alias",
                    realPath: link.path,
                    device: -1,
                    inode: -1,
                  },
                ],
                state: "creating",
                now: this.runtime.now(),
              }),
            )
          },
          onTemporaryDirectoryLink: (link) => {
            setupTemporaryDirectoryLink = link
            const updated = this.runtime.store.atomic((db) =>
              updateRetainedVerificationResourceIdentity(db, {
                operationID: initial.id,
                phase,
                checkID: check.id,
                resourceName: "tmp-alias",
                realPath: link.path,
                device: link.device,
                inode: link.inode,
                now: this.runtime.now(),
              }),
            )
            if (!updated)
              throw new Error("Retained verification temporary-link ownership reservation changed")
          },
        })
        if (!(await observeRetainedCheckContext(context)))
          throw new Error("Fresh verification resources do not have a readable ownership witness")
        this.runtime.store.atomic((db) =>
          activateRetainedVerificationResources(
            db,
            initial.id,
            phase,
            check.id,
            this.runtime.now(),
          ),
        )
      } catch (error) {
        const cleaned =
          error instanceof RetainedSetupProcessTreeUncertainError
            ? this.markRetainedCheckSetupUncertain(initial, phase, check.id, errorText(error))
            : await this.cleanupRetainedCheckSetup(
                initial,
                phase,
                check.id,
                rootDirectory,
                workspace,
                setupResource,
                setupDependencyLink,
                setupTemporaryDirectoryLink,
              )
        this.runtime.retainedVerificationAborts.delete(initial.id)
        if (runSignal.aborted || !this.retainedVerificationLive(initial.id, initial.generation))
          return undefined
        await this.holdRetainedVerification(
          initial,
          cleaned
            ? errorText(error)
            : `${errorText(error)}; partial setup cleanup could not be proven and remains uncertain`,
          fence,
        )
        return undefined
      }
      const retryReceiptSuffix =
        retryAuthorization?.continuationKind === "interrupted-check" &&
        typeof retryAuthorization.continuationID === "string"
          ? `-continuation-${retryAuthorization.continuationID}`
          : existing?.state === "retry-authorized" && deadline.amendmentID
            ? `-amendment-${deadline.amendmentID}`
            : ""
      const receiptPath = join(
        this.runtime.dataDirectory,
        "receipts",
        "retained-verification",
        initial.id,
        `${initial.generation}-${phase}-${check.id}${retryReceiptSuffix}.json`,
      )
      const inputFingerprint = `${FINGERPRINT_V2_PREFIX}${fingerprint({
        operationID: initial.id,
        generation: initial.generation,
        operationInputFingerprint: this.retainedVerificationInputFingerprint(initial, phase),
        phase,
        check: effectiveCheck,
        authoredCheck: check,
        verificationDeadline: verificationReceiptDeadline(deadline),
        workspace,
        artifact: this.runtime.store.treeRef(artifact),
        contextIdentity: context.identity,
        environmentIdentity: context.environmentIdentity,
      })}`
      let checkRow: ReturnType<typeof beginRetainedVerificationCheck>
      try {
        await this.runtime.beforeRetainedCheckBegin?.({
          operationID: initial.id,
          generation: initial.generation,
          phase,
          checkID: check.id,
          retryAuthorized: existing?.state === "retry-authorized",
        })
        checkRow = this.runtime.store.atomic((db) =>
          beginRetainedVerificationCheck(db, {
            operationID: initial.id,
            generation: initial.generation,
            phase,
            checkID: check.id,
            check: effectiveCheck,
            workspace,
            artifact,
            inputFingerprint,
            environmentIdentity: context.environmentIdentity,
            receiptPath,
            contextPath: context.directory,
            createdAt: this.runtime.now(),
            ...(retryAuthorization?.continuationKind === "interrupted-check"
              ? { allowUnchangedCheck: true }
              : {}),
          }),
        )
      } catch (error) {
        try {
          await removeRetainedCheckContext(context)
          this.runtime.store.atomic((db) =>
            settleRetainedVerificationResources(
              db,
              initial.id,
              phase,
              check.id,
              "removed",
              this.runtime.now(),
            ),
          )
        } catch {
          this.runtime.store.atomic((db) =>
            settleRetainedVerificationResources(
              db,
              initial.id,
              phase,
              check.id,
              "uncertain",
              this.runtime.now(),
            ),
          )
        }
        this.runtime.retainedVerificationAborts.delete(initial.id)
        await this.holdRetainedVerification(initial, errorText(error), fence)
        return undefined
      }
      if (!this.retainedVerificationLive(initial.id, initial.generation)) {
        await this.cleanupRetainedCheckResources(
          initial,
          phase,
          check.id,
          context.directory,
          retainedCheckIsolationWitness(context),
          fence,
        )
        this.runtime.retainedVerificationAborts.delete(initial.id)
        return undefined
      }
      try {
        const activityIdentity = {
          operationID: initial.id,
          generation: initial.generation,
          phase,
          checkID: check.id,
          inputFingerprint: checkRow.inputFingerprint,
          workspace: checkRow.workspace,
          artifact: checkRow.artifact,
          contextPath: checkRow.contextPath,
        }
        this.runtime.startCheckActivity({
          id: activityID,
          identity: activityIdentity,
          signal: runSignal,
          metadata: {
            kind: "retained",
            projectDirectory: this.runtime.directory,
            planID: initial.planID,
            taskID: initial.taskID,
            attemptID: initial.attemptID,
            operationID: initial.id,
            generation: initial.generation,
            phase,
            checkID: check.id,
            workspace,
            artifact,
            contextPath: context.directory,
            isolation: retainedCheckIsolationWitness(context),
          },
          run: (signal) =>
            this.runtime.runVerificationCheck(workspace, artifact, check, deadline, receiptPath, {
              environment: context.environment,
              environmentIdentity: context.environmentIdentity,
              ownedUntrackedPaths: context.dependencyLink ? ["node_modules"] : [],
              isolation: retainedCheckIsolationWitness(context),
              signal,
            }),
        })
        return undefined
      } catch (error) {
        this.runtime.store.atomic((db) =>
          markRetainedVerificationCheckUncertain(db, initial.id, phase, check.id, errorText(error)),
        )
        await this.cleanupRetainedCheckResources(
          initial,
          phase,
          check.id,
          context.directory,
          retainedCheckIsolationWitness(context),
          fence,
        )
        await this.holdRetainedVerification(
          initial,
          `Retained verification check ${phase}:${check.id} is uncertain: ${errorText(error)}`,
          fence,
        )
        return undefined
      }
    }
    return results
  }

  async cleanupRetainedCheckResources(
    operation: RetainedVerification,
    phase: "task" | "combined",
    checkID: string,
    contextPath: string,
    witness: unknown,
    fence: number,
  ): Promise<void> {
    try {
      const stored = this.runtime.store.atomic((db) =>
        retainedVerificationChecks(db, operation.id, phase).find(
          (check) => check.checkID === checkID,
        ),
      )
      if (!stored)
        throw new Error("Retained check resource ownership has no durable procedure record")
      const check = JSON.parse(stored.checkJSON) as TaskProposal["verification"][number]
      const procedure = retainedProcedurePlan(check.command)
      if (procedure.status !== "supported")
        throw new Error("Retained check procedure binding is no longer supported")
      const expected = {
        operationID: operation.id,
        generation: operation.generation,
        phase,
        checkID,
        originalWorkspace: operation.originalWorkspace,
        candidateWorkspace: this.retainedVerificationIsolatedWorkspace(operation, phase) ?? "",
        taskDatabase: this.runtime.store.repository.path,
        projectDirectory: this.runtime.directory,
        candidateArtifact: stored.artifact,
        projectIdentity: retainedProjectIdentity(
          this.runtime.directory,
          this.retainedVerificationIsolatedWorkspace(operation, phase) ?? "",
          stored.artifact,
        ),
        procedurePlan: procedure.plan,
      }
      await removeRetainedCheckContextFromWitness(contextPath, witness, expected)
      this.runtime.store.atomic((db) => {
        setRetainedVerificationCheckCleanup(db, operation.id, phase, checkID, "complete")
        settleRetainedVerificationResources(
          db,
          operation.id,
          phase,
          checkID,
          "removed",
          this.runtime.now(),
        )
      })
      this.runtime.store.record(
        operation.planID,
        operation.taskID,
        "RETAINED_VERIFICATION_CONTEXT_CLEANED",
        {
          operationID: operation.id,
          generation: operation.generation,
          phase,
          checkID,
          contextPath,
          cleanupState: "complete",
        },
      )
    } catch (error) {
      this.runtime.store.atomic((db) => {
        setRetainedVerificationCheckCleanup(db, operation.id, phase, checkID, "failed")
        settleRetainedVerificationResources(
          db,
          operation.id,
          phase,
          checkID,
          "uncertain",
          this.runtime.now(),
        )
      })
      this.runtime.store.record(
        operation.planID,
        operation.taskID,
        "RETAINED_VERIFICATION_CONTEXT_CLEANUP_FAILED",
        {
          operationID: operation.id,
          generation: operation.generation,
          phase,
          checkID,
          contextPath,
          cleanupState: "failed",
          reason: errorText(error),
          forcedDeletion: false,
        },
      )
      void fence
    }
  }

  private markRetainedCheckSetupUncertain(
    operation: RetainedVerification,
    phase: "task" | "combined",
    checkID: string,
    reason: string,
    contextPath?: string | null,
  ): false {
    this.runtime.store.atomic((db) =>
      settleRetainedVerificationResources(
        db,
        operation.id,
        phase,
        checkID,
        "uncertain",
        this.runtime.now(),
      ),
    )
    this.runtime.store.record(
      operation.planID,
      operation.taskID,
      "RETAINED_VERIFICATION_SETUP_CLEANUP_FAILED",
      {
        operationID: operation.id,
        generation: operation.generation,
        phase,
        checkID,
        ...(contextPath !== undefined ? { contextPath } : {}),
        reason,
        cleanupState: "failed",
        forcedDeletion: false,
      },
    )
    return false
  }

  private async cleanupRetainedCheckSetup(
    operation: RetainedVerification,
    phase: "task" | "combined",
    checkID: string,
    rootDirectory: string,
    candidateWorkspace: string,
    resource: RetainedCheckSetupResource | undefined,
    dependencyLink: RetainedCheckSetupLink | undefined,
    temporaryDirectoryLink: RetainedCheckSetupLink | undefined,
  ): Promise<boolean> {
    try {
      const persisted = this.runtime.store.atomic((db) =>
        db
          .query<
            {
              resource_name: string
              canonical_path: string
              device: number
              inode: number
              state: string
            },
            [string, string, string]
          >(
            `SELECT resource_name,canonical_path,device,inode,state
             FROM runner_retained_verification_resources
             WHERE operation_id=? AND phase=? AND check_id=? ORDER BY resource_name`,
          )
          .all(operation.id, phase, checkID),
      )
      const expectedSetupPath = join(
        realpathSync(rootDirectory),
        `retained-${operation.id}-${operation.generation}-${phase}-${checkID}`,
      )
      const root = persisted.find((item) => item.resource_name === "setup-root")
      resource ??= root
        ? {
            path: root.canonical_path,
            realPath: root.canonical_path,
            device: root.device,
            inode: root.inode,
          }
        : undefined
      if (!resource) {
        if (persisted.length || pathEntryExists(expectedSetupPath))
          throw new Error("Partial verification setup has no durable setup-root ownership witness")
        return true
      }
      if (resource.path !== expectedSetupPath)
        throw new Error("Verification setup path does not match its reserved operation identity")
      const persistedDependencyLink = persisted.find(
        (item) => item.resource_name === "dependency-link",
      )
      dependencyLink ??= persistedDependencyLink
        ? {
            path: persistedDependencyLink.canonical_path,
            target: join(resource.path, "dependencies"),
            device: persistedDependencyLink.device,
            inode: persistedDependencyLink.inode,
          }
        : undefined
      const persistedTemporaryLink = persisted.find((item) => item.resource_name === "tmp-alias")
      temporaryDirectoryLink ??= persistedTemporaryLink
        ? {
            path: persistedTemporaryLink.canonical_path,
            target: join(resource.path, "tmp"),
            device: persistedTemporaryLink.device,
            inode: persistedTemporaryLink.inode,
          }
        : undefined
      if (!temporaryDirectoryLink) {
        const aliasPath = retainedTemporaryDirectoryAliasPath({
          operationID: operation.id,
          generation: operation.generation,
          phase,
          checkID,
        })
        if (aliasPath && pathEntryExists(aliasPath))
          temporaryDirectoryLink = {
            path: aliasPath,
            target: join(resource.path, "tmp"),
            device: -1,
            inode: -1,
          }
      }
      await removeRetainedCheckSetupResources({
        rootDirectory,
        resource,
        candidateWorkspace,
        ...(dependencyLink ? { dependencyLink } : {}),
        ...(temporaryDirectoryLink ? { temporaryDirectoryLink } : {}),
      })
      this.runtime.store.atomic((db) =>
        settleRetainedVerificationResources(
          db,
          operation.id,
          phase,
          checkID,
          "removed",
          this.runtime.now(),
        ),
      )
      this.runtime.store.record(
        operation.planID,
        operation.taskID,
        "RETAINED_VERIFICATION_SETUP_CLEANED",
        {
          operationID: operation.id,
          generation: operation.generation,
          phase,
          checkID,
          contextPath: resource.path,
          cleanupState: "complete",
        },
      )
      return true
    } catch (error) {
      return this.markRetainedCheckSetupUncertain(
        operation,
        phase,
        checkID,
        errorText(error),
        resource?.path ?? null,
      )
    }
  }

  private async retainedEvidenceMissing(
    operation: RetainedVerification,
    phase: "task" | "combined",
    assertions: TaskProposal["acceptance"],
    workspace: string,
    artifact: string,
    receipts: CheckReceipt[],
  ): Promise<string[]> {
    const missing: string[] = []
    const probes = new ProbeRepository(this.runtime.store.repository)
    const resources = new ResourceRepository(this.runtime.store.repository)
    const target =
      phase === "task"
        ? ({ kind: "task", taskID: operation.taskID } as const)
        : ({ kind: "combined-candidate", planID: operation.planID } as const)
    const probeDefinition = probes.definitionForTarget(target)
    const probeRuns = probeDefinition ? probes.runsForAttempt(operation.attemptID) : []
    const basis = retainedVerificationProbeBasis(operation, phase)
    const currentInputs = basis.inputs
    const currentEnvironment = basis.environment
    for (const assertion of assertions) {
      for (const evidence of assertion.evidence) {
        if (
          evidence.kind === "verification" &&
          !receipts.some(
            (receipt) =>
              receipt.id === evidence.verificationID &&
              this.runtime.store.sameArtifact(receipt.artifact, artifact) &&
              this.runtime.store.sameArtifact(receipt.inputIdentity, artifact) &&
              receipt.exitCode === 0 &&
              !receipt.timedOut,
          )
        )
          missing.push(`${assertion.id}:verification`)
        if (evidence.kind === "artifact" && !(await artifactExists(workspace, evidence.reference)))
          missing.push(`${assertion.id}:${evidence.reference}`)
      }
      const scenarios =
        probeDefinition?.scenarios.filter((scenario) =>
          scenario.acceptanceIDs.includes(assertion.id),
        ) ?? []
      for (const scenario of scenarios) {
        const passed = probeRuns.some((run) => {
          if (
            run.attemptID !== operation.attemptID ||
            run.sessionID !== operation.originalSessionID ||
            run.producer.sessionID !== operation.owner ||
            run.producer.agent !== "architect" ||
            fingerprint(run.target) !== fingerprint(target) ||
            run.definitionID !== probeDefinition!.definitionID ||
            run.definitionRevision !== probeDefinition!.revision ||
            run.scenarioID !== scenario.id ||
            run.candidate.revision !== artifact ||
            run.candidate.workspace !== workspace ||
            fingerprint(run.procedure) !== fingerprint(scenario.procedure) ||
            fingerprint(run.inputs) !== fingerprint(currentInputs) ||
            fingerprint(run.environment) !== fingerprint(currentEnvironment)
          )
            return false
          try {
            const ownership = resources.resourcesForRun(run.runID)
            const execution = resources.execution(run.runID)
            if (
              ownership.length === 0 ||
              execution?.phase !== "finished" ||
              !this.retainedProbeResourcesAreIsolated(operation, workspace, ownership) ||
              ownership.some(
                (resource) =>
                  resource.runID !== run.runID ||
                  resource.owner.projectDirectory !== operation.projectDirectory ||
                  resource.owner.planID !== operation.planID ||
                  resource.owner.taskID !== operation.taskID ||
                  resource.owner.attemptID !== operation.attemptID ||
                  resource.owner.sessionID !== operation.originalSessionID ||
                  fingerprint(resource.owner.producer) !== fingerprint(run.producer) ||
                  fingerprint(resource.owner.candidate) !== fingerprint(run.candidate) ||
                  fingerprint(resource.owner.environment) !== fingerprint(run.environment),
              )
            )
              return false
            const eligibility = probes.eligibility(run.runID, {
              candidate: { revision: artifact, workspace },
              procedure: scenario.procedure,
              inputs: currentInputs,
              environment: currentEnvironment,
            })
            return eligibility.eligible && eligibility.satisfied
          } catch {
            return false
          }
        })
        if (!passed) missing.push(`${assertion.id}:probe:${scenario.id}`)
      }
    }
    return missing
  }

  private async removeRetainedVerificationWorkspace(
    operation: RetainedVerification,
    phase: "task" | "combined",
    fence: number,
  ): Promise<"complete" | "failed" | "pending"> {
    const workspace = this.retainedVerificationIsolatedWorkspace(operation, phase)
    const state = phase === "task" ? operation.taskWorkspaceState : operation.combinedWorkspaceState
    if (!workspace) return "complete"
    if (!state) return "pending"
    const artifact = phase === "task" ? operation.artifact : operation.combinedArtifact
    if (!artifact) return "pending"
    let recordedWorkspace = workspace
    try {
      const checks = this.runtime.store.atomic((db) =>
        retainedVerificationChecks(db, operation.id, phase),
      )
      for (const check of checks) {
        if (check.state !== "completed" || !check.receipt)
          throw new Error("Retained check activity is not conclusively complete")
        const receipt = JSON.parse(check.receipt) as CheckReceipt
        if (!checkResourcesSettled(receipt))
          throw new Error("Retained check process cleanup remains uncertain")
        if (check.cleanupState !== "complete") {
          const resourcesCleaned = await this.cleanupRetainedCheckSetup(
            operation,
            phase,
            check.checkID,
            this.runtime.dataDirectory,
            workspace,
            undefined,
            undefined,
            undefined,
          )
          if (resourcesCleaned)
            await this.cleanupRetainedCheckResources(
              operation,
              phase,
              check.checkID,
              check.contextPath,
              receipt.isolation,
              fence,
            )
        }
      }
      const remainingResources = this.runtime.store.atomic((db) =>
        db
          .query<{ state: string }, [string, string]>(
            "SELECT state FROM runner_retained_verification_resources WHERE operation_id=? AND phase=?",
          )
          .all(operation.id, phase)
          .some((resource) => resource.state !== "removed"),
      )
      const checkCleanupPending = this.runtime.store.atomic((db) =>
        retainedVerificationChecks(db, operation.id, phase).some(
          (check) => check.cleanupState !== "complete",
        ),
      )
      if (remainingResources || checkCleanupPending)
        throw new Error("Retained verification check resources remain unsettled")

      const candidates =
        state === "reserved" || state === "uncertain"
          ? startupWorktreeCandidates(workspace)
          : [workspace]
      const native = await this.runtime.host.worktrees()
      const matches = native.filter((item) =>
        candidates.some((candidate) => resolve(item) === resolve(candidate)),
      )
      if (matches.length > 1)
        throw new Error("Multiple native worktrees match the retained workspace reservation")
      const owned = matches[0]
      if (!owned) {
        const existing = candidates.filter((candidate) => existsSync(candidate))
        const gitWorktrees = (await worktreeListPorcelain(this.runtime.directory))
          .split(/\r?\n/)
          .filter((line) => line.startsWith("worktree "))
          .map((line) => resolve(line.slice("worktree ".length)))
        const registered = candidates.filter((candidate) =>
          gitWorktrees.includes(resolve(candidate)),
        )
        if (existing.length > 1 || registered.length > 1)
          throw new Error(
            "Multiple retained workspace paths exist; preserve them for reconciliation",
          )
        if (existing.length && !registered.length)
          throw new Error("Retained checkout exists without native ownership; preserve it")
        if (registered.length) {
          recordedWorkspace = registered[0]!
          const removalIntent = this.runtime.store.fenced(this.runtime.owner, fence, (db) => {
            const current = retainedVerification(db, operation.id)
            if (!current || current.generation !== operation.generation) return false
            setRetainedVerificationWorkspace(db, current, phase, recordedWorkspace, "owned")
            this.runtime.store.record(
              operation.planID,
              operation.taskID,
              "RETAINED_VERIFICATION_WORKSPACE_REMOVAL_INTENDED",
              {
                operationID: operation.id,
                generation: operation.generation,
                phase,
                workspace: recordedWorkspace,
              },
            )
            return true
          })
          if (!removalIntent) return "pending"
          await this.runtime.host.removeWorktree(recordedWorkspace)
        }
        const nativeAfterAbsent = await this.runtime.host.worktrees()
        const gitAfterAbsent = (await worktreeListPorcelain(this.runtime.directory))
          .split(/\r?\n/)
          .filter((line) => line.startsWith("worktree "))
          .map((line) => resolve(line.slice("worktree ".length)))
        if (
          nativeAfterAbsent.some((item) =>
            candidates.some((candidate) => resolve(item) === resolve(candidate)),
          ) ||
          gitAfterAbsent.some((item) =>
            candidates.some((candidate) => resolve(item) === resolve(candidate)),
          ) ||
          candidates.some((candidate) => existsSync(candidate))
        )
          throw new Error("Retained native workspace removal is not confirmed absent")
      } else {
        recordedWorkspace = owned
        if (
          realpathSync(dirname(owned)) !== realpathSync(dirname(workspace)) ||
          samePhysicalWorkspace(owned, operation.originalWorkspace) ||
          samePhysicalWorkspace(owned, this.runtime.directory) ||
          realpathSync(await gitAsync(owned, ["rev-parse", "--show-toplevel"])) !==
            realpathSync(owned) ||
          (await gitAsync(owned, ["rev-parse", "HEAD"])) !== artifact ||
          (await gitAsync(owned, ["status", "--porcelain", "--untracked-files=all"])) ||
          (await gitAsync(owned, ["ls-files", "-u", "-z"]))
        )
          throw new Error("Retained checkout identity or clean state changed; preserve it")
        const removalIntent = this.runtime.store.fenced(this.runtime.owner, fence, (db) => {
          const current = retainedVerification(db, operation.id)
          if (!current || current.generation !== operation.generation) return false
          setRetainedVerificationWorkspace(db, current, phase, owned, "owned")
          this.runtime.store.record(
            operation.planID,
            operation.taskID,
            "RETAINED_VERIFICATION_WORKSPACE_REMOVAL_INTENDED",
            {
              operationID: operation.id,
              generation: operation.generation,
              phase,
              workspace: owned,
            },
          )
          return true
        })
        if (!removalIntent) return "pending"
        await this.runtime.host.removeWorktree(owned)
      }
      const currentNative = await this.runtime.host.worktrees()
      const currentGit = (await worktreeListPorcelain(this.runtime.directory))
        .split(/\r?\n/)
        .filter((line) => line.startsWith("worktree "))
        .map((line) => resolve(line.slice("worktree ".length)))
      if (
        candidates.some((candidate) => existsSync(candidate)) ||
        currentGit.some((item) =>
          candidates.some((candidate) => resolve(item) === resolve(candidate)),
        ) ||
        currentNative.some((item) =>
          candidates.some((candidate) => resolve(item) === resolve(candidate)),
        )
      )
        throw new Error("Native adapter did not confirm retained checkout removal")
      const retired = await this.runtime.host.retireWorktreeLocation?.(recordedWorkspace)
      if (retired !== undefined && retired !== "evicted" && retired !== "not-loaded")
        throw new Error(`Native checkout location retirement is ${retired}`)
      this.runtime.store.fenced(this.runtime.owner, fence, (db) => {
        const current = retainedVerification(db, operation.id)
        if (current?.generation === operation.generation)
          setRetainedVerificationWorkspace(db, current, phase, recordedWorkspace, "removed")
      })
      this.runtime.store.record(
        operation.planID,
        operation.taskID,
        "RETAINED_VERIFICATION_WORKSPACE_CLEANED",
        {
          operationID: operation.id,
          generation: operation.generation,
          phase,
          workspace: recordedWorkspace,
          cleanupState: "complete",
          forcedDeletion: false,
        },
      )
      return "complete"
    } catch (error) {
      this.runtime.store.fenced(this.runtime.owner, fence, (db) => {
        const current = retainedVerification(db, operation.id)
        if (current?.generation === operation.generation)
          setRetainedVerificationWorkspace(db, current, phase, recordedWorkspace, "uncertain")
      })
      this.runtime.store.record(
        operation.planID,
        operation.taskID,
        "RETAINED_VERIFICATION_WORKSPACE_CLEANUP_FAILED",
        {
          operationID: operation.id,
          generation: operation.generation,
          phase,
          workspace: recordedWorkspace,
          cleanupState: "failed",
          reason: errorText(error),
          forcedDeletion: false,
        },
      )
      return "failed"
    }
  }

  async reconcileTerminalRetainedVerifications(fence: number): Promise<void> {
    const terminalOperations = this.runtime.store
      .atomic((db) => retainedVerificationsForProject(db, this.runtime.directory))
      .filter((operation) => ["accepted", "failed", "cancelled"].includes(operation.state))
    const terminalIDs = new Set(terminalOperations.map((operation) => operation.id))
    for (const operationID of this.runtime.terminalRetainedVerificationCleanupChecks.keys())
      if (!terminalIDs.has(operationID))
        this.runtime.terminalRetainedVerificationCleanupChecks.delete(operationID)
    const checkedAt = this.runtime.now()
    const operations = terminalOperations.filter((operation) => {
      if (!this.terminalRetainedVerificationCleanupRecordedComplete(operation)) return true
      const previous = this.runtime.terminalRetainedVerificationCleanupChecks.get(operation.id)
      if (
        !previous ||
        previous.generation !== operation.generation ||
        previous.updatedAt !== operation.updatedAt
      )
        return true
      const elapsed = checkedAt - previous.checkedAt
      return elapsed < 0 || elapsed >= WORKTREE_CLEANUP_FALLBACK_MS
    })
    if (!operations.length) return

    let native: string[]
    let gitWorktrees: string[]
    try {
      native = await this.runtime.host.worktrees()
      gitWorktrees = (await worktreeListPorcelain(this.runtime.directory))
        .split(/\r?\n/)
        .filter((line) => line.startsWith("worktree "))
        .map((line) => resolve(line.slice("worktree ".length)))
    } catch {
      for (const operation of operations) {
        const current = this.runtime.store.atomic((db) => retainedVerification(db, operation.id))
        if (
          current?.generation === operation.generation &&
          current.updatedAt === operation.updatedAt &&
          this.terminalRetainedVerificationCleanupRecordedComplete(current)
        )
          this.runtime.terminalRetainedVerificationCleanupChecks.set(operation.id, {
            generation: current.generation,
            updatedAt: current.updatedAt,
            checkedAt,
          })
      }
      return
    }

    for (const original of operations) {
      let operation = this.runtime.store.atomic((db) => retainedVerification(db, original.id))
      if (
        !operation ||
        operation.generation !== original.generation ||
        !["accepted", "failed", "cancelled"].includes(operation.state)
      )
        continue
      if (operation.state === "cancelled") {
        try {
          await this.runtime.recoverCancelledRetainedChecks(operation.id)
        } catch {
          // Keep the terminal operation and its native resources discoverable.
        }
        operation = this.runtime.store.atomic((db) => retainedVerification(db, original.id))
        if (!operation || operation.generation !== original.generation) continue
      }

      let cleanupComplete = true
      const workspaceResults = new Map<"task" | "combined", "complete" | "failed" | "pending">()
      for (const phase of ["task", "combined"] as const) {
        const workspace = this.retainedVerificationIsolatedWorkspace(operation, phase)
        const workspaceState =
          phase === "task" ? operation.taskWorkspaceState : operation.combinedWorkspaceState
        const checks = this.runtime.store.atomic((db) =>
          retainedVerificationChecks(db, operation!.id, phase),
        )
        let checksSettled = true
        for (const check of checks) {
          if (check.state !== "completed" || !check.receipt) {
            checksSettled = false
            break
          }
          let receipt: CheckReceipt
          try {
            receipt = JSON.parse(check.receipt) as CheckReceipt
          } catch {
            checksSettled = false
            break
          }
          if (!checkResourcesSettled(receipt)) {
            checksSettled = false
            break
          }
          const resourcePending = this.runtime.store.atomic((db) =>
            db
              .query<{ state: string }, [string, string, string]>(
                "SELECT state FROM runner_retained_verification_resources WHERE operation_id=? AND phase=? AND check_id=?",
              )
              .all(operation!.id, phase, check.checkID)
              .some((resource) => resource.state !== "removed"),
          )
          if (check.cleanupState !== "complete" || resourcePending) {
            const setupClean = await this.cleanupRetainedCheckSetup(
              operation,
              phase,
              check.checkID,
              this.runtime.dataDirectory,
              workspace ?? check.workspace,
              undefined,
              undefined,
              undefined,
            )
            if (setupClean)
              await this.cleanupRetainedCheckResources(
                operation,
                phase,
                check.checkID,
                check.contextPath,
                receipt.isolation,
                fence,
              )
          }
        }
        const refreshedChecks = this.runtime.store.atomic((db) =>
          retainedVerificationChecks(db, operation!.id, phase),
        )
        const remainingResources = this.runtime.store.atomic((db) =>
          db
            .query<{ state: string }, [string, string]>(
              "SELECT state FROM runner_retained_verification_resources WHERE operation_id=? AND phase=?",
            )
            .all(operation!.id, phase)
            .some((resource) => resource.state !== "removed"),
        )
        checksSettled &&= refreshedChecks.every(
          (check) =>
            check.state === "completed" &&
            Boolean(check.receipt) &&
            check.cleanupState === "complete",
        )
        checksSettled &&= !remainingResources

        const candidates =
          workspace && (workspaceState === "reserved" || workspaceState === "uncertain")
            ? startupWorktreeCandidates(workspace)
            : workspace
              ? [workspace]
              : []
        const inventoryHasWorkspace = candidates.some(
          (candidate) =>
            native.some((entry) => resolve(entry) === resolve(candidate)) ||
            gitWorktrees.includes(resolve(candidate)) ||
            existsSync(candidate),
        )
        const workspaceNeedsCleanup = Boolean(
          workspace && (workspaceState !== "removed" || inventoryHasWorkspace),
        )
        if (!checksSettled) {
          if (workspaceNeedsCleanup) {
            workspaceResults.set(phase, "pending")
            cleanupComplete = false
          }
          if (refreshedChecks.length || remainingResources) cleanupComplete = false
          continue
        }
        if (workspaceNeedsCleanup) {
          const result = await this.removeRetainedVerificationWorkspace(operation, phase, fence)
          workspaceResults.set(phase, result)
          if (result !== "complete") cleanupComplete = false
        } else if (workspaceState !== null && workspaceState !== "removed") {
          workspaceResults.set(phase, "pending")
          cleanupComplete = false
        }
      }

      const refreshed = this.runtime.store.atomic((db) => retainedVerification(db, operation!.id))
      if (!refreshed || refreshed.generation !== operation.generation) continue
      const taskResult = workspaceResults.get("task")
      const combinedResult = workspaceResults.get("combined")
      const workspaceUnresolved = [
        [refreshed.taskWorkspace, refreshed.taskWorkspaceState, taskResult],
        [refreshed.combinedWorkspace, refreshed.combinedWorkspaceState, combinedResult],
      ].some(
        ([workspace, state, result]) =>
          Boolean(workspace) && (state !== "removed" || (result && result !== "complete")),
      )
      cleanupComplete &&= !workspaceUnresolved
      const cleanupState = cleanupComplete ? "complete" : "failed"
      if (refreshed.cleanupState !== cleanupState) {
        this.runtime.store.fenced(this.runtime.owner, fence, (db) => {
          const current = retainedVerification(db, refreshed.id)
          if (!current || current.generation !== refreshed.generation) return
          saveRetainedVerification(db, {
            ...current,
            cleanupState,
            updatedAt: this.runtime.now(),
          })
          this.runtime.store.record(
            current.planID,
            current.taskID,
            cleanupComplete
              ? "RETAINED_VERIFICATION_TERMINAL_CLEANUP_COMPLETED"
              : "RETAINED_VERIFICATION_TERMINAL_CLEANUP_PENDING",
            {
              operationID: current.id,
              generation: current.generation,
              workspaces: {
                task: current.taskWorkspaceState,
                combined: current.combinedWorkspaceState,
              },
              results: Object.fromEntries(workspaceResults),
            },
          )
        })
      }
      const current = this.runtime.store.atomic((db) => retainedVerification(db, refreshed.id))
      if (
        cleanupComplete &&
        current?.generation === refreshed.generation &&
        ["accepted", "failed", "cancelled"].includes(current.state) &&
        this.terminalRetainedVerificationCleanupRecordedComplete(current)
      )
        this.runtime.terminalRetainedVerificationCleanupChecks.set(current.id, {
          generation: current.generation,
          updatedAt: current.updatedAt,
          checkedAt: this.runtime.now(),
        })
      else this.runtime.terminalRetainedVerificationCleanupChecks.delete(refreshed.id)
    }
  }

  private terminalRetainedVerificationCleanupRecordedComplete(operation: RetainedVerification) {
    const workspaceSettled = (workspace: string | null, state: string | null) =>
      workspace === null ? state === null : state === "removed"
    return (
      operation.cleanupState === "complete" &&
      workspaceSettled(operation.taskWorkspace, operation.taskWorkspaceState) &&
      workspaceSettled(operation.combinedWorkspace, operation.combinedWorkspaceState)
    )
  }

  private async reconcileInterruptedRetainedCheckSetup(
    operation: RetainedVerification,
    phase: "task" | "combined",
    check: TaskProposal["verification"][number],
    candidateWorkspace: string,
    fence: number,
  ): Promise<boolean> {
    const existingCheck = this.runtime.store.atomic((db) =>
      retainedVerificationChecks(db, operation.id, phase).some((item) => item.checkID === check.id),
    )
    if (existingCheck) return false
    const resources = this.runtime.store.atomic((db) =>
      db
        .query<
          {
            resource_name: string
            canonical_path: string
            device: number
            inode: number
            state: string
          },
          [string, string, string]
        >(
          `SELECT resource_name,canonical_path,device,inode,state
           FROM runner_retained_verification_resources
           WHERE operation_id=? AND phase=? AND check_id=? ORDER BY resource_name`,
        )
        .all(operation.id, phase, check.id),
    )
    if (!resources.length) return false
    // A restarted runtime has no completed installer/termination observation.
    // Ownership identifies resources; it does not establish that their writer stopped.
    const reason = `Interrupted retained verification setup ${phase}:${check.id} has unknown installer activity in ${candidateWorkspace}; preserve its resources`
    this.markRetainedCheckSetupUncertain(operation, phase, check.id, reason)
    await this.holdRetainedVerification(operation, reason, fence)
    return true
  }

  private async acceptRetainedTaskCandidate(
    initial: RetainedVerification,
    workspace: string,
    receipts: CheckReceipt[],
    fence: number,
  ): Promise<RetainedVerification | undefined> {
    const observeOwner = async () => {
      const owner = await this.runtime.host.session(initial.owner)
      if (!this.runtime.validArchitect(owner) || owner.id !== initial.owner)
        throw new Error("Retained verification owner changed before task acceptance")
    }
    try {
      if (initial.repair) {
        const plan = this.runtime.store.plan(initial.planID)
        const attempt = this.runtime.store
          .attempts(initial.planID)
          .find((a) => a.id === initial.attemptID)
        if (!plan || !attempt) throw new Error("Retained repair binding disappeared")
        await this.runtime.observeRetainedRepairCandidate(
          plan,
          attempt,
          initial.repair,
          observeOwner,
        )
      } else await observeOwner()
    } catch (error) {
      await this.holdRetainedVerification(initial, errorText(error), fence)
      return undefined
    }
    if (!(await this.retainedWorkspaceUnchanged(workspace, initial.artifact))) {
      await this.holdRetainedVerification(
        initial,
        "Retained task candidate changed after its task checks",
        fence,
      )
      return undefined
    }

    const plan = this.runtime.store.plan(initial.planID)
    const input = plan ? PlanInput.parse(JSON.parse(plan.body)) : undefined
    const nodes = this.runtime.store.nodes(initial.planID)
    const node = nodes.find((candidate) => candidate.task_id === initial.taskID)
    const attempt = this.runtime.store
      .attempts(initial.planID)
      .filter((candidate) => candidate.task_id === initial.taskID)
      .at(-1)
    const targetFailureOwnsBlock = Boolean(
      plan?.state === "blocked" &&
      node?.state === "failed" &&
      attempt?.state === "failed" &&
      plan.reason !== null &&
      (plan.reason === node.reason ||
        plan.reason === `Task ${node.task_id}: ${node.reason ?? node.state}`),
    )
    const retainedEvidenceHoldOwnsBlock = Boolean(
      plan?.state === "blocked" &&
      node?.state === "verifying" &&
      attempt?.state === "verifying" &&
      plan.reason?.startsWith("Required evidence missing:"),
    )
    const otherNodesReady = Boolean(
      input?.integrationOrder.every((taskID) => {
        if (taskID === initial.taskID) return true
        const other = nodes.find((candidate) => candidate.task_id === taskID)
        return Boolean(other?.artifact && ["accepted", "incorporated"].includes(other.state))
      }),
    )
    const canContinueCombined = Boolean(
      initial.combinedArtifact &&
      otherNodesReady &&
      (plan?.state === "accepted" || plan?.state === "cleanup-blocked" || targetFailureOwnsBlock),
    )
    return this.runtime.store.fenced(this.runtime.owner, fence, (db) => {
      const current = retainedVerification(db, initial.id)
      const currentPlan = this.runtime.store.plan(initial.planID)
      const currentTask = this.runtime.store.repository.get(initial.taskID)
      const latestAttempt = this.runtime.store
        .attempts(initial.planID)
        .filter((candidate) => candidate.task_id === initial.taskID)
        .at(-1)
      const currentNode = this.runtime.store
        .nodes(initial.planID)
        .find((candidate) => candidate.task_id === initial.taskID)
      const sourceQuarantineCurrent = Boolean(
        current?.sourceQuarantine &&
        ["running", "blocked", "accepted", "cleanup-blocked"].includes(currentPlan?.state ?? "") &&
        latestAttempt?.state === "verifying" &&
        latestAttempt.artifact === initial.artifact &&
        currentNode?.state === "verifying" &&
        sourceQuarantineVerificationBindingMatches(this.runtime.store, {
          planID: initial.planID,
          owner: initial.owner,
          attempt: latestAttempt,
          artifact: initial.artifact,
          expected: current.sourceQuarantine,
        }),
      )
      if (
        !current ||
        current.generation !== initial.generation ||
        current.state !== "task-checks" ||
        !currentPlan ||
        (current.sourceQuarantine
          ? !this.sourceQuarantinePlanVersionCurrent(current, currentPlan, db)
          : currentPlan.version !== initial.planVersion) ||
        currentPlan.revision !== initial.planRevision ||
        (current.sourceQuarantine
          ? !sourceQuarantineCurrent
          : !["blocked", "accepted", "cleanup-blocked"].includes(currentPlan.state)) ||
        !currentTask ||
        currentTask.revision !== initial.taskRevision ||
        !sameProject(currentTask.provenance.projectID, this.runtime.projectID) ||
        currentTask.provenance.projectDirectory !== this.runtime.directory ||
        this.runtime.store.repository.taskDisposition(initial.taskID) !== undefined ||
        latestAttempt?.id !== initial.attemptID ||
        latestAttempt.session_id !== initial.originalSessionID ||
        latestAttempt.message_id !== initial.originalMessageID ||
        realpathSync(latestAttempt.workspace) !== initial.originalWorkspace ||
        !currentNode ||
        !["accepted", "blocked", "failed", "verifying", "running", "ready"].includes(
          currentNode.state,
        ) ||
        (currentNode.artifact !== null && currentNode.artifact !== initial.artifact) ||
        (initial.repair &&
          (latestAttempt.artifact !== initial.repair.previousArtifact ||
            !this.runtime.retainedRepairCandidateCurrent(
              currentPlan,
              latestAttempt,
              initial.repair,
            )))
      )
        return undefined

      let expectedPlanVersion = currentPlan.version
      // Quarantined source has no idle or cleanup proof; accept only its task node.
      if (!current.sourceQuarantine)
        db.query(
          "UPDATE runner_attempts SET state=lz_runner_transition('attempt',state,'accepted'),artifact=? WHERE id=? AND state IN ('running','verifying')",
        ).run(initial.artifact, initial.attemptID)
      if (currentNode.state !== "accepted") {
        db.query(
          "UPDATE runner_nodes SET artifact=? WHERE plan_id=? AND task_id=? AND state=?",
        ).run(initial.artifact, initial.planID, initial.taskID, currentNode.state)
        this.runtime.store.move(initial.planID, initial.taskID, "RETAINED_ACCEPT")
        expectedPlanVersion += 1
      }

      let resumedForDependencies = false
      if (
        currentPlan.state === "blocked" &&
        (targetFailureOwnsBlock || retainedEvidenceHoldOwnsBlock) &&
        currentPlan.reason !== null
      ) {
        const resumed = db
          .query(
            `UPDATE runner_plans SET state=lz_runner_transition('plan',state,'running'),reason=NULL,version=version+1
             WHERE id=? AND state='blocked' AND reason=? AND version=?`,
          )
          .run(initial.planID, currentPlan.reason, expectedPlanVersion).changes
        if (resumed !== 1) throw new Error("Plan changed before retained task dependency release")
        expectedPlanVersion += 1
        resumedForDependencies = true
      }

      const allNodesReady = this.runtime.store
        .nodes(initial.planID)
        .every((candidate) =>
          input!.integrationOrder.includes(candidate.task_id)
            ? candidate.task_id === initial.taskID ||
              (Boolean(candidate.artifact) &&
                ["accepted", "incorporated"].includes(candidate.state))
            : false,
        )
      const runCombined = Boolean(
        canContinueCombined &&
        current.combinedArtifact &&
        allNodesReady &&
        ["running", "accepted", "cleanup-blocked"].includes(
          this.runtime.store.plan(initial.planID)!.state,
        ),
      )
      const updated: RetainedVerification = {
        ...current,
        state: runCombined ? "combined-checks" : "task-accepted",
        holdReason: null,
        ...(runCombined
          ? {
              planVersion: expectedPlanVersion,
              combinedWorkspace:
                current.combinedWorkspace ??
                this.runtime.retainedVerificationWorkspacePath(current.id, "combined"),
            }
          : {}),
        updatedAt: this.runtime.now(),
      }
      saveRetainedVerification(db, updated)
      this.runtime.store.record(
        initial.planID,
        initial.taskID,
        "RETAINED_TASK_CANDIDATE_ACCEPTED",
        {
          operationID: initial.id,
          generation: initial.generation,
          taskRevision: initial.taskRevision,
          attemptID: initial.attemptID,
          artifact: initial.artifact,
          taskChecks: receipts,
          combinedVerification: runCombined ? "ready" : "deferred-until-plan-readiness",
          resumedForDependencies,
          cleanupState: updated.cleanupState,
          originalAttemptPreserved: true,
          originalSessionMessageRouteUsagePreserved: true,
          oldExecutionAndResourceHoldsPreserved: true,
        },
      )
      if (resumedForDependencies)
        this.runtime.store.record(initial.planID, null, "RETAINED_TASK_RELEASED_DEPENDENCIES", {
          operationID: initial.id,
          generation: initial.generation,
          taskID: initial.taskID,
          artifact: initial.artifact,
          reason: "The exact retained task failure was resolved by ordinary task evidence",
          normalDependencyAndReservationGatesPreserved: true,
        })
      this.runtime.outcome(
        initial.planID,
        {
          status: "task-accepted",
          taskID: initial.taskID,
          attemptID: initial.attemptID,
          artifact: initial.artifact,
          retainedVerificationID: initial.id,
          generation: initial.generation,
          evidence: receipts.map((receipt) => receipt.id),
          cleanupState: updated.cleanupState,
          resumedForDependencies,
        },
        true,
      )
      return updated
    })
  }

  async advanceRetainedVerification(
    initial: RetainedVerification,
    fence: number,
    signal?: AbortSignal,
  ) {
    if (signal?.aborted) return
    let operation = this.runtime.store.atomic((db) => retainedVerification(db, initial.id))
    if (
      !operation ||
      operation.generation !== initial.generation ||
      ["accepted", "failed", "cancelled", "held"].includes(operation.state)
    )
      return
    const plan = this.runtime.store.plan(operation.planID)
    if (!plan) return
    let owner: HostSession | null | undefined
    try {
      owner = await this.runtime.host.session(operation.owner)
      const combinedPhase = operation.state === "combined-checks"
      const deferredTaskPhase = operation.state === "task-accepted"
      if (
        !this.runtime.validArchitect(owner) ||
        operation.planRevision !== plan.revision ||
        (!deferredTaskPhase &&
          (operation.sourceQuarantine
            ? !this.sourceQuarantinePlanVersionCurrent(operation, plan)
            : operation.planVersion !== plan.version)) ||
        !(
          ["blocked", "accepted", "cleanup-blocked"].includes(plan.state) ||
          ((combinedPhase || deferredTaskPhase || operation.sourceQuarantine !== undefined) &&
            plan.state === "running")
        )
      )
        throw new Error("Retained verification owner, plan version or execution authority changed")
      if (!this.retainedVerificationLive(operation.id, operation.generation))
        throw new Error("Retained verification task or attempt authority changed")
      if (operation.repair && !this.retainedTaskCandidateAccepted(operation)) {
        const attemptID = operation.attemptID
        const attempt = this.runtime.store.attempts(plan.id).find((a) => a.id === attemptID)
        if (!attempt) throw new Error("Retained repair attempt disappeared")
        await this.runtime.observeRetainedRepairCandidate(plan, attempt, operation.repair)
      }
    } catch (error) {
      await this.holdRetainedVerification(operation, errorText(error), fence)
      return
    }
    const input = PlanInput.parse(JSON.parse(plan.body))
    const task = this.runtime.store.repository.get(operation.taskID)
    if (!task) {
      await this.holdRetainedVerification(
        operation,
        "Retained task specification is unavailable",
        fence,
      )
      return
    }
    if (operation.state === "pending" || operation.state === "task-checks") {
      for (const check of task.proposal.verification)
        if (
          await this.reconcileInterruptedRetainedCheckSetup(
            operation,
            "task",
            check,
            operation.taskWorkspace ?? "",
            fence,
          )
        )
          return
    }
    if (operation.state === "combined-checks")
      for (const check of input.verification)
        if (
          await this.reconcileInterruptedRetainedCheckSetup(
            operation,
            "combined",
            check,
            operation.combinedWorkspace ?? "",
            fence,
          )
        )
          return
    if (operation.state === "pending" || operation.state === "task-checks") {
      const workspace = await this.ensureRetainedVerificationWorkspace(
        operation,
        "task",
        operation.artifact,
        fence,
      )
      if (!workspace) return
      const refreshed = this.runtime.store.atomic((db) => retainedVerification(db, initial.id))
      if (!refreshed || refreshed.generation !== initial.generation) return
      operation = refreshed
      if (operation.state === "pending") {
        const updated = await this.setRetainedVerificationState(
          operation,
          "task-checks",
          null,
          fence,
        )
        if (!updated) return
        operation = updated
      }
      const taskReceipts = await this.runRetainedVerificationChecks(
        operation,
        "task",
        task.proposal.verification,
        workspace,
        operation.artifact,
        fence,
        signal,
      )
      if (!taskReceipts || !this.retainedVerificationLive(operation.id, operation.generation))
        return
      const failed = taskReceipts.find(
        (receipt) => !checkSucceeded(receipt) || receipt.inputIdentity !== initial.artifact,
      )
      if (failed) {
        await this.holdRetainedVerification(operation, checkFailureReason(failed), fence)
        return
      }
      const missing = await this.retainedEvidenceMissing(
        operation,
        "task",
        task.proposal.acceptance,
        workspace,
        operation.artifact,
        taskReceipts,
      )
      if (missing.length) {
        await this.setRetainedVerificationState(
          operation,
          "held",
          `Required retained task evidence missing: ${missing.join(", ")}`,
          fence,
        )
        return
      }
      const accepted = await this.acceptRetainedTaskCandidate(
        operation,
        workspace,
        taskReceipts,
        fence,
      )
      if (!accepted || accepted.state === "task-accepted") return
      operation = accepted
    }
    if (operation.state === "task-accepted") {
      const deferredOperation = operation
      if (plan.state !== "running") return
      const nodes = this.runtime.store.nodes(deferredOperation.planID)
      const byTask = new Map(nodes.map((node) => [node.task_id, node]))
      const allNodesReady = input.integrationOrder.every((taskID) => {
        const node = byTask.get(taskID)
        return Boolean(
          node?.artifact &&
          ["accepted", "incorporated"].includes(node.state) &&
          (taskID !== deferredOperation.taskID || node.artifact === deferredOperation.artifact),
        )
      })
      if (!allNodesReady) return
      let combinedArtifact: string
      try {
        combinedArtifact = await combineArtifacts(
          this.runtime.directory,
          input.baseCommit,
          input.integrationOrder.map((taskID) => byTask.get(taskID)!.artifact!),
        )
      } catch (error) {
        await this.holdRetainedVerification(
          deferredOperation,
          `Combined artifact conflict: ${errorText(error)}`,
          fence,
        )
        return
      }
      const acceptedArtifacts = input.integrationOrder.map((taskID) => ({
        taskID,
        artifact: byTask.get(taskID)!.artifact!,
      }))
      const combinedInputFingerprint = fingerprint({
        operationInputFingerprint: deferredOperation.inputFingerprint,
        planID: plan.id,
        planRevision: plan.revision,
        planVersion: plan.version,
        planBody: plan.body,
        taskID: deferredOperation.taskID,
        taskArtifact: deferredOperation.artifact,
        acceptedArtifacts,
        combinedArtifact,
        verification: input.verification,
        acceptance: input.acceptance,
        environmentIdentity: deferredOperation.environmentIdentity,
      })
      const promoted = this.runtime.store.fenced(this.runtime.owner, fence, (db) => {
        const current = retainedVerification(db, deferredOperation.id)
        const currentPlan = this.runtime.store.plan(deferredOperation.planID)
        const currentNodes = this.runtime.store.nodes(deferredOperation.planID)
        const currentByTask = new Map(currentNodes.map((node) => [node.task_id, node]))
        const currentAttempt = this.runtime.store
          .attempts(deferredOperation.planID)
          .find((attempt) => attempt.id === deferredOperation.attemptID)
        const sourceAuthorityCurrent = Boolean(
          !current?.sourceQuarantine ||
          (currentPlan?.state === "running" &&
            currentAttempt?.state === "verifying" &&
            currentAttempt.artifact === deferredOperation.artifact &&
            sourceQuarantineVerificationBindingMatches(this.runtime.store, {
              planID: deferredOperation.planID,
              owner: deferredOperation.owner,
              attempt: currentAttempt,
              artifact: deferredOperation.artifact,
              expected: current.sourceQuarantine,
            })),
        )
        if (
          !current ||
          current.generation !== deferredOperation.generation ||
          current.state !== "task-accepted" ||
          !currentPlan ||
          currentPlan.state !== "running" ||
          currentPlan.version !== plan.version ||
          currentPlan.revision !== deferredOperation.planRevision ||
          !sourceAuthorityCurrent ||
          !input.integrationOrder.every((taskID) => {
            const before = byTask.get(taskID)
            const after = currentByTask.get(taskID)
            return Boolean(
              before?.artifact &&
              after?.artifact === before.artifact &&
              ["accepted", "incorporated"].includes(before.state) &&
              ["accepted", "incorporated"].includes(after.state),
            )
          }) ||
          currentByTask.get(deferredOperation.taskID)?.artifact !== deferredOperation.artifact
        )
          return undefined
        const updated: RetainedVerification = {
          ...current,
          state: "combined-checks",
          planVersion: currentPlan.version,
          combinedArtifact,
          combinedInputFingerprint,
          combinedWorkspace:
            current.combinedWorkspace ??
            this.runtime.retainedVerificationWorkspacePath(current.id, "combined"),
          holdReason: null,
          updatedAt: this.runtime.now(),
        }
        saveRetainedVerification(db, updated)
        this.runtime.store.record(
          deferredOperation.planID,
          deferredOperation.taskID,
          "RETAINED_TASK_PLAN_READY_FOR_COMBINED_VERIFICATION",
          {
            operationID: deferredOperation.id,
            generation: deferredOperation.generation,
            artifact: deferredOperation.artifact,
            combinedArtifact,
            acceptedArtifacts,
            planVersion: currentPlan.version,
          },
        )
        return updated
      })
      if (!promoted) return
      operation = promoted
    }
    if (operation.state !== "combined-checks") return
    const combinedArtifact = operation.combinedArtifact
    if (!combinedArtifact) {
      await this.holdRetainedVerification(
        operation,
        "Combined retained verification has no ready plan artifact",
        fence,
      )
      return
    }
    const combinedWorkspace = await this.ensureRetainedVerificationWorkspace(
      operation,
      "combined",
      combinedArtifact,
      fence,
    )
    if (!combinedWorkspace) return
    const refreshed = this.runtime.store.atomic((db) => retainedVerification(db, initial.id))
    if (
      !refreshed ||
      refreshed.generation !== initial.generation ||
      refreshed.state !== "combined-checks" ||
      refreshed.combinedArtifact !== combinedArtifact
    )
      return
    operation = refreshed
    const combinedReceipts = await this.runRetainedVerificationChecks(
      operation,
      "combined",
      input.verification,
      combinedWorkspace,
      combinedArtifact,
      fence,
      signal,
    )
    if (!combinedReceipts || !this.retainedVerificationLive(operation.id, operation.generation))
      return
    const failed = combinedReceipts.find(
      (receipt) => !checkSucceeded(receipt) || receipt.inputIdentity !== combinedArtifact,
    )
    if (failed) {
      await this.holdRetainedVerification(operation, checkFailureReason(failed), fence)
      return
    }
    const missing = await this.retainedEvidenceMissing(
      operation,
      "combined",
      input.acceptance,
      combinedWorkspace,
      combinedArtifact,
      combinedReceipts,
    )
    if (missing.length) {
      await this.setRetainedVerificationState(
        operation,
        "held",
        `Required retained combined evidence missing: ${missing.join(", ")}`,
        fence,
      )
      return
    }
    if (
      !(await this.retainedWorkspaceUnchanged(combinedWorkspace, combinedArtifact)) ||
      !(await this.retainedWorkspaceUnchanged(
        this.retainedVerificationIsolatedWorkspace(operation, "task")!,
        operation.artifact,
      ))
    ) {
      await this.holdRetainedVerification(
        operation,
        "Retained candidate changed after verification",
        fence,
      )
      return
    }
    const taskReceiptsForAcceptance = this.runtime.store.atomic((db) =>
      retainedVerificationChecks(db, operation.id, "task").flatMap((row) => {
        if (row.state !== "completed" || !row.receipt) return []
        try {
          return [JSON.parse(row.receipt) as CheckReceipt]
        } catch {
          return []
        }
      }),
    )
    const contextCleanup = this.runtime.store.atomic((db) =>
      retainedVerificationChecks(db, operation.id).every((row) => row.cleanupState === "complete"),
    )
    const taskCleanup = await this.removeRetainedVerificationWorkspace(operation, "task", fence)
    const combinedCleanup = await this.removeRetainedVerificationWorkspace(
      operation,
      "combined",
      fence,
    )
    const cleanupState =
      taskCleanup === "complete" && combinedCleanup === "complete" && contextCleanup
        ? "complete"
        : "failed"
    this.runtime.store.fenced(this.runtime.owner, fence, (db) => {
      const current = retainedVerification(db, operation.id)
      const currentPlan = this.runtime.store.plan(operation.planID)
      const currentTask = this.runtime.store.repository.get(operation.taskID)
      const latestAttempt = this.runtime.store
        .attempts(operation.planID)
        .filter((attempt) => attempt.task_id === operation.taskID)
        .at(-1)
      const currentNode = this.runtime.store
        .nodes(operation.planID)
        .find((node) => node.task_id === operation.taskID)
      const sourceAuthorityCurrent = Boolean(
        !current?.sourceQuarantine ||
        (["running", "blocked", "accepted", "cleanup-blocked"].includes(currentPlan?.state ?? "") &&
          latestAttempt?.state === "verifying" &&
          latestAttempt.artifact === operation.artifact &&
          latestAttempt.session_id === operation.originalSessionID &&
          latestAttempt.message_id === operation.originalMessageID &&
          realpathSync(latestAttempt.workspace) === operation.originalWorkspace &&
          sourceQuarantineVerificationBindingMatches(this.runtime.store, {
            planID: operation.planID,
            owner: operation.owner,
            attempt: latestAttempt,
            artifact: operation.artifact,
            expected: current.sourceQuarantine,
          })),
      )
      if (
        !current ||
        current.generation !== operation.generation ||
        !["pending", "task-checks", "combined-checks"].includes(current.state) ||
        !currentPlan ||
        (current.sourceQuarantine
          ? !this.sourceQuarantinePlanVersionCurrent(current, currentPlan, db)
          : currentPlan.version !== operation.planVersion) ||
        currentPlan.revision !== operation.planRevision ||
        !sourceAuthorityCurrent ||
        !currentTask ||
        currentTask.revision !== operation.taskRevision ||
        latestAttempt?.id !== operation.attemptID ||
        !currentNode ||
        !["accepted", "blocked", "failed", "verifying", "running", "ready"].includes(
          currentNode.state,
        )
      )
        return
      let expectedPlanVersion = currentPlan.version
      if (currentNode.state === "accepted") {
        if (currentNode.artifact !== operation.artifact)
          db.query(
            "UPDATE runner_nodes SET artifact=?,version=version+1 WHERE plan_id=? AND task_id=? AND state='accepted'",
          ).run(operation.artifact, operation.planID, operation.taskID)
      } else {
        db.query(
          "UPDATE runner_nodes SET artifact=? WHERE plan_id=? AND task_id=? AND state=?",
        ).run(operation.artifact, operation.planID, operation.taskID, currentNode.state)
        this.runtime.store.move(operation.planID, operation.taskID, "RETAINED_ACCEPT")
        expectedPlanVersion += 1
      }
      const updatedOperation: RetainedVerification = {
        ...current,
        state: "accepted",
        holdReason: null,
        cleanupState,
        taskWorkspaceState: taskCleanup === "complete" ? "removed" : "uncertain",
        combinedWorkspaceState: combinedCleanup === "complete" ? "removed" : "uncertain",
        updatedAt: this.runtime.now(),
      }
      saveRetainedVerification(db, updatedOperation)
      const planAcceptance = db
        .query(
          "UPDATE runner_plans SET state=lz_runner_transition('plan',state,'accepted'),artifact=?,version=version+1 WHERE id=? AND version=?",
        )
        .run(combinedArtifact, operation.planID, expectedPlanVersion)
      if (planAcceptance.changes !== 1)
        throw new Error("Plan changed before retained candidate acceptance")
      this.runtime.store.record(operation.planID, operation.taskID, "RETAINED_CANDIDATE_ACCEPTED", {
        operationID: operation.id,
        generation: operation.generation,
        taskRevision: operation.taskRevision,
        attemptID: operation.attemptID,
        artifact: operation.artifact,
        combinedArtifact,
        taskChecks: taskReceiptsForAcceptance,
        combinedChecks: combinedReceipts,
        originalAttemptStatePreserved: true,
        originalSessionMessageRouteUsagePreserved: true,
        cleanupState,
        resourceHoldsPreserved: true,
      })
      this.runtime.store.record(operation.planID, null, "PLAN_ACCEPTED", {
        artifact: combinedArtifact,
        taskArtifact: operation.artifact,
        retainedVerificationID: operation.id,
        generation: operation.generation,
        checks: combinedReceipts,
        cleanupState,
      })
      this.runtime.outcome(
        operation.planID,
        {
          status: "accepted",
          artifact: combinedArtifact,
          taskID: operation.taskID,
          taskArtifact: operation.artifact,
          attemptID: operation.attemptID,
          retainedVerificationID: operation.id,
          generation: operation.generation,
          evidence: combinedReceipts,
          cleanupState,
        },
        true,
      )
    })
  }
}
